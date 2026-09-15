#!/usr/bin/env bash
# scripts/tests/osv-severity-gate.test.sh
#
# Unit test for scripts/osv-severity-gate.sh — the severity gate the
# dep-scan-osv CI job pipes OSV-Scanner's JSON through. The gate's exit code
# is the whole pipeline's OSV verdict, so a regression here silently flips the
# security posture (a HIGH sailing through, or a LOW red-walling the train).
# No other harness covers it, so guard it directly.
#
# Each case writes a synthetic OSV-Scanner JSON blob (only the fields the gate
# reads: results[].source.path, .packages[].package, .vulnerabilities[] and
# .groups[]) and asserts the gate's exit code and, where it matters, its output.
#
# Run: bash scripts/tests/osv-severity-gate.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/osv-severity-gate.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# run_gate <json-file> — runs the gate, captures combined output + exit code
# into the globals $OUT and $RC (never aborts the test under `set -e`).
run_gate() {
  local fixture="$1"
  set +e
  OUT="$(sh "$GATE" "$fixture" 2>&1)"
  RC=$?
  set -e
}

# A one-package, one-group OSV result. $1 max_severity (CVSS string, "" = unscored),
# $2 db_specific label, $3 package name.
one_group() { # one_group <max_severity> <label> <pkg>
  local max_severity="$1" label="$2" pkg="$3"
  cat <<JSON
{"results":[{"source":{"path":"frontend/package-lock.json"},"packages":[
 {"package":{"name":"$pkg","version":"1.0.0","ecosystem":"npm"},
  "vulnerabilities":[{"id":"GHSA-x","database_specific":{"severity":"$label"}}],
  "groups":[{"ids":["GHSA-x"],"max_severity":"$max_severity"}]}
]}]}
JSON
}

# --- LOW (real dompurify shape): CVSS 2.1 → WARN, exit 0 -------------------
one_group "2.1" "LOW" "dompurify" > "$TMP/low.json"
run_gate "$TMP/low.json"
check "LOW advisory warns non-blocking (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"
check "LOW advisory is bucketed WARN" "$(echo "$OUT" | grep -q "WARN" && echo 0 || echo 1)"

# --- MEDIUM: CVSS 5.3 → WARN, exit 2 --------------------------------------
one_group "5.3" "MODERATE" "some-pkg" > "$TMP/med.json"
run_gate "$TMP/med.json"
check "MEDIUM advisory warns non-blocking (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- HIGH: CVSS 7.5 → FAIL, exit 1 ----------------------------------------
one_group "7.5" "HIGH" "bad-pkg" > "$TMP/high.json"
run_gate "$TMP/high.json"
check "HIGH advisory blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "HIGH advisory is bucketed FAIL" "$(echo "$OUT" | grep -q "FAIL" && echo 0 || echo 1)"

# --- CRITICAL: CVSS 9.8 → FAIL, exit 1 ------------------------------------
one_group "9.8" "CRITICAL" "worse-pkg" > "$TMP/crit.json"
run_gate "$TMP/crit.json"
check "CRITICAL advisory blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Boundary: exactly 7.0 → FAIL (HIGH starts at 7.0) --------------------
one_group "7.0" "HIGH" "edge-pkg" > "$TMP/edge.json"
run_gate "$TMP/edge.json"
check "CVSS exactly 7.0 blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Boundary: 6.9 → WARN (still MEDIUM) ----------------------------------
one_group "6.9" "MODERATE" "just-below.json" > "$TMP/below.json"
run_gate "$TMP/below.json"
check "CVSS 6.9 warns non-blocking (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Unscored HIGH: no CVSS but label HIGH → FAIL via fallback -------------
one_group "" "HIGH" "unscored-pkg" > "$TMP/unscored.json"
run_gate "$TMP/unscored.json"
check "unscored advisory with HIGH label blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Unscored LOW: no CVSS, label LOW → WARN ------------------------------
one_group "" "LOW" "unscored-low" > "$TMP/unscored-low.json"
run_gate "$TMP/unscored-low.json"
check "unscored advisory with LOW label warns non-blocking (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Alias fallback: label lives on a vuln matched to the group by alias --
cat > "$TMP/alias.json" <<'JSON'
{"results":[{"source":{"path":"backend/requirements.txt"},"packages":[
 {"package":{"name":"aliased","version":"2.0.0","ecosystem":"PyPI"},
  "vulnerabilities":[{"id":"PYSEC-1","aliases":["CVE-9999"],"database_specific":{"severity":"CRITICAL"}}],
  "groups":[{"ids":["CVE-9999"],"max_severity":""}]}
]}]}
JSON
run_gate "$TMP/alias.json"
check "unscored group matched to CRITICAL vuln by alias blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Mixed: one HIGH + one LOW → FAIL, and both reported -------------------
cat > "$TMP/mixed.json" <<'JSON'
{"results":[{"source":{"path":"frontend/package-lock.json"},"packages":[
 {"package":{"name":"lowpkg","version":"1.0.0","ecosystem":"npm"},
  "vulnerabilities":[{"id":"GHSA-low","database_specific":{"severity":"LOW"}}],
  "groups":[{"ids":["GHSA-low"],"max_severity":"2.1"}]},
 {"package":{"name":"highpkg","version":"1.0.0","ecosystem":"npm"},
  "vulnerabilities":[{"id":"GHSA-high","database_specific":{"severity":"HIGH"}}],
  "groups":[{"ids":["GHSA-high"],"max_severity":"8.1"}]}
]}]}
JSON
run_gate "$TMP/mixed.json"
check "mixed HIGH+LOW blocks (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "mixed run reports the LOW package too" "$(echo "$OUT" | grep -q "lowpkg" && echo 0 || echo 1)"
check "mixed run reports the HIGH package" "$(echo "$OUT" | grep -q "highpkg" && echo 0 || echo 1)"

# --- Clean: empty results → exit 0 (distinct from the exit-2 WARN band) ----
# A clean scan must stay green (0), NOT the yellow warning (2) that MEDIUM/LOW
# now emits — otherwise every green pipeline would show a spurious warning.
echo '{"results":[]}' > "$TMP/clean.json"
run_gate "$TMP/clean.json"
check "clean scan passes green (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"

# --- Fail-safe: missing file → exit 1 -------------------------------------
run_gate "$TMP/does-not-exist.json"
check "missing results file fails safe (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Fail-safe: empty file → exit 1 ---------------------------------------
: > "$TMP/empty.json"
run_gate "$TMP/empty.json"
check "empty results file fails safe (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- Fail-safe: malformed JSON → exit 1 -----------------------------------
echo 'not json {{{' > "$TMP/garbage.json"
run_gate "$TMP/garbage.json"
check "malformed JSON fails safe (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"

# --- No-arg usage → exit 3 (hard block, NOT the exit-2 warning band) -------
# A usage error must never be mistaken for the non-blocking MEDIUM/LOW warning
# the CI job allows to fail — so it exits 3, outside the allow_failure list.
set +e
sh "$GATE" >/dev/null 2>&1
NOARG_RC=$?
set -e
check "no-arg invocation exits 3 (usage, hard block)" "$([ "$NOARG_RC" -eq 3 ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "osv-severity-gate.test.sh: all $pass checks passed"
  exit 0
else
  echo "osv-severity-gate.test.sh: $fail failed, $pass passed"
  exit 1
fi
