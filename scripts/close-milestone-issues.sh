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

page=1
closed=0
while true; do
  # Fetch one page of open issues in the milestone.
  ids=$(glab issue list \
    --milestone "$MILESTONE" \
    --page "$page" \
    --per-page 30 \
    2>&1 | grep '^#' | awk '{print $1}' | tr -d '#')

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
