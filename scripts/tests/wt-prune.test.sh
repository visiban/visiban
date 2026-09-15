#!/usr/bin/env bash
# scripts/tests/wt-prune.test.sh
#
# Unit test for how `wt prune` decides a worktree's branch has landed.
#
# The bug: prune counted a branch as merged only when its local tip was an
# ancestor of origin/<default>. That fails whenever the branch's work reached
# the default branch by any path other than a plain merge commit — a tip
# rewritten after its last push (amend, local rebase, GitLab server-side
# rebase), a squash merge, or a default branch whose own history was rewritten
# (e.g. release-time compaction) after the merge landed. In all of those cases
# prune warned "commits NOT in origin/<default>" and kept the worktree
# forever, silently eating the WIP cap (visiban issue: worktrees for !37, !38,
# !39, !855, !856, !857 sat unpruned after main's history was rewritten past
# their merge commits).
#
# The fix must not trade a false keep for a false prune, so each widened path
# has a near-identical negative twin that must SURVIVE: a squash merge whose MR
# head does not match the local tip, and a branch where only SOME of the
# patches reached the default branch.
#
# `glab` is stubbed: the sandbox has no GitLab. A real glab would fail every MR
# lookup (so the squash case could never pass) and, through clear_lock, could
# act on the real project's issues. `lock_available` also requires the origin
# URL to look like a GitLab remote, so the stub repos' origins are named with
# "gitlab" in the path.
#
# Run: bash scripts/tests/wt-prune.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WT="$REPO_ROOT/scripts/wt"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() {
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# `glab api merge_requests?...` filters $GLAB_STUB_JSON (default: no MRs) by
# the request's own target_branch= query param, the way GitLab's real API
# would — this is what lets case 6 prove wt actually SENDS target_branch,
# not just that it would work if GitLab enforced it. Every other call — the
# issue label/note writes clear_lock makes — succeeds and does nothing.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/glab" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "api" ]]; then
  url="${2:-}"
  want_target="$(printf '%s' "$url" | sed -n 's/.*target_branch=\([^&]*\).*/\1/p')"
  printf '%s' "${GLAB_STUB_JSON:-[]}" | python3 -c '
import json, sys, urllib.parse
want = urllib.parse.unquote(sys.argv[1]) if sys.argv[1] else None
try:
    mrs = json.load(sys.stdin)
except Exception:
    mrs = []
if want is not None:
    mrs = [m for m in mrs if isinstance(m, dict) and m.get("target_branch") == want]
json.dump(mrs, sys.stdout)
' "$want_target"
fi
exit 0
EOF
chmod +x "$TMP/bin/glab"
export PATH="$TMP/bin:$PATH"

# mk_repo <dir> — a repo on main with a "gitlab"-named bare origin holding
# main (forge_cli/lock_available key off "gitlab" appearing in the remote URL).
mk_repo() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d"
    git init -q -b main
    git config user.email t@t.co
    git config user.name  t
    echo base > README.md
    git add -A
    git commit -qm init
    git init -q --bare "$d.gitlab-origin.git"
    git remote add origin "$d.gitlab-origin.git"
    git push -q origin main
    git fetch -q origin
  )
}

# commit_in <dir> <name> — one commit adding <name>.txt.
commit_in() {
  echo "$2" > "$1/$2.txt"
  git -C "$1" add "$2.txt"
  git -C "$1" commit -qm "$2"
}

# add_wt <repo> <branch> <commits> — a worktree on <branch> with N commits,
# pushed WITH an upstream (prune skips never-pushed branches). Prints the path.
add_wt() {
  local d="$1" b="$2" n="$3" p i
  p="$d.wt.${b//\//-}"
  git -C "$d" worktree add -q -b "$b" "$p" main 2>/dev/null
  for (( i = 1; i <= n; i++ )); do commit_in "$p" "${b//\//-}-$i"; done
  git -C "$p" push -q -u origin "$b" 2>/dev/null
  printf '%s' "$p"
}

# land <repo> <branch> — publish main and delete the branch on origin, which is
# what GitLab's merge + remove_source_branch_after_merge leaves behind.
land() {
  git -C "$1" push -q origin main 2>/dev/null
  git -C "$1" push -q origin --delete "$2" 2>/dev/null
}

RUN_OUT=""
prune_in() { # prune_in <repo> [glab json]
  set +e
  RUN_OUT="$( cd "$1" && GLAB_STUB_JSON="${2:-[]}" bash "$WT" prune 2>&1 )"
  set -e
}

not_ancestor() { # 0 when the branch tip is NOT in main's history
  ! git -C "$1" merge-base --is-ancestor "$2" main
}

# --- Case 1 (control): a merge-commit merge is pruned -----------------------
echo "Case 1: merge-commit merge"
D="$TMP/c1"; mk_repo "$D"
P="$(add_wt "$D" feat/1-merge 1)"
git -C "$D" merge -q --no-ff feat/1-merge -m "Merge feat/1-merge"
land "$D" feat/1-merge
prune_in "$D"
check "a merged, remote-deleted worktree is removed"  "$(if [[ ! -d "$P" ]]; then echo 0; else echo 1; fi)"
check "…with the standard report line"                "$(printf '%s' "$RUN_OUT" | grep -q 'removed (merged to main, remote gone)'; echo $?)"

# --- Case 2: tip rewritten after its last push -------------------------------
echo "Case 2: local tip rewritten after push"
D="$TMP/c2"; mk_repo "$D"
P="$(add_wt "$D" chore/2-amended 1)"
git -C "$D" merge -q --no-ff chore/2-amended -m "Merge chore/2-amended"
land "$D" chore/2-amended
git -C "$P" commit -q --amend -m "reworded after the push"
check "precondition: the rewritten tip is not an ancestor of main" "$(not_ancestor "$D" chore/2-amended; echo $?)"
prune_in "$D"
check "a rewritten tip whose patch is in main is removed"  "$(if [[ ! -d "$P" ]]; then echo 0; else echo 1; fi)"
check "…and says why"                                      "$(printf '%s' "$RUN_OUT" | grep -q 'every patch already in main'; echo $?)"

# --- Case 3: squash merge, merged MR head == local tip -----------------------
echo "Case 3: squash merge matched by MR head"
D="$TMP/c3"; mk_repo "$D"
P="$(add_wt "$D" feat/3-squash 2)"
git -C "$D" merge -q --squash feat/3-squash >/dev/null && git -C "$D" commit -qm "squashed"
land "$D" feat/3-squash
TIP="$(git -C "$D" rev-parse feat/3-squash)"
check "precondition: not an ancestor"               "$(not_ancestor "$D" feat/3-squash; echo $?)"
CHERRY="$(git -C "$D" cherry main feat/3-squash)"
check "precondition: git cherry cannot see it"      "$(if [[ "$CHERRY" == *"+ "* ]]; then echo 0; else echo 1; fi)"
prune_in "$D" "[{\"iid\": 1, \"sha\": \"$TIP\", \"target_branch\": \"main\"}]"
check "a squash merge whose MR head is the tip is removed" "$(if [[ ! -d "$P" ]]; then echo 0; else echo 1; fi)"
check "…and says why"                                       "$(printf '%s' "$RUN_OUT" | grep -q 'merged MR head matches the local tip'; echo $?)"

# --- Case 4: squash merge, but the MR head is NOT the local tip -------------
# The local branch carries a commit the merged MR never had. Must survive.
echo "Case 4: squash merge, MR head differs"
D="$TMP/c4"; mk_repo "$D"
P="$(add_wt "$D" feat/4-squash 2)"
git -C "$D" merge -q --squash feat/4-squash >/dev/null && git -C "$D" commit -qm "squashed"
land "$D" feat/4-squash
prune_in "$D" '[{"iid": 1, "sha": "0000000000000000000000000000000000000000", "target_branch": "main"}]'
check "a squash merge whose MR head differs is kept"  "$(if [[ -d "$P" ]]; then echo 0; else echo 1; fi)"
check "…with the not-in-main warning"                 "$(printf '%s' "$RUN_OUT" | grep -q 'NOT in origin/main'; echo $?)"

# --- Case 5: only some of the branch's patches reached main -----------------
echo "Case 5: partially landed branch"
D="$TMP/c5"; mk_repo "$D"
P="$(add_wt "$D" fix/5-partial 2)"
git -C "$D" cherry-pick "$(git -C "$P" rev-parse HEAD~1)" >/dev/null
land "$D" fix/5-partial
prune_in "$D"
check "a branch with an unlanded patch is kept"       "$(if [[ -d "$P" ]]; then echo 0; else echo 1; fi)"

# --- Case 6: squash merge, MR head matches but it merged onto a DIFFERENT
# target branch (a release branch, a mistakenly-retargeted MR) — must survive.
# Also proves wt's query actually sends target_branch: the stub filters on it
# exactly like GitLab's real API would, so this fails closed if that regresses.
echo "Case 6: squash merge, MR head matches but wrong target branch"
D="$TMP/c6"; mk_repo "$D"
P="$(add_wt "$D" feat/6-squash 2)"
git -C "$D" merge -q --squash feat/6-squash >/dev/null && git -C "$D" commit -qm "squashed"
land "$D" feat/6-squash
TIP="$(git -C "$D" rev-parse feat/6-squash)"
prune_in "$D" "[{\"iid\": 1, \"sha\": \"$TIP\", \"target_branch\": \"release/1.0\"}]"
check "a squash merge onto a different target branch is kept" "$(if [[ -d "$P" ]]; then echo 0; else echo 1; fi)"
check "…with the not-in-main warning"                          "$(printf '%s' "$RUN_OUT" | grep -q 'NOT in origin/main'; echo $?)"

echo ""
echo "wt-prune: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
