#!/usr/bin/env bash
# Tests scripts/ci-poison-env.sh (#2461): sourcing it must replace every listed
# protected variable with the sentinel (even when a real value was present, as on
# main) and point CI_API_V4_URL at a dead loopback endpoint. The file is sourced
# by alpine busybox `sh` in CI, so it is exercised under every POSIX shell found
# here, not just bash (audit B1: bash arrays broke it under busybox).
# Run: bash scripts/tests/ci-poison-env.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0

run_under() {
  local shell="$1" out n=0 line
  out="$(env -i PATH="$PATH" GITLAB_API_TOKEN=real-secret CI_API_V4_URL=https://gitlab.com/api/v4 \
    "$shell" -c ". '$ROOT/scripts/ci-poison-env.sh' || exit 9; for v in \$CI_POISON_VARS; do eval \"echo \\\$v=\\\$\$v\"; done; echo URL=\$CI_API_V4_URL" 2>&1)" \
    || { echo "FAIL($shell): sourcing failed: $out"; fail=1; return; }
  while IFS= read -r line; do
    case "$line" in
      URL=*) [ "$line" = "URL=http://127.0.0.1:9/api/v4" ] || { echo "FAIL($shell): $line"; fail=1; } ;;
      *=poisoned-by-ci-poison-env-2461) n=$((n + 1)) ;;
      *) echo "FAIL($shell): not poisoned: $line"; fail=1 ;;
    esac
  done <<<"$out"
  [ "$n" -ge 10 ] || { echo "FAIL($shell): only $n variables poisoned"; fail=1; }
  echo "$out" | grep -q 'real-secret' && { echo "FAIL($shell): real value leaked"; fail=1; }
  echo "ok under $shell ($n poisoned)"
}

ran=0
for sh_ in sh bash dash busybox; do
  command -v "$sh_" >/dev/null 2>&1 || continue
  if [ "$sh_" = busybox ]; then
    busybox sh -c ':' >/dev/null 2>&1 || continue
    # busybox needs the applet name; wrap it so `$shell -c` works.
    tmpw="$(mktemp)"; printf '#!/bin/sh\nexec busybox sh "$@"\n' >"$tmpw"; chmod +x "$tmpw"
    run_under "$tmpw"; rm -f "$tmpw"
  else
    run_under "$sh_"
  fi
  ran=$((ran + 1))
done
[ "$ran" -ge 1 ] || { echo "FAIL: no shell available"; fail=1; }
[ "$fail" -eq 0 ] && echo "ci-poison-env.test.sh: all checks passed"
exit "$fail"
