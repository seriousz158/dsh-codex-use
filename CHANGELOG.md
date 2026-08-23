# Changelog

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
