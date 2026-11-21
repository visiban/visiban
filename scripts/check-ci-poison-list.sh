#!/usr/bin/env bash
# scripts/check-ci-poison-list.sh — fail when .gitlab-ci.yml uses a `*_TOKEN`
# variable that scripts/ci-poison-env.sh neither poisons nor exempts (#2461).
# A forgotten token would stay visible to script-tests on main only, which is
# exactly the #2412 class (green MR, red main).
#
# Usage: scripts/check-ci-poison-list.sh [--ci-file F] [--poison-file F]
#        scripts/check-ci-poison-list.sh --self-test
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check() {
  local ci_file="$1" poison_file="$2" known="" tok rc=0 e
  [ -f "$ci_file" ] && [ -f "$poison_file" ] || { echo "ERROR: missing input file" >&2; return 3; }
  # Subshell: sourcing exports sentinels we do not want in this shell.
  known="$( # shellcheck disable=SC1090
    . "$poison_file" >/dev/null 2>&1
    printf '%s\n' "${CI_POISON_VARS[@]}"
    for e in "${CI_POISON_EXEMPT[@]}"; do printf '%s\n' "${e%%:*}"; done )"
  # Non-comment lines; a trailing _FILE (VISIBAN_FUZZ_TOKEN_FILE) is a path, not a secret.
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    grep -qxF "$tok" <<<"$known" && continue
    echo "FAIL: $tok is referenced in $(basename "$ci_file") but is not in CI_POISON_VARS or CI_POISON_EXEMPT" >&2
    echo "      Add it to scripts/ci-poison-env.sh (poison it, or exempt it with a reason)." >&2
    rc=1
  done < <(grep -vE '^[[:space:]]*#' "$ci_file" | grep -oE '(^|[^A-Z0-9_])[A-Z][A-Z0-9_]*_TOKEN([^A-Z0-9_]|$)' \
            | grep -oE '[A-Z][A-Z0-9_]*_TOKEN' | sort -u)
  [ $rc -eq 0 ] && echo "OK: every *_TOKEN variable in $(basename "$ci_file") is poisoned or exempted."
  return $rc
}

# shellcheck disable=SC2016  # single quotes are deliberate: literal YAML fixtures
self_test() {
  local tmp rc=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  printf 'CI_POISON_VARS=(A_TOKEN)\nCI_POISON_EXEMPT=("B_TOKEN:why")\n' >"$tmp/p.sh"
  printf 'j:\n  script:\n    - echo "$A_TOKEN" "${B_TOKEN}"\n  variables:\n    X_TOKEN_FILE: f\n' >"$tmp/ok.yml"
  check "$tmp/ok.yml" "$tmp/p.sh" >/dev/null 2>&1 || { echo "self-test FAILED: listed tokens rejected" >&2; rc=1; }
  printf 'j:\n  script:\n    - curl -H "T: $NEW_SECRET_TOKEN"\n' >"$tmp/bad.yml"
  check "$tmp/bad.yml" "$tmp/p.sh" >/dev/null 2>&1 && { echo "self-test FAILED: new token not detected" >&2; rc=1; }
  printf 'j:\n  # uses $NEW_SECRET_TOKEN\n  script: [true]\n' >"$tmp/cmt.yml"
  check "$tmp/cmt.yml" "$tmp/p.sh" >/dev/null 2>&1 || { echo "self-test FAILED: comment mention flagged" >&2; rc=1; }
  [ $rc -eq 0 ] && echo "self-test OK"
  return $rc
}

CI_FILE="$ROOT/.gitlab-ci.yml"; POISON="$ROOT/scripts/ci-poison-env.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test; exit $? ;;
    --ci-file) CI_FILE="$2"; shift 2 ;;
    --poison-file) POISON="$2"; shift 2 ;;
    *) echo "usage: $0 [--ci-file F] [--poison-file F] | --self-test" >&2; exit 3 ;;
  esac
done
check "$CI_FILE" "$POISON"
