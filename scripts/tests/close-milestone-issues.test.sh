#!/usr/bin/env bash
# scripts/tests/close-milestone-issues.test.sh
#
# Test for scripts/close-milestone-issues.sh (#1904): a glab failure must never be
# reported as "No milestone titled X" or as the milestone being finished. Drives the
# script against a stub `glab` placed first on PATH; no network access.
#
# Run: bash scripts/tests/close-milestone-issues.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/close-milestone-issues.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/close-milestone-test-1904.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"

# Stub glab. Behavior is driven by env vars:
#   STUB_FAIL_MS=1      milestones call exits 1
#   STUB_FAIL_PAGE=N    issues call for page N exits 1
#   STUB_FAIL_CLOSE=ID  `issue close ID` exits 1
#   STUB_PAGE1/STUB_PAGE2 JSON bodies for the issue pages (else [])
# Every call is appended to $STUB_LOG.
cat > "$TMP/bin/glab" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ "$1" = issue ] && [ "$2" = close ]; then
  [ "$3" = "$STUB_FAIL_CLOSE" ] && { echo "close boom" >&2; exit 1; }
  echo "closed $3"; exit 0
fi
case "$2" in
  *milestones*)
    [ "$STUB_FAIL_MS" = 1 ] && { echo "401 boom" >&2; exit 1; }
    # Honor the server-side exact-match title filter. STUB_MS_IGNORE_TITLE=1 simulates a
    # server that ignores it and returns a full page not containing the target.
    if [ "$STUB_MS_IGNORE_TITLE" = 1 ]; then echo "$STUB_MS_FULL"; exit 0; fi
    case "$2" in
      *"title=1.2"*) echo '[{"title":"1.2"}]' ;;
      *"title=1.3"*) echo '[{"title":"1.3"}]' ;;
      *"title=beyond100"*) echo '[{"title":"beyond100"}]' ;;
      *) echo '[]' ;;
    esac ;;
  *issues*)
    page="${2##*page=}"
    [ "$page" = "$STUB_FAIL_PAGE" ] && { echo "500 boom" >&2; exit 1; }
    if [ "$page" = 1 ]; then echo "${STUB_PAGE1:-[]}"; else echo "${STUB_PAGE2:-[]}"; fi ;;
esac
STUB
chmod +x "$TMP/bin/glab"
export STUB_LOG="$TMP/log" GITLAB_REPO="visiban/visiban"

fail=0
run() { # run <name> <want-rc> <want-substring> <forbidden-substring-or-empty> <milestone>
  local name="$1" want="$2" frag="$3" bad="$4" ms="$5" out code
  : > "$STUB_LOG"
  out="$(PATH="$TMP/bin:$PATH" bash "$SCRIPT" "$ms" 2>&1)"; code=$?
  if [[ "$code" -ne "$want" ]] || ! grep -qF -- "$frag" <<<"$out" \
      || { [[ -n "$bad" ]] && grep -qF -- "$bad" <<<"$out"; }; then
    echo "FAIL [$name]: rc=$code want=$want frag='$frag' bad='$bad' out=$out" >&2; fail=1
  else echo "ok [$name]"; fi
}

big="[$(seq 1 100 | sed 's/.*/{"iid":&}/' | paste -sd, -)]"

STUB_FAIL_MS=1 run milestone-lookup-fails 1 "glab api" "No milestone titled" 1.2
run unknown-milestone 1 "No milestone titled '9.9'" "" 9.9
run milestone-beyond-first-100 0 "nothing to close" "No milestone titled" beyond100
full=$(seq 1 100 | sed 's/.*/{"title":"m&"}/' | paste -sd, -)
STUB_MS_IGNORE_TITLE=1 STUB_MS_FULL="[$full]" run full-page-no-match-fails-loudly 1 "not a JSON array" "No milestone titled" 9.9
STUB_PAGE1='[{"iid":5},{"iid":6}]' run happy-path 0 "Closed 2 issue(s)" "" 1.2
run empty-milestone 0 "nothing to close" "" 1.2
STUB_FAIL_PAGE=1 run first-page-fails 1 "failed" "nothing to close" 1.2
STUB_PAGE1="$big" STUB_FAIL_PAGE=2 run later-page-fails 1 "failed" "Closed" 1.2
if grep -q 'issue close' "$STUB_LOG"; then
  echo "FAIL [later-page-fails-closes-nothing]: closed issues before a fetch failure" >&2; fail=1
else echo "ok [later-page-fails-closes-nothing]"; fi
STUB_PAGE1="$big" STUB_PAGE2='[{"iid":101}]' run paginates 0 "Closed 101 issue(s)" "" 1.2
STUB_PAGE1='[{"iid":5},{"iid":6}]' STUB_FAIL_CLOSE=5 run close-fails 1 "1 failed" "" 1.2

[[ "$fail" -eq 0 ]] && echo "close-milestone-issues test: all cases passed"
exit "$fail"
