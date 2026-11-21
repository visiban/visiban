#!/usr/bin/env bash
# scripts/tests/check-suppression-issues.test.sh
#
# Unit test for scripts/check-suppression-issues.sh — the SUPPRESSED-UNTIL(#N)
# marker gate (#1092). The gate's whole job is to fail when a suppression
# cites an issue that has since closed; a regression here would let it go
# quietly green forever, exactly the failure mode the gate exists to prevent
# (see #1090, where 0% coverage on git_lens went unnoticed for months).
#
# This test drives the script's own CHECK_SUPPRESSION_MOCK_CLOSED test hook
# (the same one --self-test uses) against small fixture trees, so it needs no
# network access and depends on no real GitLab issue existing or closing.
#
# #1694 added a second kind of case below (see "REAL FETCH PATH"): the mock
# hook never exercised check-suppression-issues.sh's actual GitLab API call,
# which is exactly how the JOB-TOKEN-401 defect went unnoticed — those cases
# drive gitlab_issue_states through a fake `curl` placed first on PATH
# instead, with no mock hook involved, proving the real request shape:
# unique-iid batching, a closed issue still blocking, an open issue still
# passing, and JOB-TOKEN never sent even when CI_JOB_TOKEN is set.
#
# Run: bash scripts/tests/check-suppression-issues.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-suppression-issues.sh"
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

# --- Fixture trees ----------------------------------------------------------
mkdir -p "$TMP/closed-hit" "$TMP/open-hit" "$TMP/plain-reason" "$TMP/mixed" "$TMP/backend-style"

cat > "$TMP/closed-hit/Component.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#4242): fixture only
EOF

cat > "$TMP/open-hit/Component.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#5150): fixture only
EOF

cat > "$TMP/plain-reason/Component.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- deps intentionally narrowed, permanent
EOF

cat > "$TMP/mixed/a.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#4242): fixture only
EOF
cat > "$TMP/mixed/b.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#5150): fixture only
EOF

cat > "$TMP/backend-style/test_thing.py" <<'EOF'
    @pytest.mark.skip(reason="SUPPRESSED-UNTIL(#4242): fixture only, arm64 runners unavailable")
    def test_arm64_only_path(self):
        pass
EOF

# The gate always scans SCAN_PATHS ("frontend/src backend"), not an arbitrary
# directory, so to test it against small fixture trees instead of the whole
# real repo we source its function definitions (run_scan, resolve_issue_state)
# and call run_scan directly. The gate is bash; the only wrinkle is its
# trailing `main "$@"` line, which would run on source too and scan the real
# repo as a side effect — so we source a scratch copy with that last line
# stripped instead of the gate file itself.
#
# The sourced file also defines and immediately runs its own top-level
# `REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO_ROOT"`
# (outside any function) AND, since #1694, a `source
# "${REPO_ROOT}/scripts/lib/gitlab-issues.sh"` that depends on that
# REPO_ROOT being right — unlike `$0`, `${BASH_SOURCE[0]}` DOES follow a
# sourced file, so sourcing a bare copy dropped directly into $TMP computes
# a REPO_ROOT that is wrong *and consequential*: the inner `source` fails
# immediately, before we would ever get a chance to restore anything. Fixed
# by mirroring the real scripts/ layout under $TMP (copy the library to the
# same relative path) so that inner source resolves correctly either way,
# then overwriting our own $REPO_ROOT/cwd back to the real repo root
# afterward regardless.
OWN_REPO_ROOT="$REPO_ROOT"
mkdir -p "$TMP/scripts/lib"
cp "$LIB" "$TMP/scripts/lib/gitlab-issues.sh"
GATE_LIB="$TMP/scripts/gate_lib.sh"
sed '$ d' "$GATE" > "$GATE_LIB"   # drop the trailing `main "$@"` line
# shellcheck source=/dev/null
source "$GATE_LIB"
REPO_ROOT="$OWN_REPO_ROOT"
cd "$REPO_ROOT"

# run_case <mock-closed-csv> <dir> — runs run_scan against a fixture
# directory with a mocked closed-issue list, capturing combined output +
# exit code into $CASE_OUT / $CASE_RC.
run_case() {
  local mock_closed="$1" dir="$2"
  set +e
  CASE_OUT="$(CHECK_SUPPRESSION_MOCK_CLOSED="$mock_closed" run_scan "$dir" 2>&1)"
  CASE_RC=$?
  set -e
}

# --- A marker citing a closed issue blocks, naming file/line/issue ---------
run_case "4242" "$TMP/closed-hit"
check "closed-issue marker blocks (exit 1)" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "failure names the file" "$(echo "$CASE_OUT" | grep -q "Component.tsx" && echo 0 || echo 1)"
check "failure names the issue number" "$(echo "$CASE_OUT" | grep -q "#4242" && echo 0 || echo 1)"
check "failure says CLOSED" "$(echo "$CASE_OUT" | grep -q "CLOSED" && echo 0 || echo 1)"

# --- A marker citing an open issue passes -----------------------------------
run_case "4242" "$TMP/open-hit"
check "open-issue marker passes (exit 0)" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

# --- A plain '-- reason' suppression with no marker is left alone ----------
run_case "4242" "$TMP/plain-reason"
check "plain-reason suppression (no marker) is never flagged, even with matching mock-closed list" \
  "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

# --- Mixed tree: one closed hit among files blocks and reports both --------
run_case "4242" "$TMP/mixed"
check "mixed tree blocks when any marker cites a closed issue" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "mixed tree reports the closed citation (a.tsx)" "$(echo "$CASE_OUT" | grep -q "a.tsx" && echo 0 || echo 1)"

# --- Backend pytest-style marker (not just eslint-disable) is also caught --
run_case "4242" "$TMP/backend-style"
check "pytest.mark.skip reason= marker is detected the same way as eslint-disable" \
  "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"

# --- Clean tree (no markers at all) passes ----------------------------------
mkdir -p "$TMP/clean"
cat > "$TMP/clean/nothing.tsx" <<'EOF'
export const x = 1;
EOF
run_case "4242" "$TMP/clean"
check "a tree with no SUPPRESSED-UNTIL marker at all passes" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

# --- A missing scan path blocks instead of silently reporting clean --------
# Regression coverage: `grep -r` on a nonexistent path errors on stderr
# (discarded) and `|| true` would otherwise swallow that, so a future rename
# of frontend/src or backend must not turn this gate into a silent no-op.
run_case "4242" "$TMP/this-path-does-not-exist"
check "a missing scan path blocks (exit 1), not a false-green clean scan" \
  "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "a missing scan path names itself in the failure" \
  "$(echo "$CASE_OUT" | grep -q "does not exist" && echo 0 || echo 1)"

# --- The gate's own --self-test mode passes as a subprocess (no network) ---
set +e
SELFTEST_OUT="$(bash "$GATE" --self-test 2>&1)"
SELFTEST_RC=$?
set -e
check "the gate's own --self-test exits 0" "$([ "$SELFTEST_RC" -eq 0 ] && echo 0 || echo 1)"
check "the gate's own --self-test reports OK" "$(echo "$SELFTEST_OUT" | grep -q "self-test: OK" && echo 0 || echo 1)"

# === REAL FETCH PATH (#1694) ================================================
#
# Everything above drives CHECK_SUPPRESSION_MOCK_CLOSED, which never touches
# gitlab_issue_states or curl at all — exactly the blind spot that let the
# JOB-TOKEN/401 defect ship unnoticed. These cases instead put a fake `curl`
# first on PATH and run the gate's *actual* fetch path end to end, with
# CHECK_SUPPRESSION_MOCK_CLOSED deliberately unset.
install_fake_curl() {
  local dir="$1" body="$2"
  mkdir -p "$dir"
  {
    echo '#!/usr/bin/env bash'
    # shellcheck disable=SC2016
    echo 'echo "$*" >> "$CALL_LOG"'
    echo "$body"
  } > "$dir/curl"
  chmod +x "$dir/curl"
}

FAKE_CURL_DIR="$TMP/fake-curl-real-path"
# shellcheck disable=SC2016
install_fake_curl "$FAKE_CURL_DIR" '
for a in "$@"; do
  case "$a" in
    JOB-TOKEN:*) echo "JOB-TOKEN SENT: $a" >&2; exit 99 ;;
  esac
done
printf '"'"'[{"iid":6060,"state":"opened"},{"iid":6161,"state":"closed"}]'"'"'
printf '"'"'\nHTTPSTATUS:200'"'"'
'

mkdir -p "$TMP/real-fetch/open" "$TMP/real-fetch/closed"
cat > "$TMP/real-fetch/open/a.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#6060): fixture only, real-fetch-path case
EOF
cat > "$TMP/real-fetch/closed/b.tsx" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#6161): fixture only, real-fetch-path case
EOF

REAL_CALL_LOG="$TMP/real-fetch-calls.log"
: > "$REAL_CALL_LOG"
set +e
REAL_OUT="$(
  unset CHECK_SUPPRESSION_MOCK_CLOSED
  export CALL_LOG="$REAL_CALL_LOG"
  export CI_JOB_TOKEN="definitely-set-but-must-never-be-sent"
  export CI_PROJECT_ID="visiban%2Fvisiban"
  unset GITLAB_API_TOKEN ISSUES_API_TOKEN
  PATH="$FAKE_CURL_DIR:$PATH" run_scan "$TMP/real-fetch" 2>&1
)"
REAL_RC=$?
set -e

check "real fetch path: closed issue blocks through the real curl call (exit 1)" \
  "$([ "$REAL_RC" -eq 1 ] && echo 0 || echo 1)"
check "real fetch path: failure names the closed file" \
  "$(echo "$REAL_OUT" | grep -q "b.tsx" && echo 0 || echo 1)"
check "real fetch path: failure names the closed issue and says CLOSED" \
  "$(echo "$REAL_OUT" | grep -q "#6161" && echo "$REAL_OUT" | grep -q "CLOSED" && echo 0 || echo 1)"
check "real fetch path: the open issue's file is never reported as a finding" \
  "$(echo "$REAL_OUT" | grep -q "a.tsx" && echo 1 || echo 0)"
check "real fetch path: both cited iids reached curl in one batched call" \
  "$(grep -q 'iids\[\]=6060' "$REAL_CALL_LOG" && grep -q 'iids\[\]=6161' "$REAL_CALL_LOG" && echo 0 || echo 1)"
check "real fetch path: exactly one HTTP call made (batched, not per-marker)" \
  "$([ "$(grep -c 'per_page=100' "$REAL_CALL_LOG")" -eq 1 ] && echo 0 || echo 1)"
check "real fetch path: JOB-TOKEN was never sent even though CI_JOB_TOKEN was set" \
  "$(grep -q 'JOB-TOKEN' "$REAL_CALL_LOG" && echo 1 || echo 0)"

# === PENDING BUDGETS (#1812) ================================================
# run_pending_scan reads backend/nightly-load-test-baseline.json-shaped files
# and applies the same closed/missing/fail-open policy as run_scan.
mkdir -p "$TMP/pb"
write_baseline() { printf '%s' "$2" > "$TMP/pb/$1.json"; }
write_baseline pending '{"endpoints":{"card_search_multi_board":{"budget_p95_ms":null,"pending_budget":"#7001"},"card_timeline":{"budget_p95_ms":60}}}'
write_baseline none '{"endpoints":{"card_timeline":{"budget_p95_ms":60}}}'
write_baseline gated '{"endpoints":{"card_timeline":{"budget_p95_ms":60,"pending_budget":"#7001"}}}'
write_baseline badref '{"endpoints":{"x":{"budget_p95_ms":null,"pending_budget":"7001"}}}'
write_baseline memonly '{"endpoints":{"flow_dwell":{"budget_p95_ms":50,"budget_peak_rss_mb":null,"pending_memory_budget":"#7002"},"card_timeline":{"budget_p95_ms":60}}}'
write_baseline memgated '{"endpoints":{"flow_dwell":{"budget_p95_ms":50,"budget_peak_rss_mb":400,"pending_memory_budget":"#7002"}}}'
write_baseline membadref '{"endpoints":{"flow_dwell":{"budget_peak_rss_mb":null,"pending_memory_budget":"7002"}}}'
printf '%s' '{not json' > "$TMP/pb/broken.json"

run_pb() { # run_pb <mock-closed-csv> <fixture-name>
  set +e
  CASE_OUT="$(CHECK_SUPPRESSION_MOCK_CLOSED="$1" run_pending_scan "$TMP/pb/$2.json" 2>&1)"
  CASE_RC=$?
  set -e
}

run_pb "7001" pending
check "pending_budget citing a closed issue blocks" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "pending_budget failure names the entry" "$(echo "$CASE_OUT" | grep -q "card_search_multi_board" && echo 0 || echo 1)"
check "pending_budget failure names the issue and says CLOSED" \
  "$(echo "$CASE_OUT" | grep -q "#7001" && echo "$CASE_OUT" | grep -q "CLOSED" && echo 0 || echo 1)"
check "pending_budget failure does not name the gated entry" "$(echo "$CASE_OUT" | grep -q "card_timeline" && echo 1 || echo 0)"

run_pb "9" pending
check "pending_budget citing an open issue passes" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

# pending_memory_budget (#2430): scanned like pending_budget, even when p95 is gated.
run_pb "7002" memonly
check "pending_memory_budget citing a closed issue blocks" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "pending_memory_budget failure names the entry and issue" \
  "$(echo "$CASE_OUT" | grep -q "flow_dwell" && echo "$CASE_OUT" | grep -q "#7002" && echo 0 || echo 1)"
check "pending_memory_budget failure does not name the unrelated entry" "$(echo "$CASE_OUT" | grep -q "card_timeline" && echo 1 || echo 0)"
run_pb "9" memonly
check "pending_memory_budget citing an open issue passes" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"
run_pb "7002" memgated
check "pending_memory_budget on an entry with a non-null budget is ignored" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"
run_pb "7002" membadref
check "pending_memory_budget without a #NNNN shape is ignored" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

run_pb "7001" none
check "baseline with no pending_budget passes" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

run_pb "7001" gated
check "pending_budget on an entry with a non-null budget is not pending (ignored)" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

run_pb "7001" badref
check "pending_budget without a #NNNN shape is not pending (ignored, as nightly_load_test.py)" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"

run_pb "7001" broken
check "unparseable baseline blocks rather than reporting clean" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
run_pb "7001" nonexistent
check "missing baseline blocks rather than reporting clean" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"

# Real fetch path: closed blocks, an issue the tracker did not return blocks,
# an inconclusive lookup (HTTP 500) fails open.
pb_curl() { # pb_curl <dir> <body-json> <status>
  install_fake_curl "$1" "
printf '%s' '$2'
printf '\\nHTTPSTATUS:$3'
"
}
pb_real() { # pb_real <fake-curl-dir>
  set +e
  CASE_OUT="$(
    unset CHECK_SUPPRESSION_MOCK_CLOSED GITLAB_API_TOKEN ISSUES_API_TOKEN
    export CALL_LOG="$TMP/pb-calls.log"
    PATH="$1:$PATH" run_pending_scan "$TMP/pb/pending.json" 2>&1
  )"
  CASE_RC=$?
  set -e
}
: > "$TMP/pb-calls.log"
pb_curl "$TMP/pb-curl-closed" '[{"iid":7001,"state":"closed"}]' 200
pb_real "$TMP/pb-curl-closed"
check "real fetch: closed pending_budget issue blocks" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
check "real fetch: looked up iid 7001" "$(grep -q 'iids\[\]=7001' "$TMP/pb-calls.log" && echo 0 || echo 1)"
pb_curl "$TMP/pb-curl-open" '[{"iid":7001,"state":"opened"}]' 200
pb_real "$TMP/pb-curl-open"
check "real fetch: open pending_budget issue passes" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"
pb_curl "$TMP/pb-curl-missing" '[]' 200
pb_real "$TMP/pb-curl-missing"
check "real fetch: pending_budget issue the tracker did not return blocks" "$([ "$CASE_RC" -eq 1 ] && echo 0 || echo 1)"
pb_curl "$TMP/pb-curl-500" '' 500
pb_real "$TMP/pb-curl-500"
check "real fetch: inconclusive lookup fails open (exit 0)" "$([ "$CASE_RC" -eq 0 ] && echo 0 || echo 1)"
check "real fetch: inconclusive lookup warns" "$(echo "$CASE_OUT" | grep -q "WARNING" && echo 0 || echo 1)"

# The real baseline in this repo parses. It carries no pending entry once every
# budget is derived (#1808), so assert the scan runs clean rather than that a
# particular entry is pending.
check "repo baseline: parses and is scanned without error" \
  "$(pending_budget_entries "$REPO_ROOT/backend/nightly-load-test-baseline.json" >/dev/null 2>&1 && echo 0 || echo 1)"

# === main() END TO END (#1812) ==============================================
# Everything above sources the gate minus its `main` line, so nothing proved
# main() composes the two scans' exit codes (a `|| true` on the pending scan
# once left every check green). Run the real script against the real repo with
# the mock hook (no network). The real baseline has no pending entry, so
# CHECK_SUPPRESSION_BASELINE points main() at the "pending" fixture, which cites #7001.
set +e
E2E_OUT="$(CHECK_SUPPRESSION_BASELINE="$TMP/pb/pending.json" CHECK_SUPPRESSION_MOCK_CLOSED=7001 bash "$GATE" 2>&1)"
E2E_RC=$?
set -e
check "end to end: a closed pending_budget issue makes the script exit 1" "$([ "$E2E_RC" -eq 1 ] && echo 0 || echo 1)"
check "end to end: failure names card_search_multi_board and says CLOSED" \
  "$(echo "$E2E_OUT" | grep -q "card_search_multi_board" && echo "$E2E_OUT" | grep -q "CLOSED" && echo 0 || echo 1)"
set +e
E2E_OUT="$(CHECK_SUPPRESSION_BASELINE="$TMP/pb/pending.json" CHECK_SUPPRESSION_MOCK_CLOSED=1 bash "$GATE" 2>&1)"
E2E_RC=$?
set -e
check "end to end: the same run with #7001 not closed exits 0" "$([ "$E2E_RC" -eq 0 ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "check-suppression-issues.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-suppression-issues.test.sh: $fail failed, $pass passed"
  exit 1
fi
