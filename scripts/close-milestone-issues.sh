#!/usr/bin/env bash
# close-milestone-issues.sh — Close all open issues in a GitLab milestone.
#
# Called automatically by release.sh after the tag is pushed. Can also be
# run manually to clean up a milestone at any point:
#
#   scripts/close-milestone-issues.sh "1.0"
#
# Requires: glab authenticated, GITLAB_REPO set or run from repo root.
# Exits 0 even if there are no open issues (idempotent).

set -euo pipefail

MILESTONE="${1:-}"
if [[ -z "$MILESTONE" ]]; then
  echo "Usage: $0 <milestone-title>" >&2
  echo "Example: $0 \"1.0\"" >&2
  exit 1
fi

REPO="${GITLAB_REPO:-$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\(.*\)\.git|\1|' | sed 's|.*[:/]\(.*\)|\1|')}"

echo "Fetching open issues for milestone '${MILESTONE}' in ${REPO}..."

# Verify the milestone exists before looping. glab issue list --milestone accepts
# any string and silently returns empty results if no matching milestone is found,
# which trips set -o pipefail via grep's exit-1 on empty input. We detect this
# early and print a helpful error instead of exiting silently.
if ! glab api "projects/${REPO//\//%2F}/milestones" 2>/dev/null \
    | python3 -c "import sys, json; ms=json.load(sys.stdin); exit(0 if any(m['title']=='''${MILESTONE}''' for m in ms) else 1)" 2>/dev/null; then
  echo "ERROR: No milestone titled '${MILESTONE}' found in ${REPO}." >&2
  echo "Available milestones:" >&2
  glab api "projects/${REPO//\//%2F}/milestones" 2>/dev/null \
    | python3 -c "import sys,json; [print('  -', m['title']) for m in json.load(sys.stdin)]" 2>/dev/null || true
  exit 1
fi

page=1
closed=0
while true; do
  # Fetch one page of open issues in the milestone.
  # Use `|| true` on the grep so an empty page (no matching lines) does not
  # cause the pipeline to exit non-zero under set -o pipefail.
  ids=$(glab issue list \
    --milestone "$MILESTONE" \
    --page "$page" \
    --per-page 30 \
    2>&1 | grep '^#' | awk '{print $1}' | tr -d '#' || true)

  [[ -z "$ids" ]] && break

  for id in $ids; do
    echo "  Closing #${id}..."
    glab issue close "$id" 2>&1
    ((closed++)) || true
  done

  page=$((page + 1))
done

if [[ $closed -eq 0 ]]; then
  echo "No open issues found for milestone '${MILESTONE}' — nothing to close."
else
  echo "Closed ${closed} issue(s) in milestone '${MILESTONE}'."
fi
