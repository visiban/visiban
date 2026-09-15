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
# Usage: sh scripts/osv-severity-gate.sh <osv-results.json>
set -eu

RESULTS="${1:-}"
if [ -z "$RESULTS" ]; then
  echo "osv-severity-gate: usage: sh scripts/osv-severity-gate.sh <osv-results.json>" >&2
  # exit 3 (not 2): a usage error must hard-block. Exit 2 is reserved for the
  # non-blocking MEDIUM/LOW warning the CI job allows to fail.
  exit 3
fi
if [ ! -s "$RESULTS" ]; then
  echo "osv-severity-gate: results file '$RESULTS' is missing or empty — treating as scan failure." >&2
  exit 1
fi

# jq filter: flatten OSV JSON to one record per advisory group. The numeric
# severity is group.max_severity (a CVSS base score string, "" when unscored).
# The fallback label is the max database_specific.severity across the group's
# member vulnerabilities (matched by id OR alias). A group FAILs when the CVSS
# score is >= 7.0, or (unscored) the label is HIGH/CRITICAL.
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

FINDINGS="$(jq -c "$FILTER" "$RESULTS")" || {
  echo "osv-severity-gate: could not parse '$RESULTS' as OSV-Scanner JSON." >&2
  exit 1
}

TOTAL="$(printf '%s' "$FINDINGS" | jq 'length')"
FAILS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "FAIL")] | length')"
WARNS="$(printf '%s' "$FINDINGS" | jq '[.[] | select(.bucket == "WARN")] | length')"

if [ "$TOTAL" -eq 0 ]; then
  echo "osv-severity-gate: no advisories — clean."
  exit 0
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
  exit 1
fi

echo "osv-severity-gate: WARN — only MEDIUM/LOW advisories present (non-blocking)." >&2
# exit 2: the CI job maps this to allow_failure, so the pipeline shows a yellow
# warning rather than a green pass — the debt is visible but does not block.
exit 2
