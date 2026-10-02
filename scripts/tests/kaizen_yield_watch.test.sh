#!/usr/bin/env bash
# scripts/tests/kaizen_yield_watch.test.sh
#
# Unit test for scripts/kaizen_yield_watch.py (#1144) - the incremental,
# continuous half of /kaizen. No network: uses --input fixtures. Verifies the
# threshold, the n/a / skipped / 0-findings distinction, the incremental
# watermark, dry-run default, and fail-open behavior.
#
# Run: bash scripts/tests/kaizen_yield_watch.test.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WATCH="$REPO_ROOT/scripts/kaizen_yield_watch.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unset KAIZEN_API_TOKEN GITLAB_API_TOKEN

fail=0; pass=0
check() { if [[ "$2" -eq 0 ]]; then pass=$((pass+1)); else echo "  FAIL: $1"; fail=$((fail+1)); fi; }

# gen <count> <start> <gate line> [branch] -> JSON list of MRs
gen() {
  python3 - "$@" <<'PY'
import json, sys
count, start, line = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
branch = sys.argv[4] if len(sys.argv) > 4 else "feat/t"
print(json.dumps([{"iid": start + i, "merged_at": f"2026-05-{(start+i)%28+1:02d}T{i:02d}:00:00Z",
  "source_branch": branch, "description": f"## Gates\n- gate: {line}\n"} for i in range(count)]))
PY
}

gen 10 1 "perf-check — 0 findings" > "$TMP/ten_zero.json"
gen 9 1 "perf-check — 0 findings" > "$TMP/nine_zero.json"
gen 12 1 "perf-check — n/a (no viewset)" > "$TMP/na.json"
gen 12 1 "perf-check — skipped (user)" > "$TMP/skipped.json"

run() { python3 "$WATCH" --state "$TMP/none.json" --declined "$TMP/none.json" --input "$1" "${@:2}" 2>&1; }

out="$(run "$TMP/ten_zero.json")"
check "10 consecutive zeros yields a candidate" "$(echo "$out" | grep -q 'CANDIDATE perf-check|feat' && echo 0 || echo 1)"
check "default is a dry run (nothing filed)" "$(echo "$out" | grep -q '(dry run) would file' && echo 0 || echo 1)"

out="$(run "$TMP/nine_zero.json")"
check "9 zeros is below threshold" "$(echo "$out" | grep -q 'No new narrowing candidates' && echo 0 || echo 1)"

out="$(run "$TMP/na.json")"
check "n/a never counts as a run" "$(echo "$out" | grep -q 'No new narrowing candidates' && echo 0 || echo 1)"
out="$(run "$TMP/skipped.json")"
check "skipped never counts as a run" "$(echo "$out" | grep -q 'No new narrowing candidates' && echo 0 || echo 1)"

# --file-issues without a token must warn, exit 0, and file nothing (fail open).
set +e; out="$(run "$TMP/ten_zero.json" --file-issues)"; rc=$?; set -e
check "--file-issues without a token fails open (exit 0)" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "--file-issues without a token warns" "$(echo "$out" | grep -q 'KAIZEN_API_TOKEN is empty' && echo 0 || echo 1)"

# Incremental: 9 zeros persisted, then one more MR crosses the threshold.
python3 "$WATCH" --state "$TMP/none.json" --declined "$TMP/none.json" --input "$TMP/nine_zero.json" --write-state "$TMP/state.json" >/dev/null 2>&1
python3 - <<PY > "$TMP/one_more.json"
import json
print(json.dumps([{"iid": 500, "merged_at": "2026-09-01T00:00:00Z", "source_branch": "feat/z",
  "description": "## Gates\n- gate: perf-check — 0 findings\n"}]))
PY
out="$(python3 "$WATCH" --state "$TMP/state.json" --declined "$TMP/none.json" --input "$TMP/one_more.json" 2>&1)"
check "incremental fold crosses threshold using persisted state" "$(echo "$out" | grep -q 'CANDIDATE perf-check|feat' && echo 0 || echo 1)"
out="$(python3 "$WATCH" --state "$TMP/state.json" --declined "$TMP/none.json" --input "$TMP/nine_zero.json" 2>&1)"
check "already-folded MRs are not double counted" "$(echo "$out" | grep -q 'folded 0 newly' && echo 0 || echo 1)"

# Declined findings are not re-raised.
echo '[{"id":"perf-check:fast-path-candidate","declined_on":"2026-01-01","note":"x"}]' > "$TMP/declined.json"
out="$(python3 "$WATCH" --state "$TMP/none.json" --declined "$TMP/declined.json" --input "$TMP/ten_zero.json" 2>&1)"
check "declined gate is suppressed" "$(echo "$out" | grep -q 'No new narrowing candidates' && echo 0 || echo 1)"

# The shipped state file must be valid JSON with the expected shape.
check "committed state file is valid" "$(python3 -c "import json;s=json.load(open('$REPO_ROOT/.claude/kaizen-yield-state.json'));assert s['version']==1 and 'pairs' in s" && echo 0 || echo 1)"

check "--self-test passes" "$(python3 "$WATCH" --self-test >/dev/null 2>&1 && echo 0 || echo 1)"

# a --declined path outside the allowed roots must fail loudly (not fall back to "nothing declined")
rc=0; python3 "$WATCH" --state "$TMP/none.json" --declined /etc/passwd --input "$TMP/ten_zero.json" >/dev/null 2>&1 || rc=$?
check "declined path escape exits 2" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then echo "kaizen_yield_watch.test.sh: all $pass checks passed"; else echo "kaizen_yield_watch.test.sh: $fail failed, $pass passed"; exit 1; fi
