import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const expected = process.env.DSH_DESKTOP_VERSION || "0.2.0-rc.2";
const escape = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const name of ["dsh-codex-appserver", "dsh-codex-search"]) {
  const path = join(root, "packages", name, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (peer.startsWith("@deepseek-ai/dsh-")) assert.match(range, new RegExp(escape), `${name}: ${peer}`);
  }
}
const compatibility = JSON.parse(await readFile(join(root, "packages/dsh-codex-appserver/compatibility.json"), "utf8"));
assert.equal(compatibility.dsh.verified.includes(expected), true);
console.log(`DSH desktop ${expected} Codex compatibility contract passed`);
