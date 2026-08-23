# dsh-codex-appserver

DeepSeek Harness provider that talks to the local Codex CLI App Server over
stdio JSON-RPC. It exposes the provider id `codex-chatgpt`; the user must
select it explicitly, and the plugin never changes DSH's default provider.

## Install

```sh
dsh plugin --profile web add github:seriousz158/dsh-codex-use#path:/packages/dsh-codex-appserver
```

The package declares both `dsh.bundle` and the web `dsh.client` manifest. The
bundle patch mounts the host provider; the client manifest injects the UI.

## Compatibility

- Node.js `>=22`
- DSH `>=0.1.0-rc.7 <0.1.1-0 || >=0.1.1-rc.0 <0.2.0-0` (verified on
  `0.1.0-rc.7` and `0.1.1-rc.2`)
- Codex CLI `0.144.1` App Server protocol fixtures

Release `0.2.3` supports Codex CLI `0.144.1` only. Other versions fail closed
with `protocol-mismatch`. This project is distributed through GitHub source
installs and GitHub Releases; it is not published to npm.

The standalone doctor is metadata-only by default:

```sh
node tools/codex-appserver-doctor.mjs --json
node tools/codex-appserver-doctor.mjs --json --live
```

The browser half exposes a revision-fenced `settings.plugin.item` card. The
quota row remains in `settings.general.item`; Fast Mode is schema-gated and
depends on upstream service-tier support, while local images are read only through
DSH attachments. OAuth and remote search are
separate routes (`dsh-codex-search` is disabled by default).

The repository root contains the full installation guide, tests, security
boundary, and legacy manual-installer migration instructions.
