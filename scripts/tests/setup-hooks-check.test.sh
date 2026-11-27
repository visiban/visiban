#!/usr/bin/env bash
# scripts/tests/setup-hooks-check.test.sh (#2686)
#
# `scripts/setup-hooks.sh --check` must exit non-zero naming each managed hook that
# is missing or unmanaged, exit 0 when both are managed, recognize the legacy
# frontend-lint pre-push hook, and write nothing. Runs against throwaway repos in a
# temp dir — never the real .git/hooks.
#
# Run: bash scripts/tests/setup-hooks-check.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/setup-hooks.sh"
TMP="$(mktemp -d -t setup-hooks-2686.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
fail=0

new_repo() { rm -rf "$TMP/r"; git init -q "$TMP/r"; }
check() { (cd "$TMP/r" && bash "$SCRIPT" --check >"$TMP/out" 2>&1); RC=$?; }
expect() { # <desc> <want-rc> [substring...]
  local desc="$1" want="$2"; shift 2
  [[ "$RC" -eq "$want" ]] || { echo "  FAIL: $desc (rc=$RC, want $want)"; fail=$((fail + 1)); return; }
  local s
  for s in "$@"; do
    grep -qF -- "$s" "$TMP/out" || { echo "  FAIL: $desc (output lacks: $s)"; fail=$((fail + 1)); return; }
  done
  echo "  ok: $desc"
}

new_repo
check
expect "missing hooks -> rc 1, both named" 1 "pre-push hook is MISSING" "pre-commit hook is MISSING"
if compgen -G "$TMP/r/.git/hooks/pre-*" | grep -qv sample; then echo "  FAIL: --check wrote a hook"; fail=$((fail + 1)); else echo "  ok: --check wrote no hook"; fi

new_repo
(cd "$TMP/r" && bash "$SCRIPT" >/dev/null 2>&1)
check
expect "installed hooks -> rc 0" 0 "pre-push hook is managed" "pre-commit hook is managed"

new_repo
printf '#!/bin/sh\n# Pre-push hook\necho "Running frontend lint..."\n' > "$TMP/r/.git/hooks/pre-push"
(cd "$TMP/r" && bash "$SCRIPT" >/dev/null 2>&1)
before="$(cat "$TMP/r/.git/hooks/pre-push")"
check
expect "legacy frontend-lint pre-push -> rc 1, chain/replace advice" 1 "pre-push hook is UNMANAGED" "legacy frontend-lint hook" "check-issue-collision.sh" "pre-commit hook is managed" 
[[ "$(cat "$TMP/r/.git/hooks/pre-push")" == "$before" ]] \
  && echo "  ok: legacy hook left untouched" || { echo "  FAIL: legacy hook modified"; fail=$((fail + 1)); }

new_repo
printf '#!/bin/sh\necho custom\n' > "$TMP/r/.git/hooks/pre-commit"
check
expect "unmanaged non-legacy pre-commit -> rc 1" 1 "pre-commit hook is UNMANAGED" "gitleaks-precommit.sh" "pre-push hook is MISSING"

new_repo
git -C "$TMP/r" -c user.email=a@b -c user.name=t commit -q --allow-empty -m x
git -C "$TMP/r" worktree add -q "$TMP/wt" -b b2
(cd "$TMP/r" && bash "$SCRIPT" >/dev/null 2>&1)
(cd "$TMP/wt" && bash "$SCRIPT" --check >"$TMP/out" 2>&1); RC=$?
expect "from a linked worktree resolves the common dir" 0 "pre-commit hook is managed"

[[ "$fail" -eq 0 ]] && echo "PASS" || { echo "FAILED: $fail"; exit 1; }
