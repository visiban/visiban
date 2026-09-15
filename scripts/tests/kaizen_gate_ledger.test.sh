#!/usr/bin/env bash
# scripts/tests/kaizen_gate_ledger.test.sh
#
# Unit test for scripts/kaizen_gate_ledger.py — the mechanical parser behind
# the `/kaizen` skill (.claude/skills/kaizen/SKILL.md, issue #1094). The
# skill's whole premise is "the `## Gates` ledger already exists, nothing
# reads it" — so a regression here would silently make the yield numbers
# wrong while the skill keeps producing confident-looking output. No other
# harness covers it.
#
# Fixture: scripts/tests/fixtures/kaizen/mrs_fixture.json — five synthetic MR
# descriptions covering:
#   iid 1: a well-formed ledger (findings > 0, 0 findings, n/a, skipped, a
#          deliverable-style changelog line)
#   iid 2: no `## Gates` section at all (adoption denominator, not numerator)
#   iid 3: a loose fenced-code-block ledger, mostly n/a lines, extra spaces
#          around the dash (the real-world format `/kaizen` must tolerate)
#   iid 4: skipped lines (distinct from n/a and from 0 findings)
#   iid 5: a malformed line (`gate: rbac-check —` with no outcome) plus a
#          line that merely mentions a gate-shaped word with no parseable
#          dash-outcome, which must be silently ignored rather than miscounted
#
# scripts/tests/fixtures/kaizen/separator_regression_fixture.json covers three
# separator edge cases regression-check found in review of #1094: a
# numbered-list bullet, an em dash with no surrounding whitespace, and —
# the real bug — an outcome that starts with hyphens right after an unspaced
# em dash, which the original greedy `[—–-]+` separator class silently
# truncated.
#
# Run: bash scripts/tests/kaizen_gate_ledger.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/kaizen_gate_ledger.py"
FIXTURE="$REPO_ROOT/scripts/tests/fixtures/kaizen/mrs_fixture.json"
SEP_FIXTURE="$REPO_ROOT/scripts/tests/fixtures/kaizen/separator_regression_fixture.json"

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 "$SCRIPT" --input "$FIXTURE" --json > "$TMP/out.json"
python3 "$SCRIPT" --input "$SEP_FIXTURE" --json > "$TMP/sep_out.json"

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

# get <key> [<key> ...] — walks the parsed JSON by successive dict keys and
# prints the value. Keys are passed as separate argv entries (never spliced
# into a python/shell string), so gate outcome text containing backticks,
# quotes, or dashes can never be mis-parsed as shell syntax.
get() {
  python3 - "$TMP/out.json" "$@" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    d = d[key]
print(d)
PYEOF
}

# --- Adoption: 4/5 MRs carry a `## Gates` heading (iid 2 does not) ---------
check "window is 5" "$([ "$(get window)" == "5" ] && echo 0 || echo 1)"
check "adoption is 4/5, not 5/5 (missing-Gates MR excluded)" \
  "$([ "$(get adopted)" == "4" ] && echo 0 || echo 1)"

# --- regression-check: 2 findings (iid1) + 3 findings (iid3) + 0 (iid4) ----
check "regression-check runs = 3 (two positive + one zero, across 3 MRs)" \
  "$([ "$(get gates regression-check runs)" == "3" ] && echo 0 || echo 1)"
check "regression-check zero = 1" \
  "$([ "$(get gates regression-check zero)" == "1" ] && echo 0 || echo 1)"
check "regression-check positive = 2" \
  "$([ "$(get gates regression-check positive)" == "2" ] && echo 0 || echo 1)"
check "regression-check yield = 66.7% (2 of 3 runs found something)" \
  "$([ "$(get gates regression-check yield_pct)" == "66.7" ] && echo 0 || echo 1)"
check "regression-check verdict is inconclusive below the 10-run threshold" \
  "$(get gates regression-check verdict | grep -q 'inconclusive' && echo 0 || echo 1)"

# --- n/a must never count toward the run denominator -----------------------
check "migration-check has 0 runs (its only line is n/a)" \
  "$([ "$(get gates migration-check runs)" == "0" ] && echo 0 || echo 1)"
check "migration-check na = 1" \
  "$([ "$(get gates migration-check na)" == "1" ] && echo 0 || echo 1)"
check "perf-check (n/a via the fenced-block MR) has 0 runs" \
  "$([ "$(get gates perf-check runs)" == "0" ] && echo 0 || echo 1)"

# --- skipped must be tracked separately from n/a and from 0 findings -------
check "voc skipped = 2, runs = 0, na = 0 (skipped is not n/a)" \
  "$([ "$(get gates voc skipped)" == "2" ] && [ "$(get gates voc runs)" == "0" ] && [ "$(get gates voc na)" == "0" ] && echo 0 || echo 1)"
check "architect skipped = 1, not folded into runs" \
  "$([ "$(get gates architect skipped)" == "1" ] && [ "$(get gates architect runs)" == "0" ] && echo 0 || echo 1)"

# --- security-review: 0 findings (iid1) + n/a (iid3) + 4 findings (iid5) ---
check "security-review runs = 2 (the n/a line excluded)" \
  "$([ "$(get gates security-review runs)" == "2" ] && echo 0 || echo 1)"
check "security-review na = 1" \
  "$([ "$(get gates security-review na)" == "1" ] && echo 0 || echo 1)"

# --- Malformed line: `gate: rbac-check —` with no outcome text ------------
check "rbac-check malformed count = 1" \
  "$([ "$(get gates rbac-check malformed)" == "1" ] && echo 0 || echo 1)"
check "the malformed rbac-check line still recorded its n/a and its finding" \
  "$([ "$(get gates rbac-check na)" == "1" ] && [ "$(get gates rbac-check positive)" == "1" ] && echo 0 || echo 1)"
check "top-level malformed_count is 1" \
  "$([ "$(get malformed_count)" == "1" ] && echo 0 || echo 1)"

# --- A gate-shaped word with no dash-outcome is silently ignored, not counted
check "'totally-unparseable-blob' produces no gate entry at all" \
  "$(python3 - "$TMP/out.json" <<'PYEOF' && echo 0 || echo 1
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if "totally-unparseable-blob" not in d["gates"] else 1)
PYEOF
)"

# --- changelog is a deliverable gate: a non-numeric outcome is expected,
#     not a data-quality problem, and must not force a fast-path/load-bearing
#     verdict off a single incidental line -----------------------------------
check "changelog has 0 numeric runs and 1 unscored (deliverable) line" \
  "$([ "$(get gates changelog runs)" == "0" ] && [ "$(get gates changelog unscored)" == "1" ] && echo 0 || echo 1)"
check "changelog verdict names it a deliverable gate, not a yield verdict" \
  "$(get gates changelog verdict | grep -q 'deliverable gate' && echo 0 || echo 1)"

# --- Text-mode output runs without crashing and mentions adoption ----------
TEXT_OUT="$(python3 "$SCRIPT" --input "$FIXTURE")"
check "text output reports adoption 4/5" \
  "$(printf '%s' "$TEXT_OUT" | grep -q '4/5' && echo 0 || echo 1)"

# get_sep <key> [<key> ...] — same as get(), against the separator-edge-case
# fixture's output file.
get_sep() {
  python3 - "$TMP/sep_out.json" "$@" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    d = d[key]
print(d)
PYEOF
}

# --- Separator regressions found by regression-check on #1094 --------------
# The original `[—–-]+` separator class was greedy and unbounded: an outcome
# starting with hyphens right after an unspaced em dash had its leading
# hyphens silently eaten as part of the separator, truncating the recorded
# text with no signal anything was lost. These three cases must now all
# parse correctly rather than silently vanishing or corrupting the outcome.

# 1. Numbered-list bullet ("1. gate: ...") must be recognized as a bullet.
check "numbered-list bullet ('1. gate: perf-check — ...') is recognized" \
  "$([ "$(get_sep gates perf-check zero)" == "1" ] && echo 0 || echo 1)"

# 2. An em dash with no surrounding whitespace must still split correctly.
check "unspaced em dash ('gate: migration-check—n/a') still separates name from outcome" \
  "$([ "$(get_sep gates migration-check na)" == "1" ] && echo 0 || echo 1)"

# 3. The real bug: an outcome starting with hyphens right after the em dash
#    must NOT have those leading hyphens silently swallowed by the separator.
check "outcome starting with '--' is not truncated by the separator" \
  "$(python3 - "$TMP/sep_out.json" <<'PYEOF' && echo 0 || echo 1
import json, sys
d = json.load(open(sys.argv[1]))
samples = d["gates"]["dependency"]["unscored_samples"]
text = samples[0][1] if samples else ""
sys.exit(0 if text.startswith("--bump-numpy") else 1)
PYEOF
)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "kaizen_gate_ledger.test.sh: all $pass checks passed"
  exit 0
else
  echo "kaizen_gate_ledger.test.sh: $fail failed, $pass passed"
  exit 1
fi
