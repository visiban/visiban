#!/usr/bin/env bash
# Tests scripts/ci-api-canary.py end to end (#2461): the loopback canary must stay
# silent for a hermetic test and flag a test that reaches the API with inherited CI
# variables. The decisive case replays #2412: resolve-docs-version.test.sh with its
# `env -u GITLAB_API_TOKEN -u CI_API_V4_URL -u CI_PROJECT_ID` scrub reverted, run under
# the poison env + canary, must be flagged. Run: bash scripts/tests/ci-api-canary.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# canary_run <name> <command...>: runs the command under poison env + canary; sets RC (verify rc) and VOUT.
canary_run() {
  local name="$1"; shift
  VOUT="$(
    # shellcheck disable=SC1091
    . "$ROOT/scripts/ci-poison-env.sh"
    export CI_PROJECT_ID=1  # GitLab always sets it; the #2412 lookup needs all three variables
    eval "$(python3 "$ROOT/scripts/ci-api-canary.py" start --log "$TMP/$name.log")"
    "$@" >"$TMP/$name.out" 2>&1
    python3 "$ROOT/scripts/ci-api-canary.py" verify --log "$TMP/$name.log" --pid "$CANARY_PID" 2>&1
  )"; RC=$?
}

canary_run hermetic true
if [ "$RC" -eq 0 ]; then ok "a test that never calls the API passes"; else bad "hermetic case flagged: $VOUT"; fi

canary_run leaky bash -c 'python3 -c "import os,urllib.request;urllib.request.urlopen(os.environ[\"CI_API_V4_URL\"]+\"/projects/1/pipelines\")"'
if [ "$RC" -eq 1 ] && grep -q '/projects/1/pipelines' <<<"$VOUT"; then ok "a test reaching the API is flagged with its path"; else bad "leaky case not flagged (rc=$RC): $VOUT"; fi

# Tests that run their own fake API are unaffected: the shipped resolve-docs-version test.
canary_run own-api bash "$ROOT/scripts/tests/resolve-docs-version.test.sh"
if [ "$RC" -eq 0 ] && grep -q 'all .* checks passed' "$TMP/own-api.out"; then ok "resolve-docs-version.test.sh (own fake API) is not flagged"; else bad "resolve-docs-version.test.sh flagged or failed (rc=$RC): $VOUT"; fi

# #2412 replay: revert the scrub, the canary must catch the inherited variables.
SRC="$ROOT/scripts/tests/resolve-docs-version.test.sh"
sed 's/ -u GITLAB_API_TOKEN -u CI_API_V4_URL -u CI_PROJECT_ID//' "$SRC" >"$TMP/reverted.test.sh"
if cmp -s "$SRC" "$TMP/reverted.test.sh"; then
  bad "revert experiment did not apply: the env -u scrub text changed; update this test"
else
  sed -i.bak "s#REPO_ROOT=.*#REPO_ROOT=\"$ROOT\"#" "$TMP/reverted.test.sh"
  canary_run reverted bash "$TMP/reverted.test.sh"
  printf '    canary> %s\n' "${VOUT//$'\n'/$'\n'    canary> }"
  if [ "$RC" -eq 1 ] && grep -q '/api/v4/' <<<"$VOUT"; then ok "reverting #2412's env -u scrub is flagged by the canary"; else bad "reverted scrub NOT flagged (rc=$RC): $VOUT"; fi
fi

# #2525: --log outside the allowed roots (absolute, or a `..` escape) is rejected with exit 2.
for badlog in /etc/canary-2525.log "$TMP/../../../../etc/canary-2525.log"; do
  for sub in start verify; do
    err="$(python3 "$ROOT/scripts/ci-api-canary.py" "$sub" --log "$badlog" 2>&1 >/dev/null)"; rc=$?
    if [ "$rc" -eq 2 ] && grep -q 'escapes' <<<"$err"; then ok "$sub rejects --log $badlog"; else bad "$sub accepted --log $badlog (rc=$rc): $err"; fi
  done
done
[ ! -e /etc/canary-2525.log ] || bad "a rejected --log still created a file"

[ "$fail" -eq 0 ] && echo "ci-api-canary.test.sh: all checks passed"
exit "$fail"
