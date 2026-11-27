#!/usr/bin/env bash
# scripts/tests/wt-hooks-check.test.sh
#
# `wt new` calls warn_if_hooks_missing (#2686). It must never execute a
# setup-hooks.sh that predates --check (that would install hooks), must stay
# silent on a clean pass, and must print the output plus a warning, still
# returning 0, when --check fails. Exercises the function only; never runs
# `wt new`.
#
# Run: bash scripts/tests/wt-hooks-check.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d -t wt-hooks-2686.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

fail=0
check() { # check <desc> <test-args...>  (a `test` expression)
  local d="$1"; shift
  if test "$@"; then echo "  ok: $d"; else echo "  FAIL: $d"; fail=$((fail + 1)); fi
}

warn() { printf 'WARN: %s\n' "$*" >&2; }
# shellcheck disable=SC1090
source <(sed -n '/^warn_if_hooks_missing()/,/^}/p' "$REPO_ROOT/scripts/wt")

mkstub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$TMP/$1"; chmod +x "$TMP/$1"; }

# Call site: the function tests above prove nothing if cmd_new never calls it. WT_SCRIPT
# lets the negative control point at a copy with the calls deleted.
WT_SCRIPT="${WT_SCRIPT:-$REPO_ROOT/scripts/wt}"
cmd_new_body="$(sed -n '/^cmd_new()/,/^}/p' "$WT_SCRIPT")"
check "cmd_new body extracted" -n "$cmd_new_body"
check "cmd_new calls warn_if_hooks_missing" -n "$(grep 'warn_if_hooks_missing' <<<"$cmd_new_body")"

# (i) predates --check: never executed
mkstub old.sh 'touch "'"$TMP"'/old-ran"; echo installing'
out="$(warn_if_hooks_missing "$TMP/old.sh" 2>&1)"; rc=$?
check "old script returns 2" "$rc" -eq 2
check "old script not executed" ! -e "$TMP/old-ran"
check "old script prints nothing" -z "$out"

# missing script
warn_if_hooks_missing "$TMP/nope.sh" >/dev/null 2>&1; rc=$?
check "missing script returns 2" "$rc" -eq 2

# (ii) clean pass is silent
mkstub clean.sh '[[ "$1" == "--check" ]] && echo "ok: hook is managed"; exit 0'
out="$(warn_if_hooks_missing "$TMP/clean.sh" 2>&1)"; rc=$?
check "clean pass returns 0" "$rc" -eq 0
check "clean pass is silent" -z "$out"

# (iii) failing check prints output + warning, returns 0
mkstub bad.sh '[[ "$1" == "--check" ]] && echo "MISSING: pre-push"; exit 1'
out="$(warn_if_hooks_missing "$TMP/bad.sh" 2>&1)"; rc=$?
check "failing check returns 0" "$rc" -eq 0
check "failing check prints its output" -n "$(grep "MISSING: pre-push" <<<"$out")"
check "failing check prints the warning" -n "$(grep "WARN: git hooks are not fully installed" <<<"$out")"

[[ "$fail" -eq 0 ]] && echo "PASS" || { echo "FAILED: $fail"; exit 1; }
