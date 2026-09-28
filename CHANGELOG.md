# Changelog

## 0.2.7 — 2026-09-28

- Support DSH `0.1.7-rc.2`'s live Config forms, Plugins tab, and Typert strict-codec factory while retaining the `0.1.5-rc.2` settings path.
- Verify a temporary Web profile can save plugin settings and display Codex quota; retain the stream-recovery and quota regression suite.

## 0.2.6 — 2026-09-28

- Refresh the App Server JSON Schema and TypeScript protocol artifacts from Codex CLI `0.158.0` with `--experimental`.
- Verify read-only account, quota, and model discovery against CLI `0.158.0` and retain strict version matching.
- Accept DSH's current string settings namespace and preserve the existing `danger-full-access` configuration option.
- Keep Codex CLI `0.149.0` as a historical fixture only.

## 0.2.5 — 2026-08-26

- Treat a successful ChatGPT `account/read` response with
  `requiresOpenaiAuth: true` as authenticated when an account is present.
- Keep explicit authentication errors and account-less auth signals as
  `reauth-required`, while preserving quota refresh and stale-snapshot behavior.
- Distribution remains via GitHub source/Releases; no `npm publish`.

## 0.2.4 — 2026-08-24

- Refresh the vendored App Server JSON Schema and TypeScript protocol artifacts from
  Codex CLI `0.149.0` with `--experimental`.
- Adapt the quota and model contracts to the new `rateLimitsByLimitId`, spend-control,
  service-tier, and model metadata fields while exposing only the public `codex` bucket.
- Keep `injectMemory` fail-closed for this protocol; no memory is promoted to
  `developerInstructions` or sent as an unsupported turn field.
- Make the portable installer isolate its tests, migrate only an explicitly declared
  legacy active link, back up stale links atomically, and reject unknown targets.
- Retain Codex `0.144.1` as historical replay fixtures only. Distribution remains via
  GitHub source/Releases; no `npm publish`.

## 0.2.3 — 2026-08-23

- Fix DSH peer ranges for prerelease runtimes `0.1.0-rc.7` and `0.1.1-rc.2`.
- Publish the core App Server Bundle as the first `0.2.3` GitHub Release artifact.
- Keep Codex CLI compatibility fail-closed at `0.144.1`; no live model turn is used by release gates.
- Document GitHub source/Release distribution; this project is not published to npm.

## 0.1.1 — 2026-08-21

- Add the official DSH Bundle manifest and patch for profile-based installation.
- Add prerelease-compatible DSH peer ranges and a published package file allowlist.
- Make the portable installer migrate legacy shared-host registrations with a backup and
  disable itself when the Bundle path is active.
- Add the MIT license and document the standard marketplace installation path.

## 0.1.0 — 2026-08-21

- Export the DSH Codex App Server provider as a standalone source repository.
- Add a portable DSH_HOME-based installer with duplicate-registration guards.
- Include protocol fixtures, read-only probe, adapter/RPC/thread-map/UI tests, and CI.
