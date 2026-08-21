#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
INSTALLER="$PROJECT_DIR/integrations/dsh/dsh-codex-install"
PACKAGE_DIR="$PROJECT_DIR/packages/dsh-codex-appserver"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-codex-install-test.XXXXXX")"
DSH_HOME="$TEMP_ROOT/.dsh"
HOST_PATCH="$DSH_HOME/cordis.patch.yml"
WEB_PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
mkdir -p "$DSH_HOME/profiles/web"
print -r -- '[]' > "$HOST_PATCH"
print -r -- '- id: unrelated' > "$WEB_PATCH"
WEB_BEFORE="$(cat "$WEB_PATCH")"

run_installer() {
  DSH_HOME="$DSH_HOME" "$INSTALLER"
}

run_installer >/dev/null
PROFILE_LINK="$DSH_HOME/profiles/node_modules/dsh-codex-appserver"
PACKAGE_LINK="$PACKAGE_DIR/node_modules"
test -L "$PROFILE_LINK"
test "$(cd -P -- "$PROFILE_LINK" && pwd -P)" = "$PACKAGE_DIR"
test -L "$PACKAGE_LINK"
test "$(cd -P -- "$PACKAGE_LINK" && pwd -P)" = "$(cd -P -- "$DSH_HOME/profiles/node_modules" && pwd -P)"
grep -Fq -- 'id: codex-appserver' "$HOST_PATCH"
grep -Fq -- 'name: dsh-codex-appserver' "$HOST_PATCH"
test "$(grep -Fc -- 'id: codex-appserver' "$HOST_PATCH")" = 1
test "$(grep -Fc -- 'name: dsh-codex-appserver' "$HOST_PATCH")" = 1
test "$(cat "$WEB_PATCH")" = "$WEB_BEFORE"

HOST_AFTER="$(cat "$HOST_PATCH")"
run_installer >/dev/null
test "$(cat "$HOST_PATCH")" = "$HOST_AFTER"
test "$(cat "$WEB_PATCH")" = "$WEB_BEFORE"

# A duplicate Web registration must be rejected before any provider reload.
print -r -- '- id: codex-appserver' >> "$WEB_PATCH"
if DSH_HOME="$DSH_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer unexpectedly accepted a duplicate Web registration'
  exit 1
fi

print "dsh-codex app-server portable install tests passed"
