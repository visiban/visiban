#!/usr/bin/env bash
# scripts/tests/release.test.sh
#
# Unit test for scripts/release.sh — specifically the CHANGELOG rotation and
# already-published guard, which are pure functions the script exposes via
# `--self-test` (see scripts/release.sh's own self-test cases for the
# regression coverage: the orphan `---` divider left by the old two-step
# sed-rename + awk-prepend rotation, cleaned up in CHANGELOG.md's 1.0.0 and
# 1.1.0 sections — #<see MR>).
#
# This file covers what `--self-test` cannot: the command-line surface (usage
# error, invalid semver rejection) that a `bash -n` syntax check alone would
# miss.
#
# Run: bash scripts/tests/release.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/release.sh"
[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT not found"; exit 1; }

fail=0
pass=0
check() { # <desc> <rc>
  if [ "$2" -eq 0 ]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# The script's own --self-test proves rotate_changelog and refuse_if_published
# against their known regression cases.
set +e
OUT="$(bash "$SCRIPT" --self-test 2>&1)"
RC=$?
set -e
check "release.sh --self-test passes" "$RC"
if ! grep -q "release: self-test passed." <<<"$OUT"; then
  echo "  FAIL: self-test did not report success"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# No version argument → usage error, not a bare crash.
set +e
OUT="$(bash "$SCRIPT" 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -qi "usage" <<<"$OUT"; then pass=$((pass + 1)); else
  echo "  FAIL: missing version argument should print usage and exit non-zero (rc=$RC)"
  fail=$((fail + 1))
fi

# Invalid semver is rejected before anything mutates the working tree.
set +e
OUT="$(cd "$REPO_ROOT" && bash "$SCRIPT" not-a-version 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -qi "not valid semver" <<<"$OUT"; then pass=$((pass + 1)); else
  echo "  FAIL: invalid semver should be rejected (rc=$RC)"
  fail=$((fail + 1))
fi

echo "release.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
