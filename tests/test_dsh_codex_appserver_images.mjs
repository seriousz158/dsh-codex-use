import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
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
    if (method === "thread/start") return { result: { thread: { id: "image-thread" } } };
    if (method === "turn/start") {
      queueMicrotask(() => this.emit("notification", { method: "turn/completed", params: { threadId: "image-thread", turn: { id: "image-turn", status: "completed", items: [] } } }));
      return { result: { turn: { id: "image-turn" } } };
    }
    throw new Error(`unexpected method ${method}`);
  }
  async notify() {}
  close() {}
}

const ref = { attachmentId: "image-1", mediaType: "image/png", bytes: 3, width: 1, height: 1 };

async function makeAdapter({ model, attachments }) {
  const rpc = new FakeRpc(model);
  const workspace = await mkdtemp(join(tmpdir(), "dsh-codex-image-workspace-"));
  const adapter = new CodexAppServerAdapter({
    rpc,
    attachments,
    threadmap: new ThreadMapStore(join(await mkdtemp(join(tmpdir(), "dsh-codex-image-map-")), "threads.json")),
    skipVersionCheck: true,
    config: { requestTimeoutMs: 30_000 },
  });
  return { adapter, rpc, workspace };
}

test("local DSH image attachments become schema-valid Codex image inputs", async () => {
  const reads = [];
  const { adapter, rpc, workspace } = await makeAdapter({
    model: { id: "vision-model", displayName: "Vision", inputModalities: ["text", "image"], serviceTiers: [] },
    attachments: { readImage: async (value, signal) => { reads.push({ value, signal }); return { ref, data: new Uint8Array([1, 2, 3]) }; } },
  });
  for await (const _chunk of adapter.stream({
    sessionId: "image-session",
    model: "vision-model",
    workspace,
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", attachment: ref }] }],
  })) {}
  const turn = rpc.requests.find((request) => request.method === "turn/start");
  assert.deepEqual(turn.params.input.map((item) => item.type), ["text", "image"]);
  assert.equal(turn.params.input[1].url, "data:image/png;base64,AQID");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].value, ref);
});

test("image input fails closed when the selected model lacks image capability", async () => {
  const { adapter, rpc, workspace } = await makeAdapter({
    model: { id: "text-model", displayName: "Text", inputModalities: ["text"], serviceTiers: [] },
    attachments: { readImage: async () => ({ ref, data: new Uint8Array([1]) }) },
  });
  await assert.rejects(
    (async () => { for await (const _chunk of adapter.stream({ sessionId: "unsupported-image", model: "text-model", workspace, messages: [{ id: "u1", role: "user", content: [{ type: "image", attachment: ref }] }] })) {} })(),
    (error) => error?.code === "protocol-error" && error.failure?.stage === "attachment",
  );
  assert.equal(rpc.requests.some((request) => request.method === "turn/start"), false);
});

test("remote URLs and path-like image blocks are rejected without network access", async () => {
  let reads = 0;
  const { adapter, workspace } = await makeAdapter({
    model: { id: "vision-model", displayName: "Vision", inputModalities: ["text", "image"], serviceTiers: [] },
    attachments: { readImage: async () => { reads += 1; return { ref, data: new Uint8Array([1]) }; } },
  });
  await assert.rejects(
    (async () => { for await (const _chunk of adapter.stream({ sessionId: "remote-image", model: "vision-model", workspace, messages: [{ id: "u1", role: "user", content: [{ type: "image", url: "https://example.invalid/image.png" }] }] })) {} })(),
    (error) => error?.code === "protocol-error" && error.failure?.stage === "attachment",
  );
  assert.equal(reads, 0);
});

console.log("image input checks passed");
