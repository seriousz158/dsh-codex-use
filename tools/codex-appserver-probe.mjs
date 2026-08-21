#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
export const EXPECTED_CODEX_VERSION = "0.144.1";
export const PROBE_METHODS = Object.freeze(new Set([
  "initialize",
  "initialized",
  "account/read",
  "account/rateLimits/read",
  "model/list",
]));
const REDACT_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential|auth|email|codexhome|home(dir|path)?|accountid|userid|workspaceid|organizationid|deviceid|machineid|installationid|servername|useragent/i;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const DEFAULT_TIMEOUT_MS = 10_000;
const SENSITIVE_ID_ANCESTORS = new Set(["account", "user", "workspace", "organization", "device", "machine", "installation"]);
const PATH_KEY = /^(?:path|cwd|root|home|directory|dir)$/i;

function sanitizeString(value) {
  if (EMAIL_VALUE.test(value)) return "[REDACTED]";
  const home = homedir();
  if (home && (value === home || value.startsWith(`${home}/`))) return "[REDACTED_PATH]";
  return value;
}

export function sanitizeFrame(value, ancestors = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeFrame(item, ancestors));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      REDACT_KEY.test(key) || (key === "id" && ancestors.some((ancestor) => SENSITIVE_ID_ANCESTORS.has(ancestor)))
        ? "[REDACTED]"
        : PATH_KEY.test(key) && typeof child === "string"
          ? "[REDACTED_PATH]"
        : sanitizeFrame(child, [...ancestors, key]),
    ]));
  }
  return typeof value === "string" ? sanitizeString(value) : value;
}

export function assertProbeMethod(method) {
  if (!PROBE_METHODS.has(method)) throw new Error(`probe method not allowed: ${method}`);
}

export function assertReadOnlyTrace(frames) {
  for (const event of frames) {
    if (event?.direction !== "out") continue;
    const method = event?.frame?.method;
    assertProbeMethod(method);
    if (method.startsWith("thread/") || method.startsWith("turn/")) {
      throw new Error(`probe emitted a prohibited method: ${method}`);
    }
  }
}

export function minimalEnvironment(env = process.env) {
  const next = {
    HOME: env.HOME ?? homedir(),
    PATH: env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    TMPDIR: env.TMPDIR,
    LANG: env.LANG,
    CODEX_HOME: env.CODEX_HOME,
  };
  return Object.fromEntries(Object.entries(next).filter(([, value]) => typeof value === "string" && value.length > 0));
}

function versionFromText(text) {
  const match = String(text).match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export async function resolveCodexVersion(codexBin = process.env.CODEX_BIN || "codex") {
  const { stdout, stderr } = await execFile(codexBin, ["--version"], { encoding: "utf8", env: minimalEnvironment() });
  return versionFromText(`${stdout}\n${stderr}`);
}

class ProbeRpc {
  constructor(child, frames) {
    this.child = child;
    this.frames = frames;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.on("exit", (code, signal) => {
      for (const reject of this.pending.values()) reject(new Error(`codex app-server exited (${code ?? "signal:" + signal})`));
      this.pending.clear();
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (error) { throw new Error(`invalid JSON-RPC frame: ${error.message}`); }
      this.frames.push({ direction: "in", frame: sanitizeFrame(frame), at: new Date().toISOString() });
      if (frame.id !== undefined && this.pending.has(frame.id)) {
        this.pending.get(frame.id)(frame);
        this.pending.delete(frame.id);
      }
    }
  }

  send(method, params = {}) {
    assertProbeMethod(method);
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    this.frames.push({ direction: "out", frame: sanitizeFrame(frame), at: new Date().toISOString() });
    this.child.stdin.write(JSON.stringify(frame) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
    });
  }

  notify(method, params = {}) {
    assertProbeMethod(method);
    const frame = { jsonrpc: "2.0", method, params };
    this.frames.push({ direction: "out", frame: sanitizeFrame(frame), at: new Date().toISOString() });
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
}

export async function runProbe({ codexBin = process.env.CODEX_BIN || "codex", outputDir = process.env.DSH_CODEX_PROBE_OUT } = {}) {
  const version = await resolveCodexVersion(codexBin);
  if (version !== EXPECTED_CODEX_VERSION) throw new Error(`codex protocol fixture requires ${EXPECTED_CODEX_VERSION}; found ${version ?? "unknown"}`);
  const targetDir = outputDir
    ? resolve(outputDir)
    : await mkdtemp(join(tmpdir(), "dsh-codex-appserver-probe-"));
  await mkdir(targetDir, { recursive: true });
  const frames = [];
  const child = spawn(codexBin, ["app-server", "--stdio"], { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new ProbeRpc(child, frames);
  try {
    const initialize = await rpc.send("initialize", {
      clientInfo: { name: "dsh-codex-appserver-probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    if (initialize.error) throw new Error(`initialize failed: ${initialize.error.message ?? "unknown error"}`);
    rpc.notify("initialized", {});
    const account = await rpc.send("account/read", {});
    if (account.error) throw new Error(`account/read failed: ${account.error.message ?? "unknown error"}`);
    const rateLimits = await rpc.send("account/rateLimits/read", {});
    if (rateLimits.error) throw new Error(`account/rateLimits/read failed: ${rateLimits.error.message ?? "unknown error"}`);
    const models = [];
    let cursor = null;
    do {
      const page = await rpc.send("model/list", { cursor });
      if (page.error) throw new Error(`model/list failed: ${page.error.message ?? "unknown error"}`);
      models.push(...(page.result?.data ?? []));
      cursor = page.result?.nextCursor ?? null;
    } while (cursor !== null);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    assertReadOnlyTrace(frames);
    const observedRateLimitUpdate = frames.some((event) => event?.direction === "in" && event?.frame?.method === "account/rateLimits/updated");
    const fixture = {
      fixtureVersion: 1,
      codexCliVersion: version,
      protocolVersion: initialize.result?.protocolVersion ?? initialize.result?.serverInfo?.version ?? `codex-app-server/${version}`,
      generatedAt: new Date().toISOString(),
      probe: { methods: ["initialize", "account/read", "account/rateLimits/read", "model/list"], modelCount: models.length, observedRateLimitUpdate },
      frames,
    };
    const output = join(targetDir, `codex-appserver-${version}.json`);
    await writeFile(output, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    return { output, fixture };
  } finally {
    child.kill("SIGTERM");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runProbe().then(({ output }) => console.log(output)).catch((error) => { console.error(`codex-appserver-probe: ${error.message}`); process.exitCode = 1; });
}
