import z from "@deepseek-ai/schemastery";
import { CodexAppServerAdapter } from "./adapter.js";
import { PROVIDER, PROVIDER_NAME } from "./protocol.js";
import { CodexAppServerService } from "./ratelimits.js";
import { findProviderConflicts, providerConflictError } from "./diagnostics.js";
import { toLlmError } from "./errors.js";

export const name = "dsh-codex-appserver";
export const inject = [];
export const NS = "llm-codex-appserver";
export const Config = z.object({
  codexBin: z.string().default(""),
  sandbox: z.union(["read-only", "workspace-write"]).default("workspace-write"),
  approvalPolicy: z.union(["never"]).default("never"),
  ephemeralThreads: z.boolean().default(true),
  injectMemory: z.boolean().default(false),
  historyBootstrap: z.number().step(1).min(0).max(100).default(20),
  rateLimitRefreshSec: z.number().step(1).min(15).max(300).default(30),
  requestTimeoutMs: z.number().step(1).min(30_000).max(1_800_000).default(600_000),
  fastMode: z.boolean().default(false),
});

export function preflightProviderConflicts(ctx) {
  const llm = typeof ctx?.get === "function" ? ctx.get("llm") : ctx?.llm;
  const conflicts = findProviderConflicts({
    providers: typeof llm?.listProviders === "function" ? llm.listProviders() : [],
    configurableProviders: typeof llm?.listConfigurableProviders === "function" ? llm.listConfigurableProviders() : [],
  });
  if (conflicts.soft.length > 0) {
    const ids = conflicts.soft.map((entry) => entry.id).join(", ");
    ctx?.logger?.warn?.(`llm-codex-appserver: legacy provider route(s) detected (${ids}); migrate them before selecting Codex`);
  }
  if (conflicts.hard.length > 0) throw toLlmError(providerConflictError(conflicts), "provider-conflict");
  return conflicts;
}

function registerSettingsCompat(ctx, entry) {
  const settingsApi = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
  if (typeof settingsApi?.register === "function") {
    return settingsApi.register(NS, Config, { base: entry });
  }
  if (settingsApi === void 0) {
    const base = entry?.config && typeof entry.config === "object" ? { ...entry.config } : {};
    return { get: () => base, update: async () => {}, watch: () => () => {}, dispose: () => {} };
  }
  const entryId = entry?.options?.id ?? entry?.id ?? NS;
  const listeners = new Set();
  const read = () => {
    try {
      const descriptor = settingsApi.describe().find((row) => row.ns === entryId || row.ns === NS);
      return descriptor?.value ?? {};
    } catch {
      return {};
    }
  };
  const onUpdated = (ns) => {
    if (ns !== entryId && ns !== NS) return;
    for (const listener of [...listeners]) {
      try { listener(read()); } catch {}
    }
  };
  const stop = ctx.on?.("settings/document-updated", onUpdated);
  return {
    get: read,
    async update(patch) { await settingsApi.update(entryId, patch); },
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); stop?.(); },
  };
}

export function apply(ctx, entry = {}) {
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
  const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
  const attachments = typeof ctx.get === "function" ? ctx.get("attachments") : ctx.attachments;
  preflightProviderConflicts(ctx);
  const scope = registerSettingsCompat(ctx, entry);
  const adapter = new CodexAppServerAdapter({
    config: () => scope.get(),
    logger: ctx.logger,
    attachments,
    workspaceResolver: (sessionId) => sessions?.get(sessionId)?.header?.cwd,
  });
  const directory = llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    settingsNs: NS,
    settingsPath: [],
  }]);
  const registration = llm.registerAdapter([PROVIDER], adapter);
  const service = new CodexAppServerService(ctx, { adapter });
  const stopWatching = scope.watch((next, previous) => adapter.reconfigure(next, previous));
  ctx.effect(() => () => {
    stopWatching();
    registration();
    directory();
    adapter.dispose();
    service.dispose?.();
  }, "dsh-codex-appserver: cleanup");
}

export { CodexAppServerAdapter } from "./adapter.js";
export { CodexAppServerService } from "./ratelimits.js";
export { ThreadMapStore } from "./threadmap.js";
