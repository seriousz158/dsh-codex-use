#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
INSTALLER="$PROJECT_DIR/integrations/dsh/dsh-codex-install"
PACKAGE_DIR="$PROJECT_DIR/packages/dsh-codex-appserver"

new_home() {
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/dsh-codex-install-test.XXXXXX")"
  mkdir -p "$root/.dsh/profiles/web"
  print -r -- "$root/.dsh"
}

# A fresh manual install uses a distinct id and disables itself when the same
# package is mounted by the official profile bundle.
DSH_HOME="$(new_home)"
HOST_PATCH="$DSH_HOME/cordis.patch.yml"
WEB_PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
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
grep -Fq -- 'id: codex-appserver-manual' "$HOST_PATCH"
grep -Fq -- 'name: dsh-codex-appserver' "$HOST_PATCH"
grep -Fq -- 'disabled: !!js' "$HOST_PATCH"
test "$(grep -Fc -- 'id: codex-appserver-manual' "$HOST_PATCH")" = 1
test "$(grep -Fc -- 'name: dsh-codex-appserver' "$HOST_PATCH")" = 1

test "$(cat "$WEB_PATCH")" = "$WEB_BEFORE"
HOST_AFTER="$(cat "$HOST_PATCH")"
run_installer >/dev/null
test "$(cat "$HOST_PATCH")" = "$HOST_AFTER"
test "$(cat "$WEB_PATCH")" = "$WEB_BEFORE"

# A legacy shared-host row is migrated atomically and backed up before the
# manual row receives the bundle-aware disabled guard.
LEGACY_HOME="$(new_home)"
LEGACY_PATCH="$LEGACY_HOME/cordis.patch.yml"
print -r -- '- insert:' > "$LEGACY_PATCH"
print -r -- '    - id: codex-appserver' >> "$LEGACY_PATCH"
print -r -- '      name: dsh-codex-appserver' >> "$LEGACY_PATCH"
DSH_HOME="$LEGACY_HOME" "$INSTALLER" >/dev/null
grep -Fq -- 'id: codex-appserver-manual' "$LEGACY_PATCH"
! grep -Eq -- '^[[:space:]-]*id: codex-appserver$' "$LEGACY_PATCH"
find "$LEGACY_HOME" -maxdepth 1 -name 'cordis.patch.yml.bak.*' -type f | grep -q .

# A duplicate Web registration must be rejected before any provider reload.
DUP_HOME="$(new_home)"
DUP_PATCH="$DUP_HOME/profiles/web/cordis.patch.yml"
print -r -- '- id: codex-appserver' > "$DUP_PATCH"
if DSH_HOME="$DUP_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer unexpectedly accepted a duplicate Web registration'
  exit 1
fi

print "dsh-codex app-server portable install tests passed"
