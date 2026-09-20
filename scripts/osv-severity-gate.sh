#!/usr/bin/env sh
# scripts/osv-severity-gate.sh — severity gate for the dep-scan-osv CI job.
#
# OSV-Scanner has no native severity threshold (confirmed on v2.3.5: no
# --severity / --fail-on / --audit-level flag), so it exits non-zero on *any*
# non-ignored advisory. That meant a single fixable LOW could red-wall the
# whole pipeline just as easily as a HIGH — no way to distinguish "block" from
# "worth knowing about" without this gate.
#
# This gate reads OSV-Scanner's `--format json` output and classifies each
# advisory group:
#   - FAIL (exit 1)  → HIGH / CRITICAL: CVSS base score >= 7.0, or — when no
#                      CVSS score is published — the GitHub advisory label
#                      (database_specific.severity) is HIGH or CRITICAL.
#   - WARN (exit 2)  → MEDIUM / LOW / unscored: printed, non-blocking. The CI
#                      job maps exit 2 to `allow_failure`, so the pipeline
#                      shows a yellow warning (surfacing dependency debt)
#                      instead of a silent green pass.
#
# Exit-code contract (the whole pipeline's OSV verdict):
#   0 → clean, no advisories survived suppression (green).
#   1 → HIGH/CRITICAL present, OR fail-safe (missing/empty/unparseable
#       results): the scan verdict is bad or the scan itself did not
#       complete — block.
#   2 → only MEDIUM/LOW/unscored advisories — non-blocking warning
#       (allow_failure).
#   3 → usage error (bad invocation). A hard block, kept distinct from 2 so a
#       misconfigured gate can never be mistaken for a benign warning.
#
# Accepted risks are suppressed via an osv-scanner.toml next to the relevant
# lockfile (auto-discovered by osv-scanner — do not pass --config, which would
# force a single global file), with a documented, expiring `IgnoredVulns`
# entry — same escape-hatch shape as migration-check's
# `# concurrency-exempt:` comment. OSV-Scanner drops a suppressed advisory
# before writing the JSON, so it never reaches this gate. This gate only
# decides *severity banding* for advisories that survive suppression.
#
# Fail-safe: a missing or unparseable results file means the scan itself did
# not complete — that must block, not silently pass.
#
# --self-test (#1093): builds synthetic OSV-Scanner JSON fixtures in a temp
# directory and asserts the classification logic still fires correctly —
# HIGH blocks, LOW/MEDIUM warns non-blocking, a missing file fails safe. Run
# by the dep-scan-osv job on the same image immediately before the real
# invocation, so a change that broke detection (e.g. a jq filter typo, or
# BusyBox jq behaving differently than expected) is caught before it can ever
# go quietly green. Unit-tested more exhaustively (11 cases) in
# scripts/tests/osv-severity-gate.test.sh — this in-script mode is the
# smaller, CI-wired proof, not a replacement for that suite.
#
# Usage: sh scripts/osv-severity-gate.sh <osv-results.json>
#        sh scripts/osv-severity-gate.sh --self-test
set -eu

# jq filter: flatten OSV JSON to one record per advisory group. The numeric
# severity is group.max_severity (a CVSS base score string, "" when unscored).
# The fallback label is the max database_specific.severity across the group's
# member vulnerabilities (matched by id OR alias). A group FAILs when the CVSS
# score is >= 7.0, or (unscored) the label is HIGH/CRITICAL.
# Defined before run_gate/self_test below so it is set before either can be
# called, including on the --self-test path which returns before the normal
# argument-parsing section that used to define it.
# shellcheck disable=SC2016  # $-vars below are jq variables, not shell — single-quote intentionally.
FILTER='
[ .results[]
  | .source.path as $src
  | .packages[]
  | .package as $pkg
  | (.vulnerabilities // []) as $vulns
  | (.groups // [])[]
  | . as $g
  | ((.max_severity // "") | if . == "" then null else tonumber end) as $cvss
  | ([ $vulns[]
       | select(([.id] + (.aliases // [])) as $names
                | ($g.ids // []) | any(. as $id | $names | index($id)))
       | (.database_specific.severity // "" | ascii_upcase) ]) as $labels
  | (($cvss != null and $cvss >= 7.0)
     or ($labels | any(. == "HIGH" or . == "CRITICAL"))) as $fail
  | { src: $src, pkg: $pkg.name, version: $pkg.version,
      ids: ($g.ids | join(",")),
      cvss: ($cvss // "n/a"),
      label: ($labels | map(select(. != "")) | (first // "UNSCORED")),
      bucket: (if $fail then "FAIL" else "WARN" end) }
]'

# run_gate <results-file>
#
# Core classification logic, extracted into a function so --self-test can
# call it in-process against synthetic fixtures without a second process.
# Prints the report to stdout/stderr; returns 0 (clean), 1 (block: HIGH/
# CRITICAL, or fail-safe), or 2 (non-blocking warn: MEDIUM/LOW/unscored) per
# the exit-code contract above.
run_gate() {
  RESULTS="$1"

  if [ ! -s "$RESULTS" ]; then
    echo "osv-severity-gate: results file '$RESULTS' is missing or empty — treating as scan failure." >&2
    return 1
  fi

  FINDINGS="$(jq -c "$FILTER" "$RESULTS")" || {
    echo "osv-severity-gate: could not parse '$RESULTS' as OSV-Scanner JSON." >&2
    return 1
  }

  TOTAL="$(printf '%s' "$FINDINGS" | jq 'length')"
  FAILS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "FAIL")] | length')"
  WARNS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "WARN")] | length')"

  if [ "$TOTAL" -eq 0 ]; then
    echo "osv-severity-gate: no advisories — clean."
    return 0
  fi

  echo "osv-severity-gate: $TOTAL advisory group(s) — $FAILS blocking (HIGH/CRITICAL), $WARNS warning (MEDIUM/LOW)."
  echo ""
  printf '%-6s  %-9s  %-24s  %-6s  %-9s  %s\n' "BUCKET" "SEVERITY" "PACKAGE@VERSION" "CVSS" "SOURCE" "ADVISORY"
  printf '%s' "$FINDINGS" | jq -r '
    sort_by(.bucket == "WARN", .cvss)
    | .[]
    | [ .bucket, .label, (.pkg + "@" + .version),
        (.cvss | tostring), (.src | sub(".*/"; "")), .ids ]
    | @tsv' \
    | while IFS="$(printf '\t')" read -r bucket label pv cvss src ids; do
        printf '%-6s  %-9s  %-24s  %-6s  %-9s  %s\n' "$bucket" "$label" "$pv" "$cvss" "$src" "$ids"
      done
  echo ""

  if [ "$FAILS" -gt 0 ]; then
    echo "osv-severity-gate: FAIL — $FAILS HIGH/CRITICAL advisory group(s) block the pipeline." >&2
    echo "Fix the dependency, or (only for an accepted risk) add a documented, expiring" >&2
    echo "IgnoredVulns entry to an osv-scanner.toml next to the affected lockfile." >&2
    return 1
  fi

  echo "osv-severity-gate: WARN — only MEDIUM/LOW advisories present (non-blocking)." >&2
  return 2
}

# self_test — synthetic OSV JSON fixtures covering the classification
# boundaries a silent regression would most plausibly erase: HIGH blocks,
# clean passes, a missing file fails safe (rather than silently passing —
# the exact failure class #1093 exists to catch), and LOW-only warns without
# blocking.
self_test() {
  ST_TMP=$(mktemp -d)
  trap 'rm -rf "$ST_TMP"' EXIT

  command -v jq >/dev/null 2>&1 || {
    echo "osv-severity-gate --self-test: jq not installed — cannot self-test (same dependency the real gate needs)." >&2
    exit 1
  }

  echo "=== osv-severity-gate.sh --self-test ==="

  cat > "$ST_TMP/high.json" <<'JSON'
{"results":[{"source":{"path":"backend/requirements.txt"},"packages":[
 {"package":{"name":"bad-pkg","version":"1.0.0","ecosystem":"PyPI"},
  "vulnerabilities":[{"id":"GHSA-x","database_specific":{"severity":"HIGH"}}],
  "groups":[{"ids":["GHSA-x"],"max_severity":"7.5"}]}
]}]}
JSON
  ST_RC=0
  run_gate "$ST_TMP/high.json" >/dev/null 2>&1 || ST_RC=$?
  if [ "$ST_RC" -ne 1 ]; then
    echo "SELF-TEST FAILED: HIGH advisory did not block (got exit $ST_RC, expected 1)." >&2
    exit 1
  fi
  echo "Case 1 OK: HIGH/CRITICAL advisory blocks (exit 1)."

  echo '{"results":[]}' > "$ST_TMP/clean.json"
  ST_RC=0
  run_gate "$ST_TMP/clean.json" >/dev/null 2>&1 || ST_RC=$?
  if [ "$ST_RC" -ne 0 ]; then
    echo "SELF-TEST FAILED: clean scan did not pass (got exit $ST_RC, expected 0)." >&2
    exit 1
  fi
  echo "Case 2 OK: clean scan passes (exit 0)."

  ST_RC=0
  run_gate "$ST_TMP/does-not-exist.json" >/dev/null 2>&1 || ST_RC=$?
  if [ "$ST_RC" -ne 1 ]; then
    echo "SELF-TEST FAILED: missing results file did not fail safe (got exit $ST_RC, expected 1)." >&2
    exit 1
  fi
  echo "Case 3 OK: missing results file fails safe (exit 1), not a silent pass."

  cat > "$ST_TMP/low.json" <<'JSON'
{"results":[{"source":{"path":"frontend/package-lock.json"},"packages":[
 {"package":{"name":"low-pkg","version":"1.0.0","ecosystem":"npm"},
  "vulnerabilities":[{"id":"GHSA-y","database_specific":{"severity":"LOW"}}],
  "groups":[{"ids":["GHSA-y"],"max_severity":"2.1"}]}
]}]}
JSON
  ST_RC=0
  run_gate "$ST_TMP/low.json" >/dev/null 2>&1 || ST_RC=$?
  if [ "$ST_RC" -ne 2 ]; then
    echo "SELF-TEST FAILED: LOW-only advisory did not warn non-blocking (got exit $ST_RC, expected 2)." >&2
    exit 1
  fi
  echo "Case 4 OK: MEDIUM/LOW-only advisory warns non-blocking (exit 2)."

  echo "=== osv-severity-gate.sh --self-test: PASSED ==="
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

RESULTS="${1:-}"
if [ -z "$RESULTS" ]; then
  echo "osv-severity-gate: usage: sh scripts/osv-severity-gate.sh <osv-results.json>" >&2
  echo "                          sh scripts/osv-severity-gate.sh --self-test" >&2
  # exit 3 (not 2): a usage error must hard-block. Exit 2 is reserved for the
  # non-blocking MEDIUM/LOW warning the CI job allows to fail.
  exit 3
fi

run_gate "$RESULTS"
exit $?
