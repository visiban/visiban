#!/usr/bin/env bash
# close-milestone-issues.sh — Close all open issues in a GitLab milestone.
#
# Called automatically by release.sh after a stable tag is pushed (pre-releases
# leave the milestone open). Can also be
# run manually to clean up a milestone at any point:
#
#   scripts/close-milestone-issues.sh "1.0"
#
# Requires: glab authenticated, GITLAB_REPO set or run from repo root.
# Exits 0 even if there are no open issues (idempotent). Exits nonzero, loudly, on
# any glab/API failure (#1904): a failed call is never reported as "no milestone"
# or "nothing left to close".

set -euo pipefail

MILESTONE="${1:-}"
if [[ -z "$MILESTONE" ]]; then
  echo "Usage: $0 <milestone-title>" >&2
  echo "Example: $0 \"1.0\"" >&2
  exit 1
fi

REPO="${GITLAB_REPO:-$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\(.*\)\.git|\1|' | sed 's|.*[:/]\(.*\)|\1|')}"

echo "Fetching open issues for milestone '${MILESTONE}' in ${REPO}..."

PROJECT="projects/${REPO//\//%2F}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# api_get <path> — print the response body, or die. A glab failure (auth, network,
# 5xx) must never look like an empty result (#1904), so the exit status is checked
# explicitly instead of discarding stderr and piping into a parser.
api_get() {
  local out
  if ! out=$(glab api "$1" 2>&1); then
    die "glab api $1 failed: ${out}"
  fi
  printf '%s' "$out"
}

# Verify the milestone exists before looping. The issues API silently returns an
# empty list for an unknown milestone title, so check the milestone list first.
# Titles are passed via argv, never interpolated into Python source.
# `title=` is an exact-match filter server-side, so the target is found no matter how
# many milestones the project has (an unfiltered first page of 100 would report a
# page-2 milestone as missing). state=all includes closed milestones.
encoded_ms=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MILESTONE")
ms_json=$(api_get "${PROJECT}/milestones?state=all&per_page=100&title=${encoded_ms}")
ms_check=$(printf '%s' "$ms_json" | python3 -c '
import sys, json
try:
    ms = json.load(sys.stdin)
except ValueError:
    print("BAD"); sys.exit(0)
if not isinstance(ms, list):
    print("BAD"); sys.exit(0)
if any(m.get("title") == sys.argv[1] for m in ms):
    print("FOUND")
elif len(ms) >= 100:
    # Defensive: a full page with no exact match means the filter was ignored and
    # the target may be on a later page. Fail loudly rather than say "missing".
    print("BAD")
    sys.exit(0)
else:
    print("MISSING")
for m in ms:
    print("  - " + str(m.get("title")))
' "$MILESTONE") || die "could not parse milestones response from glab"
case "$(printf '%s\n' "$ms_check" | head -n1)" in
  FOUND) ;;
  MISSING)
    echo "ERROR: No milestone titled '${MILESTONE}' found in ${REPO}." >&2
    echo "Available milestones:" >&2
    printf '%s\n' "$ms_check" | tail -n +2 >&2
    exit 1
    ;;
  *) die "milestones response from glab was not a JSON array: ${ms_json}" ;;
esac

# Collect every open issue iid first, paging until a short/empty page. Collecting
# before closing keeps pagination stable (closing shifts later pages) and lets a
# fetch failure abort before any issue is touched.
ids=()
page=1
while true; do
  body=$(api_get "${PROJECT}/issues?milestone=${encoded_ms}&state=opened&per_page=100&page=${page}")
  page_ids=$(printf '%s' "$body" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not isinstance(d, list):
    sys.exit(3)
print("\n".join(str(i["iid"]) for i in d))
print("COUNT=%d" % len(d))
') || die "issues page ${page} was not a JSON array: ${body}"
  count="${page_ids##*COUNT=}"
  while IFS= read -r id; do
    [[ "$id" == COUNT=* || -z "$id" ]] && continue
    ids+=("$id")
  done <<<"$page_ids"
  [[ "$count" -lt 100 ]] && break
  page=$((page + 1))
done

closed=0
failed=0
for id in "${ids[@]+"${ids[@]}"}"; do
  echo "  Closing #${id}..."
  if glab issue close "$id" 2>&1; then
    closed=$((closed + 1))
  else
    echo "ERROR: failed to close #${id}" >&2
    failed=$((failed + 1))
  fi
done

if [[ $failed -gt 0 ]]; then
  die "closed ${closed} issue(s) but ${failed} failed in milestone '${MILESTONE}'."
elif [[ $closed -eq 0 ]]; then
  echo "No open issues found for milestone '${MILESTONE}' — nothing to close."
else
  echo "Closed ${closed} issue(s) in milestone '${MILESTONE}'."
fi
