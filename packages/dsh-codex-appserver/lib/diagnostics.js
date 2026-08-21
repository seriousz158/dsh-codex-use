import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { PROVIDER } from "./protocol.js";
import { COMPATIBILITY, EXPECTED_CODEX_VERSION, verifyCompatibility } from "./compatibility.js";
import { CodexProviderError, errorContext } from "./errors.js";
import { ThreadMapStore } from "./threadmap.js";

const execFile = promisify(execFileCallback);
export const SOFT_PROVIDER_IDS = Object.freeze(["dsh-codex", "openai-codex", "codex-appserver"]);

function providerId(entry) {
  if (typeof entry === "string") return entry;
  return entry?.id ?? entry?.provider ?? null;
}

function providerIds(entries) {
  return (Array.isArray(entries) ? entries : []).map(providerId).filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * Check the public LLM registries before this plugin mutates either registry.
 * The returned object is deliberately data-only so it can also be used by the
 * standalone doctor without loading a Cordis host.
 */
export function findProviderConflicts({ providers = [], configurableProviders = [], targetProvider = PROVIDER } = {}) {
  const registered = providerIds(providers);
  const configurable = providerIds(configurableProviders);
  const hard = [];
  const soft = [];
  if (registered.includes(targetProvider)) hard.push({ kind: "registered-provider", id: targetProvider });
  if (configurable.includes(targetProvider)) hard.push({ kind: "configurable-provider", id: targetProvider });

  const counts = new Map();
  for (const id of configurable) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) hard.push({ kind: "duplicate-configurable-provider", id, count });
  }
  for (const id of [...registered, ...configurable]) {
    if (SOFT_PROVIDER_IDS.includes(id) && id !== targetProvider && !soft.some((entry) => entry.id === id)) {
      soft.push({ id, kind: "legacy-provider" });
    }
  }
  return Object.freeze({
    hard: Object.freeze(hard),
    soft: Object.freeze(soft),
    providerRegistered: registered.includes(targetProvider),
    configurableProviderRegistered: configurable.includes(targetProvider),
  });
}

export function providerConflictError(conflicts) {
  const ids = [...new Set((conflicts?.hard ?? []).map((entry) => entry.id).filter(Boolean))];
  const suffix = ids.length > 0 ? ` (${ids.join(", ")})` : "";
  return new CodexProviderError(
    `Codex provider registration conflicts with an existing provider${suffix}; remove the duplicate or migrate the old route before enabling dsh-codex-appserver`,
    "provider-conflict",
    errorContext("provider-conflict"),
  );
}

function textFile(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function scanStaticProviderConflicts({ files = [], targetProvider = PROVIDER } = {}) {
  const providers = [];
  const configurableProviders = [];
  const evidence = [];
  for (const file of files) {
    const text = textFile(file);
    if (!text) continue;
    for (const id of [targetProvider, ...SOFT_PROVIDER_IDS]) {
      if (new RegExp(`(?:^|[\\s"'])${id.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:$|[\\s"'])`, "m").test(text)) {
        providers.push(id);
        evidence.push({ file, id });
      }
    }
  }
  return Object.freeze({ ...findProviderConflicts({ providers, configurableProviders, targetProvider }), evidence });
}

async function readVersion(binary, args = ["--version"]) {
  if (!binary) return null;
  try {
    const { stdout, stderr } = await execFile(binary, args, { encoding: "utf8" });
    const match = `${stdout}\n${stderr}`.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    return match?.[1] ?? null;
  } catch { return null; }
}

export function defaultDiagnosticsPaths({ dshHome = process.env.DSH_HOME, profile = process.env.DSH_PROFILE || "web" } = {}) {
  const home = resolve(dshHome || join(homedir(), ".dsh"));
  const profileDir = join(home, "profiles", profile);
  return {
    home,
    profile,
    profileDir,
    hostPatch: join(home, "cordis.patch.yml"),
    profilePatch: join(profileDir, "cordis.patch.yml"),
    profilePackage: join(profileDir, "package.json"),
    bundleLink: join(home, "profiles", "node_modules", "dsh-codex-appserver"),
    threadmap: join(home, "storages", "codex-appserver", "threads.json"),
  };
}

function issue(code, message, overrides = {}) {
  return { ...errorContext(code, overrides), message };
}

export async function buildOfflineDiagnostics({
  dshBin = process.env.DSH_BIN || null,
  codexBin = process.env.CODEX_BIN || "codex",
  dshHome = process.env.DSH_HOME,
  profile = process.env.DSH_PROFILE || "web",
  threadmapPath,
} = {}) {
  const paths = defaultDiagnosticsPaths({ dshHome, profile });
  const compatibility = verifyCompatibility();
  const nodeVersion = process.version;
  const dshVersion = await readVersion(dshBin, ["--version"]);
  const codexVersion = await readVersion(codexBin, ["--version"]);
  const issues = [];
  if (!dshVersion) issues.push(issue("startup-failed", "DSH runtime version could not be determined", { stage: "runtime", action: "install-dsh" }));
  if (!codexVersion) issues.push(issue("codex-not-found", "Codex CLI is not available", { stage: "runtime", action: "install-codex", retryable: false }));
  if (codexVersion && codexVersion !== EXPECTED_CODEX_VERSION) issues.push(issue("protocol-mismatch", `Codex CLI ${codexVersion} does not match ${EXPECTED_CODEX_VERSION}`));
  if (!compatibility.ok) issues.push(issue("protocol-mismatch", "vendored Codex protocol schema hash does not match compatibility.json"));

  let storage = { threadmap: "unknown" };
  try {
    const store = new ThreadMapStore(threadmapPath || paths.threadmap);
    await store.read();
    storage = { threadmap: existsSync(threadmapPath || paths.threadmap) ? "readable" : "absent" };
  } catch (error) {
    storage = { threadmap: "corrupt" };
    issues.push(issue("threadmap-corrupt", error.message));
  }

  const staticConflicts = scanStaticProviderConflicts({ files: [paths.hostPatch, paths.profilePatch, paths.profilePackage] });
  if (staticConflicts.hard.length > 0) issues.push(issue("provider-conflict", "static profile configuration contains a duplicate Codex provider"));
  const bundleInstalled = existsSync(paths.bundleLink) || existsSync(join(paths.profileDir, "node_modules", "dsh-codex-appserver"));
  if (!bundleInstalled) issues.push(issue("startup-failed", "dsh-codex-appserver is not mounted in the selected profile", { stage: "startup", action: "install-plugin" }));

  return {
    schemaVersion: 1,
    plugin: { version: COMPATIBILITY.pluginVersion, provider: PROVIDER },
    runtime: {
      node: nodeVersion,
      dsh: dshVersion,
      codexCli: { available: Boolean(codexVersion), version: codexVersion },
    },
    protocol: {
      expected: EXPECTED_CODEX_VERSION,
      actual: codexVersion,
      compatible: codexVersion ? codexVersion === EXPECTED_CODEX_VERSION : null,
      schema: COMPATIBILITY.codex.protocol,
      schemaSha256: compatibility.actual,
      schemaHashExpected: compatibility.expected,
      schemaHashValid: compatibility.ok,
    },
    registration: {
      providerRegistered: null,
      conflicts: [...staticConflicts.hard, ...staticConflicts.soft],
    },
    storage,
    account: { state: "unknown" },
    quota: { state: "unknown", updatedAt: null, source: "none", buckets: {} },
    models: { state: "unknown", count: null },
    profile: { home: paths.home, name: paths.profile, bundleInstalled },
    issues,
  };
}

export function summarizeLiveFixture(fixture) {
  const inbound = (fixture?.frames ?? []).filter((event) => event?.direction === "in").map((event) => event.frame);
  // The probe keeps response ids but does not retain request method on a
  // response frame. Use the first result of each allowed call in order.
  const results = inbound.filter((frame) => frame?.id !== undefined && frame?.result).map((frame) => frame.result);
  const account = results[1] ?? null;
  const rates = results[2] ?? null;
  const modelPages = results.slice(3);
  const models = modelPages.flatMap((page) => page?.data ?? []);
  const rawBuckets = rates?.rateLimitsByLimitId ?? rates?.buckets ?? rates?.rateLimits;
  const bucketEntries = Array.isArray(rawBuckets)
    ? rawBuckets
    : rawBuckets?.limitId
      ? [rawBuckets]
      : rawBuckets && typeof rawBuckets === "object"
        ? Object.values(rawBuckets)
        : [];
  const rateBuckets = Object.fromEntries(bucketEntries.filter((entry) => entry?.limitId).map((entry) => [entry.limitId, entry]));
  return {
    account: { state: account ? "account-readable" : "unavailable" },
    quota: rates
      ? { state: "available", updatedAt: new Date().toISOString(), source: "account/rateLimits/read", buckets: rateBuckets }
      : { state: "unavailable", updatedAt: null, source: "account/rateLimits/read", buckets: {} },
    models: { state: "available", count: models.length },
  };
}

export async function buildLiveDiagnostics(options = {}) {
  const offline = await buildOfflineDiagnostics(options);
  const issues = [...offline.issues];
  let live;
  try {
    const { runProbe } = await import("../../../tools/codex-appserver-probe.mjs");
    const result = await runProbe({ codexBin: options.codexBin || process.env.CODEX_BIN || "codex" });
    live = summarizeLiveFixture(result.fixture);
  } catch (error) {
    const code = /auth|account/i.test(error.message) ? "account-unavailable" : /rate limit/i.test(error.message) ? "rate-limits-unavailable" : "startup-failed";
    issues.push(issue(code, error.message));
    live = {
      account: { state: code === "account-unavailable" ? "unavailable" : "unknown" },
      quota: { state: "unavailable", updatedAt: null, source: "none", buckets: {}, error: errorContext(code) },
      models: { state: "unknown", count: null },
    };
  }
  return { ...offline, ...live, issues };
}

export async function readHostRegistry(ctx) {
  const providers = typeof ctx?.llm?.listProviders === "function" ? ctx.llm.listProviders() : [];
  const configurableProviders = typeof ctx?.llm?.listConfigurableProviders === "function" ? ctx.llm.listConfigurableProviders() : [];
  return findProviderConflicts({ providers, configurableProviders });
}

export function formatDiagnosticsError(error) {
  return {
    ...errorContext(error?.code ?? "protocol-error"),
    message: error?.message ?? "Codex diagnostics failed",
  };
}
