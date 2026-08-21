import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadMapStore, THREADMAP_VERSION } from "../packages/dsh-codex-appserver/lib/threadmap.js";

const directory = await mkdtemp(join(tmpdir(), "dsh-codex-threadmap-"));
const path = join(directory, "threads.json");
const store = new ThreadMapStore(path);

await Promise.all(Array.from({ length: 24 }, async (_, index) => {
  await store.set(`session-${index}`, {
    providerEpoch: 1,
    threadId: `thread-${index}`,
    model: "model-1",
    checkpointUserMsgId: null,
    memorySnapshotHash: null,
    inFlight: null,
  });
}));
const map = await store.read();
assert.equal(map.version, THREADMAP_VERSION);
assert.equal(Object.keys(map.entries).length, 24, "process-local serialization must retain concurrent session writes");
assert.equal(map.entries["session-17"].threadId, "thread-17");
assert.equal((await stat(path)).mode & 0o777, 0o600, "thread maps must not be world-readable");
assert.equal((await readdir(directory)).some((name) => name.includes(".tmp-")), false, "atomic rename must not leave a temporary threadmap behind");

await writeFile(path, "not valid JSON", { mode: 0o600 });
await assert.rejects(store.read(), (error) => error?.code === "threadmap-corrupt");

console.log("dsh-codex app-server threadmap tests passed");
