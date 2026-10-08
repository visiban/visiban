#!/usr/bin/env bash
# Pre-tag / pre-audit check: every open `security::deferred` issue, in ANY milestone, must
# carry a valid unexpired accepted-risk note or it is a blocker (#1520, extends #1519/#1521).
#
# Usage:
#   check-security-deferred.sh              # exit 0 = clean, 1 = blocker(s) or check could not run
#   check-security-deferred.sh --self-test
#
# Why ALL milestones (maintainer decision, #1520): the unfixed gap is in `main` and ships
# with the tag whichever milestone the issue sits on. Filtering to the target milestone (plus
# milestone=None) let an issue moved to a later milestone, or left open in an already-closed
# one, drop out of the check. See docs/maintainers/security-deferred-label.md.
#
# Fail-CLOSED: any glab failure, non-array response, or missing glab/jq is a blocker, never
# "0 issues". (Contrast check_latest_not_drifted in release.sh, which fails open on a probe
# error because a backstop runs in the tag pipeline; nothing backstops this check.)
#
# This is the single implementation: /pre-release Step 1.5 and scripts/release.sh both call
# it, so the query cannot diverge. The accepted-risk verdict is scripts/security-deferred-verdict.sh.
#
# Env: GLAB (glab command, default glab), PROJECT (url-encoded path, default visiban%2Fvisiban),
#      TODAY / CAP (passed to the verdict script), VERDICT_SCRIPT (override, for tests).
set -uo pipefail

check() {
  local glab="${GLAB:-glab}" project="${PROJECT:-visiban%2Fvisiban}"
  local here; here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  local verdict_script="${VERDICT_SCRIPT:-$here/security-deferred-verdict.sh}"
  local today cap D N=0 FAIL=0 BLOCK=0
  today=${TODAY:-$(date +%F)}
  cap=${CAP:-$(date -v+1y +%F 2>/dev/null || date -d '+1 year' +%F 2>/dev/null)}   # BSD or GNU date
  if ! command -v "$glab" >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "🔴 deferred-security check could not run: glab and jq are required — treat as a blocker"
    return 1
  fi
  D=$(mktemp)
  # fetch <api-path>: glab must exit 0 and EVERY page must be a JSON array (an auth/404
  # error is an object, or a nonzero exit); prints the merged array.
  fetch() {
    local out; out=$("$glab" api --paginate "$1") || return 1
    printf '%s' "$out" | jq -s -e 'length>0 and all(.[]; type=="array")' >/dev/null 2>&1 || return 1
    printf '%s' "$out" | jq -s 'add'
  }
  # No milestone filter on purpose: see header.
  fetch "projects/$project/issues?labels=security::deferred&state=opened&per_page=100" > "$D" \
    || { rm -f "$D"; echo "🔴 deferred-security check could not run: issue query failed (auth/network/API error) — treat as a blocker"; return 1; }
  local iid conf ms notes cand v
  for iid in $(jq -r '.[].iid' "$D"); do
    N=$((N+1))
    conf=$(jq -r --argjson i "$iid" '.[]|select(.iid==$i)|.confidential' "$D")
    ms=$(jq -r --argjson i "$iid" '.[]|select(.iid==$i)|.milestone.title // "none"' "$D")
    notes=$(fetch "projects/$project/issues/$iid/notes?per_page=100") || { FAIL=1; echo "🔴 #$iid deferred-security check could not run: notes query failed — treat as a blocker"; continue; }
    # candidate lines as "author|line" from the description and every non-system comment
    cand=$( { jq -r --argjson i "$iid" '.[]|select(.iid==$i)|.author.username as $a|(.description // "")|gsub("\r";"")|split("\n")[]|select(startswith("Accepted risk:"))|"\($a)|\(.)"' "$D"
              printf '%s' "$notes" | jq -r '.[]|select(.system|not)|.author.username as $a|.body|gsub("\r";"")|split("\n")[]|select(startswith("Accepted risk:"))|"\($a)|\(.)"'; } )
    # An empty verdict (script missing/crashed) fails closed to BLOCKER; exit 1 is the normal BLOCKER signal.
    v=$(printf '%s\n' "$cand" | TODAY="$today" CAP="$cap" sh "$verdict_script" 2>/dev/null) || true
    [ -n "$v" ] || v="BLOCKER (verdict script produced no output)"
    case "$v" in BLOCKER*) BLOCK=1 ;; esac
    echo "#$iid confidential=$conf milestone=$ms $v"
  done
  rm -f "$D"
  echo "checked $N issue(s) across all milestones$([ "$FAIL" = 0 ] || echo '; CHECK DID NOT COMPLETE — a blocker')"
  [ "$FAIL" = 0 ] && [ "$BLOCK" = 0 ]
}

self_test() {
  local tmp rc=0 here; tmp=$(mktemp -d); here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # Stub glab: logs each path, serves $STUB_ISSUES / $STUB_NOTES, or fails when STUB_FAIL=1.
  cat > "$tmp/glab" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
[ "${STUB_FAIL:-}" = 1 ] && exit 1
case "$*" in *"/notes"*) cat "$STUB_NOTES" ;; *) cat "$STUB_ISSUES" ;; esac
STUB
  chmod +x "$tmp/glab"
  export STUB_LOG="$tmp/log" STUB_ISSUES="$tmp/issues.json" STUB_NOTES="$tmp/notes.json"
  export GLAB="$tmp/glab" TODAY=2026-10-08 CAP=2027-10-08
  t() { # name want_rc [grep-pattern-in-output]
    local out rc2; : > "$STUB_LOG"
    out=$(check 2>&1); rc2=$?
    if [ "$rc2" -ne "$2" ] || { [ -n "${3:-}" ] && ! grep -q -- "$3" <<<"$out"; }; then
      echo "FAIL [$1]: want rc=$2 pattern='${3:-}', got rc=$rc2: $out" >&2; rc=1
    else echo "ok [$1]"; fi
  }
  echo '[]' > "$STUB_NOTES"
  echo '[]' > "$STUB_ISSUES";                                                                     t no-issues 0 'checked 0 issue'
  # The bug class: an issue on a CLOSED/other milestone (and one on a later milestone) must block.
  echo '[{"iid":7,"confidential":false,"milestone":{"title":"1.1"},"author":{"username":"a"},"description":""}]' > "$STUB_ISSUES"
  t closed-milestone-blocks 1 '#7 confidential=false milestone=1.1 BLOCKER'
  echo '[{"iid":8,"confidential":true,"milestone":{"title":"2.0"},"author":{"username":"a"},"description":""}]' > "$STUB_ISSUES"
  t later-milestone-blocks 1 'milestone=2.0 BLOCKER'
  echo '[{"iid":9,"confidential":false,"milestone":null,"author":{"username":"a"},"description":""}]' > "$STUB_ISSUES"
  t no-milestone-blocks 1 'milestone=none BLOCKER'
  # Query must not filter by milestone, and must ask for open security::deferred issues.
  if grep -q 'milestone=' "$STUB_LOG" || ! grep -q 'labels=security::deferred&state=opened' "$STUB_LOG"; then
    echo "FAIL [query-shape]: $(cat "$STUB_LOG")" >&2; rc=1; else echo "ok [query-shape]"; fi
  # Valid accepted-risk note in the description clears it, regardless of milestone.
  echo '[{"iid":7,"confidential":false,"milestone":{"title":"1.1"},"author":{"username":"a"},"description":"Accepted risk: accepted-by: @bob; reason: ok; expires: 2027-01-01"}]' > "$STUB_ISSUES"
  t accepted-clears 0 'ACCEPTED'
  # Expired note still blocks.
  echo '[{"iid":7,"confidential":false,"milestone":{"title":"1.1"},"author":{"username":"a"},"description":"Accepted risk: accepted-by: @bob; reason: ok; expires: 2026-01-01"}]' > "$STUB_ISSUES"
  t expired-blocks 1 'BLOCKER'
  # Accepted via a non-system comment; a system note with the same text must not count.
  echo '[{"iid":7,"confidential":false,"milestone":null,"author":{"username":"a"},"description":""}]' > "$STUB_ISSUES"
  echo '[{"system":true,"author":{"username":"x"},"body":"Accepted risk: accepted-by: @bob; reason: ok; expires: 2027-01-01"}]' > "$STUB_NOTES"
  t system-note-ignored 1 'BLOCKER'
  echo '[{"system":false,"author":{"username":"c"},"body":"Accepted risk: accepted-by: @bob; reason: ok; expires: 2027-01-01"}]' > "$STUB_NOTES"
  t comment-note-accepted 0 'ACCEPTED'
  # Fail closed: API error, and a non-array (error object) response.
  STUB_FAIL=1 t api-error-fails-closed 1 'could not run'
  echo '{"message":"401 Unauthorized"}' > "$STUB_ISSUES"
  t non-array-fails-closed 1 'could not run'
  echo '[{"iid":7,"confidential":false,"milestone":null,"author":{"username":"a"},"description":""}]' > "$STUB_ISSUES"
  echo '{"message":"404"}' > "$STUB_NOTES"
  t notes-error-fails-closed 1 'DID NOT COMPLETE'
  GLAB=/nonexistent/glab t missing-glab-fails-closed 1 'glab and jq are required'
  echo '[{"system":false,"author":{"username":"c"},"body":"x"}]' > "$STUB_NOTES"
  VERDICT_SCRIPT=/nonexistent t missing-verdict-fails-closed 1 'BLOCKER'
  rm -rf "$tmp"
  [ "$rc" -eq 0 ] && echo "check-security-deferred self-test: all cases passed"
  return $rc
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  "") check; exit $? ;;
  *) echo "usage: $0 [--self-test]" >&2; exit 2 ;;
esac
