import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { safeSearchFetch } from "./remote-search.js";

export const name = "dsh-codex-search";
export const inject = ["llm"];
export const PROVIDER = "codex-search";
export const NS = "llm-codex-search";
export const Config = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(""),
  maxResponseBytes: z.number().step(1).min(1_024).max(5_000_000).default(1_000_000),
  timeoutMs: z.number().step(1).min(1_000).max(60_000).default(10_000),
});

class CodexSearchAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config; }
  providerInfo(provider) { return { id: provider, name: "Codex Search" }; }
  async listModels(provider = PROVIDER) { return provider === PROVIDER ? [{ provider, id: "web", name: "Codex Search" }] : []; }
  async *stream(options) {
    const config = this.config();
    if (!config.enabled) throw new LlmError("Codex Search is disabled", "provider-conflict");
    const message = [...(options.messages ?? [])].reverse().find((entry) => entry.role === "user");
    const query = (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
    if (!query) throw new LlmError("Search requires a text query", "turn-failed");
    if (!config.endpoint) throw new LlmError("Search endpoint is not configured", "startup-failed");
    const url = new URL(config.endpoint);
    url.searchParams.set("q", query);
    const result = await safeSearchFetch(url, { maxBytes: config.maxResponseBytes, timeoutMs: config.timeoutMs, signal: options.signal });
    if (result.text) yield { type: "text-delta", index: 0, text: result.text };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export function apply(ctx, entry = {}) {
  const settingsApi = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
  const scope = typeof settingsApi?.register === "function"
    ? settingsApi.register(NS, Config, { base: entry })
    : { get: () => (entry?.config && typeof entry.config === "object" ? { ...entry.config } : { enabled: false }), watch: () => () => {}, dispose: () => {} };
  const config = () => scope.get();
  if (!config().enabled) return;
  const existing = typeof ctx.llm.listProviders === "function" && ctx.llm.listProviders().some((item) => item.id === PROVIDER);
  if (existing) throw new LlmError("Codex Search provider is already registered", "provider-conflict");
  const adapter = new CodexSearchAdapter(config);
  const directory = ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "Codex Search", settingsNs: NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.effect(() => () => { registration(); directory(); adapter.dispose?.(); }, "dsh-codex-search: cleanup");
}

export { CodexSearchAdapter };
