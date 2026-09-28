import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Config, NS } from "../packages/dsh-codex-appserver/lib/index.js";
import { sandboxPolicy } from "../packages/dsh-codex-appserver/lib/protocol.js";

test("0.2.x settings keep the safe defaults and expose only the gated Fast Mode switch", () => {
  assert.equal(NS, "llm-codex-appserver");
  const resolved = Object.fromEntries(Object.entries(Config({})).map(([key, value]) => [key, typeof value?.get === "function" ? value.get() : value]));
  assert.deepEqual(resolved, {
    codexBin: "",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    ephemeralThreads: true,
    injectMemory: false,
    historyBootstrap: 20,
    rateLimitRefreshSec: 30,
    requestTimeoutMs: 600000,
    fastMode: false,
  });
});

test("the existing profile's danger-full-access choice remains usable", () => {
  const sandbox = Config({ sandbox: "danger-full-access" }).sandbox;
  assert.equal(typeof sandbox?.get === "function" ? sandbox.get() : sandbox, "danger-full-access");
  assert.deepEqual(sandboxPolicy("danger-full-access", "/tmp"), { type: "dangerFullAccess" });
});

const client = await readFile(new URL("../packages/dsh-codex-appserver/lib/client.js", import.meta.url), "utf8");
assert.match(client, /settings\.plugin\.item/);
assert.match(client, /scope\.set|settingsScope\.set/);
assert.match(client, /settingsScope\.unset/);
assert.match(client, /放弃修改/);

console.log("settings checks passed");
