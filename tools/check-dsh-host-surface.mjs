#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  const browser = process.env.PLAYWRIGHT_CLI || commandOnPath("playwright-cli") || commandOnPath("playwright");
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
  const result = hostSurfaceResult();
  printResult(result, { json });
  process.exitCode = result.state === "failed" ? 1 : 0;
}
