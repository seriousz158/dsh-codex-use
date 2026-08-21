import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const output = execFileSync("npm", [
  "pack",
  "--dry-run",
  "--workspace",
  "packages/dsh-codex-appserver",
  "--json",
], { cwd: root, encoding: "utf8" });
const pack = JSON.parse(output);
const files = new Set(pack[0]?.files?.map(({ path }) => path));

for (const required of [
  "package.json",
  "README.md",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/types/index.d.ts",
]) assert.ok(files.has(required), `packed bundle is missing ${required}`);
for (const forbidden of ["node_modules/", ".env", ".dsh/"]) {
  assert.equal([...files].some((file) => file.startsWith(forbidden)), false, `packed bundle contains ${forbidden}`);
}

console.log(`dsh-codex-appserver release archive tests passed (${files.size} files)`);
