import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  MAX_FRAME_BYTES,
  approvalResponse,
  minimalEnvironment,
  validateApprovalResponse,
  validateClientRequest,
  validateNotification,
  validateResponse,
  validateServerRequest,
} from "./protocol.js";

const DEFAULT_RESTART_BASE_MS = 100;
const DEFAULT_MAX_RESTARTS = 3;

export class CodexRpcError extends Error {
  constructor(message, code = "startup-failed", options = {}) {
    super(message, options);
    this.name = "CodexRpcError";
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CodexRpc extends EventEmitter {
  constructor({
    codexBin = "codex",
    env = process.env,
    logger = console,
    spawnImpl = spawn,
    commandFactory,
    restartBaseMs = DEFAULT_RESTART_BASE_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
  } = {}) {
    super();
    this.codexBin = codexBin;
    this.env = minimalEnvironment(env);
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.commandFactory = commandFactory ?? ((bin) => ({ command: bin, args: ["app-server", "--stdio"] }));
    this.restartBaseMs = restartBaseMs;
    this.maxRestarts = maxRestarts;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.starting = null;
    this.generation = 0;
    this.restartAttempts = 0;
    this.lastFailure = null;
  }

  async start() {
    if (this.closed) throw new CodexRpcError("Codex app-server is closed", "aborted");
    if (this.child) return;
    if (this.starting) return await this.starting;
    const generation = this.generation;
    const promise = this.#start(generation, this.codexBin, this.env);
    this.starting = promise;
    try { await promise; }
    finally {
      if (this.starting === promise) this.starting = null;
    }
  }

  async #start(generation, codexBin, env) {
    if (this.lastFailure) {
      if (this.restartAttempts >= this.maxRestarts) {
        throw new CodexRpcError(`Codex app-server restart limit reached after ${this.maxRestarts} retries`, "startup-failed", { cause: this.lastFailure });
      }
      const delay = this.restartBaseMs * (2 ** this.restartAttempts);
      this.restartAttempts += 1;
      await sleep(delay);
      if (this.closed) throw new CodexRpcError("Codex app-server is closed", "aborted");
      if (generation !== this.generation) throw new CodexRpcError("Codex app-server start was invalidated by reconfiguration", "aborted");
    }
    let child;
    try {
      const { command, args } = this.commandFactory(codexBin);
      child = this.spawnImpl(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      const failure = new CodexRpcError(`Codex app-server failed to start: ${error.message}`, "startup-failed", { cause: error });
      this.lastFailure = failure;
      throw failure;
    }
    if (this.closed || generation !== this.generation) {
      try { child?.stdin?.end?.(); } catch {}
      try { child?.kill?.("SIGTERM"); } catch {}
      throw new CodexRpcError("Codex app-server start was invalidated by reconfiguration", "aborted");
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      const failure = new CodexRpcError("Codex app-server did not expose stdio", "startup-failed");
      this.lastFailure = failure;
      throw failure;
    }
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this.#consume(child, String(chunk)));
    child.stderr.setEncoding?.("utf8");
    child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    child.on("error", (error) => this.#handleChildFailure(child, new CodexRpcError(`Codex app-server failed to start: ${error.message}`, "startup-failed", { cause: error })));
    child.on("exit", (code, signal) => this.#handleChildFailure(child, new CodexRpcError(`Codex app-server exited (${code ?? `signal:${signal}`})`, "aborted")));
  }

  markHealthy() {
    this.lastFailure = null;
    this.restartAttempts = 0;
  }

  #handleChildFailure(child, error) {
    if (child !== this.child) return;
    this.child = null;
    this.buffer = "";
    if (!this.closed) this.lastFailure = error;
    this.#rejectPending(error);
    if (!this.closed) this.emit("exit", error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #fatalProtocolError(error) {
    const child = this.child;
    this.#handleChildFailure(child, error);
    try { child?.kill?.("SIGTERM"); } catch {}
    this.emit("protocol-error", error);
  }

  #consume(child, chunk) {
    if (child !== this.child) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.#fatalProtocolError(new CodexRpcError("Codex JSON-RPC frame exceeds the size limit", "protocol-error"));
      return;
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (error) {
        this.#fatalProtocolError(new CodexRpcError(`Invalid Codex JSON-RPC frame: ${error.message}`, "protocol-error", { cause: error }));
        return;
      }
      if (frame.id !== undefined && this.pending.has(frame.id)) {
        const pending = this.pending.get(frame.id);
        const validation = validateResponse(pending.method, frame);
        if (!validation.ok) {
          this.#fatalProtocolError(new CodexRpcError(`Invalid Codex response ${pending.method}: ${(validation.errors ?? [validation.code]).join("; ")}`, "protocol-error"));
          return;
        }
        this.pending.delete(frame.id);
        pending.resolve(frame);
        continue;
      }
      if (typeof frame.method !== "string") {
        this.#fatalProtocolError(new CodexRpcError("Codex JSON-RPC frame has neither a known response nor method", "protocol-error"));
        return;
      }
      if (frame.id !== undefined) {
        void this.#handleServerRequest(frame);
        continue;
      }
      const validation = validateNotification(frame.method, frame.params);
      if (!validation.ok) {
        if (validation.code === "unknown-notification") {
          this.emit("ignored-notification", frame);
          continue;
        }
        this.#fatalProtocolError(new CodexRpcError(`Invalid Codex notification ${frame.method}: ${(validation.errors ?? [validation.code]).join("; ")}`, "protocol-error"));
        return;
      }
      this.emit("notification", frame);
    }
  }

  async #handleServerRequest(frame) {
    const validation = validateServerRequest(frame.method, frame.params);
    if (!validation.ok) {
      this.notifyError(frame.id, -32601, `Unsupported Codex server request: ${frame.method}`);
      this.#fatalProtocolError(new CodexRpcError(`Unsupported or invalid Codex server request: ${frame.method}`, "protocol-error"));
      return;
    }
    try {
      const response = approvalResponse(frame.method);
      const responseValidation = validateApprovalResponse(frame.method, response);
      if (!responseValidation.ok) throw new Error((responseValidation.errors ?? [responseValidation.code]).join("; "));
      this.notifyResponse(frame.id, response);
      this.emit("approval", frame);
    } catch (error) {
      this.notifyError(frame.id, -32602, error.message);
      this.#fatalProtocolError(new CodexRpcError(`Codex approval response failed: ${error.message}`, "approval-denied", { cause: error }));
    }
  }

  async request(method, params = {}, { signal, timeoutMs = 600_000 } = {}) {
    const validation = validateClientRequest(method, params);
    if (!validation.ok) throw new CodexRpcError(`Invalid Codex request ${method}: ${(validation.errors ?? [validation.code]).join("; ")}`, "protocol-error");
    if (signal?.aborted) throw new CodexRpcError("Codex request aborted", "aborted");
    await this.start();
    if (signal?.aborted) throw new CodexRpcError("Codex request aborted", "aborted");
    const generation = this.generation;
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle(reject, new CodexRpcError(`Codex request timed out: ${method}`, "timeout"));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        settle(reject, new CodexRpcError("Codex request aborted", "aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      try { this.#write(frame, generation); }
      catch (error) {
        this.pending.delete(id);
        settle(reject, error instanceof CodexRpcError ? error : new CodexRpcError(error.message, "startup-failed", { cause: error }));
      }
    });
  }

  async notify(method, params = {}) {
    const validation = validateClientRequest(method, params);
    if (!validation.ok) throw new CodexRpcError(`Invalid Codex notification ${method}: ${(validation.errors ?? [validation.code]).join("; ")}`, "protocol-error");
    await this.start();
    this.#write({ jsonrpc: "2.0", method, params }, this.generation);
  }

  #write(frame, expectedGeneration = this.generation) {
    if (expectedGeneration !== this.generation) throw new CodexRpcError("Codex app-server was reconfigured", "aborted");
    if (!this.child?.stdin?.writable) throw new CodexRpcError("Codex app-server stdin is unavailable", "startup-failed");
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  notifyResponse(id, result) {
    try { this.#write({ jsonrpc: "2.0", id, result }); } catch (error) { this.logger.warn?.(`codex app-server response write failed: ${error.message}`); }
  }

  notifyError(id, code, message) {
    try { this.#write({ jsonrpc: "2.0", id, error: { code, message } }); } catch (error) { this.logger.warn?.(`codex app-server error write failed: ${error.message}`); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.starting = null;
    const child = this.child;
    this.child = null;
    this.#rejectPending(new CodexRpcError("Codex app-server closed", "aborted"));
    if (!child) return;
    try { child.stdin?.end?.(); } catch {}
    const terminate = setTimeout(() => { try { child.kill?.("SIGTERM"); } catch {} }, 1_000);
    terminate.unref?.();
  }

  /**
   * Replace the executable/environment boundary after a live settings edit.
   * The next request lazily starts a fresh app-server process.
   */
  reopen({ codexBin = this.codexBin, env = this.env } = {}) {
    const child = this.child;
    this.generation += 1;
    this.child = null;
    this.buffer = "";
    this.#rejectPending(new CodexRpcError("Codex app-server was reconfigured", "aborted"));
    this.codexBin = codexBin;
    this.env = minimalEnvironment(env);
    this.closed = false;
    this.starting = null;
    this.restartAttempts = 0;
    this.lastFailure = null;
    if (!child) return;
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.("SIGTERM"); } catch {}
  }
}
