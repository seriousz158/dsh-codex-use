import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), "utf8"));

const rootManifest = await readJson("package.json");
const appserver = await readJson("packages/dsh-codex-appserver/package.json");
const search = await readJson("packages/dsh-codex-search/package.json");
const compatibility = await readJson("packages/dsh-codex-appserver/compatibility.json");

const appserverRange = appserver.peerDependencies["@deepseek-ai/dsh-llm"];
const searchRange = search.peerDependencies["@deepseek-ai/dsh-llm"];

assert.equal(rootManifest.version, "0.2.4");
assert.equal(appserver.version, "0.2.4");
assert.equal(search.version, "0.1.0");
assert.equal(appserver.version, compatibility.pluginVersion);
assert.equal(compatibility.codex.cliVersion, "0.149.0");
assert.equal(compatibility.codex.protocol, "v2");
assert.equal(compatibility.dsh.supported, appserverRange);
assert.equal(searchRange, appserverRange);
for (const name of ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-settings"]) {
  assert.equal(search.peerDependencies[name], searchRange);
}
for (const name of ["@deepseek-ai/dsh-attachment", "@deepseek-ai/dsh-typert-protocol"]) {
  assert.equal(Object.hasOwn(search.peerDependencies, name), false, `${name} must not be added to search peers`);
}
for (const name of [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-typert-protocol",
]) {
  assert.equal(appserver.peerDependencies[name], appserverRange);
}

for (const version of ["0.1.0-rc.7", "0.1.1-rc.2", "0.1.1"]) {
  assert.equal(semver.satisfies(version, appserverRange), true, `${version} must satisfy ${appserverRange}`);
}
assert.equal(semver.satisfies("0.2.0-rc.1", appserverRange), false);
assert.deepEqual(compatibility.dsh.verified, ["0.1.0-rc.7", "0.1.1-rc.2"]);

console.log(`DSH peer range contract passed (${appserverRange})`);
