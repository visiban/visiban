#!/usr/bin/env bash
# scripts/tests/check-gate-selftest-parity.test.sh
#
# Unit test for scripts/check-gate-selftest-parity.sh — the meta-gate behind
# #1093's house rule ("every bespoke gate script ships a --self-test mode").
# This script's whole premise is "derive the gate list from .gitlab-ci.yml
# itself, never hardcode it" — so a regression here would let the parity
# check quietly stop noticing new gates, which is exactly the failure class
# #1093 exists to close. No other harness covers it.
#
# The script also ships its own `--self-test` (two cases: a known-bad CI
# file and a known-good one). This file is the broader, CI-wired regression
# suite in the same style as scripts/tests/osv-severity-gate.test.sh and
# scripts/tests/kaizen_gate_ledger.test.sh — it exercises the CLI (--ci-file
# / --scripts-root overrides) rather than calling internal functions, and
# adds edge cases the script's own --self-test does not cover (comment-line
# exclusion, dedup of a script referenced by multiple jobs, a missing
# on-disk script, and an empty CI file).
#
# Run: bash scripts/tests/check-gate-selftest-parity.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-gate-selftest-parity.sh"

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

# run_gate <ci-file> <scripts-root> — runs the gate, captures combined
# output + exit code into the globals $OUT and $RC (never aborts the test
# under `set -e`).
run_gate() {
  local ci_file="$1" scripts_root="$2"
  set +e
  OUT="$(bash "$GATE" --ci-file "$ci_file" --scripts-root "$scripts_root" 2>&1)"
  RC=$?
  set -e
}

mkdir -p "$TMP/scripts"

# A script that ships --self-test and is invoked with the flag: compliant.
cat > "$TMP/scripts/good.sh" <<'EOS'
#!/usr/bin/env bash
case "${1:-}" in
  --self-test) echo "ok"; exit 0 ;;
esac
echo "real run"
EOS

# A script with no --self-test at all: the known-bad case.
cat > "$TMP/scripts/bad.sh" <<'EOS'
#!/usr/bin/env bash
echo "real run, no self-test"
EOS

# Ships --self-test, but no job ever passes the flag: the real
# migration-numbering-check gap this issue was filed over, reproduced.
cat > "$TMP/scripts/unwired.sh" <<'EOS'
#!/usr/bin/env bash
case "${1:-}" in
  --self-test) echo "ok"; exit 0 ;;
esac
echo "real run"
EOS

# No --self-test, but documents the escape hatch: must not be flagged.
cat > "$TMP/scripts/exempt.sh" <<'EOS'
#!/usr/bin/env bash
# gate-selftest-exempt: no feasible synthetic input, see docs.
echo "real run"
EOS

# --- Case 1: a clean CI file (only compliant + exempt scripts) passes -------
cat > "$TMP/ci-clean.yml" <<'EOS'
good-job:
  script:
    - bash scripts/good.sh --self-test
    - bash scripts/good.sh

exempt-job:
  script:
    - bash scripts/exempt.sh
EOS
run_gate "$TMP/ci-clean.yml" "$TMP"
check "clean CI file (compliant + exempt only) passes (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "clean run reports 0 violations" "$(echo "$OUT" | grep -q '0 violation' && echo 0 || echo 1)"

# --- Case 2: bad.sh (no --self-test support) is flagged ---------------------
cat > "$TMP/ci-bad.yml" <<'EOS'
bad-job:
  script:
    - bash scripts/bad.sh
EOS
run_gate "$TMP/ci-bad.yml" "$TMP"
check "script with no --self-test support blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "violation names bad.sh" "$(echo "$OUT" | grep -q 'VIOLATION: scripts/bad.sh' && echo 0 || echo 1)"

# --- Case 3: unwired.sh (has --self-test, CI never passes the flag) is
# flagged — this is the exact bug class #1093 found in migration-numbering-check
cat > "$TMP/ci-unwired.yml" <<'EOS'
unwired-job:
  script:
    - bash scripts/unwired.sh
EOS
run_gate "$TMP/ci-unwired.yml" "$TMP"
check "script with --self-test but no CI invocation of it blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "violation names unwired.sh and explains the gap" \
  "$(echo "$OUT" | grep -q 'VIOLATION: scripts/unwired.sh' && echo "$OUT" | grep -q 'no job in' && echo 0 || echo 1)"

# --- Case 4: exempt.sh is never flagged, with or without other violations --
cat > "$TMP/ci-exempt-only.yml" <<'EOS'
exempt-job:
  script:
    - bash scripts/exempt.sh
EOS
run_gate "$TMP/ci-exempt-only.yml" "$TMP"
check "exempt-only CI file passes (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "exempt.sh is reported as EXEMPT, not VIOLATION" \
  "$(echo "$OUT" | grep -q 'EXEMPT: scripts/exempt.sh' && ! echo "$OUT" | grep -q 'VIOLATION: scripts/exempt.sh' && echo 0 || echo 1)"

# --- Case 5: a commented-out reference must not count as a gate at all -----
# (matches the real .gitlab-ci.yml shape: "Also wired as a local pre-commit
# hook (scripts/gitleaks-precommit.sh...)" is prose, not an invocation.)
cat > "$TMP/ci-commented.yml" <<'EOS'
# See scripts/bad.sh for details — not actually invoked here.
noop-job:
  script:
    - echo "nothing to do"
EOS
run_gate "$TMP/ci-commented.yml" "$TMP"
check "a comment-only reference to bad.sh is not flagged (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "comment-only run finds no gate scripts at all" "$(echo "$OUT" | grep -q 'no scripts/\* gate scripts referenced' && echo 0 || echo 1)"

# --- Case 6: a script referenced by path but missing on disk is skipped,
# not flagged as a violation (a different failure mode: the job itself will
# fail the first time it actually runs) ---
cat > "$TMP/ci-missing.yml" <<'EOS'
ghost-job:
  script:
    - bash scripts/does-not-exist.sh
EOS
run_gate "$TMP/ci-missing.yml" "$TMP"
check "a script referenced but absent on disk does not block (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

# --- Case 7: dedup — the same compliant script referenced by two separate
# jobs is counted once, not flagged twice ---
cat > "$TMP/ci-dedup.yml" <<'EOS'
job-one:
  script:
    - bash scripts/good.sh --self-test
    - bash scripts/good.sh

job-two:
  script:
    - bash scripts/good.sh
EOS
run_gate "$TMP/ci-dedup.yml" "$TMP"
check "script referenced by two jobs passes once self-test is wired anywhere (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "dedup run reports exactly 1 gate script checked" "$(echo "$OUT" | grep -q '^check-gate-selftest-parity: 1 gate script' && echo 0 || echo 1)"

# --- Case 8: missing CI file fails safe, not silently -----------------------
run_gate "$TMP/does-not-exist.yml" "$TMP"
check "a missing CI file fails safe (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- The script's own --self-test mode must also pass -----------------------
set +e
SELFTEST_OUT="$(bash "$GATE" --self-test 2>&1)"
SELFTEST_RC=$?
set -e
check "the gate's own --self-test mode passes" "$([ "$SELFTEST_RC" -eq 0 ] && echo 0 || echo 1)"
check "the gate's own --self-test output reports PASSED" "$(echo "$SELFTEST_OUT" | grep -q 'PASSED' && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "check-gate-selftest-parity.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-gate-selftest-parity.test.sh: $fail failed, $pass passed"
  exit 1
fi
