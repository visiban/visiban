#!/usr/bin/env bash
# Tests scripts/ci-poison-env.sh (#2461): sourcing it must replace every listed
# protected variable with the sentinel (even when a real value was present, as on
# main) and point CI_API_V4_URL at a dead loopback endpoint.
# Run: bash scripts/tests/ci-poison-env.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
out="$(env -i PATH="$PATH" GITLAB_API_TOKEN=real-secret CI_API_V4_URL=https://gitlab.com/api/v4 \
  bash -c ". '$ROOT/scripts/ci-poison-env.sh'; for v in \"\${CI_POISON_VARS[@]}\"; do echo \"\$v=\${!v}\"; done; echo URL=\$CI_API_V4_URL")"
n=0
while IFS= read -r line; do
  case "$line" in
    URL=*) [ "$line" = "URL=http://127.0.0.1:9/api/v4" ] || { echo "FAIL: $line"; fail=1; } ;;
    *=poisoned-by-ci-poison-env-2461) n=$((n + 1)) ;;
    *) echo "FAIL: not poisoned: $line"; fail=1 ;;
  esac
done <<<"$out"
[ "$n" -ge 10 ] || { echo "FAIL: only $n variables poisoned"; fail=1; }
echo "$out" | grep -q 'real-secret' && { echo "FAIL: real value leaked"; fail=1; }
[ "$fail" -eq 0 ] && echo "ci-poison-env.test.sh: all checks passed"
exit "$fail"
