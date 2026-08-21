#!/usr/bin/env node

import { buildLiveDiagnostics, buildOfflineDiagnostics, formatDiagnosticsError } from "../packages/dsh-codex-appserver/lib/diagnostics.js";
import { locateDshBinary } from "./check-dsh-host-surface.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const json = process.argv.includes("--json");
const live = process.argv.includes("--live");
const options = {
  dshBin: process.env.DSH_BIN || locateDshBinary(),
  codexBin: option("--codex-bin") || process.env.CODEX_BIN || "codex",
  dshHome: option("--dsh-home") || process.env.DSH_HOME,
  profile: option("--profile") || process.env.DSH_PROFILE || "web",
};

try {
  const report = live ? await buildLiveDiagnostics(options) : await buildOfflineDiagnostics(options);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${live ? "live" : "offline"} doctor: ${report.issues.length === 0 ? "ok" : `${report.issues.length} issue(s)`}`);
    console.log(`  Codex: ${report.runtime.codexCli.available ? report.runtime.codexCli.version : "unavailable"}`);
    console.log(`  Protocol: ${report.protocol.compatible === true ? "compatible" : report.protocol.compatible === false ? "mismatch" : "unknown"}`);
    console.log(`  Account: ${report.account.state}`);
    console.log(`  Quota: ${report.quota.state}`);
    if (report.issues.length > 0) for (const item of report.issues) console.log(`  - [${item.code}] ${item.message}`);
  }
} catch (error) {
  const failure = formatDiagnosticsError(error);
  if (json) console.log(JSON.stringify({ schemaVersion: 1, issues: [failure] }, null, 2));
  else console.error(`doctor failed: [${failure.code}] ${failure.message}`);
  process.exitCode = 1;
}
