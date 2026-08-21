import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { CodexRpc, CodexRpcError } from "./rpc.js";
import { loadMemorySnapshot } from "./memory.js";
import { ThreadMapStore } from "./threadmap.js";
import { isExplicitReauthSignal, toLlmError } from "./errors.js";
import {
  EXPECTED_CODEX_VERSION,
  MAX_NOTIFICATION_QUEUE,
  PROVIDER,
  PROVIDER_NAME,
  assertAbsoluteDirectory,
  mapTokenUsage,
  mergeRateLimitSnapshot,
  normalizeRateLimits,
  parseCodexVersion,
  sandboxPolicy,
  validateNotification,
} from "./protocol.js";

const execFile = promisify(execFileCallback);
const DEFAULT_CONFIG = Object.freeze({
  codexBin: "",
  sandbox: "workspace-write",
  approvalPolicy: "never",
  // DSH conversations must not become normal Codex history unless the user
  // explicitly opts into persistent threads.
  ephemeralThreads: true,
  injectMemory: false,
  historyBootstrap: 20,
  rateLimitRefreshSec: 30,
  requestTimeoutMs: 600_000,
  fastMode: false,
});
export const MAX_HISTORY_TRANSCRIPT_CHARS = 12_000;
const HISTORY_TRUNCATION_PREFIX = "[Earlier conversation truncated]\n";
class AsyncMutex {
  tail = Promise.resolve();
  async acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = next;
    await previous;
    return release;
  }
}

class NotificationHub {
  constructor(rpc) {
    this.queue = [];
    this.waiters = [];
    this.listener = (frame) => this.push(frame);
    this.exitListener = (error) => this.rejectAll(error);
    rpc.on("notification", this.listener);
    rpc.on("exit", this.exitListener);
    rpc.on("protocol-error", this.exitListener);
    this.rpc = rpc;
  }

  push(frame) {
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index];
      if (!waiter.predicate(frame)) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(frame);
      return;
    }
    if (this.queue.length >= MAX_NOTIFICATION_QUEUE) this.queue.shift();
    this.queue.push(frame);
  }

  next(predicate, { signal, timeoutMs }) {
    const queued = this.queue.findIndex(predicate);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]);
    if (signal?.aborted) return Promise.reject(new CodexRpcError("Codex turn aborted", "aborted"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null, reject: null, timer: null, onAbort: null };
      const settle = (callback, value) => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", waiter.onAbort);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        callback(value);
      };
      waiter.resolve = (value) => settle(resolve, value);
      waiter.reject = (error) => settle(reject, error);
      waiter.timer = setTimeout(() => waiter.reject(new CodexRpcError("Timed out waiting for Codex notification", "timeout")), timeoutMs);
      waiter.onAbort = () => waiter.reject(new CodexRpcError("Codex turn aborted", "aborted"));
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error instanceof Error ? error : new CodexRpcError("Codex app-server exited", "aborted"));
  }

  dispose() {
    this.rpc.off("notification", this.listener);
    this.rpc.off("exit", this.exitListener);
    this.rpc.off("protocol-error", this.exitListener);
    this.rejectAll(new CodexRpcError("Codex notification hub closed", "aborted"));
    this.queue = [];
  }
}

function textOf(message) {
  return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}

function imageBlocksOf(message) {
  return (message?.content ?? []).filter((block) => block?.type === "image");
}

function hasProviderInput(message) {
  return Boolean(textOf(message) || imageBlocksOf(message).length > 0);
}

function isToolMessage(message) {
  return message?.source?.kind === "tool" || (message?.content ?? []).some((block) => block.type === "tool-result" || block.type === "tool-call");
}

function normalMessages(messages) {
  return messages.filter((message) => !isToolMessage(message) && (message.role === "user" || message.role === "assistant") && textOf(message));
}

function historyTranscript(messages, limit) {
  const transcript = normalMessages(messages).slice(-limit).map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${textOf(message)}`).join("\n");
  if (transcript.length <= MAX_HISTORY_TRANSCRIPT_CHARS) return transcript;
  const suffixLength = Math.max(0, MAX_HISTORY_TRANSCRIPT_CHARS - HISTORY_TRUNCATION_PREFIX.length);
  return `${HISTORY_TRUNCATION_PREFIX}${transcript.slice(-suffixLength)}`;
}

function userSequenceHash(messages) {
  const hash = createHash("sha256");
  for (const message of messages.filter((entry) => entry.role === "user" && !isToolMessage(entry))) {
    hash.update(String(message.id ?? ""));
    hash.update("\0");
    hash.update(textOf(message));
    hash.update("\0");
    for (const block of imageBlocksOf(message)) {
      hash.update(String(block.attachment?.attachmentId ?? ""));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function messageSequenceHash(messages) {
  const hash = createHash("sha256");
  for (const message of normalMessages(messages)) {
    hash.update(message.role);
    hash.update("\0");
    hash.update(textOf(message));
    hash.update("\0");
    for (const block of imageBlocksOf(message)) {
      hash.update(String(block.attachment?.attachmentId ?? ""));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function completionText(turn) {
  return (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").map((item) => item.text).join("");
}

function completedItemText(item) {
  if (typeof item?.text === "string") return item.text;
  return (item?.content ?? []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

function failure(message, code) { return { message, code }; }

function normalizeConfig(config = {}) {
  const next = { ...DEFAULT_CONFIG, ...config };
  if (!["read-only", "workspace-write"].includes(next.sandbox)) throw new Error("llm-codex-appserver: invalid sandbox");
  if (next.approvalPolicy !== "never") throw new Error("llm-codex-appserver: approvalPolicy must be never in v1");
  if (typeof next.ephemeralThreads !== "boolean") throw new Error("llm-codex-appserver: ephemeralThreads must be boolean");
  if (!Number.isInteger(next.historyBootstrap) || next.historyBootstrap < 0 || next.historyBootstrap > 100) throw new Error("llm-codex-appserver: historyBootstrap must be 0..100");
  if (!Number.isInteger(next.rateLimitRefreshSec) || next.rateLimitRefreshSec < 15 || next.rateLimitRefreshSec > 300) throw new Error("llm-codex-appserver: rateLimitRefreshSec must be 15..300");
  if (!Number.isInteger(next.requestTimeoutMs) || next.requestTimeoutMs < 30_000 || next.requestTimeoutMs > 1_800_000) throw new Error("llm-codex-appserver: requestTimeoutMs must be 30000..1800000");
  if (typeof next.fastMode !== "boolean") throw new Error("llm-codex-appserver: fastMode must be boolean");
  return next;
}

function asLlmError(error, fallback = "turn-failed") {
  if (error instanceof LlmError && error.failure?.stage) return error;
  const candidate = error?.code === "ENOENT" ? "codex-not-found" : error?.code;
  return toLlmError(error, typeof candidate === "string" ? candidate : fallback);
}

function attachmentError(message, cause, action = "check-attachment") {
  const source = Object.assign(new Error(message), { code: "protocol-error" });
  return toLlmError(source, "protocol-error", { stage: "attachment", action, retryable: false, cause });
}

export class CodexAppServerAdapter extends LlmAdapter {
  constructor(options = {}) {
    super();
    this.config = () => normalizeConfig(typeof options.config === "function" ? options.config() : options.config);
    this.logger = options.logger ?? console;
    this.rpc = options.rpc ?? new CodexRpc({ codexBin: options.codexBin || "codex", logger: this.logger });
    this.threadmap = options.threadmap ?? new ThreadMapStore(options.threadmapPath);
    this.workspaceResolver = options.workspaceResolver;
    this.attachments = options.attachments ?? null;
    this.memoryLoader = options.memoryLoader ?? loadMemorySnapshot;
    this.versionReader = options.versionReader ?? (async (bin, env) => {
      const { stdout, stderr } = await execFile(bin, ["--version"], { encoding: "utf8", env });
      return parseCodexVersion(`${stdout}\n${stderr}`);
    });
    this.versionChecked = options.skipVersionCheck === true;
    this.initialized = false;
    this.initializing = null;
    this.connectionEpoch = 0;
    this.models = null;
    this.modelDetails = new Map();
    this.modelFetchedAt = 0;
    this.hub = null;
    this.sessionLocks = new Map();
    this.threadLocks = new Map();
    // Ephemeral Codex threads are reusable only while this adapter owns the
    // live app-server connection. A new runtime must never resume an old
    // ephemeral thread (or accidentally fall back to a legacy persistent one).
    this.ephemeralRuntimeId = randomUUID();
    this.lastRateLimits = null;
    this.lastRateLimitsAt = 0;
    this.rateLimitsStale = false;
    this.rateLimitsLoading = null;
    this.accountRead = false;
    this.accountReading = null;
    this.rateLimitListeners = new Set();
    this.rpc.on("stderr", (line) => this.logger.debug?.(`codex app-server: ${String(line).trim()}`));
    this.rpc.on("exit", () => {
      this.ephemeralRuntimeId = randomUUID();
      this.initialized = false;
      this.initializing = null;
      this.accountRead = false;
      this.accountReading = null;
    });
    this.rateLimitNotification = (frame) => this.#applyRateLimitNotification(frame);
    this.rpc.on("notification", this.rateLimitNotification);
  }

  providerInfo(provider) { return { id: provider, name: PROVIDER_NAME }; }
  providerRetryPolicy() { return { mode: "normal", maxRetries: 0, retryableCodes: ["turn-failed"], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }; }

  onRateLimits(listener) {
    this.rateLimitListeners.add(listener);
    return () => this.rateLimitListeners.delete(listener);
  }

  reconfigure(nextConfig = {}, previousConfig = {}) {
    const nextBin = nextConfig.codexBin || "codex";
    const previousBin = previousConfig.codexBin || "codex";
    this.models = null;
    this.modelDetails.clear();
    this.modelFetchedAt = 0;
    this.lastRateLimits = null;
    this.lastRateLimitsAt = 0;
    this.rateLimitsStale = false;
    if (nextBin === previousBin) return;
    this.connectionEpoch += 1;
    this.ephemeralRuntimeId = randomUUID();
    this.hub?.dispose();
    this.hub = null;
    this.initialized = false;
    this.initializing = null;
    this.accountRead = false;
    this.accountReading = null;
    this.versionChecked = false;
    this.rpc.codexBin = nextBin;
    if (typeof this.rpc.reopen === "function") this.rpc.reopen({ codexBin: nextBin, env: this.rpc.env });
  }

  #resetTransportAfterInitializationFailure(epoch) {
    if (epoch !== this.connectionEpoch) return;
    this.initialized = false;
    this.accountRead = false;
    this.accountReading = null;
    this.hub?.dispose();
    this.hub = null;
    if (typeof this.rpc.reopen === "function") {
      try {
        this.rpc.reopen({ codexBin: this.config().codexBin || "codex", env: this.rpc.env });
      } catch (error) {
        this.logger.warn?.(`llm-codex-appserver: failed to reset RPC after initialization failure: ${error.message}`);
      }
    }
  }

  #publishRateLimits() {
    for (const listener of [...this.rateLimitListeners]) {
      try { listener(this.lastRateLimits); } catch (error) { this.logger.warn?.(`llm-codex-appserver rate-limit listener failed: ${error.message}`); }
    }
  }

  async #checkVersion() {
    if (this.versionChecked) return;
    const bin = this.config().codexBin || "codex";
    let version;
    try { version = await this.versionReader(bin, this.rpc.env); }
    catch (error) { throw asLlmError(error, "codex-not-found"); }
    const allowMismatch = process.env.NODE_ENV === "development" && process.env.DSH_CODEX_ALLOW_PROTOCOL_MISMATCH === "1";
    if (version !== EXPECTED_CODEX_VERSION && !allowMismatch) {
      throw new LlmError(`Codex protocol mismatch: expected ${EXPECTED_CODEX_VERSION}, got ${version ?? "unknown"}`, "protocol-mismatch");
    }
    this.versionChecked = true;
  }

  async #ensureReady() {
    await this.#checkVersion();
    if (this.initialized) return;
    if (this.initializing) return await this.initializing;
    const epoch = this.connectionEpoch;
    const initialization = (async () => {
      this.rpc.codexBin = this.config().codexBin || "codex";
      const response = await this.rpc.request("initialize", {
        clientInfo: { name: "dsh-codex-appserver", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, { timeoutMs: 15_000 });
      if (epoch !== this.connectionEpoch) throw new LlmError("Codex app-server was reconfigured during initialization", "startup-failed");
      if (response.error) throw new LlmError(response.error.message ?? "Codex initialize failed", "startup-failed");
      await this.rpc.notify("initialized", {});
      if (epoch !== this.connectionEpoch) throw new LlmError("Codex app-server was reconfigured during initialization", "startup-failed");
      this.hub ??= new NotificationHub(this.rpc);
      this.initialized = true;
      this.rpc.markHealthy?.();
    })();
    this.initializing = initialization;
    try { await initialization; }
    catch (error) {
      this.#resetTransportAfterInitializationFailure(epoch);
      throw asLlmError(error, "startup-failed");
    }
    finally {
      if (this.initializing === initialization) this.initializing = null;
    }
  }

  async listModels(provider = PROVIDER) {
    if (provider !== PROVIDER) return [];
    const now = Date.now();
    if (this.models && now - this.modelFetchedAt < 300_000) return this.models;
    try {
      await this.#ensureReady();
      const models = [];
      const seenCursors = new Set();
      let cursor = null;
      do {
        if (cursor !== null && seenCursors.has(cursor)) throw new Error("model/list repeated a cursor");
        if (cursor !== null) seenCursors.add(cursor);
        const response = await this.rpc.request("model/list", { cursor }, { timeoutMs: 15_000 });
        if (response.error) throw new Error(response.error.message ?? "model/list failed");
        for (const model of response.result?.data ?? []) {
          this.modelDetails.set(String(model.id), model);
          models.push({ provider, id: String(model.id), name: String(model.displayName ?? model.id), ...(typeof model.description === "string" ? { description: model.description } : {}), ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities } : {}), ...(Array.isArray(model.serviceTiers) ? { serviceTiers: model.serviceTiers } : {}) });
        }
        cursor = response.result?.nextCursor ?? null;
      } while (cursor !== null);
      this.models = models;
      this.modelFetchedAt = now;
      return models;
    } catch (error) {
      this.logger.warn?.(`llm-codex-appserver: model list unavailable: ${error.message}`);
      return this.models ?? [];
    }
  }

  async #ensureAccountRead() {
    if (this.accountRead) return;
    if (this.accountReading) return await this.accountReading;
    this.accountReading = (async () => {
      await this.#ensureReady();
      const response = await this.rpc.request("account/read", {}, { timeoutMs: 15_000 });
      if (response.error) {
        const code = isExplicitReauthSignal(response) ? "reauth-required" : "account-unavailable";
        throw new LlmError(response.error.message ?? "Codex account unavailable", code);
      }
      if (isExplicitReauthSignal(response)) throw new LlmError("Codex account authentication is required", "reauth-required");
      this.accountRead = true;
    })();
    try { await this.accountReading; }
    finally { this.accountReading = null; }
  }

  async resolveModel(provider, model, signal) {
    const models = await this.listModels(provider);
    signal?.throwIfAborted?.();
    const hit = models.find((entry) => entry.id === model) ?? { provider, id: model, name: model, inputModalities: ["text"] };
    const source = this.modelDetails.get(model);
    const efforts = source?.supportedReasoningEfforts?.map((item) => ({ id: item.reasoningEffort, name: item.reasoningEffort, description: item.description })) ?? [];
    return { ...hit, ...(efforts.length > 0 ? { reasoning: { efforts, defaultEffort: source.defaultReasoningEffort } } : {}) };
  }

  async getRateLimits({ force = false } = {}) {
    const config = this.config();
    const now = Date.now();
    if (!force && !this.rateLimitsStale && this.lastRateLimits && now - this.lastRateLimitsAt < config.rateLimitRefreshSec * 1000) return this.lastRateLimits;
    if (this.rateLimitsLoading) return await this.rateLimitsLoading;
    this.rateLimitsLoading = (async () => {
      await this.#ensureAccountRead();
      const response = await this.rpc.request("account/rateLimits/read", {}, { timeoutMs: 15_000 });
      if (response.error) {
        const code = isExplicitReauthSignal(response) ? "reauth-required" : "rate-limits-unavailable";
        throw new LlmError(response.error.message ?? "Codex rate limits unavailable", code);
      }
      const buckets = Object.fromEntries(normalizeRateLimits(response.result).map((entry) => [entry.limitId, entry]));
      this.lastRateLimits = Object.freeze({
        state: "available",
        updatedAt: new Date().toISOString(),
        source: "account/rateLimits/read",
        buckets: Object.freeze(buckets),
      });
      this.lastRateLimitsAt = Date.now();
      this.rateLimitsStale = false;
      this.#publishRateLimits();
      return this.lastRateLimits;
    })();
    try { return await this.rateLimitsLoading; }
    catch (error) {
      const normalized = asLlmError(error, "rate-limits-unavailable");
      const state = normalized.code === "reauth-required" ? "reauth-required" : this.lastRateLimits ? "stale" : "unavailable";
      const previous = this.lastRateLimits;
      const snapshot = Object.freeze({
        state,
        updatedAt: previous?.updatedAt ?? null,
        source: previous?.source ?? "none",
        buckets: Object.freeze(previous?.buckets ?? {}),
        error: Object.freeze({
          code: normalized.code,
          retryable: normalized.failure?.retryable ?? true,
        }),
      });
      this.lastRateLimits = snapshot;
      this.lastRateLimitsAt = 0;
      this.rateLimitsStale = true;
      this.#publishRateLimits();
      return snapshot;
    }
    finally { this.rateLimitsLoading = null; }
  }

  #applyRateLimitNotification(frame) {
    if (frame.method !== "account/rateLimits/updated") return;
    const patch = frame.params?.rateLimits;
    const limitId = patch?.limitId;
    if (typeof limitId !== "string" || !limitId) {
      this.rateLimitsStale = true;
      this.lastRateLimitsAt = 0;
      if (this.lastRateLimits) {
        this.lastRateLimits = Object.freeze({ ...this.lastRateLimits, state: "stale", error: Object.freeze({ code: "rate-limits-unavailable", retryable: true }) });
        this.#publishRateLimits();
      }
      return;
    }
    if (limitId !== "codex") return;
    if (!this.lastRateLimits) {
      const first = { limitId, limitName: "Codex" };
      this.lastRateLimits = Object.freeze({
        state: "available",
        updatedAt: new Date().toISOString(),
        source: "notification",
        buckets: Object.freeze({ codex: { ...mergeRateLimitSnapshot(first, patch), limitId, limitName: "Codex" } }),
      });
      this.lastRateLimitsAt = Date.now();
      this.rateLimitsStale = false;
      this.#publishRateLimits();
      return;
    }
    const buckets = { ...this.lastRateLimits.buckets };
    const previous = buckets[limitId] ?? { limitId, limitName: limitId };
    buckets[limitId] = { ...mergeRateLimitSnapshot(previous, patch), limitId, limitName: "Codex" };
    this.lastRateLimits = Object.freeze({
      state: "available",
      updatedAt: new Date().toISOString(),
      source: "notification",
      buckets: Object.freeze(buckets),
    });
    this.lastRateLimitsAt = Date.now();
    this.rateLimitsStale = false;
    this.#publishRateLimits();
  }

  async status() {
    try {
      await this.#ensureReady();
      return { available: true, code: null, message: null };
    } catch (error) {
      const normalized = asLlmError(error, "startup-failed");
      return { available: false, code: normalized.code, message: normalized.message };
    }
  }

  #lockFor(locks, key) {
    let lock = locks.get(key);
    if (!lock) { lock = new AsyncMutex(); locks.set(key, lock); }
    return lock;
  }

  #workspace(options, sessionId) {
    const supplied = options.workspace ?? options.cwd ?? options.session?.header?.cwd ?? this.workspaceResolver?.(sessionId) ?? process.cwd();
    return assertAbsoluteDirectory(supplied);
  }

  async #saveThreadEntry(sessionId, entry, config) {
    const ephemeral = config.ephemeralThreads === true;
    return await this.threadmap.set(sessionId, {
      ...entry,
      ephemeral,
      runtimeId: ephemeral ? this.ephemeralRuntimeId : null,
    });
  }

  async #loadThreadEntry(sessionId, config) {
    const entry = await this.threadmap.get(sessionId);
    if (!entry) return null;
    const wantsEphemeral = config.ephemeralThreads === true;
    const entryIsEphemeral = entry.ephemeral === true;
    const sameRuntime = entry.runtimeId === this.ephemeralRuntimeId;

    if (wantsEphemeral === entryIsEphemeral && (!wantsEphemeral || sameRuntime)) return entry;

    // Never silently resubmit a turn whose old thread cannot be safely
    // resumed. This also protects the first request after upgrading from the
    // old persistent-thread implementation.
    if (entry.inFlight) {
      throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown");
    }
    return null;
  }

  async #recoverInFlight(sessionId, entry, config) {
    const inFlight = entry.inFlight;
    if (!inFlight) return { kind: "none", entry };
    if (!inFlight.turnId || inFlight.state === "starting") throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown");
    let response;
    try { response = await this.rpc.request("thread/read", { threadId: entry.threadId, includeTurns: true }, { timeoutMs: 15_000 }); }
    catch (error) { throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown", { cause: error }); }
    if (response.error || !response.result?.thread) throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown");
    const turn = (response.result.thread.turns ?? []).find((candidate) => candidate.id === inFlight.turnId);
    if (!turn) throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown");
    if (turn.status === "completed") {
      const updated = await this.#saveThreadEntry(sessionId, {
        ...entry,
        inFlight: { ...inFlight, state: "completed" },
        usageState: "missing",
      }, config);
      return { kind: "completed", entry: updated, text: completionText(turn) };
    }
    if (turn.status === "inProgress") {
      const updated = await this.#saveThreadEntry(sessionId, {
        ...entry,
        inFlight: { ...inFlight, state: "running" },
      }, config);
      return { kind: "running", entry: updated, turnId: inFlight.turnId };
    }
    const checkpoint = { ...entry, inFlight: null, lastTurnStatus: turn.status };
    const updated = await this.#saveThreadEntry(sessionId, checkpoint, config);
    if (turn.status === "interrupted") return { kind: "interrupted", entry: updated };
    if (turn.status === "failed") return { kind: "failed", entry: updated, message: turn.error?.message ?? "Codex turn failed" };
    throw new LlmError("Codex turn state unknown; refusing to resubmit", "turn-state-unknown");
  }

  async #imageInput(block, signal) {
    const reference = block?.attachment;
    if (!reference || typeof reference !== "object" || typeof reference.attachmentId !== "string" || !reference.mediaType) {
      throw attachmentError("Codex image input must reference a DSH attachment");
    }
    if (typeof this.attachments?.readImage !== "function") {
      throw attachmentError("DSH attachment storage is unavailable", undefined, "enable-attachment-store");
    }
    let stored;
    try {
      stored = await this.attachments.readImage(reference, signal);
    } catch (error) {
      throw attachmentError(`Codex image attachment could not be read: ${error.message}`, error);
    }
    const data = stored?.data;
    const mediaType = stored?.ref?.mediaType ?? reference.mediaType;
    if (!(data instanceof Uint8Array) || typeof mediaType !== "string" || !/^image\/(?:png|jpe?g|webp|gif)$/.test(mediaType)) {
      throw attachmentError("DSH attachment returned invalid image bytes");
    }
    return { type: "image", url: `data:${mediaType};base64,${Buffer.from(data).toString("base64")}` };
  }

  async #buildInputs(messages, signal) {
    const inputs = [];
    const messageIds = [];
    for (const message of messages) {
      for (const block of message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          inputs.push({ type: "text", text: block.text });
          messageIds.push(String(message.id ?? ""));
        } else if (block?.type === "image") {
          inputs.push(await this.#imageInput(block, signal));
          messageIds.push(String(message.id ?? ""));
        }
      }
    }
    return { inputs, messageIds };
  }

  async *stream(options) {
    const sessionId = String(options.sessionId ?? "anonymous");
    const releaseSession = await this.#lockFor(this.sessionLocks, sessionId).acquire();
    let releaseThread;
    try {
      const config = this.config();
      const entry = options.purpose ? null : await this.#loadThreadEntry(sessionId, config);
      const lockKey = entry?.threadId ? `thread:${entry.threadId}` : `session:${sessionId}`;
      releaseThread = await this.#lockFor(this.threadLocks, lockKey).acquire();
      yield* this.#streamLocked(options, sessionId, config);
    }
    catch (error) { throw asLlmError(error); }
    finally {
      releaseThread?.();
      releaseSession();
    }
  }

  async *#streamLocked(options, sessionId, config) {
    await this.#ensureReady();
    const cwd = this.#workspace(options, sessionId);
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const userMessages = messages.filter((message) => message.role === "user" && !isToolMessage(message) && hasProviderInput(message));
    const latest = userMessages.at(-1);
    if (!latest) throw new LlmError("Codex turn has no user message", "turn-failed");
    let serviceTier;
    const hasImages = userMessages.some((message) => imageBlocksOf(message).length > 0);
    if (config.fastMode === true || hasImages) {
      await this.listModels(PROVIDER);
      const model = this.modelDetails.get(String(options.model));
      if (Array.isArray(model?.serviceTiers) && model.serviceTiers.some((tier) => (typeof tier === "string" ? tier : tier?.id) === "priority")) serviceTier = "priority";
      if (hasImages && (!Array.isArray(model?.inputModalities) || !model.inputModalities.includes("image"))) {
        throw attachmentError("Selected Codex model does not advertise image input", undefined, "select-image-capable-model");
      }
    }
    let entry = options.purpose ? null : await this.#loadThreadEntry(sessionId, config);
    let recoveredCompletedWithoutUsage = false;
    let recoveredRunning = false;
    let recoveredTurnId = null;
    if (entry?.inFlight) {
      const recovery = await this.#recoverInFlight(sessionId, entry, config);
      entry = recovery.entry;
      const recoveredUserMessageId = entry.inFlight?.clientUserMessageId ?? entry.checkpointUserMsgId;
      if (recovery.kind === "completed" && latest.id === recoveredUserMessageId) {
        if (recovery.text) yield { type: "text-delta", index: 0, text: recovery.text };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      if (recovery.kind === "completed") recoveredCompletedWithoutUsage = true;
      if (recovery.kind === "running") {
        if (String(latest.id) !== String(recoveredUserMessageId)) {
          throw new LlmError("Codex has an active turn; refusing to submit a newer message", "turn-state-unknown");
        }
        recoveredRunning = true;
        recoveredTurnId = recovery.turnId;
      }
      if (recovery.kind === "interrupted" && latest.id === entry.checkpointUserMsgId) {
        yield { type: "finish", reason: { kind: "aborted", failure: failure("Codex turn interrupted", "ABORTED") } };
        return;
      }
      if (recovery.kind === "failed" && latest.id === entry.checkpointUserMsgId) {
        yield { type: "finish", reason: { kind: "error", failure: failure(recovery.message, "turn-failed") } };
        return;
      }
    }
    const latestIndex = messages.findLastIndex((message) => message.id === latest.id);
    const historyBeforeLatest = messages.slice(0, Math.max(0, latestIndex));
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && !isToolMessage(message));
    const checkpointIndex = entry?.checkpointUserMsgId ? userMessages.findIndex((message) => message.id === entry.checkpointUserMsgId) : -1;
    const checkpointConsistent = !entry?.checkpointUserMsgId || (checkpointIndex >= 0 && (!entry.checkpointUserHash || entry.checkpointUserHash === userSequenceHash(userMessages.slice(0, checkpointIndex + 1))));
    const providerSwitched = Boolean(entry && lastAssistant?.source?.provider && lastAssistant.source.provider !== PROVIDER);
    const continuityMismatch = Boolean(entry?.continuityHash && latest.id !== entry.checkpointUserMsgId && entry.continuityHash !== messageSequenceHash(historyBeforeLatest));
    let memory = { hash: null, text: null };
    if (config.injectMemory) {
      try {
        const snapshot = await this.memoryLoader();
        if (typeof snapshot?.text === "string" && snapshot.text.length > 0 && typeof snapshot.hash === "string") memory = { hash: snapshot.hash, text: snapshot.text };
      } catch (error) {
        this.logger.warn?.(`llm-codex-appserver: memory context was disabled: ${error.message}`);
      }
    }
    const memoryChanged = Boolean(entry && entry.memorySnapshotHash !== memory.hash);
    const newThread = !recoveredRunning && Boolean(options.purpose || !entry || providerSwitched || memoryChanged || !checkpointConsistent || continuityMismatch || recoveredCompletedWithoutUsage);
    const epoch = newThread ? (entry?.providerEpoch ?? 0) + 1 : entry.providerEpoch;
    const newUsers = !entry || newThread ? userMessages : userMessages.slice(checkpointIndex + 1);
    if (!recoveredRunning && !newThread && newUsers.length === 0) {
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const builtInputs = recoveredRunning ? { inputs: [], messageIds: [] } : await this.#buildInputs(newThread ? [latest] : newUsers, options.signal);
    const inputs = builtInputs.inputs;
    if (newThread) {
      const transcript = historyTranscript(historyBeforeLatest, config.historyBootstrap);
      if (transcript) {
        const firstText = inputs.findIndex((input) => input.type === "text");
        if (firstText >= 0) inputs[firstText].text = `${transcript}\n\nCurrent request:\n${inputs[firstText].text}`;
        else { inputs.unshift({ type: "text", text: `${transcript}\n\nCurrent request:` }); builtInputs.messageIds.unshift(String(latest.id ?? "")); }
      }
    }
    let threadId = entry?.threadId;
    const ephemeral = config.ephemeralThreads === true || Boolean(options.purpose);
    if (newThread) {
      const response = await this.rpc.request("thread/start", {
        model: options.model,
        sandbox: config.sandbox,
        approvalPolicy: "never",
        cwd,
        ephemeral,
      }, { signal: options.signal, timeoutMs: config.requestTimeoutMs });
      if (response.error || !response.result?.thread?.id) throw new LlmError(response.error?.message ?? "Codex thread/start failed", "turn-failed");
      threadId = response.result.thread.id;
    } else if (!ephemeral) {
      const response = await this.rpc.request("thread/resume", { threadId, model: options.model, sandbox: config.sandbox, approvalPolicy: "never", cwd }, { signal: options.signal, timeoutMs: config.requestTimeoutMs });
      if (response.error) throw new LlmError(response.error.message ?? "Codex thread/resume failed", "turn-failed");
    }
    const nextCheckpointHash = userSequenceHash(userMessages);
    const inFlight = recoveredRunning
      ? entry.inFlight
      : { state: "starting", turnId: null, messageIds: builtInputs.messageIds, clientUserMessageId: String(latest.id), checkpointUserHash: nextCheckpointHash, startedAt: new Date().toISOString() };
    let persisted = entry;
    if (!options.purpose && !recoveredRunning) {
      persisted = await this.#saveThreadEntry(sessionId, {
        providerEpoch: epoch,
        threadId,
        model: options.model,
        checkpointUserMsgId: entry?.checkpointUserMsgId ?? null,
        checkpointUserHash: entry?.checkpointUserHash ?? null,
        continuityHash: newThread ? null : entry?.continuityHash ?? null,
        memorySnapshotHash: memory.hash,
        inFlight,
      }, config);
    }
    let turnId = recoveredTurnId;
    if (!recoveredRunning) {
      let started;
      try {
        started = await this.rpc.request("turn/start", {
          threadId,
          input: inputs,
          model: options.model,
          effort: options.reasoningEffort ?? null,
          clientUserMessageId: String(latest.id),
          approvalPolicy: "never",
          cwd,
          sandboxPolicy: sandboxPolicy(config.sandbox, cwd),
          ...(serviceTier ? { serviceTier } : {}),
          ...(memory.text ? { additionalContext: { "dpsk-memory": { kind: "untrusted", value: memory.text } } } : {}),
        }, { signal: options.signal, timeoutMs: config.requestTimeoutMs });
      } catch (error) {
        if (error?.code === "aborted" || options.signal?.aborted) {
          yield { type: "finish", reason: { kind: "aborted", failure: failure("Codex turn aborted before its id was known", "ABORTED") } };
          return;
        }
        throw asLlmError(error);
      }
      turnId = started.result?.turn?.id;
      if (started.error || !turnId) {
        if (!options.purpose) await this.#saveThreadEntry(sessionId, { ...persisted, inFlight: null }, config);
        throw new LlmError(started.error?.message ?? "Codex turn/start failed", "turn-failed");
      }
      if (!options.purpose) persisted = await this.#saveThreadEntry(sessionId, { ...persisted, inFlight: { ...inFlight, state: "running", turnId } }, config);
    }
    let completion = null;
    let usage = null;
    let usageYielded = false;
    let visibleText = false;
    let streamedText = "";
    let completedText = "";
    let interrupting = null;
    const interrupt = () => {
      interrupting ??= this.rpc.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => {});
      return interrupting;
    };
    const onAbort = () => { void interrupt(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) await interrupt();
      while (!completion) {
        let frame;
        try {
        frame = await this.hub.next((candidate) => {
          if (candidate.params?.threadId !== threadId) return false;
          if (candidate.method === "turn/completed") return candidate.params?.turn?.id === turnId;
          return candidate.params?.turnId === turnId;
        }, { signal: options.signal, timeoutMs: config.requestTimeoutMs });
        } catch (error) {
          if (error?.code === "aborted" || options.signal?.aborted) {
            await interrupt();
            yield { type: "finish", reason: { kind: "aborted", failure: failure("Codex turn aborted", "ABORTED") } };
            return;
          }
          throw asLlmError(error);
        }
        const validation = validateNotification(frame.method, frame.params);
        if (!validation.ok) throw new LlmError(`Invalid Codex notification: ${frame.method}`, "turn-failed");
        if (frame.method === "item/agentMessage/delta") { visibleText = true; streamedText += frame.params.delta; yield { type: "text-delta", index: 0, text: frame.params.delta }; continue; }
        if (frame.method === "item/reasoning/summaryTextDelta" || frame.method === "item/reasoning/textDelta") { yield { type: "reasoning-delta", index: 1, text: frame.params.delta }; continue; }
        if (frame.method === "thread/tokenUsage/updated") { usage = mapTokenUsage(frame.params.tokenUsage); if (usage && !usageYielded) { usageYielded = true; yield { type: "usage", usage }; } continue; }
        if (frame.method === "item/completed" && frame.params.item?.type === "agentMessage") completedText += completedItemText(frame.params.item);
        if (frame.method === "turn/completed") completion = frame.params.turn;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    const assistantText = visibleText ? streamedText : completedText;
    if (!visibleText && assistantText) yield { type: "text-delta", index: 0, text: assistantText };
    if (completion.status === "completed") {
      if (!usage) {
        try {
          const frame = await this.hub.next((candidate) => candidate.method === "thread/tokenUsage/updated" && candidate.params?.threadId === threadId && candidate.params?.turnId === turnId, { timeoutMs: 500 });
          usage = mapTokenUsage(frame.params.tokenUsage);
        } catch {}
      }
      if (usage && !usageYielded) yield { type: "usage", usage };
      if (!options.purpose) {
        const settled = usage
          ? {
            ...persisted,
            checkpointUserMsgId: latest.id,
            checkpointUserHash: nextCheckpointHash,
            continuityHash: assistantText ? messageSequenceHash([...normalMessages(messages), { role: "assistant", content: [{ type: "text", text: assistantText }] }]) : null,
            inFlight: null,
            usageState: "received",
          }
          : { ...persisted, inFlight: { ...inFlight, state: "completed", turnId }, usageState: "missing" };
        await this.#saveThreadEntry(sessionId, settled, config);
      }
      void this.getRateLimits().catch(() => {});
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (!options.purpose) await this.#saveThreadEntry(sessionId, { ...persisted, checkpointUserMsgId: latest.id, checkpointUserHash: nextCheckpointHash, inFlight: null, lastTurnStatus: completion.status }, config);
    if (completion.status === "interrupted") {
      yield { type: "finish", reason: { kind: "aborted", failure: failure("Codex turn interrupted", "ABORTED") } };
      return;
    }
    yield { type: "finish", reason: { kind: "error", failure: failure(completion.error?.message ?? "Codex turn failed", "turn-failed") } };
  }

  dispose() {
    this.hub?.dispose();
    this.rpc.off("notification", this.rateLimitNotification);
    this.rpc.close();
  }
}

export { DEFAULT_CONFIG, normalizeConfig };
