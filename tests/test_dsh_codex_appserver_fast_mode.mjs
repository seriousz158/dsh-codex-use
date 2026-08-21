import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAppServerAdapter } from "../packages/dsh-codex-appserver/lib/adapter.js";
import { ThreadMapStore } from "../packages/dsh-codex-appserver/lib/threadmap.js";

class FakeRpc extends EventEmitter {
  constructor(model) { super(); this.model = model; this.requests = []; this.env = { PATH: process.env.PATH }; }
  async request(method, params = {}, options = {}) {
    this.requests.push({ method, params, options });
    if (method === "initialize") return { result: {} };
    if (method === "model/list") return { result: { data: [this.model], nextCursor: null } };
    if (method === "thread/start") return { result: { thread: { id: "fast-thread" } } };
    if (method === "turn/start") {
      queueMicrotask(() => this.emit("notification", { method: "turn/completed", params: { threadId: "fast-thread", turn: { id: "fast-turn", status: "completed", items: [] } } }));
      return { result: { turn: { id: "fast-turn" } } };
    }
    throw new Error(`unexpected method ${method}`);
  }
  async notify() {}
  close() {}
}

async function run(model, fastMode) {
  const workspace = await mkdtemp(join(tmpdir(), "dsh-codex-fast-"));
  const rpc = new FakeRpc(model);
  const adapter = new CodexAppServerAdapter({
    rpc,
    threadmap: new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-fast-map-")), "threads.json")),
    skipVersionCheck: true,
    config: { fastMode, requestTimeoutMs: 30_000 },
  });
  for await (const _chunk of adapter.stream({ sessionId: `fast-${fastMode}`, model: model.id, workspace, messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }] })) {}
  return rpc.requests.find((request) => request.method === "turn/start");
}

test("existing 0.144.1 fixture advertises priority service tier", async () => {
  const fixture = JSON.parse(await readFile(new URL("../tools/fixtures/codex-appserver-0.144.1.json", import.meta.url), "utf8"));
  const modelFrames = fixture.frames.filter((event) => event.direction === "in" && event.frame?.result?.data);
  assert.ok(modelFrames.some((event) => event.frame.result.data.some((model) => model.serviceTiers?.some((tier) => tier.id === "priority"))));
});

test("Fast Mode sends only the schema-defined turn/start serviceTier", async () => {
  const request = await run({ id: "model-fast", displayName: "Fast", serviceTiers: [{ id: "priority", name: "Fast", description: "" }] }, true);
  assert.equal(request.params.serviceTier, "priority");
  assert.equal(Object.hasOwn(request.params, "service_tier"), false);
  assert.equal(Object.hasOwn(request.params, "additionalSpeedTiers"), false);
});

test("Fast Mode is capability-gated and omitted for models without priority", async () => {
  const request = await run({ id: "model-normal", displayName: "Normal", serviceTiers: [{ id: "standard", name: "Standard", description: "" }] }, true);
  assert.equal(Object.hasOwn(request.params, "serviceTier"), false);
});

test("disabled Fast Mode never performs model capability probing", async () => {
  const request = await run({ id: "model-normal", displayName: "Normal", serviceTiers: [{ id: "priority", name: "Fast", description: "" }] }, false);
  assert.equal(Object.hasOwn(request.params, "serviceTier"), false);
});

console.log("fast mode checks passed");
