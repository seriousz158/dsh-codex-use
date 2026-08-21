import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../packages/dsh-codex-appserver/lib/adapter.js";
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
  notify(method, params = {}) { this.notifications.push({ method, params }); }
  close() { this.closed = true; }
}

function user(id, text) {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function assistant(id, text, provider = "deepseek") {
  return { id, role: "assistant", source: { provider }, content: [{ type: "text", text }] };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const workspace = await mkdtemp(join(tmpdir(), "dsh-codex-workspace-"));
const store = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-map-")), "threads.json"));
const rpc = new FakeRpc(async (method, params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "thread-1" } } };
  if (method === "turn/start") {
    queueMicrotask(() => {
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" } });
      client.emit("notification", { method: "item/reasoning/textDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", contentIndex: 0, delta: "reason" } });
      client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, reasoningOutputTokens: 4, totalTokens: 10 }, total: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1, reasoningOutputTokens: 4, totalTokens: 10 } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    });
    return { result: { turn: { id: "turn-1" } } };
  }
  throw new Error(`unexpected request ${method}`);
});

const adapter = new CodexAppServerAdapter({
  rpc,
  threadmap: store,
  skipVersionCheck: true,
  config: { sandbox: "workspace-write", injectMemory: false, requestTimeoutMs: 30_000 },
});

const chunks = await collect(adapter.stream({
  sessionId: "session-1",
  model: "model-1",
  workspace,
  messages: [assistant("a0", "existing answer"), user("u1", "new request")],
}));
assert.deepEqual(chunks.map((chunk) => chunk.type), ["text-delta", "reasoning-delta", "usage", "finish"]);
assert.equal(chunks.at(-1).reason.kind, "stop");
assert.equal(rpc.requests.find((request) => request.method === "thread/start").params.cwd, workspace);
assert.equal(rpc.requests.find((request) => request.method === "turn/start").params.cwd, workspace);
assert.deepEqual(rpc.requests.find((request) => request.method === "turn/start").params.sandboxPolicy.writableRoots, [workspace]);
assert.equal(rpc.requests.filter((request) => request.method === "turn/start").length, 1);
assert.equal(chunks.some((chunk) => chunk.type === "tool-call-delta"), false);

const testSubagentChunks = await collect(adapter.stream({
  sessionId: "test-subagent-session",
  model: "model-1",
  workspace,
  messages: [user("subagent-u1", "run an isolated test task")],
}));
assert.equal(testSubagentChunks.at(-1).reason.kind, "stop");
const createdThreads = rpc.requests.filter((request) => request.method === "thread/start");
assert.equal(createdThreads.length, 2, "a main DSH chat and a test subagent must each create their own Codex thread");
assert.ok(createdThreads.every((request) => request.params.ephemeral === true), "all DSH-created Codex threads must be ephemeral by default, including test subagent sessions");
assert.equal((await store.get("session-1"))?.ephemeral, true, "the local thread map must mark a DSH chat as ephemeral so it is never resumed as a persistent Codex history");

const legacyPrivacyStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-legacy-privacy-map-")), "threads.json"));
await legacyPrivacyStore.set("legacy-privacy-session", {
  providerEpoch: 1,
  threadId: "legacy-persistent-thread",
  model: "model-1",
  checkpointUserMsgId: "privacy-u1",
  checkpointUserHash: null,
  memorySnapshotHash: null,
  inFlight: null,
});
let privacyThreadSequence = 0;
let privacyTurnSequence = 0;
const privacyRpc = new FakeRpc(async (method, params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: `privacy-thread-${++privacyThreadSequence}` } } };
  if (method === "thread/resume") throw new Error("privacy mode must never resume a legacy persistent Codex thread");
  if (method === "turn/start") {
    const turnId = `privacy-turn-${++privacyTurnSequence}`;
    queueMicrotask(() => {
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId, itemId: `${turnId}-message`, delta: "private answer" } });
      client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage: { last: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 }, total: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed", items: [] } } });
    });
    return { result: { turn: { id: turnId } } };
  }
  throw new Error(`unexpected privacy request ${method}`);
});
const privacyAdapter = new CodexAppServerAdapter({ rpc: privacyRpc, threadmap: legacyPrivacyStore, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
await collect(privacyAdapter.stream({ sessionId: "legacy-privacy-session", model: "model-1", workspace, messages: [user("privacy-u1", "first private request")] }));
assert.equal(privacyRpc.requests.filter((request) => request.method === "thread/resume").length, 0, "privacy mode must ignore legacy persistent mappings");
assert.equal(privacyRpc.requests.find((request) => request.method === "thread/start").params.ephemeral, true);
assert.equal((await legacyPrivacyStore.get("legacy-privacy-session"))?.ephemeral, true, "privacy mode must replace only the active mapping with an ephemeral one");

const restartPrivacyRpc = new FakeRpc(async (method, params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/start") return { result: { thread: { id: "privacy-thread-after-restart" } } };
  if (method === "thread/resume") throw new Error("a restarted DSH provider must not resume an ephemeral thread");
  if (method === "turn/start") {
    queueMicrotask(() => {
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: "privacy-turn-after-restart", itemId: "privacy-restart-message", delta: "fresh private answer" } });
      client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId: "privacy-turn-after-restart", tokenUsage: { last: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 }, total: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: params.threadId, turn: { id: "privacy-turn-after-restart", status: "completed", items: [] } } });
    });
    return { result: { turn: { id: "privacy-turn-after-restart" } } };
  }
  throw new Error(`unexpected restart privacy request ${method}`);
});
const restartedPrivacyAdapter = new CodexAppServerAdapter({ rpc: restartPrivacyRpc, threadmap: legacyPrivacyStore, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
await collect(restartedPrivacyAdapter.stream({ sessionId: "legacy-privacy-session", model: "model-1", workspace, messages: [user("privacy-u1", "first private request"), user("privacy-u2", "second private request")] }));
assert.equal(restartPrivacyRpc.requests.filter((request) => request.method === "thread/resume").length, 0, "privacy mode must start a fresh ephemeral thread after a provider restart");
assert.equal(restartPrivacyRpc.requests.find((request) => request.method === "thread/start").params.ephemeral, true);

const legacyInFlightStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-legacy-inflight-map-")), "threads.json"));
await legacyInFlightStore.set("legacy-inflight-session", {
  providerEpoch: 1,
  threadId: "legacy-inflight-thread",
  model: "model-1",
  checkpointUserMsgId: null,
  checkpointUserHash: null,
  memorySnapshotHash: null,
  inFlight: { state: "running", turnId: "legacy-inflight-turn", clientUserMessageId: "legacy-inflight-u1", messageIds: ["legacy-inflight-u1"] },
});
const legacyInFlightRpc = new FakeRpc(async () => { throw new Error("an uncertain legacy turn must not touch Codex again"); });
const legacyInFlightAdapter = new CodexAppServerAdapter({ rpc: legacyInFlightRpc, threadmap: legacyInFlightStore, skipVersionCheck: true, config: { injectMemory: false, requestTimeoutMs: 30_000 } });
await assert.rejects(
  collect(legacyInFlightAdapter.stream({ sessionId: "legacy-inflight-session", model: "model-1", workspace, messages: [user("legacy-inflight-u1", "never duplicate this turn")] })),
  (error) => error?.code === "turn-state-unknown",
);
assert.equal(legacyInFlightRpc.requests.length, 0, "an uncertain legacy turn must not be resumed or submitted after privacy mode is enabled");

const recoveryStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-recovery-")), "threads.json"));
await recoveryStore.set("session-recovery", {
  providerEpoch: 1,
  threadId: "thread-old",
  model: "model-1",
  checkpointUserMsgId: null,
  memorySnapshotHash: null,
  inFlight: { turnId: "turn-old", clientUserMessageId: "u-old", messageIds: ["u-old"], state: "running" },
});
let recoveryTurnStarts = 0;
const recoveryRpc = new FakeRpc(async (method) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/read") return { result: { thread: { id: "thread-old", turns: [{ id: "turn-old", status: "completed", items: [] }] } } };
  if (method === "turn/start") { recoveryTurnStarts += 1; return { result: { turn: { id: "unexpected" } } }; }
  throw new Error(`unexpected recovery request ${method}`);
});
const recoveryAdapter = new CodexAppServerAdapter({ rpc: recoveryRpc, threadmap: recoveryStore, skipVersionCheck: true, config: { ephemeralThreads: false, injectMemory: false, requestTimeoutMs: 30_000 } });
const recovered = await collect(recoveryAdapter.stream({ sessionId: "session-recovery", model: "model-1", workspace, messages: [user("u-old", "do not submit twice")] }));
assert.equal(recoveryTurnStarts, 0, "a completed in-flight turn must never be submitted again");
assert.equal(recovered.at(-1).type, "finish");
assert.equal(recovered.at(-1).reason.kind, "stop");

const unknownStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-unknown-")), "threads.json"));
await unknownStore.set("session-unknown", {
  providerEpoch: 1,
  threadId: "thread-unknown",
  model: "model-1",
  checkpointUserMsgId: null,
  memorySnapshotHash: null,
  inFlight: { turnId: "turn-unknown", clientUserMessageId: "u-unknown", messageIds: ["u-unknown"], state: "running" },
});
let unknownTurnStarts = 0;
const unknownRpc = new FakeRpc(async (method) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/read") return { result: { thread: { id: "thread-unknown", turns: [] } } };
  if (method === "thread/resume") return { result: { thread: { id: "thread-unknown" } } };
  if (method === "turn/start") { unknownTurnStarts += 1; throw new Error("must not resubmit an uncertain turn"); }
  throw new Error(`unexpected unknown-state request ${method}`);
});
const unknownAdapter = new CodexAppServerAdapter({ rpc: unknownRpc, threadmap: unknownStore, skipVersionCheck: true, config: { ephemeralThreads: false, injectMemory: false, requestTimeoutMs: 30_000 } });
let unknownError;
try {
  await collect(unknownAdapter.stream({ sessionId: "session-unknown", model: "model-1", workspace, messages: [user("u-unknown", "never charge twice")] }));
} catch (error) {
  unknownError = error;
}
assert.equal(unknownTurnStarts, 0, "an in-flight turn absent from thread/read is uncertain, not a resend signal");
assert.equal(unknownError?.code, "turn-state-unknown");

const runningStore = new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-running-")), "threads.json"));
await runningStore.set("session-running", {
  providerEpoch: 1,
  threadId: "thread-running",
  model: "model-1",
  checkpointUserMsgId: null,
  memorySnapshotHash: null,
  inFlight: { turnId: "turn-running", clientUserMessageId: "u-running", messageIds: ["u-running"], state: "running" },
});
let runningTurnStarts = 0;
const runningRpc = new FakeRpc(async (method, _params, _options, client) => {
  if (method === "initialize") return { result: {} };
  if (method === "thread/read") return { result: { thread: { id: "thread-running", turns: [{ id: "turn-running", status: "inProgress", items: [] }] } } };
  if (method === "thread/resume") {
    queueMicrotask(() => {
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread-running", turnId: "turn-running", itemId: "item-running", delta: "resumed" } });
      client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "thread-running", turnId: "turn-running", tokenUsage: { last: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3 }, total: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3 } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "thread-running", turn: { id: "turn-running", status: "completed", items: [] } } });
    });
    return { result: { thread: { id: "thread-running" } } };
  }
  if (method === "turn/start") { runningTurnStarts += 1; throw new Error("a running turn must be resumed, not submitted again"); }
  throw new Error(`unexpected running recovery request ${method}`);
});
const runningAdapter = new CodexAppServerAdapter({ rpc: runningRpc, threadmap: runningStore, skipVersionCheck: true, config: { ephemeralThreads: false, injectMemory: false, requestTimeoutMs: 30_000 } });
const runningRecovered = await collect(runningAdapter.stream({ sessionId: "session-running", model: "model-1", workspace, messages: [user("u-running", "resume this turn")] }));
assert.equal(runningTurnStarts, 0, "an accepted in-flight turn must not be submitted twice");
assert.deepEqual(runningRecovered.map((chunk) => chunk.type), ["text-delta", "usage", "finish"]);
assert.equal(runningRecovered.at(-1).reason.kind, "stop");

console.log("dsh-codex app-server adapter tests passed");
