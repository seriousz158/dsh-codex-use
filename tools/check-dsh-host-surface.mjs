#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
function isRequired() {
  return process.env.DSH_HOST_SURFACE_REQUIRED === "1";
}

function commandOnPath(command) {
  for (const entry of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

export function locateDshBinary() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const explicit = process.env.DSH_BIN;
  const candidates = unique([
    explicit,
    commandOnPath("dsh"),
    join(home, "runtime", "dsh-0.1.0-rc.7", "node_modules", ".bin", "dsh"),
    join(home, "runtime", "dsh", "node_modules", ".bin", "dsh"),
    join(homedir(), ".dsh", "runtime", "dsh-0.1.0-rc.7", "node_modules", ".bin", "dsh"),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function locateRuntimeNodeModules(dshBin = locateDshBinary()) {
  if (process.env.DSH_RUNTIME_NODE_MODULES && existsSync(process.env.DSH_RUNTIME_NODE_MODULES)) {
    return resolve(process.env.DSH_RUNTIME_NODE_MODULES);
  }
  if (!dshBin) return null;
  let current = resolve(dshBin);
  for (let index = 0; index < 6; index += 1) {
    current = dirname(current);
    if (current.endsWith("/node_modules") && existsSync(current)) return current;
  }
  return null;
}

function packageFile(nodeModules, packageName, relativePath) {
  return nodeModules ? join(nodeModules, packageName, relativePath) : null;
}

export function inspectHostSurface({ dshBin = locateDshBinary(), runtimeNodeModules = locateRuntimeNodeModules(dshBin) } = {}) {
  const checks = {
    dshRuntime: Boolean(dshBin && existsSync(dshBin)),
    settingsScope: false,
    pluginSlot: false,
  };
  const files = {};
  if (runtimeNodeModules) {
    files.settings = packageFile(runtimeNodeModules, "@deepseek-ai/dsh-client-ui-settings", "lib/client.js");
    files.pluginSettings = packageFile(runtimeNodeModules, "@deepseek-ai/dsh-client-ui-settings-plugins", "lib/client.js");
    checks.settingsScope = Boolean(files.settings && existsSync(files.settings)
      && /settingsScope/.test(readFileSync(files.settings, "utf8")));
    checks.pluginSlot = Boolean(files.pluginSettings && existsSync(files.pluginSettings)
      && /settings\.plugin\.item/.test(readFileSync(files.pluginSettings, "utf8")));
  }

  const browser = process.env.PLAYWRIGHT_CLI || commandOnPath("playwright-cli") || join(homedir(), ".codex", "skills", "playwright", "scripts", "playwright_cli.sh");
  checks.browser = Boolean(browser);
  const missing = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const runtimeMissing = !checks.dshRuntime;
  const browserMissing = !checks.browser;
  const surfaceMissing = checks.dshRuntime && (!checks.settingsScope || !checks.pluginSlot);

  return {
    dshBin,
    runtimeNodeModules,
    browser,
    checks,
    missing,
    runtimeMissing,
    browserMissing,
    surfaceMissing,
    fallback: {
      slot: checks.pluginSlot ? "settings.plugin.item" : "settings.general.item",
      settingsTransport: checks.settingsScope ? "settingsScope.bind" : "unavailable",
    },
  };
}

function packageDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "dsh-codex-appserver");
}

async function createTemporaryProfile(dshBin) {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "dsh-codex-host-surface-"));
  const dshHome = join(root, ".dsh");
  await mkdir(dshHome, { recursive: true, mode: 0o700 });
  const packagePath = process.env.DSH_PLUGIN_DIR || packageDirectory();
  await execFile(dshBin, ["plugin", "--profile", "web", "add", packagePath], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 120_000,
  });
  return { root, dshHome, packagePath };
}

async function launchWeb(dshBin, dshHome) {
  const child = spawn(dshBin, ["web", "--host", "127.0.0.1", "--port", "0"], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for DSH Web (${errorOutput.trim() || "no stderr"})`)), 30_000);
    const poll = () => {
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolveUrl(match[0]); return; }
      if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`DSH Web exited (${child.exitCode}): ${errorOutput.trim()}`)); return; }
      setTimeout(poll, 100);
    };
    poll();
  });
  return { child, url };
}

function snapshotRef(snapshot, pattern) {
  const lines = String(snapshot).split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return null;
  return lines[index].match(/\[ref=(e\d+)\]/)?.[1] ?? null;
}

function snapshotInputRef(snapshot, labelPattern) {
  const lines = String(snapshot).split("\n");
  const index = lines.findIndex((line) => labelPattern.test(line));
  if (index < 0) return null;
  for (const line of lines.slice(index, index + 8)) {
    if (!/(?:textbox|spinbutton)/.test(line)) continue;
    const ref = line.match(/\[ref=(e\d+)\]/);
    if (ref) return ref[1];
  }
  return null;
}

async function browserCommand(browser, args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFile(browser, args, { encoding: "utf8", timeout: 60_000 });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    if (allowFailure) return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    throw new Error(`Playwright ${args.join(" ")} failed: ${error.stderr || error.message}`);
  }
}

export async function runBrowserSurfaceCheck({ browser, url, dshHome }) {
  if (!browser || !existsSync(browser)) throw new Error("Playwright CLI is not available");
  await browserCommand(browser, ["open", url]);
  let snapshot = await browserCommand(browser, ["snapshot"]);
  const continueRef = snapshotRef(snapshot, /button "继续"/);
  if (continueRef) await browserCommand(browser, ["click", continueRef]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  const settingsRef = snapshotRef(snapshot, /button "设置"/);
  if (!settingsRef) throw new Error("settings trigger is not visible in the Web surface");
  await browserCommand(browser, ["click", settingsRef]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  if (!/Codex 套餐额度/.test(snapshot)) throw new Error("Codex quota row is not visible");
  const pluginRef = snapshotRef(snapshot, /button "插件"/);
  if (!pluginRef) throw new Error("plugin settings tab is not visible in the Web surface");
  await browserCommand(browser, ["click", pluginRef]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  if (!/Codex App Server/.test(snapshot) || !/settings\.plugin\.item|Codex CLI/.test(snapshot)) throw new Error("Codex plugin settings card is not visible in the Web settings surface");

  const codexInput = snapshotInputRef(snapshot, /Codex CLI 路径/);
  const save = snapshotRef(snapshot, /button "保存"/);
  if (!codexInput || !save) throw new Error("settings card controls are missing");
  const testCodexPath = "/opt/homebrew/bin/codex";
  await browserCommand(browser, ["fill", codexInput, testCodexPath]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  const saveAfterEdit = snapshotRef(snapshot, /button "保存"/);
  if (!saveAfterEdit || !/button "保存"[^\n]*\[ref=/.test(snapshot)) throw new Error("Save did not become available for a draft");
  await browserCommand(browser, ["click", saveAfterEdit]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  if (!snapshot.includes(testCodexPath)) throw new Error("saved codexBin value was not reflected in the settings snapshot");

  const discardInput = snapshotInputRef(snapshot, /Codex CLI 路径/);
  const discard = snapshotRef(snapshot, /button "放弃修改"/);
  await browserCommand(browser, ["fill", discardInput, "/tmp/dsh-codex-discard-check"]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  const discardAfterEdit = snapshotRef(snapshot, /button "放弃修改"/);
  await browserCommand(browser, ["click", discardAfterEdit]);
  snapshot = await browserCommand(browser, ["snapshot"]);
  if (snapshot.includes("/tmp/dsh-codex-discard-check")) throw new Error("Discard did not restore the saved settings snapshot");

  const settingsFile = join(dshHome, "settings.yaml");
  if (existsSync(settingsFile)) {
    const persisted = await readFile(settingsFile, "utf8");
    if (!persisted.includes("llm-codex-appserver")) throw new Error("settings Save did not persist the plugin namespace");
  }
  await browserCommand(browser, ["close"], { allowFailure: true });
  return { visible: true, saved: true, discarded: true };
}

export async function runLiveHostSurfaceCheck({ dshBin = locateDshBinary(), browser } = {}) {
  if (!dshBin || !existsSync(dshBin)) throw new Error("DSH rc.7 runtime is not available");
  const profile = await createTemporaryProfile(dshBin);
  const web = await launchWeb(dshBin, profile.dshHome);
  try {
    const browserResult = await runBrowserSurfaceCheck({ browser, url: web.url, dshHome: profile.dshHome });
    return { ...profile, url: web.url, browser: browserResult };
  } finally {
    web.child.kill("SIGTERM");
  }
}

export function hostSurfaceResult(options = {}) {
  const result = inspectHostSurface(options);
  if (result.surfaceMissing) {
    return { ...result, state: "failed", reason: "DSH runtime is present but required Host settings surface is missing" };
  }
  if (result.runtimeMissing || result.browserMissing) {
    return {
      ...result,
      state: isRequired() ? "failed" : "skipped",
      reason: result.runtimeMissing
        ? "DSH rc.7 runtime is not available"
        : "Playwright/browser runtime is not available",
    };
  }
  return {
    ...result,
    state: "ready",
    reason: "Host settings slot and settingsScope transport are available",
  };
}

export function printResult(result, { json = false } = {}) {
  const output = {
    schemaVersion: 1,
    state: result.state,
    reason: result.reason,
    dshBin: result.dshBin,
    runtimeNodeModules: result.runtimeNodeModules,
    browser: result.browser,
    checks: result.checks,
    fallback: result.fallback,
    live: result.live ?? null,
  };
  if (json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[${result.state.toUpperCase()}] ${result.reason}`);
    for (const [key, value] of Object.entries(result.checks)) {
      console.log(`  ${key}: ${value ? "ok" : "missing"}`);
    }
    console.log(`  slot: ${result.fallback.slot}`);
    console.log(`  settings transport: ${result.fallback.settingsTransport}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const staticResult = hostSurfaceResult();
  const needsLive = staticResult.state === "ready" && !process.argv.includes("--static");
  if (!needsLive) {
    printResult(staticResult, { json });
    process.exitCode = staticResult.state === "failed" ? 1 : 0;
  } else {
    runLiveHostSurfaceCheck({ dshBin: staticResult.dshBin, browser: staticResult.browser })
      .then((live) => {
        const result = { ...staticResult, state: "ready", reason: "Host settings slot, revision-fenced card, quota row, and temporary Web profile were verified", live: { url: live.url, browser: live.browser } };
        printResult(result, { json });
      })
      .catch((error) => {
        const result = { ...staticResult, state: "failed", reason: error.message };
        printResult(result, { json });
        process.exitCode = 1;
      });
  }
}
