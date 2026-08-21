import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CodexRpc } from "../packages/dsh-codex-appserver/lib/rpc.js";
import { minimalEnvironment } from "../packages/dsh-codex-appserver/lib/protocol.js";

const fallbackEnvironment = minimalEnvironment({ PATH: "/bin", TMPDIR: "/tmp" });
assert.equal(fallbackEnvironment.HOME, homedir(), "Codex must have a native HOME under LaunchAgent");
assert.equal(fallbackEnvironment.CODEX_HOME, join(homedir(), ".codex"), "Codex must have its default CODEX_HOME under LaunchAgent");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill(signal = "SIGTERM") {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, signal);
    return true;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function wireChild(child, writes, onFrame) {
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      writes.push(frame);
      onFrame(frame, child);
    }
  });
}

function reply(child, id, result) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const secretEnv = {
  HOME: "/tmp/dsh-codex-home",
  CODEX_HOME: "/tmp/dsh-codex-home/.codex",
  PATH: process.env.PATH,
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  DEEPSEEK_API_KEY: "must-not-pass",
  OPENAI_API_KEY: "must-not-pass",
  MCP_SECRET: "must-not-pass",
};
const approvalChild = new FakeChild();
const approvalWrites = [];
let approvalSpawnOptions;
wireChild(approvalChild, approvalWrites, (frame, child) => {
  if (frame.method === "initialize") queueMicrotask(() => reply(child, frame.id, {}));
});
const approvalRpc = new CodexRpc({
  env: secretEnv,
  restartBaseMs: 0,
  spawnImpl: (_command, _args, options) => {
    approvalSpawnOptions = options;
    return approvalChild;
  },
});

await approvalRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
await approvalRpc.notify("initialized", {});
assert.deepEqual(Object.keys(approvalSpawnOptions.env).sort(), ["CODEX_HOME", "HOME", "LANG", "LC_CTYPE", "PATH", "TMPDIR"]);
assert.equal(approvalSpawnOptions.env.DEEPSEEK_API_KEY, undefined);
assert.equal(approvalSpawnOptions.env.OPENAI_API_KEY, undefined);
assert.equal(approvalSpawnOptions.env.MCP_SECRET, undefined);

const approvalRequests = [
  ["item/commandExecution/requestApproval", { itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }, { decision: "decline" }],
  ["item/fileChange/requestApproval", { itemId: "item-2", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }, { decision: "decline" }],
  ["item/permissions/requestApproval", { cwd: "/tmp", itemId: "item-3", permissions: {}, startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }, { permissions: {} }],
  ["applyPatchApproval", { callId: "call-1", conversationId: "thread-1", fileChanges: {} }, { decision: "denied" }],
  ["execCommandApproval", { callId: "call-2", command: ["pwd"], conversationId: "thread-1", cwd: "/tmp", parsedCmd: [] }, { decision: "denied" }],
];
for (const [index, [method, params, expected]] of approvalRequests.entries()) {
  const id = 100 + index;
  approvalChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  await tick();
  const response = approvalWrites.filter((frame) => frame.id === id).at(-1);
  assert.deepEqual(response, { jsonrpc: "2.0", id, result: expected }, `${method} must receive a protocol-valid denial`);
}

approvalChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, method: "unknown/request", params: {} })}\n`);
await tick();
assert.deepEqual(approvalWrites.filter((frame) => frame.id === 999).at(-1), {
  jsonrpc: "2.0",
  id: 999,
  error: { code: -32601, message: "Unsupported Codex server request: unknown/request" },
});
assert.equal(approvalRpc.child, null, "an unknown server request must close the current RPC process");

const restartChildren = [];
const restartWrites = [];
let restartCount = 0;
const restartRpc = new CodexRpc({
  env: secretEnv,
  restartBaseMs: 0,
  spawnImpl: () => {
    const child = new FakeChild();
    const generation = restartCount++;
    wireChild(child, restartWrites, (frame, activeChild) => {
      if (frame.method === "initialize") queueMicrotask(() => reply(activeChild, frame.id, {}));
      if (frame.method === "model/list" && generation > 0) queueMicrotask(() => reply(activeChild, frame.id, { data: [], nextCursor: null }));
    });
    restartChildren.push(child);
    return child;
  },
});
await restartRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
const pending = restartRpc.request("model/list", { cursor: null });
await tick();
restartChildren[0].emit("exit", 1, null);
await assert.rejects(pending, (error) => error?.code === "aborted");
const recovered = await restartRpc.request("model/list", { cursor: null });
assert.deepEqual(recovered.result, { data: [], nextCursor: null });
assert.equal(restartChildren.length, 2, "the next request must lazily spawn exactly one replacement process");

const reopenedChildren = [];
const reopenedCommands = [];
const reopenRpc = new CodexRpc({
  codexBin: "codex-one",
  env: secretEnv,
  restartBaseMs: 0,
  spawnImpl: (command) => {
    reopenedCommands.push(command);
    const child = new FakeChild();
    wireChild(child, [], (frame, activeChild) => {
      if (frame.method === "initialize") queueMicrotask(() => reply(activeChild, frame.id, {}));
    });
    reopenedChildren.push(child);
    return child;
  },
});
await reopenRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
reopenRpc.reopen({ codexBin: "codex-two", env: secretEnv });
await reopenRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
assert.deepEqual(reopenedCommands, ["codex-one", "codex-two"], "reopen must replace the executable for the next lazy start");

// Reconfiguration must invalidate an asynchronous restart that is already sleeping.
// The old start promise must not be allowed to spawn a second process after reopen().
const racingCommands = [];
const racingChildren = [];
const racingRpc = new CodexRpc({
  codexBin: "codex-race-old",
  env: secretEnv,
  restartBaseMs: 25,
  spawnImpl: (command) => {
    racingCommands.push(command);
    const child = new FakeChild();
    wireChild(child, [], (frame, activeChild) => {
      if (frame.method === "initialize") queueMicrotask(() => reply(activeChild, frame.id, {}));
    });
    racingChildren.push(child);
    return child;
  },
});
await racingRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
racingChildren[0].emit("exit", 1, null);
const staleStart = racingRpc.start();
await tick();
racingRpc.reopen({ codexBin: "codex-race-new", env: secretEnv });
await assert.rejects(staleStart, (error) => error?.code === "aborted", "a stale start must be invalidated by reopen");
await racingRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
assert.deepEqual(racingCommands, ["codex-race-old", "codex-race-new"], "reopen must prevent a stale start from spawning another child");

// A malformed response must fail closed instead of being handed to the adapter.
const malformedChild = new FakeChild();
wireChild(malformedChild, [], (frame, activeChild) => {
  if (frame.method === "model/list") queueMicrotask(() => activeChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { data: "not-an-array" } })}\n`));
});
const malformedRpc = new CodexRpc({
  env: secretEnv,
  spawnImpl: () => malformedChild,
});
await assert.rejects(
  malformedRpc.request("model/list", { cursor: null }),
  (error) => error?.code === "protocol-error",
  "a malformed model/list response must be rejected as a protocol error",
);
assert.equal(malformedRpc.child, null, "a malformed response must close the affected RPC process");

// codex-cli 0.144.1 emits response frames without the optional jsonrpc member.
// Keep that observed wire form compatible while still validating the result body.
const observedEnvelopeChild = new FakeChild();
wireChild(observedEnvelopeChild, [], (frame, activeChild) => {
  if (frame.method === "initialize") queueMicrotask(() => activeChild.stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`));
});
const observedEnvelopeRpc = new CodexRpc({ env: secretEnv, spawnImpl: () => observedEnvelopeChild });
const observedEnvelopeResponse = await observedEnvelopeRpc.request("initialize", {
  clientInfo: { name: "dsh-codex-appserver-test", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
assert.deepEqual(observedEnvelopeResponse, { id: 1, result: {} }, "the observed Codex response envelope remains accepted");

approvalRpc.close();
restartRpc.close();
reopenRpc.close();
racingRpc.close();
malformedRpc.close();
observedEnvelopeRpc.close();
console.log("dsh-codex app-server RPC tests passed");
