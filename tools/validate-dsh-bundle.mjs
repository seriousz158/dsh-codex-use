import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages", "dsh-codex-appserver");
const packageFile = join(packageDir, "package.json");
const manifest = JSON.parse(await readFile(packageFile, "utf8"));
const patchPath = manifest.dsh?.bundle?.patch;

assert.equal(typeof patchPath, "string", "package.json must declare dsh.bundle.patch");
assert.ok(!patchPath.startsWith("/"), "bundle patch must be relative to the package");
const patchFile = resolve(packageDir, patchPath);
const packageRelativePatch = relative(packageDir, patchFile);
assert.equal(packageRelativePatch, patchPath.replace(/^\.\//, ""), "bundle patch must stay inside the package");
await access(patchFile, constants.R_OK);
const patch = await readFile(patchFile, "utf8");
assert.match(patch, new RegExp(`name:\\s*${manifest.name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "m"));
assert.equal(manifest.exports?.["./cordis.patch.yml"], patchPath, "cordis.patch.yml must be exported");
assert.ok(manifest.files?.includes("lib"), "published files must include lib");
assert.ok(manifest.files?.includes("cordis.patch.yml"), "published files must include cordis.patch.yml");
assert.match(manifest.peerDependencies?.["@deepseek-ai/dsh-llm"] ?? "", /0\.1\.0-rc\.6/);
assert.match(manifest.peerDependencies?.["@deepseek-ai/dsh-settings"] ?? "", /0\.1\.0-rc\.6/);
assert.match(manifest.peerDependencies?.["@deepseek-ai/dsh-typert-protocol"] ?? "", /0\.1\.0-rc\.6/);

console.log(`dsh bundle validation passed: ${manifest.name}@${manifest.version}`);
