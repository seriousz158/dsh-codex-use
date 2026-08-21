import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildOfflineDiagnostics,
  findProviderConflicts,
  scanStaticProviderConflicts,
  summarizeLiveFixture,
} from "../packages/dsh-codex-appserver/lib/diagnostics.js";

import { readFile } from "node:fs/promises";

test("offline doctor is metadata-only and reports unknown account/quota", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-codex-doctor-"));
  const report = await buildOfflineDiagnostics({
    dshHome: home,
    profile: "web",
    dshBin: join(home, "missing-dsh"),
    codexBin: join(home, "missing-codex"),
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.account.state, "unknown");
  assert.equal(report.quota.state, "unknown");
  assert.equal(report.registration.providerRegistered, null);
  assert.equal(report.profile.home, home);
  assert.ok(report.issues.some((item) => item.code === "codex-not-found"));
});

test("provider conflict detection separates hard and soft routes", () => {
  const result = findProviderConflicts({
    providers: [{ id: "codex-chatgpt", name: "old" }, { id: "dsh-codex", name: "legacy" }],
    configurableProviders: [{ provider: "openai-codex" }, { provider: "openai-codex" }],
  });
  assert.equal(result.hard[0].id, "codex-chatgpt");
  assert.ok(result.hard.some((entry) => entry.kind === "duplicate-configurable-provider"));
  assert.deepEqual(result.soft.map((entry) => entry.id), ["dsh-codex", "openai-codex"]);
});

test("static profile scan never reads credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-codex-static-"));
  const patch = join(root, "cordis.patch.yml");
  await writeFile(patch, "- id: old\n  provider: openai-codex\n", { mode: 0o600 });
  const result = scanStaticProviderConflicts({ files: [patch] });
  assert.equal(result.hard.length, 0);
  assert.deepEqual(result.soft.map((entry) => entry.id), ["openai-codex"]);
});

test("live fixture summarizer keeps account, quota, and model metadata bounded", async () => {
  const fixture = JSON.parse(await readFile(new URL("../tools/fixtures/codex-appserver-0.144.1.json", import.meta.url), "utf8"));
  const report = summarizeLiveFixture(fixture);
  assert.equal(report.account.state, "account-readable");
  assert.equal(report.quota.state, "available");
  assert.equal(report.quota.buckets.codex.limitId, "codex");
  assert.ok(report.models.count > 0);
});

console.log("doctor checks passed");
