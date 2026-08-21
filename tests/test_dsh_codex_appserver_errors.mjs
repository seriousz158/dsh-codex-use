import assert from "node:assert/strict";
import { LlmError } from "@deepseek-ai/dsh-llm";
import {
  CODEX_ERROR_CODES,
  CodexProviderError,
  errorContext,
  isExplicitReauthSignal,
  normalizeCodexError,
  serializeCodexError,
} from "../packages/dsh-codex-appserver/lib/errors.js";

const required = [
  "codex-not-found", "startup-failed", "protocol-mismatch", "account-unavailable", "timeout",
  "rate-limits-unavailable", "threadmap-corrupt", "protocol-error", "provider-conflict", "reauth-required",
];
for (const code of required) {
  assert.ok(CODEX_ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(errorContext(code)).sort(), ["action", "code", "retryable", "stage"]);
}

const conflict = normalizeCodexError(new Error("duplicate"), "provider-conflict");
assert.ok(conflict instanceof CodexProviderError);
assert.equal(conflict.code, "provider-conflict");
assert.equal(conflict.stage, "registration");
assert.equal(conflict.action, "remove-duplicate-provider");
assert.equal(conflict.retryable, false);
assert.deepEqual(serializeCodexError({ code: "not-known" }, "timeout"), errorContext("timeout"));

const attachmentFailure = new LlmError("attachment failed", "protocol-error");
attachmentFailure.failure = Object.freeze({
  ...attachmentFailure.failure,
  stage: "attachment",
  action: "check-attachment",
  retryable: false,
});
assert.deepEqual(serializeCodexError(attachmentFailure), {
  code: "protocol-error",
  stage: "attachment",
  action: "check-attachment",
  retryable: false,
});

assert.equal(isExplicitReauthSignal({ result: { requiresOpenaiAuth: true } }), true);
assert.equal(isExplicitReauthSignal({ error: { code: "authentication_required" } }), true);
assert.equal(isExplicitReauthSignal({ error: { code: "network_error", message: "auth endpoint unavailable" } }), false);

console.log("dsh-codex app-server error model tests passed");
