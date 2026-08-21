import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter, MAX_HISTORY_TRANSCRIPT_CHARS } from "../packages/dsh-codex-appserver/lib/adapter.js";
import { CodexAppServerService } from "../packages/dsh-codex-appserver/lib/ratelimits.js";
import { ThreadMapStore } from "../packages/dsh-codex-appserver/lib/threadmap.js";

class FakeRpc extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.requests = [];
    this.notifications = [];
    this.env = { PATH: process.env.PATH };
  }

  async request(method, params = {}, options = {}) {
    this.requests.push({ method, params, options });
    return await this.handler(method, params, options, this);
  }

  async notify(method, params = {}) { this.notifications.push({ method, params }); }
  close() {}
}

function user(id, text) {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function assistant(id, text, provider = "deepseek-official") {
  return { id, role: "assistant", source: { provider }, content: [{ type: "text", text }] };
}

assert.match(Function.prototype.toString.call(CodexAppServerService.prototype.rateLimits), /async rateLimits\(request\)/, "SRC remote methods must not use default parameters");

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function emitCompleted(client, { threadId, turnId, text = "done", usage = true }) {
  queueMicrotask(() => {
    client.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: `${turnId}-message`, delta: text },
    });
    if (usage) {
      client.emit("notification", {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: { cachedInputTokens: 0, inputTokens: 3, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 8 },
            total: { cachedInputTokens: 0, inputTokens: 3, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 8 },
          },
        },
      });
    }
    client.emit("notification", {
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
    });
  });
}

const workspace = await mkdtemp(join(tmpdir(), "dsh-codex-contract-workspace-"));
const memoryStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-memory-map-")), "threads.json"));
const memoryRpc = new FakeRpc(async (method, _params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "memory-thread" } } };
  if (method === "turn/start") {
    emitCompleted(client, { threadId: "memory-thread", turnId: "memory-turn", text: "memory answer" });
    return { result: { turn: { id: "memory-turn" } } };
  }
  if (method === "account/rateLimits/read") return { result: { rateLimits: { limitId: "codex", primary: { usedPercent: 1 } } } };
  throw new Error(`unexpected memory request ${method}`);
});
const memoryAdapter = new CodexAppServerAdapter({
  rpc: memoryRpc,
  threadmap: memoryStore,
  skipVersionCheck: true,
  workspaceResolver: (sessionId) => sessionId === "memory-session" ? workspace : null,
  memoryLoader: async () => ({ hash: "memory-hash-1", text: "[DPSK MEMORY: UNTRUSTED CONTEXT]\nproject fact\n[END DPSK MEMORY]" }),
  config: { sandbox: "workspace-write", injectMemory: true, requestTimeoutMs: 30_000 },
});
const memoryChunks = await collect(memoryAdapter.stream({
  sessionId: "memory-session",
  model: "model-1",
  messages: [assistant("memory-a0", "prior assistant conclusion"), user("memory-u1", "continue the task")],
}));
assert.equal(memoryChunks.at(-1).reason.kind, "stop");
const memoryThreadStart = memoryRpc.requests.find((request) => request.method === "thread/start");
const memoryTurnStart = memoryRpc.requests.find((request) => request.method === "turn/start");
assert.equal(memoryThreadStart.params.cwd, workspace, "a DSH session workspace must override process.cwd()");
assert.equal(memoryTurnStart.params.cwd, workspace);
assert.deepEqual(memoryTurnStart.params.sandboxPolicy.writableRoots, [workspace]);
assert.equal(Object.hasOwn(memoryThreadStart.params, "developerInstructions"), false, "memory must not become a high-priority developer instruction");
assert.deepEqual(memoryTurnStart.params.additionalContext, {
  "dpsk-memory": { kind: "untrusted", value: "[DPSK MEMORY: UNTRUSTED CONTEXT]\nproject fact\n[END DPSK MEMORY]" },
});
assert.match(memoryTurnStart.params.input[0].text, /Assistant: prior assistant conclusion/);

const rateRequests = [];
const rateRpc = new FakeRpc(async (method) => {
  rateRequests.push(method);
  if (method === "initialize") return { result: {} };
  if (method === "account/read") return { result: { account: null, requiresOpenaiAuth: false } };
  if (method === "account/rateLimits/read") {
    if (!rateRequests.includes("account/read")) {
      throw Object.assign(new Error("account/read must precede account/rateLimits/read"), { code: "internal" });
    }
    return {
      result: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 12, resetsAt: 1_800_000_000, windowDurationMins: 300 },
            secondary: { usedPercent: 4, resetsAt: 1_800_000_600, windowDurationMins: 10_080 },
          },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 0, resetsAt: 1_800_001_800, windowDurationMins: 10_080 },
          },
        },
      },
    };
  }
  throw new Error(`unexpected rate request ${method}`);
});
const rateAdapter = new CodexAppServerAdapter({ rpc: rateRpc, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
const rateSnapshots = [];
rateAdapter.onRateLimits((snapshot) => rateSnapshots.push(snapshot));
const initialLimits = await rateAdapter.getRateLimits();
assert.deepEqual(rateRequests, ["initialize", "account/read", "account/rateLimits/read"]);
assert.deepEqual(rateRpc.notifications, [{ method: "initialized", params: {} }]);
assert.deepEqual(Object.keys(initialLimits.buckets), ["codex"], "only the Codex quota bucket is exposed");
assert.equal(initialLimits.buckets.codex.primary.usedPercent, 12);
rateRpc.emit("notification", {
  method: "account/rateLimits/updated",
  params: { rateLimits: { limitId: "codex", primary: { usedPercent: 37 }, secondary: null } },
});
const mergedLimits = await rateAdapter.getRateLimits();
assert.equal(mergedLimits.buckets.codex.primary.usedPercent, 37);
assert.equal(mergedLimits.buckets.codex.primary.resetsAt, 1_800_000_000, "sparse updates retain prior metadata");
assert.equal(mergedLimits.buckets.codex.secondary.usedPercent, 4, "nullable sparse values do not erase an observed secondary bucket");
assert.ok(rateSnapshots.length >= 2);
rateRpc.emit("notification", {
  method: "account/rateLimits/updated",
  params: { rateLimits: { limitId: "codex_bengalfox", primary: { usedPercent: 1 } } },
});
assert.deepEqual(Object.keys((await rateAdapter.getRateLimits()).buckets), ["codex"], "non-Codex updates stay hidden");

const modelRpc = new FakeRpc(async (method, params) => {
  if (method === "initialize") return { result: {} };
  if (method === "model/list" && params.cursor === null) return { result: { data: [{ id: "model-a", displayName: "Model A" }], nextCursor: "next" } };
  if (method === "model/list" && params.cursor === "next") return { result: { data: [{ id: "model-b", displayName: "Model B" }], nextCursor: null } };
  throw new Error(`unexpected model request ${method}`);
});
const modelAdapter = new CodexAppServerAdapter({ rpc: modelRpc, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
assert.deepEqual((await modelAdapter.listModels()).map((model) => model.id), ["model-a", "model-b"]);
assert.equal(modelRpc.requests.filter((request) => request.method === "model/list").length, 2, "model/list must read every cursor page");

const mismatchRpc = new FakeRpc(async () => { throw new Error("a version mismatch must fail before RPC startup"); });
const mismatchAdapter = new CodexAppServerAdapter({
  rpc: mismatchRpc,
  versionReader: async () => "0.0.0",
  config: { injectMemory: false, requestTimeoutMs: 30_000 },
});
assert.deepEqual(await mismatchAdapter.status(), {
  available: false,
  code: "protocol-mismatch",
  message: "Codex protocol mismatch: expected 0.144.1, got 0.0.0",
});
assert.deepEqual(await mismatchAdapter.listModels(), []);
assert.equal(mismatchRpc.requests.length, 0);

let startupAttempts = 0;
let startupReopens = 0;
const startupFailureRpc = new FakeRpc(async (method) => {
  if (method === "initialize") {
    startupAttempts += 1;
    return startupAttempts === 1
      ? { error: { code: -32000, message: "temporary initialize failure" } }
      : { result: {} };
  }
  throw new Error(`unexpected startup request ${method}`);
});
startupFailureRpc.reopen = () => { startupReopens += 1; };
const startupFailureAdapter = new CodexAppServerAdapter({ rpc: startupFailureRpc, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
assert.equal((await startupFailureAdapter.status()).available, false);
assert.equal(startupReopens, 1, "an initialize failure must discard the old RPC process before a retry");
assert.equal((await startupFailureAdapter.status()).available, true);
assert.equal(startupAttempts, 2);

const corruptDirectory = await mkdtemp(join(tmpdir(), "dsh-codex-corrupt-map-"));
const corruptPath = join(corruptDirectory, "threads.json");
await writeFile(corruptPath, "not json", { mode: 0o600 });
const corruptRpc = new FakeRpc(async (method) => {
  if (method === "initialize") return { result: {} };
  throw new Error(`unexpected corrupt-store request ${method}`);
});
const corruptAdapter = new CodexAppServerAdapter({
  rpc: corruptRpc,
  threadmap: new ThreadMapStore(corruptPath),
  skipVersionCheck: true,
  config: { injectMemory: false, requestTimeoutMs: 30_000 },
});
let corruptError;
try {
  await collect(corruptAdapter.stream({ sessionId: "corrupt-session", model: "model-1", workspace, messages: [user("corrupt-u1", "do not expose internal storage failures")] }));
} catch (error) {
  corruptError = error;
}
assert.equal(corruptError?.code, "threadmap-corrupt", "threadmap failures must keep their stable storage error code");

const sharedThreadStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-shared-thread-map-")), "threads.json"));
for (const sessionId of ["shared-a", "shared-b"]) {
  await sharedThreadStore.set(sessionId, {
    providerEpoch: 1,
    threadId: "shared-thread",
    model: "model-1",
    checkpointUserMsgId: null,
    memorySnapshotHash: null,
    inFlight: null,
  });
}
let activeTurns = 0;
let maxActiveTurns = 0;
let sharedTurnSequence = 0;
const sharedThreadRpc = new FakeRpc(async (method, _params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/resume") return { result: { thread: { id: "shared-thread" } } };
  if (method === "turn/start") {
    const turnId = `shared-turn-${++sharedTurnSequence}`;
    activeTurns += 1;
    maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
    setTimeout(() => {
      activeTurns -= 1;
      emitCompleted(client, { threadId: "shared-thread", turnId, text: turnId });
    }, 20);
    return { result: { turn: { id: turnId } } };
  }
  throw new Error(`unexpected shared-thread request ${method}`);
});
const sharedThreadAdapter = new CodexAppServerAdapter({ rpc: sharedThreadRpc, threadmap: sharedThreadStore, skipVersionCheck: true, config: { ephemeralThreads: false, injectMemory: false, requestTimeoutMs: 30_000 } });
await Promise.all([
  collect(sharedThreadAdapter.stream({ sessionId: "shared-a", model: "model-1", workspace, messages: [user("shared-a-u1", "first turn")] })),
  collect(sharedThreadAdapter.stream({ sessionId: "shared-b", model: "model-1", workspace, messages: [user("shared-b-u1", "second turn")] })),
]);
assert.equal(maxActiveTurns, 1, "different sessions that resolve to the same Codex thread must serialize turn/start");

let memorySnapshot = { hash: "rotation-memory-a", text: "memory A" };
let rotationThreadStarts = 0;
let rotationTurns = 0;
const rotationStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-rotation-map-")), "threads.json"));
const rotationRpc = new FakeRpc(async (method, params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: `rotation-thread-${++rotationThreadStarts}` } } };
  if (method === "thread/resume") throw new Error("a changed memory snapshot must create a new Codex thread");
  if (method === "turn/start") {
    const turnId = `rotation-turn-${++rotationTurns}`;
    emitCompleted(client, { threadId: params.threadId, turnId, text: `rotation-answer-${rotationTurns}` });
    return { result: { turn: { id: turnId } } };
  }
  throw new Error(`unexpected rotation request ${method}`);
});
const rotationAdapter = new CodexAppServerAdapter({
  rpc: rotationRpc,
  threadmap: rotationStore,
  skipVersionCheck: true,
  memoryLoader: async () => memorySnapshot,
  config: { injectMemory: true, requestTimeoutMs: 30_000 },
});
await collect(rotationAdapter.stream({ sessionId: "rotation-session", model: "model-1", workspace, messages: [user("rotation-u1", "first memory turn")] }));
memorySnapshot = { hash: "rotation-memory-b", text: "memory B" };
await collect(rotationAdapter.stream({
  sessionId: "rotation-session",
  model: "model-1",
  workspace,
  messages: [user("rotation-u1", "first memory turn"), assistant("rotation-a1", "rotation-answer-1", "codex-chatgpt"), user("rotation-u2", "second memory turn")],
}));
const rotationEntry = await rotationStore.get("rotation-session");
assert.equal(rotationThreadStarts, 2, "a changed memory hash must create a new thread instead of reusing old context");
assert.equal(rotationEntry.providerEpoch, 2);
assert.equal(rotationEntry.memorySnapshotHash, "rotation-memory-b");

const cancelRpc = new FakeRpc(async (method) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "cancel-thread" } } };
  if (method === "turn/start") return { result: { turn: { id: "cancel-turn" } } };
  if (method === "turn/interrupt") return { result: {} };
  throw new Error(`unexpected cancel request ${method}`);
});
const cancelAdapter = new CodexAppServerAdapter({
  rpc: cancelRpc,
  threadmap: new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-cancel-map-")), "threads.json")),
  skipVersionCheck: true,
  config: { injectMemory: false, requestTimeoutMs: 30_000 },
});
const controller = new AbortController();
const cancelPromise = collect(cancelAdapter.stream({ sessionId: "cancel-session", model: "model-1", workspace, signal: controller.signal, messages: [user("cancel-u1", "cancel this request")] }));
setTimeout(() => controller.abort(), 20);
const cancelled = await cancelPromise;
assert.equal(cancelled.at(-1).reason.kind, "aborted");
assert.equal(cancelRpc.requests.filter((request) => request.method === "turn/interrupt").length, 1);

const filteringRpc = new FakeRpc(async (method, _params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "filter-thread" } } };
  if (method === "turn/start") {
    queueMicrotask(() => {
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "filter-thread", turnId: "other-turn", itemId: "other-item", delta: "wrong" } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "filter-thread", turn: { id: "other-turn", status: "completed", items: [] } } });
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "filter-thread", turnId: "filter-turn", itemId: "filter-item", delta: "right" } });
      client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "filter-thread", turnId: "filter-turn", tokenUsage: { last: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, total: { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "filter-thread", turn: { id: "filter-turn", status: "completed", items: [] } } });
    });
    return { result: { turn: { id: "filter-turn" } } };
  }
  throw new Error(`unexpected filtering request ${method}`);
});
const filteringAdapter = new CodexAppServerAdapter({
  rpc: filteringRpc,
  threadmap: new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-filter-map-")), "threads.json")),
  skipVersionCheck: true,
  config: { injectMemory: false, requestTimeoutMs: 30_000 },
});
const filtered = await collect(filteringAdapter.stream({ sessionId: "filter-session", model: "model-1", workspace, messages: [user("filter-u1", "filter notifications")] }));
assert.equal(filtered.find((chunk) => chunk.type === "text-delta")?.text, "right", "notifications from another turn must not leak into the current stream");

const nullBucketRequests = [];
const nullBucketRpc = new FakeRpc(async (method) => {
  nullBucketRequests.push(method);
  if (method === "initialize") return { result: {} };
  if (method === "account/read") return { result: { account: null, requiresOpenaiAuth: false } };
  if (method === "account/rateLimits/read") return {
    result: {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 23, resetsAt: 1_800_001_200, windowDurationMins: 300 },
        secondary: null,
      },
      rateLimitsByLimitId: null,
    },
  };
  throw new Error(`unexpected null-bucket request ${method}`);
});
const nullBucketAdapter = new CodexAppServerAdapter({ rpc: nullBucketRpc, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
const nullBucketLimits = await nullBucketAdapter.getRateLimits();
assert.equal(nullBucketLimits.buckets.codex.primary.usedPercent, 23, "a null multi-bucket field must retain the backward-compatible single rate limit bucket");

const longHistoryRpc = new FakeRpc(async (method, params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "long-history-thread" } } };
  if (method === "turn/start") {
    emitCompleted(client, { threadId: "long-history-thread", turnId: "long-history-turn", text: "bounded" });
    return { result: { turn: { id: "long-history-turn" } } };
  }
  throw new Error(`unexpected long-history request ${method}`);
});
const longHistoryAdapter = new CodexAppServerAdapter({
  rpc: longHistoryRpc,
  threadmap: new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-long-history-map-")), "threads.json")),
  skipVersionCheck: true,
  config: { injectMemory: false, historyBootstrap: 100, requestTimeoutMs: 30_000 },
});
const longHistoryMessages = [];
for (let index = 0; index < 60; index += 1) {
  longHistoryMessages.push(index % 2 === 0 ? user(`long-u-${index}`, `old-${index}:${"x".repeat(600)}`) : assistant(`long-a-${index}`, `old-${index}:${"y".repeat(600)}`));
}
longHistoryMessages.push(user("long-current", "the current request"));
await collect(longHistoryAdapter.stream({ sessionId: "long-history-session", model: "model-1", workspace, messages: longHistoryMessages }));
const longHistoryInput = longHistoryRpc.requests.find((request) => request.method === "turn/start").params.input[0].text;
const [longHistoryTranscript] = longHistoryInput.split("\n\nCurrent request:\n");
assert.ok(longHistoryTranscript.length <= MAX_HISTORY_TRANSCRIPT_CHARS, "provider-switch transcript must have a hard character ceiling");
assert.match(longHistoryTranscript, /Earlier conversation truncated/, "a clipped transcript must disclose truncation");
assert.match(longHistoryTranscript, /old-59:/, "a clipped transcript must preserve the newest prior context");

console.log("dsh-codex app-server adapter contract tests passed");
