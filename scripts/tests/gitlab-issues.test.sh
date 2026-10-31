#!/usr/bin/env bash
# scripts/tests/gitlab-issues.test.sh
#
# Unit test for scripts/lib/gitlab-issues.sh (#1694) — the shared GitLab
# issue-state resolver ported from trueppm/trueppm#4452. Drives
# gitlab_issue_states against a fake `curl` placed first on PATH, so it
# needs no network access and depends on no real GitLab issue existing.
#
# Covers, directly against the library (scripts/tests/check-suppression-issues.test.sh
# covers the same guarantees one layer up, through check-suppression-issues.sh's
# real fetch path):
#   - batching: every cited iid ends up in the request URL;
#   - JOB-TOKEN is never sent, even when CI_JOB_TOKEN is set;
#   - token resolution order: GITLAB_API_TOKEN, else ISSUES_API_TOKEN, else
#     anonymous;
#   - a 401 on an authenticated request falls back to an anonymous request
#     for the same batch instead of reporting the lookup inconclusive;
#   - an iid the tracker never returns is simply absent from the output —
#     callers, not this library, decide what "missing" means;
#   - a transport failure (curl itself exits non-zero) returns 1 and prints
#     nothing.
#
# Run: bash scripts/tests/gitlab-issues.test.sh
#
# shellcheck disable=SC2016
# (file-wide: every install_fake_curl body below is deliberately
# single-quoted so its `$*`/`$CALL_LOG`/`$a` references stay literal until
# the written-out curl fixture script actually runs later, instead of
# expanding now against this test's own variables.)
set -euo pipefail

# Start from a token-free environment: GITLAB_API_TOKEN is a protected project
# CI variable (#1996), so on main it would otherwise leak into every case and
# defeat the token-resolution assertions below, which set tokens per command.
unset GITLAB_API_TOKEN ISSUES_API_TOKEN

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/gitlab-issues.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <0-if-true>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# shellcheck source=scripts/lib/gitlab-issues.sh
source "$LIB"

# fake_curl <script-body> — writes an executable `curl` into its own PATH
# directory for the duration of one case and prepends it to PATH. Each
# invocation's args are appended, one line per call, to "$TMP/calls.log" (so
# a test can assert on batching/headers), before the fixture-specific body
# decides what to print. `$CALL_LOG` is always available to the fixture.
FAKE_BIN_BASE="$TMP/bin"
mkdir -p "$FAKE_BIN_BASE"

install_fake_curl() {
  local name="$1" body="$2"
  local dir="$FAKE_BIN_BASE/$name"
  mkdir -p "$dir"
  {
    echo '#!/usr/bin/env bash'
    echo 'echo "$*" >> "$CALL_LOG"'
    echo "$body"
  } > "$dir/curl"
  chmod +x "$dir/curl"
  printf '%s' "$dir"
}

# --- Case 1: batching — every cited iid appears in the request URL --------
CALL_LOG="$TMP/calls-batch.log"
: > "$CALL_LOG"
export CALL_LOG
fake_dir="$(install_fake_curl batch '
for a in "$@"; do
  case "$a" in
    JOB-TOKEN:*) echo "JOB-TOKEN SENT" >&2; exit 99 ;;
  esac
done
printf '"'"'[{"iid":1,"state":"opened"},{"iid":2,"state":"closed"},{"iid":3,"state":"opened"}]'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
')"
PATH="$fake_dir:$PATH" out="$(PATH="$fake_dir:$PATH" gitlab_issue_states 1 2 3)"
rc=$?
check "batch call succeeds" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "batch output resolves iid 1 as opened" "$(echo "$out" | grep -qx $'1\topened' && echo 0 || echo 1)"
check "batch output resolves iid 2 as closed" "$(echo "$out" | grep -qx $'2\tclosed' && echo 0 || echo 1)"
check "batch output resolves iid 3 as opened" "$(echo "$out" | grep -qx $'3\topened' && echo 0 || echo 1)"
check "a single call carries all three iids" "$(grep -c 'iids\[\]=1' "$CALL_LOG" | grep -qx 1 && echo 0 || echo 1)"
# Each logged invocation's args embed a literal newline (the curl -w format
# string starts with one), so a plain `wc -l` over-counts by 2x — count
# request URLs instead via the "per_page=100" marker that appears exactly
# once per call.
check "exactly one HTTP call made for a batch under GITLAB_ISSUES_BATCH_SIZE" "$([ "$(grep -c 'per_page=100' "$CALL_LOG")" -eq 1 ] && echo 0 || echo 1)"

# --- Case 2: GITLAB_ISSUES_BATCH_SIZE chunks across multiple requests ------
CALL_LOG="$TMP/calls-chunk.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl chunk '
printf '"'"'[{"iid":1,"state":"opened"}]'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
')"
out="$(PATH="$fake_dir:$PATH" GITLAB_ISSUES_BATCH_SIZE=2 gitlab_issue_states 1 2 3 4 5)"
rc=$?
check "chunked lookup still succeeds" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "batch size 2 over 5 iids makes 3 requests" "$([ "$(grep -c 'per_page=100' "$CALL_LOG")" -eq 3 ] && echo 0 || echo 1)"

# --- Case 3: JOB-TOKEN is never sent even when CI_JOB_TOKEN is set --------
CALL_LOG="$TMP/calls-jobtoken.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl jobtoken '
for a in "$@"; do
  case "$a" in
    JOB-TOKEN:*) echo "JOB-TOKEN SENT" >&2; exit 99 ;;
  esac
done
printf '"'"'[{"iid":1,"state":"opened"}]'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
')"
rc=0
PATH="$fake_dir:$PATH" CI_JOB_TOKEN="definitely-set" gitlab_issue_states 1 >/dev/null 2>&1 || rc=$?
check "a lookup with CI_JOB_TOKEN set still succeeds (JOB-TOKEN not sent)" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "no call ever carried a JOB-TOKEN header" "$(grep -q 'JOB-TOKEN' "$CALL_LOG" && echo 1 || echo 0)"

# --- Case 4: token resolution order — GITLAB_API_TOKEN before ISSUES_API_TOKEN, both before anonymous ---
CALL_LOG="$TMP/calls-tokenorder.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl tokenorder '
for a in "$@"; do
  case "$a" in
    "PRIVATE-TOKEN: from-gitlab-api-token")
      printf '"'"'[{"iid":1,"state":"opened"}]\nHTTPSTATUS:200'"'"'
      exit 0
      ;;
  esac
done
echo "WRONG TOKEN USED: $*" >&2
exit 1
')"
out="$(PATH="$fake_dir:$PATH" GITLAB_API_TOKEN="from-gitlab-api-token" ISSUES_API_TOKEN="from-issues-api-token" gitlab_issue_states 1)"
rc=$?
check "GITLAB_API_TOKEN is preferred over ISSUES_API_TOKEN" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "the preferred token's header actually reached curl" "$(grep -q 'from-gitlab-api-token' "$CALL_LOG" && echo 0 || echo 1)"

CALL_LOG="$TMP/calls-fallbacktoken.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl fallbacktoken '
for a in "$@"; do
  case "$a" in
    "PRIVATE-TOKEN: from-issues-api-token")
      printf '"'"'[{"iid":1,"state":"opened"}]\nHTTPSTATUS:200'"'"'
      exit 0
      ;;
  esac
done
echo "WRONG TOKEN USED: $*" >&2
exit 1
')"
rc=0
PATH="$fake_dir:$PATH" ISSUES_API_TOKEN="from-issues-api-token" gitlab_issue_states 1 >/dev/null 2>"$TMP/stderr-fallbacktoken.log" || rc=$?
check "ISSUES_API_TOKEN is used when GITLAB_API_TOKEN is unset" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"

# --- Case 5: a 401 on an authenticated request falls back to anonymous ----
CALL_LOG="$TMP/calls-401.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl token401 '
has_auth=0
for a in "$@"; do
  case "$a" in "PRIVATE-TOKEN:"*) has_auth=1 ;; esac
done
if [ "$has_auth" -eq 1 ]; then
  printf '"'"'{"message":"401 Unauthorized"}\nHTTPSTATUS:401'"'"'
else
  printf '"'"'[{"iid":1,"state":"opened"}]\nHTTPSTATUS:200'"'"'
fi
')"
out="$(PATH="$fake_dir:$PATH" GITLAB_API_TOKEN="rejected-token" gitlab_issue_states 1 2>"$TMP/stderr-401.log")"
rc=$?
check "a rejected token's 401 still resolves via the anonymous fallback" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "the fallback resolves the issue correctly" "$(echo "$out" | grep -qx $'1\topened' && echo 0 || echo 1)"
check "exactly two requests were made (authenticated, then anonymous)" "$([ "$(grep -c 'per_page=100' "$CALL_LOG")" -eq 2 ] && echo 0 || echo 1)"
check "a 401 warning was printed" "$(grep -q '401' "$TMP/stderr-401.log" && echo 0 || echo 1)"

# --- Case 6: an iid the tracker never returns is simply absent ------------
CALL_LOG="$TMP/calls-missing.log"
: > "$CALL_LOG"
fake_dir="$(install_fake_curl missing '
printf '"'"'[{"iid":1,"state":"opened"}]'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
')"
out="$(PATH="$fake_dir:$PATH" gitlab_issue_states 1 999)"
rc=$?
check "a batch with one missing iid still succeeds" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "the resolved iid is printed" "$(echo "$out" | grep -qx $'1\topened' && echo 0 || echo 1)"
check "the missing iid is never printed as any state" "$(echo "$out" | grep -q '^999' && echo 1 || echo 0)"

# --- Case 7: a transport failure returns 1 and prints nothing -------------
fake_dir="$(install_fake_curl transportfail '
exit 7
')"
rc=0
out="$(PATH="$fake_dir:$PATH" gitlab_issue_states 1 2>/dev/null)" || rc=$?
check "a transport failure (curl exits non-zero) returns 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
check "a transport failure prints no state lines" "$([ -z "$out" ] && echo 0 || echo 1)"

# --- Case 8: a malformed (non-array) body is treated as inconclusive ------
fake_dir="$(install_fake_curl malformed '
printf '"'"'{"not":"an array"}'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
')"
rc=0
out="$(PATH="$fake_dir:$PATH" gitlab_issue_states 1 2>/dev/null)" || rc=$?
check "a malformed (non-array) 200 body returns 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
check "a malformed body prints no state lines" "$([ -z "$out" ] && echo 0 || echo 1)"

# --- Case 9: no ids requested is a no-op, not an error ---------------------
rc=0
out="$(gitlab_issue_states 2>/dev/null)" || rc=$?
check "calling with no ids returns 0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "calling with no ids prints nothing" "$([ -z "$out" ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "gitlab-issues.test.sh: all $pass checks passed"
  exit 0
else
  echo "gitlab-issues.test.sh: $fail failed, $pass passed"
  exit 1
fi
