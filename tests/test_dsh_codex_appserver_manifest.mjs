import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "dsh-codex-appserver");
const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const patch = await readFile(join(packageDir, "cordis.patch.yml"), "utf8");

assert.equal(manifest.name, "dsh-codex-appserver");
assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(manifest.dsh?.client?.platform, "web");
assert.equal(manifest.exports?.["./cordis.patch.yml"], "./cordis.patch.yml");
assert.ok(manifest.files.includes("cordis.patch.yml"));
for (const name of [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-typert-protocol",
]) {
  assert.equal(manifest.peerDependencies[name], ">=0.1.0-rc.6 <0.2.0-0");
}
assert.match(patch, /- id: codex-appserver\n\s+name: dsh-codex-appserver\n?$/m);

console.log("dsh-codex-appserver bundle manifest tests passed");
