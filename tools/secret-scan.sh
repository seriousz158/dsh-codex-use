#!/bin/zsh
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$ROOT"

fail=0
if find . -path './.git' -prune -o -type f \( \
  -name '.credentials.yaml' -o -name '.anonymous-user-id' -o -name '*.zstd' \
  -o -name '*.pem' -o -name '*.key' -o -name '.env' -o -name '.env.*' \
\) -print | grep -q .; then
  print -u2 -- 'secret-scan: forbidden credential/session/build file found'
  fail=1
fi

if rg -n --hidden \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!tests/**' \
  --glob '!tools/fixtures/**' \
  -- '-----BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE)|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}' \
  .; then
  print -u2 -- 'secret-scan: possible credential or private key found'
  fail=1
fi

if [[ -n "${HOME:-}" ]] && rg -n --hidden \
  --glob '!.git/**' \
  --glob '!node_modules/**' \
  --glob '!tools/secret-scan.sh' \
  --fixed-strings -- "$HOME" .; then
  print -u2 -- 'secret-scan: current home path found in the export'
  fail=1
fi

if find . -path './.git' -prune -o -type l -print | while IFS= read -r link; do
  target="$(readlink "$link")"
  case "$target" in
    *auth.json|*credentials*|*sessions*|*storages*) print -u2 -- "secret-scan: unsafe symlink $link -> $target"; exit 1 ;;
  esac
done; then
  :
else
  fail=1
fi

(( fail == 0 )) || exit 1
print 'secret-scan: passed'
