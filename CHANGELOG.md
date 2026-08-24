# Changelog

## 0.2.4 — 2026-08-24

- Refresh the vendored App Server JSON Schema and TypeScript protocol artifacts from
  Codex CLI `0.149.0` with `--experimental`.
- Adapt the quota and model contracts to the new `rateLimitsByLimitId`, spend-control,
  service-tier, and model metadata fields while exposing only the public `codex` bucket.
- Treat a successful ChatGPT `account/read` result with `requiresOpenaiAuth: true` as
  authenticated; only an account-less auth signal or explicit auth error is `reauth-required`.
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
