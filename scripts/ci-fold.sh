#!/bin/sh
# shellcheck shell=sh
# scripts/ci-fold.sh -- run several independent CI checks in one job (#2523).
#
# Sourced by a `.gitlab-ci.yml` job that folds tiny self-test jobs together so
# they stop each paying their own executor setup, image pull and runner slot:
#
#   . scripts/ci-fold.sh
#   fold_member some-old-job-name  some_function_or_command args...
#   fold_member_not_on_tag other-old-job-name  other_function
#   fold_finish
#
# Contract (what makes a folded job as informative as the separate jobs were):
#   * every member runs, even after an earlier one fails;
#   * each member prints a `== <old-job-name> ==` banner and its own verdict;
#   * a member stops at its own first failing command (it runs in a subshell
#     under `set -e`, like a separate job's script would);
#   * fold_finish exits non-zero and names every failed member, else 0.
#
# POSIX sh: runs on alpine busybox ash and python:slim's dash.
#
# Usage:  sh scripts/ci-fold.sh --self-test

FOLD_FAILED=""
FOLD_RAN=0
FOLD_SKIPPED=0

# fold_member <name> <command> [args...]
fold_member() {
  _fold_name=$1
  shift
  printf '\n== %s ==\n' "$_fold_name"
  FOLD_RAN=$((FOLD_RAN + 1))
  # A plain subshell (never `if`/`||`), so `set -e` is honored inside it.
  (
    set -e
    "$@"
  )
  _fold_rc=$?
  if [ "$_fold_rc" -ne 0 ]; then
    FOLD_FAILED="$FOLD_FAILED $_fold_name"
    printf '== %s: FAILED (exit %s) ==\n' "$_fold_name" "$_fold_rc"
  else
    printf '== %s: ok ==\n' "$_fold_name"
  fi
}

# Same as fold_member but skipped in a tag pipeline. The separate job had an
# MR-or-default-branch rule, so it never ran for a release tag; folding it into
# a job that does run there must not add it to the release pipeline.
fold_member_not_on_tag() {
  if [ -n "${CI_COMMIT_TAG:-}" ]; then
    printf '\n== %s ==\n== %s: skipped (never ran in tag pipelines) ==\n' "$1" "$1"
    FOLD_SKIPPED=$((FOLD_SKIPPED + 1))
    return 0
  fi
  fold_member "$@"
}

# fold_finish -- print the summary; return 1 when any member failed.
fold_finish() {
  printf '\n== summary: %s member(s) run, %s skipped ==\n' "$FOLD_RAN" "$FOLD_SKIPPED"
  if [ -n "$FOLD_FAILED" ]; then
    printf 'FAILED members:%s\n' "$FOLD_FAILED" >&2
    return 1
  fi
  echo "All members passed."
  return 0
}

fold_self_test() {
  _st_fail=0
  _st_check() { # <label> <condition-rc>
    if [ "$2" -eq 0 ]; then echo "ok:   $1"; else echo "FAIL: $1"; _st_fail=1; fi
  }
  _st_dir=$(mktemp -d) || exit 2
  trap 'rm -rf "$_st_dir"' EXIT
  # shellcheck disable=SC2329  # invoked indirectly through fold_member
  _ok() { echo "ran-ok" >>"$_st_dir/ran"; }
  # shellcheck disable=SC2329  # invoked indirectly through fold_member
  _bad() { echo "ran-bad" >>"$_st_dir/ran"; false; }
  # shellcheck disable=SC2329  # invoked indirectly through fold_member
  _mid_fail() { false; echo "after-failure" >>"$_st_dir/leak"; }
  # shellcheck disable=SC2329  # invoked indirectly through fold_member
  _later() { echo "ran-later" >>"$_st_dir/ran"; }

  # Case 1: a failing member does not stop the later ones, and is named.
  out=$(
    FOLD_FAILED="" FOLD_RAN=0 FOLD_SKIPPED=0
    fold_member first _ok
    fold_member second _bad
    fold_member third _later
    fold_finish 2>&1
    echo "finish-rc=$?"
  )
  printf '%s\n' "$out" | grep -q '^== second: FAILED (exit 1) ==$'
  _st_check "failing member is reported" $?
  printf '%s\n' "$out" | grep -q '^FAILED members: second$'
  _st_check "summary names only the failed member" $?
  printf '%s\n' "$out" | grep -q '^finish-rc=1$'
  _st_check "fold_finish fails when a member failed" $?
  _n=$(grep -c ran-later "$_st_dir/ran")
  if [ "$_n" -eq 1 ]; then _rc=0; else _rc=1; fi
  _st_check "members after a failure still run" "$_rc"
  printf '%s\n' "$out" | grep -q '^== first ==$'
  _st_check "banner names the member" $?

  # Case 2: a member stops at its first failing command (set -e inside it).
  rm -f "$_st_dir/leak"
  (
    FOLD_FAILED="" FOLD_RAN=0 FOLD_SKIPPED=0
    fold_member mid _mid_fail >/dev/null 2>&1
  )
  if [ ! -e "$_st_dir/leak" ]; then _rc=0; else _rc=1; fi
  _st_check "a member stops at its first failing command" "$_rc"

  # Case 3: all green -> exit 0.
  out=$(
    FOLD_FAILED="" FOLD_RAN=0 FOLD_SKIPPED=0
    fold_member only _ok
    fold_finish 2>&1
    echo "finish-rc=$?"
  )
  printf '%s\n' "$out" | grep -q '^finish-rc=0$'
  _st_check "fold_finish passes when every member passed" $?

  # Case 4: tag pipelines skip fold_member_not_on_tag members, and only those.
  : >"$_st_dir/ran"
  out=$(
    FOLD_FAILED="" FOLD_RAN=0 FOLD_SKIPPED=0
    CI_COMMIT_TAG=v9.9.9
    fold_member_not_on_tag skipped_on_tag _bad
    fold_member always _ok
    fold_finish 2>&1
    echo "finish-rc=$?"
  )
  printf '%s\n' "$out" | grep -q 'skipped_on_tag: skipped'
  _st_check "tag pipeline skips a not-on-tag member" $?
  grep -q ran-bad "$_st_dir/ran"; _rc=$?
  _st_check "the skipped member did not execute" $((1 - _rc))
  printf '%s\n' "$out" | grep -q '^finish-rc=0$'
  _st_check "a skipped member never fails the job" $?
  : >"$_st_dir/ran"
  (
    FOLD_FAILED="" FOLD_RAN=0 FOLD_SKIPPED=0
    unset CI_COMMIT_TAG
    fold_member_not_on_tag runs_off_tag _ok >/dev/null 2>&1
  )
  grep -q ran-ok "$_st_dir/ran"
  _st_check "outside a tag pipeline the member runs" $?

  if [ "$_st_fail" -ne 0 ]; then
    echo "=== ci-fold.sh --self-test: FAILED ===" >&2
    return 1
  fi
  echo "=== ci-fold.sh --self-test: PASSED ==="
}

# Run the self-test only when executed (not when sourced).
case "${0##*/}" in
  ci-fold.sh)
    case "${1:-}" in
      --self-test) fold_self_test; exit $? ;;
      *) echo "usage: sh scripts/ci-fold.sh --self-test   (or: . scripts/ci-fold.sh)" >&2; exit 2 ;;
    esac
    ;;
esac
