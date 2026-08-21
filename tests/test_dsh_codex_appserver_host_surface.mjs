import assert from "node:assert/strict";
import test from "node:test";

import {
  hostSurfaceResult,
  inspectHostSurface,
} from "../tools/check-dsh-host-surface.mjs";

test("host surface check skips when DSH runtime is unavailable", () => {
  const previous = process.env.DSH_HOST_SURFACE_REQUIRED;
  delete process.env.DSH_HOST_SURFACE_REQUIRED;
  try {
    const result = hostSurfaceResult({
      dshBin: "/tmp/dsh-codex-use-missing/dsh",
      runtimeNodeModules: "/tmp/dsh-codex-use-missing/node_modules",
    });
    assert.equal(result.state, "skipped");
    assert.equal(result.checks.dshRuntime, false);
    assert.equal(result.fallback.slot, "settings.general.item");
    assert.equal(result.fallback.settingsTransport, "unavailable");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOST_SURFACE_REQUIRED;
    else process.env.DSH_HOST_SURFACE_REQUIRED = previous;
  }
});

test("required host surface check fails when dependencies are missing", () => {
  const previous = process.env.DSH_HOST_SURFACE_REQUIRED;
  process.env.DSH_HOST_SURFACE_REQUIRED = "1";
  try {
    const result = hostSurfaceResult({
      dshBin: "/tmp/dsh-codex-use-missing/dsh",
      runtimeNodeModules: "/tmp/dsh-codex-use-missing/node_modules",
    });
    assert.equal(result.state, "failed");
    assert.match(result.reason, /runtime/i);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOST_SURFACE_REQUIRED;
    else process.env.DSH_HOST_SURFACE_REQUIRED = previous;
  }
});

test("rc.7 host packages expose settings transport and plugin slot", () => {
  const runtimeNodeModules = process.env.DSH_RUNTIME_NODE_MODULES;
  if (!runtimeNodeModules) {
    console.log("SKIP: DSH_RUNTIME_NODE_MODULES is not set");
    return;
  }
  const result = inspectHostSurface({
    dshBin: process.env.DSH_BIN || "/tmp/dsh-codex-use-missing/dsh",
    runtimeNodeModules,
  });
  assert.equal(result.checks.settingsScope, true);
  assert.equal(result.checks.pluginSlot, true);
});

console.log("host surface unit checks passed");
