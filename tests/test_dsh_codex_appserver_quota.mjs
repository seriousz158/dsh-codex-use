import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CodexAppServerAdapter } from "../packages/dsh-codex-appserver/lib/adapter.js";

class FakeRpc extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.requests = []; this.env = { PATH: process.env.PATH }; }
  async request(method, params = {}, options = {}) { this.requests.push({ method, params, options }); return await this.handler(method, params, options, this); }
  async notify() {}
  close() {}
}

function adapterFor(handler) {
  return new CodexAppServerAdapter({
    rpc: new FakeRpc(handler),
    skipVersionCheck: true,
    config: { requestTimeoutMs: 30_000, rateLimitRefreshSec: 15 },
  });
}

test("account/read failures use account-unavailable and expose an unavailable quota snapshot", async () => {
  const adapter = adapterFor(async (method) => {
    if (method === "initialize") return { result: {} };
    if (method === "account/read") return { error: { code: -32001, message: "account endpoint unavailable" } };
    throw new Error(`unexpected method ${method}`);
  });
  const snapshot = await adapter.getRateLimits({ force: true });
  assert.equal(snapshot.state, "unavailable");
  assert.equal(snapshot.source, "none");
  assert.equal(snapshot.error.code, "account-unavailable");
  assert.equal(snapshot.error.retryable, true);
});

test("refresh failures preserve a previous snapshot as stale", async () => {
  let refreshes = 0;
  const adapter = adapterFor(async (method) => {
    if (method === "initialize") return { result: {} };
    if (method === "account/read") return { result: { account: null, requiresOpenaiAuth: false } };
    if (method === "account/rateLimits/read") {
      refreshes += 1;
      if (refreshes > 1) return { error: { code: -32002, message: "quota temporarily unavailable" } };
      return { result: { rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 20 } } } } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const first = await adapter.getRateLimits({ force: true });
  assert.equal(first.state, "available");
  const second = await adapter.getRateLimits({ force: true });
  assert.equal(second.state, "stale");
  assert.equal(second.buckets.codex.primary.usedPercent, 20);
  assert.equal(second.error.code, "rate-limits-unavailable");
});

test("malformed rate-limit notifications mark an observed snapshot stale", async () => {
  const rpc = new FakeRpc(async (method) => {
    if (method === "initialize") return { result: {} };
    if (method === "account/read") return { result: { account: null, requiresOpenaiAuth: false } };
    if (method === "account/rateLimits/read") return { result: { rateLimits: { limitId: "codex", primary: { usedPercent: 10 } } } };
    throw new Error(`unexpected method ${method}`);
  });
  const adapter = new CodexAppServerAdapter({ rpc, skipVersionCheck: true, config: { requestTimeoutMs: 30_000 } });
  await adapter.getRateLimits({ force: true });
  rpc.emit("notification", { method: "account/rateLimits/updated", params: { rateLimits: {} } });
  const snapshot = adapter.lastRateLimits;
  assert.equal(snapshot.state, "stale");
  assert.equal(snapshot.error.code, "rate-limits-unavailable");
});

test("explicit authentication signal is reauth-required, not a generic network error", async () => {
  const adapter = adapterFor(async (method) => {
    if (method === "initialize") return { result: {} };
    if (method === "account/read") return { result: { requiresOpenaiAuth: true } };
    throw new Error(`unexpected method ${method}`);
  });
  const snapshot = await adapter.getRateLimits({ force: true });
  assert.equal(snapshot.state, "reauth-required");
  assert.equal(snapshot.error.code, "reauth-required");
});

console.log("quota checks passed");
