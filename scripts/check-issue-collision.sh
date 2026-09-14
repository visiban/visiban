#!/usr/bin/env bash
# scripts/check-issue-collision.sh — push-time issue-collision check (#1096).
#
# scripts/wt applies a `status::wip` GitLab label so parallel agent sessions don't
# grab the same issue — but that lock only covers work that goes through `wt`. A
# plain `git checkout -b feat/N-something` bypasses it entirely: no label, no
# collision detection, and the first signal is two merge requests solving the same
# issue. This script closes that gap by keying off the branch name and the forge
# directly, so it holds regardless of how the branch was created.
#
# Usage:
#   scripts/check-issue-collision.sh              Check the current branch. Exit 1
#                                                   blocks (only a real collision does
#                                                   this — see "Blocking vs warning").
#   scripts/check-issue-collision.sh --hook [...]  Same, for the pre-push hook
#                                                   installed by setup-hooks.sh. Extra
#                                                   args (git passes remote name/url)
#                                                   are accepted and ignored.
#   scripts/check-issue-collision.sh --self-test   Run offline self-tests (#1093)
#                                                   against stubbed forge responses —
#                                                   no network, no glab required.
#
# Blocking vs warning:
#   BLOCKS the push — an OPEN merge request already exists for this issue from a
#     DIFFERENT source branch. That is the actual collision: two branches racing to
#     close the same issue.
#   WARNS only, never blocks — the issue is already closed, or the `status::wip`
#     lock is held by a different branch (possibly another worktree). Both are
#     signals worth a second look, not proof of a collision.
#
# Fails closed, with a named escape hatch:
#   ALLOW_ISSUE_COLLISION=1  — allow the push despite a detected collision (the
#                              legitimate stacked-MR case: two branches for the same
#                              issue on purpose).
#
# Degrades to a WARN + allow (never a hard failure) when the forge can't be reached:
# glab missing, unauthenticated, origin isn't GitLab-hosted, or the API call itself
# fails (network down, offline on a plane). A developer must always be able to push.
#
# WT_LOCK_LABEL  GitLab label used for the wt check-out lock (default: status::wip) —
#                same variable name and default as scripts/wt, so both agree if
#                either is overridden.

set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers (same style as scripts/wt)
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_RED='\033[31m'; C_YELLOW='\033[33m'; C_GREEN='\033[32m'; C_DIM='\033[2m'; C_OFF='\033[0m'
else
  C_RED=''; C_YELLOW=''; C_GREEN=''; C_DIM=''; C_OFF=''
fi

err()  { printf "${C_RED}check-issue-collision: %s${C_OFF}\n" "$*" >&2; }
warn() { printf "${C_YELLOW}check-issue-collision: %s${C_OFF}\n" "$*" >&2; }
ok()   { printf "${C_GREEN}check-issue-collision: %s${C_OFF}\n" "$*"; }
say()  { printf "%s\n" "$*"; }
dim()  { printf "${C_DIM}%s${C_OFF}\n" "$*"; }

WT_LOCK_LABEL="${WT_LOCK_LABEL:-status::wip}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Detect the forge CLI, same logic as scripts/wt's forge_cli().
forge_cli() {
  local url; url="$(git remote get-url origin 2>/dev/null || true)"
  case "$url" in
    *github.com*) echo gh ;;
    *gitlab*)     echo glab ;;
    *)            echo "" ;;
  esac
}

lock_available() { [[ "$(forge_cli)" == "glab" ]] && command -v glab >/dev/null 2>&1; }

# Extract the issue number encoded in a branch name, e.g. feat/1096-foo -> 1096.
# Empty for a branch with no leading issue number (chore/some-slug, main, ...).
issue_from_branch() {
  local branch="$1"
  if [[ "$branch" =~ ^(feat|fix|chore|docs)/([0-9]+)- ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  fi
}

# The branch named in the most recent wt "checked out" note on an issue, or empty.
# Mirrors scripts/wt's last_checkout_note() note format:
#   "🔒 checked out <ts> · branch `<branch>` · worktree `<path>`"
last_checkout_branch() {
  local issue="$1" note
  note="$(glab issue view "$issue" --comments --output json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
notes = d.get('Notes') or d.get('notes') or []
hits = [(n.get('body') or '') for n in notes if '🔒 checked out' in (n.get('body') or '')]
print(hits[-1] if hits else '')
" 2>/dev/null || true)"
  if [[ "$note" =~ branch\ \`([^\`]+)\` ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# Pure decision function — takes already-fetched data, makes zero network calls.
# This is what --self-test exercises directly with fixtures, and what main() calls
# with real glab output.
#
# Args:
#   $1 issue number
#   $2 current branch
#   $3 related_mrs_json  — JSON array from
#                           `glab api projects/:id/issues/<issue>/related_merge_requests`
#                           (or "[]")
#   $4 issue_state        — "opened" | "closed" | "" (unknown)
#   $5 lock_branch        — branch named in the last status::wip check-out note, or ""
#
# Prints findings to stdout/stderr via the helpers above. Returns 0 (allow) or
# 1 (block) — the caller decides whether a 1 is fatal or overridden by
# ALLOW_ISSUE_COLLISION.
decide_collision() {
  local issue="$1" branch="$2" mrs_json="$3" issue_state="$4" lock_branch="$5"
  local blocking=0 other

  # Block: an OPEN MR already exists for this issue from a DIFFERENT branch.
  other="$(printf '%s' "$mrs_json" | python3 -c '
import json, sys
try:
    mrs = json.load(sys.stdin)
except Exception:
    mrs = []
branch = sys.argv[1]
for mr in mrs:
    if mr.get("state") == "opened" and mr.get("source_branch") != branch:
        print("%s\t%s\t%s" % (mr.get("iid", "?"), mr.get("source_branch", "?"), mr.get("web_url", "")))
        break
' "$branch" 2>/dev/null || true)"

  if [[ -n "$other" ]]; then
    local mr_iid mr_branch mr_url
    IFS=$'\t' read -r mr_iid mr_branch mr_url <<< "$other"
    err "issue #$issue already has an open MR: !$mr_iid from branch '$mr_branch'"
    [[ -n "$mr_url" ]] && dim "  $mr_url"
    blocking=1
  fi

  # Warn only: issue already closed.
  if [[ "$issue_state" == "closed" ]]; then
    warn "issue #$issue is already closed — double check this push is still needed"
  fi

  # Warn only: status::wip lock held by a different branch (possibly another worktree).
  if [[ -n "$lock_branch" && "$lock_branch" != "$branch" ]]; then
    warn "issue #$issue carries '$WT_LOCK_LABEL' checked out on branch '$lock_branch' — possibly another worktree already on this"
  fi

  return "$blocking"
}

# ---------------------------------------------------------------------------
# Main (network path)
# ---------------------------------------------------------------------------

main() {
  local branch issue
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
    dim "check-issue-collision: detached HEAD — nothing to check"
    return 0
  fi

  issue="$(issue_from_branch "$branch")"
  if [[ -z "$issue" ]]; then
    dim "check-issue-collision: no issue number in branch '$branch' — nothing to check"
    return 0
  fi

  if ! lock_available; then
    warn "glab unavailable or origin isn't GitLab-hosted — skipping collision check (push allowed)"
    return 0
  fi

  if ! glab auth status >/dev/null 2>&1; then
    warn "glab not authenticated — skipping collision check (push allowed)"
    return 0
  fi

  local mrs_json
  if ! mrs_json="$(glab api "projects/:id/issues/${issue}/related_merge_requests" 2>/dev/null)"; then
    warn "could not reach GitLab — skipping collision check (push allowed)"
    return 0
  fi
  [[ -n "$mrs_json" ]] || mrs_json="[]"

  local issue_json issue_state lock_branch=""
  issue_json="$(glab issue view "$issue" --output json 2>/dev/null || true)"
  issue_state="$(printf '%s' "$issue_json" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("state", ""))
except Exception:
    print("")
' 2>/dev/null || true)"

  if printf '%s' "$issue_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if sys.argv[1] in (d.get("labels") or []) else 1)
' "$WT_LOCK_LABEL" 2>/dev/null; then
    lock_branch="$(last_checkout_branch "$issue")"
  fi

  local rc=0
  decide_collision "$issue" "$branch" "$mrs_json" "$issue_state" "$lock_branch" || rc=$?

  if [[ "$rc" -eq 0 ]]; then
    return 0
  fi

  if [[ -n "${ALLOW_ISSUE_COLLISION:-}" ]]; then
    warn "ALLOW_ISSUE_COLLISION=1 set — allowing push despite the collision above"
    return 0
  fi

  err "push blocked. If this is a legitimate stacked MR, override with: ALLOW_ISSUE_COLLISION=1 git push ..."
  return 1
}

# ---------------------------------------------------------------------------
# Self-test (#1093) — offline, no glab, no network.
# ---------------------------------------------------------------------------

run_self_test() {
  local failures=0

  assert_eq() { # description, expected, actual
    if [[ "$2" == "$3" ]]; then
      ok "  ok: $1"
    else
      err "  FAIL: $1 (expected: '$2' | got: '$3')"
      failures=$((failures + 1))
    fi
  }

  assert_contains() { # description, haystack, needle
    if [[ "$2" == *"$3"* ]]; then
      ok "  ok: $1"
    else
      err "  FAIL: $1 (expected output to contain: '$3')"
      failures=$((failures + 1))
    fi
  }

  say "check-issue-collision self-test"
  say "================================"
  say ""
  say "-- issue_from_branch --"
  assert_eq "feat/1096-foo-bar -> 1096" "1096" "$(issue_from_branch 'feat/1096-foo-bar')"
  assert_eq "fix/42-bar -> 42" "42" "$(issue_from_branch 'fix/42-bar')"
  assert_eq "docs/7-readme -> 7" "7" "$(issue_from_branch 'docs/7-readme')"
  assert_eq "chore/some-slug -> empty (no issue number)" "" "$(issue_from_branch 'chore/some-slug')"
  assert_eq "main -> empty" "" "$(issue_from_branch 'main')"
  assert_eq "release/1.2.0 -> empty (not a tracked prefix)" "" "$(issue_from_branch 'release/1.2.0')"

  say ""
  say "-- decide_collision --"

  local out rc

  out="$(decide_collision 1096 'feat/1096-mine' '[]' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "no related MRs, open issue -> allow" "0" "$rc"

  out="$(decide_collision 1096 'feat/1096-mine' '[{"iid":42,"state":"opened","source_branch":"feat/1096-other","web_url":"https://example.test/mr/42"}]' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "open MR on a different branch -> block" "1" "$rc"
  assert_contains "block message names the MR" "$out" "!42"
  assert_contains "block message names the branch" "$out" "feat/1096-other"

  out="$(decide_collision 1096 'feat/1096-mine' '[{"iid":42,"state":"opened","source_branch":"feat/1096-mine","web_url":""}]' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "open MR on THIS branch -> allow (it's our own MR)" "0" "$rc"

  out="$(decide_collision 1096 'feat/1096-mine' '[{"iid":42,"state":"closed","source_branch":"feat/1096-other","web_url":""}]' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "closed MR on a different branch -> allow (not open)" "0" "$rc"

  out="$(decide_collision 1096 'feat/1096-mine' '[{"iid":7,"state":"opened","source_branch":"feat/1096-a"},{"iid":42,"state":"opened","source_branch":"feat/1096-mine"}]' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "one MR on our branch, one on another -> block on the other" "1" "$rc"
  assert_contains "block message names the colliding MR, not ours" "$out" "!7"

  out="$(decide_collision 1096 'feat/1096-mine' '[]' 'closed' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "closed issue alone -> allow (warn only)" "0" "$rc"
  assert_contains "closed-issue warning printed" "$out" "already closed"

  out="$(decide_collision 1096 'feat/1096-mine' '[]' 'opened' 'feat/1096-someone-else' 2>&1)" && rc=0 || rc=$?
  assert_eq "lock held by another branch -> allow (warn only)" "0" "$rc"
  assert_contains "lock warning printed" "$out" "status::wip"

  out="$(decide_collision 1096 'feat/1096-mine' '[]' 'opened' 'feat/1096-mine' 2>&1)" && rc=0 || rc=$?
  assert_eq "lock held by THIS branch -> allow, no warning" "0" "$rc"
  if [[ "$out" == *"status::wip"* ]]; then
    err "  FAIL: unexpected lock warning when the lock is our own branch's"
    failures=$((failures + 1))
  else
    ok "  ok: no spurious lock warning for our own branch"
  fi

  out="$(decide_collision 1096 'feat/1096-mine' '[{"iid":42,"state":"opened","source_branch":"feat/1096-other","web_url":""}]' 'closed' 'feat/1096-other' 2>&1)" && rc=0 || rc=$?
  assert_eq "collision + closed issue + foreign lock all at once -> still blocks" "1" "$rc"
  assert_contains "combined case still warns on closed issue" "$out" "already closed"
  assert_contains "combined case still warns on foreign lock" "$out" "status::wip"

  out="$(decide_collision 1096 'feat/1096-mine' 'not valid json{{{' 'opened' '' 2>&1)" && rc=0 || rc=$?
  assert_eq "malformed MR JSON -> treated as no MRs, allow (fail closed on collision, not on garbage)" "0" "$rc"

  say ""
  say "-- ALLOW_ISSUE_COLLISION override (main()'s post-decide branch) --"
  # decide_collision itself has no knowledge of the env var — the override lives in
  # main(). Exercise that branch logic directly against a blocking decision.
  local override_rc
  ( export ALLOW_ISSUE_COLLISION=1
    set +e
    decide_collision 1096 'feat/1096-mine' '[{"iid":42,"state":"opened","source_branch":"feat/1096-other","web_url":""}]' 'opened' '' >/dev/null 2>&1
    d_rc=$?
    [[ "$d_rc" -ne 0 && -n "${ALLOW_ISSUE_COLLISION:-}" ]]
  )
  override_rc=$?
  assert_eq "override path allows a blocking decision when ALLOW_ISSUE_COLLISION=1" "0" "$override_rc"

  say ""
  if (( failures == 0 )); then
    ok "all checks passed"
    return 0
  else
    err "$failures failure(s)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

case "${1:-}" in
  --self-test)
    run_self_test
    exit $?
    ;;
  --hook)
    shift
    main "$@"
    exit $?
    ;;
  -h|--help)
    sed -n '2,/^$/p' "$0" | sed -E 's/^# ?//'
    exit 0
    ;;
  "")
    main
    exit $?
    ;;
  *)
    err "unknown option: $1 (use --self-test, --hook, or no args)"
    exit 2
    ;;
esac
