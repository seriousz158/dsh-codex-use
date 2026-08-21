import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXPECTED_CODEX_VERSION,
  PROBE_METHODS,
  assertProbeMethod,
  assertReadOnlyTrace,
  runProbe,
  sanitizeFrame,
} from "../tools/codex-appserver-probe.mjs";

const root = new URL("..", import.meta.url);
const fixturePath = new URL("../tools/fixtures/codex-appserver-0.144.1.json", import.meta.url);
const contractsPath = new URL("../tools/fixtures/codex-appserver-contract-samples-0.144.1.json", import.meta.url);

const sensitive = {
  account: {
    id: "account-private",
    email: "private@example.test",
    codexHome: "/Users/private/.codex",
    authToken: "private-token",
  },
  user: { id: "user-private" },
  cwd: "/Users/private/project",
  path: "/Users/private/project/secret.txt",
  installationId: "installation-private",
  serverName: "private-machine.local",
  userAgent: "private-user-agent",
  model: { id: "model-public" },
};
const redacted = sanitizeFrame(sensitive);
assert.equal(redacted.account.id, "[REDACTED]");
assert.equal(redacted.account.email, "[REDACTED]");
assert.equal(redacted.account.codexHome, "[REDACTED]");
assert.equal(redacted.account.authToken, "[REDACTED]");
assert.equal(redacted.user.id, "[REDACTED]");
assert.equal(redacted.cwd, "[REDACTED_PATH]");
assert.equal(redacted.path, "[REDACTED_PATH]");
assert.equal(redacted.installationId, "[REDACTED]");
assert.equal(redacted.serverName, "[REDACTED]");
assert.equal(redacted.userAgent, "[REDACTED]");
assert.equal(redacted.model.id, "model-public");
assert.throws(() => assertProbeMethod("turn/start"), /not allowed/);
assert.throws(() => assertReadOnlyTrace([{ direction: "out", frame: { method: "thread/start" } }]), /not allowed/);

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.equal(fixture.fixtureVersion, 1);
assert.equal(fixture.codexCliVersion, EXPECTED_CODEX_VERSION);
assert.equal(typeof fixture.protocolVersion, "string");
assert.equal(typeof fixture.generatedAt, "string");
assert.equal(typeof fixture.probe.observedRateLimitUpdate, "boolean");
assertReadOnlyTrace(fixture.frames);
for (const event of fixture.frames) {
  const method = event?.frame?.method;
  if (event?.direction === "out") assert.ok(PROBE_METHODS.has(method), `unexpected probe method ${method}`);
}
const serialized = JSON.stringify(fixture);
assert.doesNotMatch(serialized, /"email"\s*:\s*"(?!\[REDACTED\])/i);
assert.doesNotMatch(serialized, /private@example\.test/i);

const contracts = JSON.parse(await readFile(contractsPath, "utf8"));
assert.equal(contracts.codexCliVersion, EXPECTED_CODEX_VERSION);
assert.equal(contracts.protocolVersion, fixture.protocolVersion);
assert.equal(contracts.turnCompleted.method, "turn/completed");
assert.equal(Object.hasOwn(contracts.turnCompleted.params, "usage"), false);
assert.equal(contracts.tokenUsageUpdated.method, "thread/tokenUsage/updated");
assert.ok(contracts.tokenUsageUpdated.params.tokenUsage.last);
assert.ok(contracts.tokenUsageUpdated.params.tokenUsage.total);

const probeDirectory = await mkdtemp(join(tmpdir(), "dsh-codex-probe-"));
const fakeCodex = join(probeDirectory, "fake-codex.mjs");
await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv[2] === "--version") {
  console.log("codex ${EXPECTED_CODEX_VERSION}");
  process.exit(0);
}
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (!request.id) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "fake/${EXPECTED_CODEX_VERSION}" };
  else if (request.method === "account/read") result = { account: { id: "private-account", email: "private@example.test", codexHome: "/Users/private/.codex" } };
  else if (request.method === "account/rateLimits/read") result = { rateLimits: { limitId: "codex", primary: { usedPercent: 2 } } };
  else if (request.method === "model/list" && request.params.cursor === null) result = { data: [{ id: "model-a" }], nextCursor: "cursor-2" };
  else if (request.method === "model/list" && request.params.cursor === "cursor-2") result = { data: [{ id: "model-b" }], nextCursor: null };
  else result = { unexpected: request.method };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`, { mode: 0o700 });
await chmod(fakeCodex, 0o700);
const liveFixtureDirectory = join(probeDirectory, "fixtures");
const probe = await runProbe({ codexBin: fakeCodex, outputDir: liveFixtureDirectory });
assert.equal(probe.fixture.probe.modelCount, 2);
assert.equal(probe.fixture.protocolVersion, `fake/${EXPECTED_CODEX_VERSION}`);
assert.equal(probe.fixture.probe.observedRateLimitUpdate, false, "the probe must distinguish an absent passive rate-limit update from a received one");
assertReadOnlyTrace(probe.fixture.frames);
const pagedRequests = probe.fixture.frames.filter((event) => event.direction === "out" && event.frame.method === "model/list");
assert.deepEqual(pagedRequests.map((event) => event.frame.params.cursor), [null, "cursor-2"]);
assert.doesNotMatch(JSON.stringify(probe.fixture), /private@example\.test|private-account|\/Users\/private/);

const defaultProbe = await runProbe({ codexBin: fakeCodex });
assert.ok(defaultProbe.output.startsWith(tmpdir()), "the probe must write to a temporary directory by default");
assert.notEqual(dirname(defaultProbe.output), new URL("../tools/fixtures/", import.meta.url).pathname.replace(/\/$/, ""));
assert.doesNotMatch(JSON.stringify(defaultProbe.fixture), /private@example\.test|private-account|\/Users\/private/);

console.log("dsh-codex app-server probe tests passed");
