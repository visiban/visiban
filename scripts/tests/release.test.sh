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


# Version-consistency checks must fail closed (#1269): a broken check must
# exit non-zero BEFORE any commit/push/tag, and must leave the working tree
# fully rolled back (git reset --hard / checkout main / release branch
# deleted) rather than partially mutated. Exercised against an isolated local
# clone of this repo so the real branch/commit/rollback machinery runs for
# real without touching this checkout or any real remote — `origin` on the
# clone is this on-disk repo, not GitLab, so nothing here reaches the network.
TMPCLONE="$(mktemp -d)"
git clone --quiet "$REPO_ROOT" "$TMPCLONE/repo"
(
  cd "$TMPCLONE/repo"
  # Simulate bump_chart_app_version's anchor (`^appVersion: `) silently no
  # longer matching a future Chart.yaml reformat — the exact failure mode
  # #1269 is guarding against — by quoting the key so the line no longer
  # starts with `appVersion: `.
  sed -i.bak 's/^appVersion: /"appVersion": /' helm/visiban/Chart.yaml
  rm -f helm/visiban/Chart.yaml.bak
  git -c user.email=t@t -c user.name=t commit -aqm "test: break appVersion anchor"
)
set +e
OUT="$(cd "$TMPCLONE/repo" && RELEASE_ASSUME_YES=1 bash scripts/release.sh 9.9.9-test.1 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -q "version consistency check(s) failed" <<<"$OUT"; then
  pass=$((pass + 1))
else
  echo "  FAIL: a broken version-consistency check should exit non-zero and report why (rc=$RC)"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
fi

# No commit was made and the release branch was rolled back: back on main,
# the release branch is gone, and the working tree is clean — not left with
# the file rewrites this run made (Chart.yaml, .env.example, etc.) sitting
# uncommitted for the operator to clean up by hand.
STRAY_BRANCH=$(cd "$TMPCLONE/repo" && git branch --list "chore/release-9.9.9-test.1")
CURRENT_BRANCH=$(cd "$TMPCLONE/repo" && git branch --show-current)
DIRTY=$(cd "$TMPCLONE/repo" && git status --porcelain)
if [ -z "$STRAY_BRANCH" ] && [ "$CURRENT_BRANCH" = "main" ] && [ -z "$DIRTY" ]; then
  pass=$((pass + 1))
else
  echo "  FAIL: a failed version-consistency check should roll the release branch back completely (stray branch='${STRAY_BRANCH}' current branch='${CURRENT_BRANCH}' dirty='${DIRTY}')"
  fail=$((fail + 1))
fi
rm -rf "$TMPCLONE"

echo "release.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
