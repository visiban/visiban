#!/usr/bin/env bash
# scripts/check-script-tests-wired.sh — fail when a scripts/tests/*.test.sh is not run by CI (#2117).
#
# check-rbac-coverage.test.sh stayed red for weeks (#2069) because no CI job ran
# it; 16 of 22 files in scripts/tests/ were in the same state. A test that CI
# never runs is a test that rots silently, so this gate derives the file list
# from the directory and requires each one to either
#   (a) appear as a run command (`bash scripts/tests/<name>`) on a non-comment
#       line of .gitlab-ci.yml, or
#   (b) be listed in scripts/tests/unwired-allowlist.txt with a reason
#       (`<file><TAB>reason`), so every exemption is grep-able and reviewed.
# An allowlist entry for a file that no longer exists, or that is now wired, is
# also a failure — otherwise the allowlist only ever grows.
#
# Usage: scripts/check-script-tests-wired.sh [--ci-file F] [--tests-dir D] [--allowlist F]
#        scripts/check-script-tests-wired.sh --self-test
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check() {
  local ci_file="$1" tests_dir="$2" allowlist="$3" rc=0 f name
  [ -f "$ci_file" ] || { echo "ERROR: CI file not found: $ci_file" >&2; return 3; }
  [ -d "$tests_dir" ] || { echo "ERROR: tests dir not found: $tests_dir" >&2; return 3; }
  local ci_run
  # Non-comment lines only: a mention in a comment does not run anything.
  ci_run="$(grep -vE '^[[:space:]]*#' "$ci_file" | grep -E '(^|[[:space:]])(bash|sh)[[:space:]]+scripts/tests/' || true)"
  local allowed=""
  if [ -f "$allowlist" ]; then
    allowed="$(grep -vE '^[[:space:]]*(#|$)' "$allowlist" | cut -f1)"
    # Every entry needs a non-empty reason.
    while IFS=$'\t' read -r name reason; do
      [ -n "$name" ] || continue
      if [ -z "${reason// /}" ]; then
        echo "FAIL: allowlist entry '$name' has no reason" >&2; rc=1
      fi
    done < <(grep -vE '^[[:space:]]*(#|$)' "$allowlist")
  fi
  for f in "$tests_dir"/*.test.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    local wired=0 listed=0
    grep -qF "scripts/tests/$name" <<<"$ci_run" && wired=1
    grep -qxF "$name" <<<"$allowed" && listed=1
    if [ $wired -eq 0 ] && [ $listed -eq 0 ]; then
      echo "FAIL: scripts/tests/$name is not run by any CI job." >&2
      echo "      Add 'bash scripts/tests/$name' to a job in .gitlab-ci.yml, or list it in" >&2
      echo "      scripts/tests/unwired-allowlist.txt with a reason." >&2
      rc=1
    elif [ $wired -eq 1 ] && [ $listed -eq 1 ]; then
      echo "FAIL: $name is wired in CI but still in the allowlist; remove the entry." >&2; rc=1
    fi
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -e "$tests_dir/$name" ] || { echo "FAIL: allowlist entry '$name' does not exist in $tests_dir." >&2; rc=1; }
  done <<<"$allowed"
  [ $rc -eq 0 ] && echo "OK: every scripts/tests/*.test.sh is wired into CI or allowlisted with a reason."
  return $rc
}

self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/tests"
  : >"$tmp/tests/a.test.sh"; : >"$tmp/tests/b.test.sh"
  printf 'job:\n  script:\n    - bash scripts/tests/a.test.sh\n  # bash scripts/tests/b.test.sh\n' >"$tmp/ci.yml"
  : >"$tmp/allow.txt"
  # b is only mentioned in a comment: must fail.
  check "$tmp/ci.yml" "$tmp/tests" "$tmp/allow.txt" >/dev/null 2>&1 && { echo "self-test FAILED: unwired file not detected" >&2; rc=1; }
  # allowlisted with a reason: passes.
  printf 'b.test.sh\tneeds a live cluster\n' >"$tmp/allow.txt"
  check "$tmp/ci.yml" "$tmp/tests" "$tmp/allow.txt" >/dev/null 2>&1 || { echo "self-test FAILED: allowlisted file rejected" >&2; rc=1; }
  # allowlisted without a reason: fails.
  printf 'b.test.sh\t\n' >"$tmp/allow.txt"
  check "$tmp/ci.yml" "$tmp/tests" "$tmp/allow.txt" >/dev/null 2>&1 && { echo "self-test FAILED: reasonless entry accepted" >&2; rc=1; }
  # stale entry (wired file listed, missing file listed): fails.
  printf 'b.test.sh\tx\na.test.sh\tx\n' >"$tmp/allow.txt"
  check "$tmp/ci.yml" "$tmp/tests" "$tmp/allow.txt" >/dev/null 2>&1 && { echo "self-test FAILED: wired-but-allowlisted accepted" >&2; rc=1; }
  printf 'b.test.sh\tx\ngone.test.sh\tx\n' >"$tmp/allow.txt"
  check "$tmp/ci.yml" "$tmp/tests" "$tmp/allow.txt" >/dev/null 2>&1 && { echo "self-test FAILED: stale entry accepted" >&2; rc=1; }
  [ $rc -eq 0 ] && echo "self-test OK"
  return $rc
}

CI_FILE="$ROOT/.gitlab-ci.yml"; TESTS_DIR="$ROOT/scripts/tests"; ALLOWLIST="$ROOT/scripts/tests/unwired-allowlist.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test; exit $? ;;
    --ci-file) CI_FILE="$2"; shift 2 ;;
    --tests-dir) TESTS_DIR="$2"; shift 2 ;;
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    *) echo "usage: $0 [--ci-file F] [--tests-dir D] [--allowlist F] | --self-test" >&2; exit 3 ;;
  esac
done
check "$CI_FILE" "$TESTS_DIR" "$ALLOWLIST"
