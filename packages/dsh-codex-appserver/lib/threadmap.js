import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const THREADMAP_VERSION = 1;
export function defaultThreadMapPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(resolve(home), "storages", "codex-appserver", "threads.json");
}

function emptyMap() { return { version: THREADMAP_VERSION, entries: {} }; }
function validMap(value) {
  return value && value.version === THREADMAP_VERSION && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries);
}

export class ThreadMapStore {
  constructor(path = defaultThreadMapPath()) {
    this.path = resolve(path);
    this.queue = Promise.resolve();
  }

  #locked(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async #readUnlocked() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (!validMap(parsed)) throw new Error("invalid threadmap version");
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return emptyMap();
      throw Object.assign(new Error(`Codex threadmap is corrupt: ${error.message}`), { code: "threadmap-corrupt", cause: error });
    }
  }

  async #writeUnlocked(value) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async read() { return await this.#locked(() => this.#readUnlocked()); }

  async get(sessionId) {
    const map = await this.read();
    return map.entries[String(sessionId)] ?? null;
  }

  async set(sessionId, entry) {
    return await this.#locked(async () => {
      const map = await this.#readUnlocked();
      map.entries[String(sessionId)] = { ...entry, updatedAt: new Date().toISOString() };
      await this.#writeUnlocked(map);
      return map.entries[String(sessionId)];
    });
  }

  async remove(sessionId) {
    return await this.#locked(async () => {
      const map = await this.#readUnlocked();
      delete map.entries[String(sessionId)];
      await this.#writeUnlocked(map);
    });
  }
}
