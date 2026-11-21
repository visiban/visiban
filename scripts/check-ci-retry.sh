#!/usr/bin/env bash
# scripts/check-ci-retry.sh — fail when any `retry:` in .gitlab-ci.yml can retry
# a script failure (#2462). Red tests here have repeatedly been real bugs, so
# only infrastructure failure classes may retry (see `default:` and
# docs/maintainers/known-ci-failures.md). Forbidden in a retry `when:`:
# script_failure, unknown_failure, always (all include script failures).
#
# Usage: scripts/check-ci-retry.sh [--ci-file F] | --self-test
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check() {
  local out
  [ -f "$1" ] || { echo "ERROR: CI file not found: $1" >&2; return 3; }
  out="$(awk '
    { line=$0; sub(/[[:space:]]+#.*$/, "", line); if (line ~ /^[[:space:]]*#/) next }
    match(line, /^[[:space:]]*/) { ind=RLENGTH }
    inretry && line !~ /^[[:space:]]*$/ && ind <= rind { inretry=0 }
    line ~ /^[[:space:]]*retry:/ { inretry=1; rind=ind; seen=1 }
    inretry && line ~ /(^|[^a-z_])(script_failure|unknown_failure|always)([^a-z_]|$)/ {
      printf "FAIL: line %d: retry includes a script-failure class: %s\n", NR, line; bad=1 }
    END { if (!seen) print "FAIL: no retry: found at all (default retry missing?)"; exit (bad || !seen) ? 1 : 0 }
  ' "$1")" && { echo "OK: no retry: in $(basename "$1") can retry a script failure."; return 0; }
  echo "$out" >&2
  return 1
}

self_test() {
  local tmp rc=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  printf 'default:\n  retry:\n    max: 2\n    when:\n      - runner_system_failure\n      - api_failure\nj:\n  retry: 0\n  script: [true]\n' >"$tmp/ok.yml"
  check "$tmp/ok.yml" >/dev/null 2>&1 || { echo "self-test FAILED: safe config rejected" >&2; rc=1; }
  printf 'default:\n  retry:\n    max: 2\n    when:\n      - script_failure\n' >"$tmp/b1.yml"
  check "$tmp/b1.yml" >/dev/null 2>&1 && { echo "self-test FAILED: block script_failure missed" >&2; rc=1; }
  printf 'j:\n  retry: { max: 2, when: [unknown_failure] }\n' >"$tmp/b2.yml"
  check "$tmp/b2.yml" >/dev/null 2>&1 && { echo "self-test FAILED: inline unknown_failure missed" >&2; rc=1; }
  printf 'j:\n  retry:\n    max: 1\n    when: always\n' >"$tmp/b3.yml"
  check "$tmp/b3.yml" >/dev/null 2>&1 && { echo "self-test FAILED: when: always missed" >&2; rc=1; }
  # script_failure outside a retry block (a comment, a different key) is fine.
  printf 'default:\n  retry:\n    when:\n      - api_failure\nj:\n  script:\n    - echo script_failure always\n' >"$tmp/ok2.yml"
  check "$tmp/ok2.yml" >/dev/null 2>&1 || { echo "self-test FAILED: unrelated mention flagged" >&2; rc=1; }
  printf 'j:\n  script: [true]\n' >"$tmp/none.yml"
  check "$tmp/none.yml" >/dev/null 2>&1 && { echo "self-test FAILED: missing retry not detected" >&2; rc=1; }
  [ $rc -eq 0 ] && echo "self-test OK"
  return $rc
}

CI_FILE="$ROOT/.gitlab-ci.yml"
case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --ci-file) CI_FILE="${2:?}" ;;
  "") ;;
  *) echo "usage: $0 [--ci-file F] | --self-test" >&2; exit 3 ;;
esac
check "$CI_FILE"
