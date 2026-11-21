#!/usr/bin/env bash
# Tests scripts/ci-hermetic-run.sh (#2461) under every POSIX shell found here
# (CI runs it with alpine busybox `sh`):
#   * the wrapped command sees poisoned tokens and the canary URL;
#   * its exit status is passed through, and a clean run exits 0;
#   * a command that reaches the canary fails the wrapper even when it exits 0;
#   * the CALLER's real variables are untouched (jobs with a real step after
#     their tests, e.g. suppressions-check, rely on this).
# Run: bash scripts/tests/ci-hermetic-run.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
W="$ROOT/scripts/ci-hermetic-run.sh"
fail=0
ran=0

for sh_ in sh bash dash busybox; do
  command -v "$sh_" >/dev/null 2>&1 || continue
  shell=("$sh_"); [ "$sh_" = busybox ] && shell=(busybox sh)
  ran=$((ran + 1))
  export GITLAB_API_TOKEN=real-secret CI_API_V4_URL=https://gitlab.example.invalid/api/v4

  # shellcheck disable=SC2016  # expanded by the wrapped shell, on purpose
  out="$("${shell[@]}" "$W" sh -c 'echo "TOK=$GITLAB_API_TOKEN URL=$CI_API_V4_URL"' 2>&1)"; rc=$?
  [ $rc -eq 0 ] || { echo "FAIL($sh_): clean command exited $rc: $out"; fail=1; }
  case "$out" in *"TOK=poisoned-by-ci-poison-env-2461 URL=http://127.0.0.1:"*) ;; *) echo "FAIL($sh_): not poisoned: $out"; fail=1 ;; esac
  case "$out" in *real-secret*) echo "FAIL($sh_): real token leaked into the wrapped command"; fail=1 ;; esac

  "${shell[@]}" "$W" sh -c 'exit 7' >/dev/null 2>&1; rc=$?
  [ $rc -eq 7 ] || { echo "FAIL($sh_): exit status not passed through (got $rc, want 7)"; fail=1; }

  out="$("${shell[@]}" "$W" python3 -c 'import os, urllib.request; urllib.request.urlopen(os.environ["CI_API_V4_URL"] + "/projects/1/pipelines", timeout=5).read()' 2>&1)"; rc=$?
  [ $rc -eq 1 ] || { echo "FAIL($sh_): an API call through inherited variables was not flagged (rc=$rc): $out"; fail=1; }
  case "$out" in *"/projects/1/pipelines"*) ;; *) echo "FAIL($sh_): canary did not name the request: $out"; fail=1 ;; esac

  [ "$GITLAB_API_TOKEN" = real-secret ] && [ "$CI_API_V4_URL" = https://gitlab.example.invalid/api/v4 ] \
    || { echo "FAIL($sh_): the caller's real variables changed"; fail=1; }

  "${shell[@]}" "$W" >/dev/null 2>&1; rc=$?
  [ $rc -eq 2 ] || { echo "FAIL($sh_): no command must be a usage error (got $rc)"; fail=1; }
  [ $fail -eq 0 ] && echo "ok under $sh_"
done
[ $ran -gt 0 ] || { echo "FAIL: no POSIX shell found"; exit 1; }
[ $fail -eq 0 ] && echo "ci-hermetic-run: all cases passed"
exit $fail
