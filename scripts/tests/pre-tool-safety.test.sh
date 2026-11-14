#!/usr/bin/env bash
# scripts/tests/pre-tool-safety.test.sh
#
# Self-test for .claude/hooks/pre-tool-safety.sh (#2230): real-shaped PreToolUse
# payloads (path nested under tool_input), exit codes, and block text on stderr.
#
# Run: bash scripts/tests/pre-tool-safety.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/pre-tool-safety.sh"

TMP="$(cd -P "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail=0
OUT="$TMP/out"; ERR="$TMP/err"

# run <payload-json> [env assignments...] -> sets RC; stdout/stderr in files
run() {
  local payload="$1"; shift
  printf '%s' "$payload" | env "$@" bash "$HOOK" >"$OUT" 2>"$ERR"
  RC=$?
}
expect() { # expect <desc> <rc> [stderr-substring]
  if [[ "$RC" -ne "$2" ]]; then
    echo "  FAIL: $1 (rc=$RC, want $2)"; fail=$((fail + 1)); return
  fi
  if [[ -n "${3:-}" ]] && ! grep -q -- "$3" "$ERR"; then
    echo "  FAIL: $1 (stderr lacks '$3')"; fail=$((fail + 1)); return
  fi
  if [[ "$2" -eq 2 && -s "$OUT" ]]; then
    echo "  FAIL: $1 (block text leaked to stdout)"; fail=$((fail + 1)); return
  fi
  echo "  ok: $1"
}
edit() { printf '{"session_id":"s","cwd":"/","hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$1"; }
nb() { printf '{"hook_event_name":"PreToolUse","tool_name":"NotebookEdit","tool_input":{"notebook_path":"%s","new_source":"x"}}' "$1"; }

mkrepo() { # mkrepo <dir> <default-branch>
  git init -q -b "$2" "$1"
  git -C "$1" config user.email t@t.co
  git -C "$1" config user.name t
  echo base > "$1/README.md"
  git -C "$1" add -A
  git -C "$1" commit -qm init
}

M="$TMP/main-repo"
mkrepo "$M" main

run "$(edit "$M/frontend/package-lock.json")" ; expect "lockfile blocked" 2 BLOCKED
run "$(edit "$M/backend/boards/migrations/0001_x.py")" ALLOW_DEFAULT_BRANCH_EDIT=1
expect "migration blocked" 2 BLOCKED
run "$(edit "$M/README.md")" ; expect "main checkout on main blocked" 2 "scripts/wt new"
run "$(edit "$M/new/sub/dir/file.ts")" ; expect "new file in missing subdir blocked" 2 BLOCKED
run "$(nb "$M/n.ipynb")" ; expect "NotebookEdit on main blocked" 2 BLOCKED
run "$(edit "$M/README.md")" ALLOW_DEFAULT_BRANCH_EDIT=1 ; expect "override env allows" 0
run "" ; expect "empty stdin allowed" 0
run "not json {" ; expect "garbage stdin allowed" 0
run '{"file_path":"'"$M"'/README.md"}' ; expect "top-level file_path (wrong shape) ignored" 0
run "$(edit "$TMP/outside-no-repo.txt")" ; expect "file outside any repo allowed" 0

git -C "$M" worktree add -q -b feat/1-x "$TMP/linked"
run "$(edit "$TMP/linked/README.md")" ; expect "linked worktree on feature branch allowed" 0
git -C "$M" worktree add -q --detach "$TMP/linked-det"
run "$(edit "$TMP/linked-det/README.md")" ; expect "linked worktree detached allowed" 0

git -C "$M" checkout -q -b feat/2-y
run "$(edit "$M/README.md")" ; expect "main checkout on feature branch allowed" 0
git -C "$M" checkout -q --detach
run "$(edit "$M/README.md")" ; expect "main checkout detached HEAD allowed" 0

# Default branch detected from origin/HEAD when it is not 'main'.
T="$TMP/trunk-repo"
mkrepo "$T" trunk
git init -q --bare "$TMP/origin.git"
git -C "$T" remote add origin "$TMP/origin.git"
git -C "$T" push -q origin trunk
git -C "$T" fetch -q origin
git -C "$T" remote set-head origin trunk
run "$(edit "$T/README.md")" ; expect "custom default branch (trunk) blocked" 2 "'trunk'"
git -C "$T" checkout -q -b main
run "$(edit "$T/README.md")" ; expect "branch 'main' allowed when default is trunk" 0

if [[ "$fail" -ne 0 ]]; then echo "$fail failure(s)"; exit 1; fi
echo "all passed"
