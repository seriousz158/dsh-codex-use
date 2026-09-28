import z from "@deepseek-ai/schemastery";
import { CodexAppServerAdapter } from "./adapter.js";
import { PROVIDER, PROVIDER_NAME } from "./protocol.js";
import { CodexAppServerService } from "./ratelimits.js";
import { findProviderConflicts, providerConflictError } from "./diagnostics.js";
import { toLlmError } from "./errors.js";

export const name = "dsh-codex-appserver";
export const inject = ["llm", "settings", "sessions", "attachments"];
export const NS = "llm-codex-appserver";
const live = (schema) => typeof schema.volatile === "function" ? schema.volatile() : schema;
const values = (config) => Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value?.get === "function" ? value.get() : value]));
const configFields = (wrap) => ({
  codexBin: wrap(z.string().default("")),
  sandbox: wrap(z.union(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write")),
  approvalPolicy: wrap(z.union(["never"]).default("never")),
  ephemeralThreads: wrap(z.boolean().default(true)),
  injectMemory: wrap(z.boolean().default(false)),
  historyBootstrap: wrap(z.number().step(1).min(0).max(100).default(20)),
  rateLimitRefreshSec: wrap(z.number().step(1).min(15).max(300).default(30)),
  requestTimeoutMs: wrap(z.number().step(1).min(30_000).max(1_800_000).default(600_000)),
  fastMode: wrap(z.boolean().default(false)),
});
export const Config = z.object(configFields(live));
const LegacyConfig = z.object(configFields((schema) => schema));

export function preflightProviderConflicts(ctx) {
  const conflicts = findProviderConflicts({
    providers: typeof ctx?.llm?.listProviders === "function" ? ctx.llm.listProviders() : [],
    configurableProviders: typeof ctx?.llm?.listConfigurableProviders === "function" ? ctx.llm.listConfigurableProviders() : [],
  });
  if (conflicts.soft.length > 0) {
    const ids = conflicts.soft.map((entry) => entry.id).join(", ");
    ctx?.logger?.warn?.(`llm-codex-appserver: legacy provider route(s) detected (${ids}); migrate them before selecting Codex`);
  }
  if (conflicts.hard.length > 0) throw toLlmError(providerConflictError(conflicts), "provider-conflict");
  return conflicts;
}

export function apply(ctx, entry = {}) {
  preflightProviderConflicts(ctx);
  const legacySettings = typeof ctx.settings.register === "function";
  const scope = legacySettings
    ? ctx.settings.register(NS, LegacyConfig, { base: values(entry) })
    : { get: () => entry, watch: () => () => {} };
  if (!legacySettings) {
    ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), "dsh-codex-appserver: settings presentation");
  }
  const adapter = new CodexAppServerAdapter({
    config: () => values(scope.get()),
    logger: ctx.logger,
    attachments: ctx.attachments,
    workspaceResolver: (sessionId) => ctx.sessions.get(sessionId)?.header?.cwd,
  });
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    settingsNs: legacySettings ? NS : ctx.fiber.entry?.options.id ?? "codex-appserver",
    settingsPath: [],
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  const service = new CodexAppServerService(ctx, { adapter });
  let previousConfig = values(scope.get());
  const stopWatching = legacySettings
    ? scope.watch((next, previous) => adapter.reconfigure(values(next), values(previous)))
    : ctx.on("loader/volatile-update", () => {
      const next = values(scope.get());
      adapter.reconfigure(next, previousConfig);
      previousConfig = next;
    });
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
