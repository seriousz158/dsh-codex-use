import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Config, NS, PROVIDER } from "../packages/dsh-codex-search/lib/index.js";
import { isPrivateAddress, validateSearchUrl } from "../packages/dsh-codex-search/lib/remote-search.js";

test("search is a separate provider and disabled by default", () => {
  assert.equal(PROVIDER, "codex-search");
  assert.equal(NS, "llm-codex-search");
  assert.deepEqual(Config({}), { enabled: false, endpoint: "", maxResponseBytes: 1_000_000, timeoutMs: 10_000 });
});

const searchManifest = JSON.parse(await readFile(new URL("../packages/dsh-codex-search/package.json", import.meta.url), "utf8"));
const searchPatch = await readFile(new URL("../packages/dsh-codex-search/cordis.patch.yml", import.meta.url), "utf8");
assert.equal(searchManifest.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.ok(searchManifest.files.includes("lib"));
assert.match(searchPatch, /name: dsh-codex-search/);

test("SSRF validation rejects private and credential-bearing endpoints", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.8"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.throws(() => validateSearchUrl("http://127.0.0.1/search"), /private/);
  assert.throws(() => validateSearchUrl("https://user:pass@example.com/search"), /credentials/);
  assert.throws(() => validateSearchUrl("ftp://example.com/search"), /http or https/);
  assert.equal(validateSearchUrl("https://example.com/search").hostname, "example.com");
});

console.log("codex search checks passed");
