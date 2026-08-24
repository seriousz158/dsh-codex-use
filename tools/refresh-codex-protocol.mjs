#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_CODEX_VERSION = "0.149.0";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");
const protocolDir = resolve(repoDir, "packages/dsh-codex-appserver/lib/protocol");
const aggregateSchema = join(protocolDir, "codex_app_server_protocol.v2.schemas.json");
const codexBin = process.env.CODEX_BIN || "/opt/homebrew/bin/codex";

function fail(message) {
  console.error(`refresh-codex-protocol: ${message}`);
  process.exitCode = 1;
}

function run(args) {
  const result = spawnSync(codexBin, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${codexBin} ${args.join(" ")} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

async function collectFiles(directory) {
  const files = new Map();
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const content = await readFile(path);
        files.set(relative(directory, path), createHash("sha256").update(content).digest("hex"));
      }
    }
  }
  await visit(directory);
  return files;
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}

async function main() {
  const versionOutput = run(["--version"]);
  const match = versionOutput.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/m);
  if (!match || match[1] !== EXPECTED_CODEX_VERSION) {
    throw new Error(`expected Codex CLI ${EXPECTED_CODEX_VERSION}, got ${versionOutput.trim() || "<no version>"}`);
  }

  const before = await collectFiles(protocolDir);
  const generationRoot = await mkdtemp(join(tmpdir(), "dsh-codex-protocol-"));
  const generatedJson = join(generationRoot, "json");
  const generatedTs = join(generationRoot, "ts");
  run(["app-server", "generate-json-schema", "--experimental", "--out", generatedJson]);
  run(["app-server", "generate-ts", "--experimental", "--out", generatedTs]);

  const protocolSource = await readFile(resolve(repoDir, "packages/dsh-codex-appserver/lib/protocol.js"), "utf8");
  const mappedSchemas = [...protocolSource.matchAll(/:\s*"([^"]+\.json)"/g)].map((match) => match[1]);
  const uniqueMappings = [...new Set(mappedSchemas)];
  const availability = await Promise.all(uniqueMappings.map(async (path) => [path, await requireFile(generatedJson, path)]));
  const missing = availability.filter(([, exists]) => !exists).map(([path]) => path);
  if (missing.length) throw new Error(`generated schema mappings are missing: ${missing.join(", ")}`);

  // Copy file-by-file rather than using fs.cp on macOS.  The latter may create
  // Finder-style "name 2.json" siblings instead of replacing an existing
  // generated artifact, which would pollute the package with stale duplicates.
  await copyTree(generatedJson, protocolDir);
  await copyTree(generatedTs, join(protocolDir, "ts"));

  const after = await collectFiles(protocolDir);
  const changed = [];
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  changed.sort();
  const schemaHash = createHash("sha256").update(await readFile(aggregateSchema)).digest("hex");
  console.log(`Codex CLI: ${EXPECTED_CODEX_VERSION}`);
  console.log(`Generated with: --experimental`);
  console.log(`Schema SHA-256: ${schemaHash}`);
  console.log(`Changed files (${changed.length}):`);
  for (const path of changed) console.log(`- ${path}`);
  console.log("Unreferenced files from older schema generations are retained; remove them only in an explicit cleanup change.");
}

function requireFile(root, path) {
  // Mappings are relative to lib/protocol.  The generator's v2 files live in
  // the v2 subdirectory, while a few approval files remain at the root.
  return stat(resolve(root, path)).then(() => true, () => false);
}

main().catch((error) => fail(error.message));
