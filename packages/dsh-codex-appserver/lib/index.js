import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { CodexAppServerAdapter } from "./adapter.js";
import { PROVIDER, PROVIDER_NAME } from "./protocol.js";
import { CodexAppServerService } from "./ratelimits.js";

export const name = "dsh-codex-appserver";
export const inject = ["llm", "settings", "sessions"];
export const NS = settingsNamespace("llm-codex-appserver");
export const Config = z.object({
  codexBin: z.string().default(""),
  sandbox: z.union(["read-only", "workspace-write"]).default("workspace-write"),
  approvalPolicy: z.union(["never"]).default("never"),
  ephemeralThreads: z.boolean().default(true),
  injectMemory: z.boolean().default(false),
  historyBootstrap: z.number().step(1).min(0).max(100).default(20),
  rateLimitRefreshSec: z.number().step(1).min(15).max(300).default(30),
  requestTimeoutMs: z.number().step(1).min(30_000).max(1_800_000).default(600_000),
});

export function apply(ctx, entry = {}) {
  const scope = ctx.settings.register(NS, Config, { base: entry });
  const adapter = new CodexAppServerAdapter({
    config: () => scope.get(),
    logger: ctx.logger,
    workspaceResolver: (sessionId) => ctx.sessions.get(sessionId)?.header?.cwd,
  });
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: PROVIDER_NAME,
    settingsNs: NS,
    settingsPath: [],
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
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
