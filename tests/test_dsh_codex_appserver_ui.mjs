import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const clientPath = new URL("../packages/dsh-codex-appserver/lib/client.js", import.meta.url);
const source = await readFile(clientPath, "utf8");
assert.match(source, /aria-expanded/, "the provider row must expose a controlled disclosure state");
assert.match(source, /tag\.textContent !== css/, "an HMR reload must replace stale plugin styles");
assert.match(source, /role: "progressbar"/, "usage must expose an accessible progress bar");
assert.match(source, /展开额度详情|收起额度详情/, "the disclosure affordance must be visible in Chinese");
assert.match(source, /剩余/, "quota values must be presented as remaining allowance");
assert.match(source, /buckets\?\.codex/, "the settings row must only expose the Codex quota bucket");
assert.match(source, /settings\.plugin\.item/, "the plugin settings card must use the plugin slot");
assert.match(source, /settingsScope\.bind/, "the plugin settings card must use the revision-fenced settings transport");
assert.ok(source.includes("background:rgba(148,163,184,.28)"), "the progress track must keep contrast in dark and light themes");
assert.ok(source.includes("background:#38bdf8"), "a full remaining allowance must use the blue-green normal color");
assert.ok(source.includes("background:#fbbf24"), "a medium remaining allowance must use the amber warning color");
assert.ok(source.includes("background:#fb923c"), "a low remaining allowance must use the orange critical color");

let registered;
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(entry) { registered = entry; } } },
}, { filename: clientPath.pathname });

const jsx = (type, props = {}) => ({ type, props });
const jsxs = jsx;
const components = [];
const effects = [];
const state = [];
let hookIndex = 0;
const react = {
  useState(initial) {
    const index = hookIndex++;
    if (!Object.hasOwn(state, index)) state[index] = initial;
    return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
  },
  useCallback(callback) { return callback; },
  useEffect(callback) { effects.push(callback); },
};
const fakeService = {
  async status() { return { ok: true, value: { ok: true, value: { available: true } } }; },
  async rateLimits() {
    return {
      ok: true,
      value: {
        ok: true,
        value: {
          updatedAt: "2026-08-18T08:16:36.000Z",
          buckets: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1_755_676_400 },
              secondary: null,
            },
            spark: {
              limitId: "spark",
              limitName: "GPT-5.3-Codex-Spark",
              primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1_756_126_596 },
              secondary: null,
            },
          },
        },
      },
    };
  },
};
const settingsWrites = [];
const settingsValue = { codexBin: "", sandbox: "workspace-write", approvalPolicy: "never", ephemeralThreads: true, injectMemory: false, historyBootstrap: 20, requestTimeoutMs: 600000, rateLimitRefreshSec: 30, fastMode: false };
const fakeSettingsScope = {
  snapshot: { status: "ready", writable: true, value: settingsValue, revision: 1 },
  getSnapshot() { return this.snapshot; },
  subscribe() { return () => {}; },
  async set(field, value) { settingsWrites.push({ op: "set", field, value }); this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, value: { ...this.snapshot.value, [field]: value } }; },
  async unset(field) { settingsWrites.push({ op: "unset", field }); this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, value: { ...this.snapshot.value, [field]: undefined } }; },
};
const plugin = registered.factory((name) => {
  if (name === "react") return react;
  if (name === "react/jsx-runtime") return { jsx, jsxs };
  throw new Error(`unexpected client dependency ${name}`);
});
await plugin.apply({
  remote: { async $mount() { return () => {}; } },
  effect() {},
  inject(_dependencies, callback) {
    callback({
      remote: { codexAppserver: fakeService },
      slots: {
        inject(_slot, register) { register(); },
        register(metadata, value) { components.push({ metadata, value }); return value; },
      },
      settingsScope: { bind() { return fakeSettingsScope; } },
    });
  },
});

const quotaComponent = components.find(({ metadata }) => metadata.id === "codex-appserver")?.value;
const settingsComponent = components.find(({ metadata }) => metadata.key === "llm-codex-appserver")?.value;
assert.ok(quotaComponent, "quota row must remain in settings.general.item");
assert.ok(settingsComponent, "settings card must be registered in settings.plugin.item");

function render() {
  hookIndex = 0;
  return quotaComponent();
}

function childrenOf(node) {
  const children = node?.props?.children;
  return Array.isArray(children) ? children : [children];
}

function findAll(node, predicate, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, result);
    return result;
  }
  if (!node || typeof node !== "object") return result;
  if (predicate(node)) result.push(node);
  for (const child of childrenOf(node)) findAll(child, predicate, result);
  return result;
}

let tree = render();
const disclosure = () => findAll(tree, (node) => node.type === "button" && node.props?.["aria-controls"] === "dshca-quota-details")[0];
assert.ok(disclosure(), "the whole quota summary must be expandable");
assert.equal(disclosure().props["aria-expanded"], false, "quota details must be collapsed by default");

await effects[0]();
await new Promise((resolve) => setImmediate(resolve));
tree = render();
assert.equal(disclosure().props["aria-expanded"], false, "refreshing allowance data must not expand quota details");
const collapsedBars = findAll(tree, (node) => node.props?.role === "progressbar");
assert.equal(collapsedBars.length, 1, "collapsed quota details must retain only the Codex remaining-allowance bar");
assert.ok(collapsedBars.every((bar) => bar.props.className?.split(/\s+/).includes("dshca_meter_track")), "progress bars must use the CSS track class that defines their visible height");
assert.equal(collapsedBars[0].props["aria-valuenow"], 9, "the compact Codex bar must show remaining, not used allowance");
assert.ok(collapsedBars.some((bar) => bar.props["aria-label"] === "Codex剩余额度"), "the compact Codex bar must be labelled as remaining allowance");
const collapsedMeterValues = findAll(tree, (node) => node.props?.className === "dshca_meter_value").map((node) => node.props.children);
assert.ok(collapsedMeterValues.includes("剩余 9%"), "the compact quota text must show remaining allowance");
assert.ok(!JSON.stringify(tree).includes("GPT-5.3-Codex-Spark"), "Spark must not appear in the quota row");

disclosure().props.onClick();
tree = render();
assert.equal(disclosure().props["aria-expanded"], true, "clicking the disclosure must expand quota details");
const progressBars = findAll(tree, (node) => node.props?.role === "progressbar");
assert.equal(progressBars.length, 2, "expanded details must retain only compact and detailed Codex primary bars");
assert.equal(progressBars[0].props["aria-valuenow"], 9);
assert.ok(progressBars.some((bar) => bar.props["aria-label"] === "主额度剩余额度"), "expanded details must label primary allowance bars as remaining");

disclosure().props.onClick();
tree = render();
assert.equal(disclosure().props["aria-expanded"], false, "clicking the disclosure again must collapse quota details");
assert.equal(findAll(tree, (node) => node.props?.role === "progressbar").length, 1, "collapsing quota details must retain only the compact Codex remaining-allowance bar");

state.length = 0;
hookIndex = 0;
const settingsTree = settingsComponent();
const settingInputs = findAll(settingsTree, (node) => node.type === "input");
const codexBin = settingInputs.find((node) => node.props?.value === "");
assert.ok(codexBin, "settings card must expose codexBin");
codexBin.props.onChange({ target: { value: "/custom/codex" } });
hookIndex = 0;
const draftTree = settingsComponent();
const saveButton = findAll(draftTree, (node) => node.type === "button" && node.props?.children === "保存")[0];
assert.equal(saveButton.props.disabled, false, "Save must become enabled for a draft change");
await saveButton.props.onClick();
assert.deepEqual(settingsWrites[0], { op: "set", field: "codexBin", value: "/custom/codex" });
assert.equal(fakeSettingsScope.snapshot.revision, 2, "settings writes must advance the revision fence");
hookIndex = 0;
const savedTree = settingsComponent();
const discardButton = findAll(savedTree, (node) => node.type === "button" && node.props?.children === "放弃修改")[0];
assert.equal(discardButton.props.disabled, true, "Discard is disabled when there is no draft");

console.log("dsh-codex app-server UI tests passed");
