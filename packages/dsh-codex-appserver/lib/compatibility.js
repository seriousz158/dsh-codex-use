import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compatibilityPath = resolve(packageDirectory, "compatibility.json");
export const COMPATIBILITY = Object.freeze(JSON.parse(readFileSync(compatibilityPath, "utf8")));
export const EXPECTED_CODEX_VERSION = COMPATIBILITY.codex.cliVersion;
export const EXPECTED_DSH_RANGE = COMPATIBILITY.dsh.supported;
export const PROTOCOL_SCHEMA_PATH = resolve(packageDirectory, COMPATIBILITY.codex.schemaFile);

export function protocolSchemaSha256() {
  return createHash("sha256").update(readFileSync(PROTOCOL_SCHEMA_PATH)).digest("hex");
}

export function verifyCompatibility() {
  const actual = protocolSchemaSha256();
  return { ok: actual === COMPATIBILITY.codex.schemaSha256, expected: COMPATIBILITY.codex.schemaSha256, actual };
}
