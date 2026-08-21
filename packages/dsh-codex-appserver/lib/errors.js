import { LlmError } from "@deepseek-ai/dsh-llm";

export const CODEX_ERROR_CODES = Object.freeze([
  "codex-not-found", "startup-failed", "protocol-mismatch", "account-unavailable", "timeout",
  "rate-limits-unavailable", "threadmap-corrupt", "protocol-error", "provider-conflict", "reauth-required",
  "turn-failed", "turn-state-unknown", "approval-denied", "usage-unavailable",
]);

const DEFAULT_CONTEXT = Object.freeze({
  "codex-not-found": { stage: "runtime", action: "install-codex", retryable: false },
  "startup-failed": { stage: "startup", action: "restart-app-server", retryable: true },
  "protocol-mismatch": { stage: "compatibility", action: "pin-compatible-codex", retryable: false },
  "account-unavailable": { stage: "account", action: "check-codex-account", retryable: true },
  timeout: { stage: "rpc", action: "retry-request", retryable: true },
  "rate-limits-unavailable": { stage: "quota", action: "refresh-quota", retryable: true },
  "threadmap-corrupt": { stage: "storage", action: "repair-threadmap", retryable: false },
  "protocol-error": { stage: "rpc", action: "upgrade-codex", retryable: false },
  "provider-conflict": { stage: "registration", action: "remove-duplicate-provider", retryable: false },
  "reauth-required": { stage: "account", action: "authenticate-with-codex-cli", retryable: false },
  "turn-failed": { stage: "turn", action: "retry-request", retryable: true },
  "turn-state-unknown": { stage: "turn", action: "inspect-thread-state", retryable: false },
  "approval-denied": { stage: "turn", action: "review-permission-policy", retryable: false },
  "usage-unavailable": { stage: "turn", action: "retry-request", retryable: true },
});

const EXPLICIT_REAUTH_CODES = new Set(["reauth-required", "reauth_required", "authentication_required"]);

export class CodexProviderError extends Error {
  constructor(message, code, { stage, action, retryable, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexProviderError";
    this.code = code;
    const defaults = DEFAULT_CONTEXT[code] ?? DEFAULT_CONTEXT["turn-failed"];
    this.stage = stage ?? defaults.stage;
    this.action = action ?? defaults.action;
    this.retryable = retryable ?? defaults.retryable;
  }
}

export function errorContext(code, overrides = {}) {
  const defaults = DEFAULT_CONTEXT[code] ?? DEFAULT_CONTEXT["turn-failed"];
  return Object.freeze({ code, stage: overrides.stage ?? defaults.stage, action: overrides.action ?? defaults.action, retryable: overrides.retryable ?? defaults.retryable });
}

export function serializeCodexError(error, fallbackCode = "turn-failed") {
  const fallback = CODEX_ERROR_CODES.includes(fallbackCode) ? fallbackCode : "turn-failed";
  const code = CODEX_ERROR_CODES.includes(error?.code) ? error.code : fallback;
  return errorContext(code, error ?? {});
}

export function normalizeCodexError(error, fallbackCode = "turn-failed", overrides = {}) {
  if (error instanceof CodexProviderError && !Object.keys(overrides).length) return error;
  const context = serializeCodexError({ ...error, ...overrides }, fallbackCode);
  return new CodexProviderError(error?.message ?? "Codex provider failed", context.code, { ...context, cause: error });
}

export function toLlmError(error, fallbackCode = "turn-failed", overrides = {}) {
  const normalized = normalizeCodexError(error, fallbackCode, overrides);
  const result = new LlmError(normalized.message, normalized.code, { cause: normalized });
  result.failure = Object.freeze({ ...result.failure, stage: normalized.stage, action: normalized.action, retryable: normalized.retryable });
  return result;
}

export function isExplicitReauthSignal(value) {
  if (!value || typeof value !== "object") return false;
  if (value.requiresOpenaiAuth === true || value.result?.requiresOpenaiAuth === true) return true;
  const code = value.error?.code ?? value.code;
  return typeof code === "string" && EXPLICIT_REAUTH_CODES.has(code);
}
