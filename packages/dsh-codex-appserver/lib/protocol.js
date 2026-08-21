import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPATIBILITY, EXPECTED_CODEX_VERSION } from "./compatibility.js";

export const PROVIDER = "codex-chatgpt";
export const PROVIDER_NAME = "OpenAI Codex（ChatGPT）";
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_NOTIFICATION_QUEUE = 512;
export { COMPATIBILITY, EXPECTED_CODEX_VERSION };

const protocolDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "protocol");
const schemaCache = new Map();
const notificationSchemas = Object.freeze({
  "item/agentMessage/delta": "v2/AgentMessageDeltaNotification.json",
  "item/reasoning/summaryTextDelta": "v2/ReasoningSummaryTextDeltaNotification.json",
  "item/reasoning/textDelta": "v2/ReasoningTextDeltaNotification.json",
  "item/completed": "v2/ItemCompletedNotification.json",
  "thread/tokenUsage/updated": "v2/ThreadTokenUsageUpdatedNotification.json",
  "turn/completed": "v2/TurnCompletedNotification.json",
  "account/rateLimits/updated": "v2/AccountRateLimitsUpdatedNotification.json",
});
const clientRequestSchemas = Object.freeze({
  "thread/start": "v2/ThreadStartParams.json",
  "thread/resume": "v2/ThreadResumeParams.json",
  "thread/read": "v2/ThreadReadParams.json",
  "model/list": "v2/ModelListParams.json",
  "turn/start": "v2/TurnStartParams.json",
  "turn/interrupt": "v2/TurnInterruptParams.json",
});
const clientResponseSchemas = Object.freeze({
  "account/read": "v2/GetAccountResponse.json",
  "account/rateLimits/read": "v2/GetAccountRateLimitsResponse.json",
  "model/list": "v2/ModelListResponse.json",
  "thread/start": "v2/ThreadStartResponse.json",
  "thread/resume": "v2/ThreadResumeResponse.json",
  "thread/read": "v2/ThreadReadResponse.json",
  "turn/start": "v2/TurnStartResponse.json",
  "turn/interrupt": "v2/TurnInterruptResponse.json",
});
const serverRequestSchemas = Object.freeze({
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams.json",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalParams.json",
  "item/permissions/requestApproval": "PermissionsRequestApprovalParams.json",
  applyPatchApproval: "ApplyPatchApprovalParams.json",
  execCommandApproval: "ExecCommandApprovalParams.json",
});
const approvalResponseSchemas = Object.freeze({
  "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalResponse.json",
  "item/fileChange/requestApproval": "FileChangeRequestApprovalResponse.json",
  "item/permissions/requestApproval": "PermissionsRequestApprovalResponse.json",
  applyPatchApproval: "ApplyPatchApprovalResponse.json",
  execCommandApproval: "ExecCommandApprovalResponse.json",
});

export const KNOWN_NOTIFICATIONS = Object.freeze(new Set(Object.keys(notificationSchemas)));

function loadSchema(relativePath) {
  const cached = schemaCache.get(relativePath);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(resolve(protocolDirectory, relativePath), "utf8"));
  schemaCache.set(relativePath, parsed);
  return parsed;
}

function jsonTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolveReference(reference, root) {
  if (!reference.startsWith("#/")) throw new Error(`unsupported JSON Schema reference: ${reference}`);
  return reference.slice(2).split("/").reduce((value, segment) => value?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function schemaCheck(schema, value, root, path, errors, depth = 0) {
  if (depth > 80) {
    errors.push(`${path}: schema recursion limit exceeded`);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const target = resolveReference(schema.$ref, root);
    if (!target) errors.push(`${path}: unresolved schema reference ${schema.$ref}`);
    else schemaCheck(target, value, root, path, errors, depth + 1);
    return;
  }
  if (schema.not) {
    const nested = [];
    schemaCheck(schema.not, value, root, path, nested, depth + 1);
    if (nested.length === 0) errors.push(`${path}: matches a forbidden schema`);
  }
  if (schema.allOf) for (const candidate of schema.allOf) schemaCheck(candidate, value, root, path, errors, depth + 1);
  if (schema.anyOf) {
    const matches = schema.anyOf.some((candidate) => {
      const nested = [];
      schemaCheck(candidate, value, root, path, nested, depth + 1);
      return nested.length === 0;
    });
    if (!matches) errors.push(`${path}: does not match any allowed schema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      const nested = [];
      schemaCheck(candidate, value, root, path, nested, depth + 1);
      return nested.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path}: matches ${matches} oneOf schemas`);
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: does not equal the required constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) errors.push(`${path}: is not an allowed enum value`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => jsonTypeMatches(value, type))) {
      errors.push(`${path}: expected ${types.join("|")}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) schemaCheck(schema.items, value[index], root, `${path}[${index}]`, errors, depth + 1);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) schemaCheck(child, value[key], root, `${path}.${key}`, errors, depth + 1);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) if (!known.has(key)) errors.push(`${path}.${key}: additional property is not allowed`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, child] of Object.entries(value)) if (!known.has(key)) schemaCheck(schema.additionalProperties, child, root, `${path}.${key}`, errors, depth + 1);
    }
  }
}

export function validateJsonSchema(schema, value) {
  const errors = [];
  schemaCheck(schema, value, schema, "$", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, code: "schema-invalid", errors: errors.slice(0, 3) };
}

function validateMappedSchema(mapping, method, value, kind) {
  const relativePath = mapping[method];
  if (!relativePath) return { ok: false, code: `unknown-${kind}` };
  try { return validateJsonSchema(loadSchema(relativePath), value); }
  catch (error) { return { ok: false, code: "schema-unavailable", errors: [error.message] }; }
}

export function validateClientRequest(method, params) {
  if (method === "initialize") {
    return params?.capabilities?.experimentalApi === true && typeof params?.clientInfo?.name === "string"
      ? { ok: true }
      : { ok: false, code: "schema-invalid", errors: ["initialize requires clientInfo and experimentalApi=true"] };
  }
  if (method === "initialized" || method === "account/read" || method === "account/rateLimits/read") {
    return params && typeof params === "object" && !Array.isArray(params) && Object.keys(params).length === 0
      ? { ok: true }
      : { ok: false, code: "schema-invalid", errors: [`${method} accepts no parameters`] };
  }
  return validateMappedSchema(clientRequestSchemas, method, params, "client-request");
}

export function validateResponse(method, frame) {
  if (!frame || frame.id === undefined || (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0")) {
    return { ok: false, code: "schema-invalid", errors: ["Codex response must contain id and may only use jsonrpc=2.0 when present"] };
  }
  const hasResult = Object.hasOwn(frame, "result");
  const hasError = Object.hasOwn(frame, "error");
  if (hasResult === hasError) {
    return { ok: false, code: "schema-invalid", errors: ["JSON-RPC response must contain exactly one of result or error"] };
  }
  if (hasError) {
    const error = frame.error;
    if (!error || typeof error !== "object" || Array.isArray(error) || !Number.isInteger(error.code) || typeof error.message !== "string") {
      return { ok: false, code: "schema-invalid", errors: ["JSON-RPC error response has an invalid error object"] };
    }
    return { ok: true };
  }
  if (!clientResponseSchemas[method]) return { ok: true };
  return validateMappedSchema(clientResponseSchemas, method, frame.result, "client-response");
}

export function validateNotification(method, params) {
  return validateMappedSchema(notificationSchemas, method, params, "notification");
}

export function validateServerRequest(method, params) {
  return validateMappedSchema(serverRequestSchemas, method, params, "server-request");
}

export function validateApprovalResponse(method, response) {
  return validateMappedSchema(approvalResponseSchemas, method, response, "approval-response");
}

export function minimalEnvironment(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : resolve(home, ".codex");
  const allowed = {
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: env.PATH,
    TMPDIR: env.TMPDIR,
    LANG: env.LANG,
  };
  for (const [key, value] of Object.entries(env)) if (key.startsWith("LC_")) allowed[key] = value;
  return Object.fromEntries(Object.entries(allowed).filter(([, value]) => typeof value === "string" && value.length > 0));
}

export function parseCodexVersion(text) {
  return String(text).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function assertAbsoluteDirectory(cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/") || !existsSync(resolve(cwd))) throw new Error(`invalid Codex cwd: ${cwd}`);
  return resolve(cwd);
}

export function sandboxPolicy(mode, cwd) {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "workspace-write") return { type: "workspaceWrite", networkAccess: false, writableRoots: [cwd] };
  throw new Error(`unsupported Codex sandbox: ${mode}`);
}

export function approvalResponse(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "item/permissions/requestApproval") return { permissions: {} };
  if (method === "applyPatchApproval" || method === "execCommandApproval") return { decision: "denied" };
  throw new Error(`unsupported Codex approval request: ${method}`);
}

export function mapTokenUsage(value) {
  const last = value?.last ?? value;
  if (!last || !Number.isFinite(last.inputTokens) || !Number.isFinite(last.outputTokens)) return null;
  return {
    inputTokens: Math.max(0, Number(last.inputTokens)),
    outputTokens: Math.max(0, Number(last.outputTokens)),
    ...(Number.isFinite(last.cachedInputTokens) ? { cacheReadTokens: Math.max(0, Number(last.cachedInputTokens)) } : {}),
    ...(Number.isFinite(last.reasoningOutputTokens) ? { reasoningTokens: Math.max(0, Number(last.reasoningOutputTokens)) } : {}),
  };
}

export function mergeRateLimitSnapshot(previous, patch) {
  if (!previous) return patch ?? null;
  if (!patch) return previous;
  const merge = (left, right) => {
    if (right === undefined || right === null) return left;
    if (typeof right === "object" && !Array.isArray(right)) {
      const merged = {};
      for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right)])) merged[key] = merge(left?.[key], right[key]);
      return merged;
    }
    return right;
  };
  return merge(previous, patch);
}

export function normalizeRateLimits(result) {
  const buckets = result?.rateLimitsByLimitId;
  const codex = buckets && typeof buckets === "object" && !Array.isArray(buckets)
    ? buckets.codex
    : null;
  const fallback = result?.rateLimits;
  const snapshot = codex ?? (fallback && (fallback.limitId === "codex" || fallback.limitId == null) ? fallback : null);
  if (!snapshot) return [];
  return [{
    limitId: "codex",
    limitName: "Codex",
    planType: snapshot.planType ?? null,
    primary: snapshot.primary ?? null,
    secondary: snapshot.secondary ?? null,
    credits: snapshot.credits ?? null,
    individualLimit: snapshot.individualLimit ?? null,
  }];
}
