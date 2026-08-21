window.__ModuleLoader__.load({
  id: "dsh-codex-appserver",
  factory: (require) => {
    var module = { exports: {} };
    const jsx = require("react/jsx-runtime");
    const react = require("react");
    const strict = (parse) => ({ mode: "strict", typeSymbol: "dsh-codex-appserver/types#Result", schema: { parse } });
    const result = (value) => {
      if (!value || typeof value !== "object" || typeof value.ok !== "boolean") throw new Error("invalid Codex provider result");
      if (!value.ok && typeof value.error?.code !== "string") throw new Error("invalid Codex provider error");
      return value;
    };
    const operationResult = (value) => { const transport = result(value); return transport.ok ? result(transport.value) : transport; };
    const forceRequest = (value) => ({ force: value?.force === true });
    const remote = { package: "dsh-codex-appserver", descriptors: [
      { id: "dsh-codex-appserver#codexAppserver/status", service: "codexAppserver", namespace: "codexAppserver", method: "status", invocation: { kind: "direct" }, parameters: [], result: strict(result) },
      { id: "dsh-codex-appserver#codexAppserver/rateLimits", service: "codexAppserver", namespace: "codexAppserver", method: "rateLimits", invocation: { kind: "direct" }, parameters: [{ name: "request", wire: "request", source: "json", codec: strict(forceRequest) }], result: strict(result) },
    ] };
    const css = `.dshca_row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}.dshca_panel{min-width:0;flex:1}.dshca_disclosure{min-width:0}.dshca_toggle{display:flex;align-items:flex-start;width:100%;gap:12px;border:0;background:transparent;color:inherit;cursor:pointer;padding:0 0 4px;text-align:left}.dshca_toggle:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#2563eb);outline-offset:3px;border-radius:4px}.dshca_summary_main{min-width:0;display:flex;flex-direction:column;gap:4px;flex:1}.dshca_summary_hint{flex:none;font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888);white-space:nowrap;padding-top:2px}.dshca_summary_meters{display:flex;flex-direction:column;gap:6px;padding:2px 0 4px}.dshca_title{font:var(--dsw-font-s-strong-14,14px sans-serif);font-weight:600}.dshca_desc,.dshca_status,.dshca_window_meta{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888)}.dshca_error{color:var(--dsw-alias-state-danger,#c53b37)}.dshca_meter{min-width:0}.dshca_meter_header{display:flex;justify-content:space-between;gap:8px;font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888)}.dshca_meter_value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#222);white-space:nowrap}.dshca_meter_track{box-sizing:border-box;height:6px;margin-top:4px;overflow:hidden;background:rgba(148,163,184,.28);border:1px solid rgba(148,163,184,.35);border-radius:999px}.dshca_meter_fill{display:block;width:var(--dshca-progress,0%);height:100%;background:#38bdf8;border-radius:inherit}.dshca_meter[data-severity=warning] .dshca_meter_fill{background:#fbbf24}.dshca_meter[data-severity=critical] .dshca_meter_fill{background:#fb923c}.dshca_details_body{display:flex;flex-direction:column;gap:10px;padding:8px 0 2px}.dshca_bucket{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l3,#f0f0f0)}.dshca_bucket_title{display:block;font:var(--dsw-font-s-strong-14,14px sans-serif);font-weight:600;margin-bottom:8px}.dshca_bucket_grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dshca_window{min-width:0}.dshca_window_meta{display:block;margin-top:4px;line-height:1.4}.dshca_empty{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888)}.dshca_button{align-self:flex-start;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:6px;padding:6px 10px;background:transparent;cursor:pointer}.dshca_button:disabled{opacity:.5;cursor:default}.dshca_settings{display:flex;flex-direction:column;gap:12px;padding:10px 0}.dshca_settings_title{font:var(--dsw-font-s-strong-14,14px sans-serif);font-weight:600}.dshca_settings_hint,.dshca_settings_error{font:var(--dsw-font-xs-13,12px sans-serif);color:var(--dsw-alias-label-caption,#888)}.dshca_settings_error{color:var(--dsw-alias-state-danger,#c53b37)}.dshca_settings_field{display:flex;align-items:center;justify-content:space-between;gap:12px}.dshca_settings_field label{font:var(--dsw-font-xs-13,12px sans-serif)}.dshca_settings_field input,.dshca_settings_field select{max-width:240px;min-width:0}.dshca_settings_actions{display:flex;gap:8px}.dshca_settings_actions button{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:6px;padding:6px 10px;background:transparent;cursor:pointer}.dshca_settings_actions button:disabled{opacity:.5;cursor:default}@media (max-width:560px){.dshca_summary_main{margin-bottom:8px}.dshca_summary_hint{display:block;margin-bottom:6px}.dshca_bucket_grid{grid-template-columns:1fr}.dshca_settings_field{align-items:flex-start;flex-direction:column}.dshca_settings_field input,.dshca_settings_field select{max-width:none;width:100%}}`;
    const tagId = "dsh-codex-appserver/style.css";
    if (typeof document !== "undefined") { let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]"); if (tag === null) { tag = document.createElement("style"); tag.dataset.plugin = "dsh-codex-appserver"; tag.dataset.pluginCss = tagId; document.head.appendChild(tag); } if (tag.textContent !== css) tag.textContent = css; }
    const entry = { name: "dsh-codex-appserver", inject: ["slots", "remote", "settingsScope"], async apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(remote);
      ctx.effect(() => disposeRemote, "dsh-codex-appserver: remote cleanup");
      ctx.inject(["remote.codexAppserver", "settingsScope"], (providerCtx) => {
        const service = providerCtx.remote.codexAppserver;
        const settingsScope = typeof providerCtx.settingsScope?.bind === "function" ? providerCtx.settingsScope.bind({ namespace: "llm-codex-appserver" }) : null;
        const clampPercent = (value) => Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;
        const remainingPercent = (window) => { const used = clampPercent(window?.usedPercent); return used === null ? null : 100 - used; };
        const severityFor = (value) => value === null ? "unknown" : value <= 10 ? "critical" : value <= 25 ? "warning" : "normal";
        const formatWindowMeta = (window) => {
          if (!window) return "无此窗口";
          const duration = Number.isFinite(window.windowDurationMins) ? `${window.windowDurationMins} 分钟窗口` : "窗口时长未知";
          const reset = Number.isFinite(window.resetsAt) ? `重置于 ${new Date(window.resetsAt * 1000).toLocaleString()}` : "重置时间未知";
          return `${duration} · ${reset}`;
        };
        const UsageMeter = ({ label, window, compact = false }) => {
          const remaining = remainingPercent(window);
          const value = remaining === null ? "剩余未知" : `剩余 ${remaining}%`;
          if (!window) return jsx.jsx("div", { className: "dshca_window", children: [
            jsx.jsx("div", { className: "dshca_meter_header", children: [jsx.jsx("span", { children: label }), jsx.jsx("span", { className: "dshca_meter_value", children: "无此窗口" })] }),
          ] });
          return jsx.jsxs("div", { className: "dshca_window", children: [
            jsx.jsxs("div", { className: "dshca_meter_header", children: [jsx.jsx("span", { children: label }), jsx.jsx("span", { className: "dshca_meter_value", children: value })] }),
            jsx.jsx("div", { className: "dshca_meter dshca_meter_track", role: "progressbar", "aria-label": `${label}剩余额度`, "aria-valuemin": 0, "aria-valuemax": 100, ...(remaining === null ? {} : { "aria-valuenow": remaining }), "data-severity": severityFor(remaining), children: jsx.jsx("span", { className: "dshca_meter_fill", style: { "--dshca-progress": `${remaining ?? 0}%` } }) }),
            !compact && jsx.jsx("span", { className: "dshca_window_meta", children: formatWindowMeta(window) }),
          ] });
        };
        function CodexRateLimitRow() {
          const [state, setState] = react.useState({ loading: true, status: null, limits: null, error: null });
          const [expanded, setExpanded] = react.useState(false);
          const refresh = react.useCallback(async (force = false) => {
            setState((current) => ({ ...current, loading: true, error: null }));
            try {
              const [status, limits] = await Promise.all([operationResult(await service.status()), operationResult(await service.rateLimits({ force }))]);
              const quotaError = limits.ok ? limits.value?.error?.code ?? null : limits.error?.code ?? "rate-limits-unavailable";
              setState({ loading: false, status: status.ok ? status.value : null, limits: limits.ok ? limits.value : null, error: status.ok ? quotaError : (status.error?.code ?? quotaError ?? "startup-failed") });
            } catch { setState({ loading: false, status: null, limits: null, error: "rate-limits-unavailable" }); }
          }, []);
          react.useEffect(() => { void refresh(false); }, [refresh]);
          const codexBucket = state.limits?.buckets?.codex;
          const buckets = codexBucket ? [codexBucket] : [];
          const statusDescription = state.loading ? "正在检查 Codex Provider…" : state.status?.available ? "Codex Provider 已就绪" : state.error === "protocol-mismatch" ? "Codex Provider：协议版本不兼容" : state.error ? `Codex Provider：不可用（${state.error}）` : "Codex Provider：状态未知";
          const detailDescription = state.loading ? "正在读取 Codex 套餐额度…" : state.error ? `暂时无法读取（${state.error}）` : buckets.length === 0 ? "暂时无法读取" : null;
          const summaryMeters = buckets.length > 0 ? buckets.map((bucket) => UsageMeter({ label: bucket.limitName ?? bucket.limitId, window: bucket.primary, compact: true })) : jsx.jsx("span", { className: "dshca_empty", children: detailDescription });
          const bucketDetails = buckets.map((bucket) => jsx.jsxs("div", { className: "dshca_bucket", children: [
            jsx.jsx("span", { className: "dshca_bucket_title", children: bucket.limitName ?? bucket.limitId }),
            jsx.jsxs("div", { className: "dshca_bucket_grid", children: [
              UsageMeter({ label: "主额度", window: bucket.primary }),
              UsageMeter({ label: "次额度", window: bucket.secondary }),
            ] }),
          ] }));
          return jsx.jsxs("div", { className: "dshca_row", children: [
            jsx.jsxs("div", { className: "dshca_panel", children: [
              jsx.jsxs("div", { className: "dshca_disclosure", children: [
                jsx.jsxs("button", { type: "button", className: "dshca_toggle", "aria-expanded": expanded, "aria-controls": "dshca-quota-details", onClick: () => setExpanded((current) => !current), children: [
                  jsx.jsxs("span", { className: "dshca_summary_main", children: [
                    jsx.jsx("span", { className: "dshca_title", children: "Codex 套餐额度" }),
                    jsx.jsx("span", { className: state.error ? "dshca_desc dshca_error" : "dshca_desc", role: "status", "aria-live": "polite", children: statusDescription }),
                  ] }),
                  jsx.jsx("span", { className: "dshca_summary_hint", children: expanded ? "收起额度详情" : "展开额度详情" }),
                ] }),
                jsx.jsx("div", { className: "dshca_summary_meters", children: summaryMeters }),
              ] }),
              expanded && jsx.jsxs("div", { id: "dshca-quota-details", className: "dshca_details_body", children: [
                bucketDetails.length > 0 ? bucketDetails : jsx.jsx("span", { className: state.error ? "dshca_empty dshca_error" : "dshca_empty", children: detailDescription ?? "暂时无法读取" }),
                state.limits?.updatedAt && jsx.jsx("span", { className: "dshca_status", children: `更新于 ${new Date(state.limits.updatedAt).toLocaleTimeString()}` }),
              ] }),
            ] }),
            jsx.jsx("button", { type: "button", className: "dshca_button", disabled: state.loading, onClick: () => void refresh(true), children: state.loading ? "读取中…" : "刷新" }),
          ] });
        }
        providerCtx.slots.inject("settings.general.item", () => providerCtx.slots.register({ name: "settings.general.item", id: "codex-appserver", order: 31 }, CodexRateLimitRow));
        if (settingsScope) {
          const defaults = { codexBin: "", sandbox: "workspace-write", approvalPolicy: "never", ephemeralThreads: true, injectMemory: false, historyBootstrap: 20, requestTimeoutMs: 600000, rateLimitRefreshSec: 30, fastMode: false };
          const clone = (value) => ({ ...defaults, ...(value && typeof value === "object" ? value : {}) });
          const SettingsField = ({ label, children }) => jsx.jsxs("div", { className: "dshca_settings_field", children: [jsx.jsx("label", { children: label }), children] });
          const CodexSettingsCard = () => {
            const initial = clone(settingsScope.getSnapshot?.().value);
            const [draft, setDraft] = react.useState(initial);
            const [saved, setSaved] = react.useState(initial);
            const [dirty, setDirty] = react.useState(false);
            const [saving, setSaving] = react.useState(false);
            const [error, setError] = react.useState(null);
            const snapshot = settingsScope.getSnapshot?.() ?? { status: "unavailable", writable: false, value: undefined };
            react.useEffect(() => {
              const sync = () => {
                const next = clone(settingsScope.getSnapshot?.().value);
                setSaved(next);
                if (!dirty) setDraft(next);
              };
              const unsubscribe = settingsScope.subscribe?.(sync);
              sync();
              return unsubscribe;
            }, [dirty]);
            const update = (field, value) => { setDraft((current) => ({ ...current, [field]: value })); setDirty(true); setError(null); };
            const save = async () => {
              setSaving(true);
              setError(null);
              try {
                for (const field of Object.keys(defaults)) {
                  if (Object.is(draft[field], saved[field])) continue;
                  if (Object.is(draft[field], defaults[field])) await settingsScope.unset(field);
                  else await settingsScope.set(field, draft[field]);
                }
                const next = clone(settingsScope.getSnapshot?.().value ?? draft);
                setSaved(next); setDraft(next); setDirty(false);
              } catch (failure) { setError(failure?.code === "settings-conflict" ? "设置已被其他窗口更新，请先重试" : "设置保存失败，请稍后重试"); }
              finally { setSaving(false); }
            };
            const discard = () => { setDraft(clone(saved)); setDirty(false); setError(null); };
            const unavailable = snapshot.status !== "ready" || snapshot.writable === false;
            return jsx.jsxs("div", { className: "dshca_settings", children: [
              jsx.jsx("div", { className: "dshca_settings_title", children: "Codex App Server" }),
              jsx.jsx("div", { className: "dshca_settings_hint", children: unavailable ? "设置传输暂不可用；额度监控仍在通用设置中。" : "修改仅在保存后生效，revision 冲突会自动重新读取。" }),
              jsx.jsx(SettingsField, { label: "Codex CLI 路径", children: jsx.jsx("input", { value: draft.codexBin, disabled: unavailable || saving, onChange: (event) => update("codexBin", event.target.value) }) }),
              jsx.jsx(SettingsField, { label: "Sandbox", children: jsx.jsxs("select", { value: draft.sandbox, disabled: unavailable || saving, onChange: (event) => update("sandbox", event.target.value), children: [jsx.jsx("option", { value: "workspace-write", children: "workspace-write" }), jsx.jsx("option", { value: "read-only", children: "read-only" })] }) }),
              jsx.jsx(SettingsField, { label: "Approval policy（安全策略）", children: jsx.jsx("input", { value: "never", readOnly: true, disabled: true }) }),
              jsx.jsx(SettingsField, { label: "Ephemeral threads", children: jsx.jsx("input", { type: "checkbox", checked: draft.ephemeralThreads, disabled: unavailable || saving, onChange: (event) => update("ephemeralThreads", event.target.checked) }) }),
              jsx.jsx(SettingsField, { label: "Inject memory", children: jsx.jsx("input", { type: "checkbox", checked: draft.injectMemory, disabled: unavailable || saving, onChange: (event) => update("injectMemory", event.target.checked) }) }),
              jsx.jsx(SettingsField, { label: "History bootstrap", children: jsx.jsx("input", { type: "number", min: 0, max: 100, value: draft.historyBootstrap, disabled: unavailable || saving, onChange: (event) => update("historyBootstrap", Number(event.target.value)) }) }),
              jsx.jsx(SettingsField, { label: "Request timeout (ms)", children: jsx.jsx("input", { type: "number", min: 30000, max: 1800000, value: draft.requestTimeoutMs, disabled: unavailable || saving, onChange: (event) => update("requestTimeoutMs", Number(event.target.value)) }) }),
              jsx.jsx(SettingsField, { label: "Quota refresh (sec)", children: jsx.jsx("input", { type: "number", min: 15, max: 300, value: draft.rateLimitRefreshSec, disabled: unavailable || saving, onChange: (event) => update("rateLimitRefreshSec", Number(event.target.value)) }) }),
              jsx.jsx(SettingsField, { label: "Fast Mode（服务层级）", children: jsx.jsx("input", { type: "checkbox", checked: draft.fastMode, disabled: unavailable || saving, onChange: (event) => update("fastMode", event.target.checked) }) }),
              error && jsx.jsx("div", { className: "dshca_settings_error", role: "alert", children: error }),
              jsx.jsxs("div", { className: "dshca_settings_actions", children: [
                jsx.jsx("button", { type: "button", disabled: unavailable || !dirty || saving, onClick: () => void save(), children: saving ? "保存中…" : "保存" }),
                jsx.jsx("button", { type: "button", disabled: !dirty || saving, onClick: discard, children: "放弃修改" }),
              ] }),
            ] });
          };
          providerCtx.slots.inject("settings.plugin.item", () => providerCtx.slots.register({ name: "settings.plugin.item", key: "llm-codex-appserver", order: 31 }, CodexSettingsCard));
        }
      });
    } };
    module.exports = entry;
    return module.exports;
  },
});
