#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SOURCE_PACKAGE_DIR="$PROJECT_DIR/packages/dsh-codex-appserver"

# The installer wires the package's node_modules back into DSH_HOME.  Keep
# that test-only link inside a temporary repository copy so a failed or
# interrupted test cannot mutate the checked-out package.
make_test_project() {
  TEST_PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-codex-install-repo.XXXXXX")"
  mkdir -p "$TEST_PROJECT_DIR/integrations/dsh" "$TEST_PROJECT_DIR/packages/dsh-codex-appserver"
  cp -- "$PROJECT_DIR/integrations/dsh/dsh-codex-install" "$TEST_PROJECT_DIR/integrations/dsh/dsh-codex-install"
  for file in package.json README.md compatibility.json cordis.patch.yml; do
    cp -- "$SOURCE_PACKAGE_DIR/$file" "$TEST_PROJECT_DIR/packages/dsh-codex-appserver/$file"
  done
  cp -R -- "$SOURCE_PACKAGE_DIR/lib" "$TEST_PROJECT_DIR/packages/dsh-codex-appserver/lib"
  INSTALLER="$TEST_PROJECT_DIR/integrations/dsh/dsh-codex-install"
  PACKAGE_DIR="$TEST_PROJECT_DIR/packages/dsh-codex-appserver"
}

make_test_project

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
test "$(cd -P -- "$PROFILE_LINK" && pwd -P)" = "$(cd -P -- "$PACKAGE_DIR" && pwd -P)"
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

# A legacy shared-host row and active legacy package link are migrated
# atomically and backed up before the manual row receives the bundle-aware
# disabled guard.
LEGACY_HOME="$(new_home)"
make_test_project
LEGACY_PATCH="$LEGACY_HOME/cordis.patch.yml"
print -r -- '- insert:' > "$LEGACY_PATCH"
print -r -- '    - id: codex-appserver' >> "$LEGACY_PATCH"
print -r -- '      name: dsh-codex-appserver' >> "$LEGACY_PATCH"
LEGACY_PACKAGE_DIR="$LEGACY_HOME/legacy-package"
mkdir -p "$LEGACY_PACKAGE_DIR"
print -r -- '{"name":"dsh-codex-appserver"}' > "$LEGACY_PACKAGE_DIR/package.json"
LEGACY_PROFILE_LINK="$LEGACY_HOME/profiles/node_modules/dsh-codex-appserver"
mkdir -p "$(dirname -- "$LEGACY_PROFILE_LINK")"
ln -s "$LEGACY_PACKAGE_DIR" "$LEGACY_PROFILE_LINK"
DSH_HOME="$LEGACY_HOME" DSH_CODEX_LEGACY_PACKAGE_DIR="$LEGACY_PACKAGE_DIR" "$INSTALLER" >/dev/null
grep -Fq -- 'id: codex-appserver-manual' "$LEGACY_PATCH"
! grep -Eq -- '^[[:space:]-]*id: codex-appserver$' "$LEGACY_PATCH"
find "$LEGACY_HOME" -maxdepth 1 -name 'cordis.patch.yml.bak.*' -type f | grep -q .
find "$LEGACY_HOME/profiles/node_modules" -maxdepth 1 -name 'dsh-codex-appserver.bak.*' -type l | grep -q .
test "$(cd -P -- "$LEGACY_PROFILE_LINK" && pwd -P)" = "$(cd -P -- "$PACKAGE_DIR" && pwd -P)"

# A stale dependency link is backed up in the package copy before the new
# profile dependency link is created.
STALE_HOME="$(new_home)"
make_test_project
STALE_PACKAGE_LINK="$PACKAGE_DIR/node_modules"
ln -s "$STALE_HOME/missing-node-modules" "$STALE_PACKAGE_LINK"
DSH_HOME="$STALE_HOME" "$INSTALLER" >/dev/null
find "$PACKAGE_DIR" -maxdepth 1 -name 'node_modules.bak.*' -type l | grep -q .
test "$(cd -P -- "$STALE_PACKAGE_LINK" && pwd -P)" = "$(cd -P -- "$STALE_HOME/profiles/node_modules" && pwd -P)"

# A duplicate Web registration must be rejected before any provider reload.
DUP_HOME="$(new_home)"
make_test_project
DUP_PATCH="$DUP_HOME/profiles/web/cordis.patch.yml"
print -r -- '- id: codex-appserver' > "$DUP_PATCH"
if DSH_HOME="$DUP_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer unexpectedly accepted a duplicate Web registration'
  exit 1
fi

# An active link pointing anywhere other than the package or the explicitly
# declared legacy directory is rejected rather than overwritten.
UNKNOWN_HOME="$(new_home)"
make_test_project
UNKNOWN_PROFILE_LINK="$UNKNOWN_HOME/profiles/node_modules/dsh-codex-appserver"
mkdir -p "$UNKNOWN_HOME/unknown-package"
mkdir -p "$(dirname -- "$UNKNOWN_PROFILE_LINK")"
ln -s "$UNKNOWN_HOME/unknown-package" "$UNKNOWN_PROFILE_LINK"
if DSH_HOME="$UNKNOWN_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer unexpectedly replaced an unknown active plugin link'
  exit 1
fi

print "dsh-codex app-server portable install tests passed"
