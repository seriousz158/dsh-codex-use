import assert from "node:assert/strict";
import test from "node:test";

import { preflightProviderConflicts } from "../packages/dsh-codex-appserver/lib/index.js";

test("provider preflight fails closed with a stable provider-conflict error", () => {
  let warning = "";
  const ctx = {
    llm: {
      listProviders: () => [{ id: "codex-chatgpt", name: "existing" }],
      listConfigurableProviders: () => [{ provider: "dsh-codex" }],
    },
    logger: { warn: (message) => { warning = message; } },
  };
  assert.throws(() => preflightProviderConflicts(ctx), (error) => {
    assert.equal(error.code, "provider-conflict");
    assert.equal(error.failure.stage, "registration");
    assert.equal(error.failure.action, "remove-duplicate-provider");
    assert.equal(error.failure.retryable, false);
    assert.match(error.message, /remove the duplicate|migrate/i);
    return true;
  });
  assert.match(warning, /dsh-codex/);
});

test("provider preflight accepts an empty registry", () => {
  const result = preflightProviderConflicts({ llm: { listProviders: () => [], listConfigurableProviders: () => [] } });
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.soft, []);
});

console.log("provider conflict checks passed");
