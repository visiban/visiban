#!/usr/bin/env bash
# scripts/tests/check-trivyignore-expiry.test.sh — unit test for
# scripts/check-trivyignore-expiry.sh (#1072). Run: bash scripts/tests/check-trivyignore-expiry.test.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-trivyignore-expiry.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
expect() { # expect <desc> <want-rc> <today> <file> [output-substring]
  local rc=0 out
  out="$(TODAY="$3" sh "$GATE" "$4" 2>&1)" || rc=$?
  if [[ "$rc" -ne "$2" ]] || { [[ -n "${5:-}" ]] && [[ "$out" != *"$5"* ]]; }; then
    echo "  FAIL: $1 (rc=$rc, want $2): $out"; fail=1
  fi
}
two='misconfigurations:
  - id: A-1
    statement: >-
      folded text
      tracked in #5.
    expired_at: 2027-01-15
  - id: B-2
    statement: ok #6
    expired_at: 2026-12-01
'
printf '%s' "$two" > "$TMP/two.yaml"
expect "all in date" 0 2026-10-08 "$TMP/two.yaml" "2 entries OK"
expect "second entry expired" 1 2026-12-02 "$TMP/two.yaml" "B-2: EXPIRED"
expect "expiry day itself is still valid" 0 2026-12-01 "$TMP/two.yaml"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: soon\n' > "$TMP/bad.yaml"
expect "malformed date" 1 2026-10-08 "$TMP/bad.yaml" "not YYYY-MM-DD"
printf 'misconfigurations:\n  - id: C\n    statement: x\n    expired_at: 2027-01-01\n' > "$TMP/nolink.yaml"
expect "no issue link" 1 2026-10-08 "$TMP/nolink.yaml" "no #NNNN"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n' > "$TMP/noexp.yaml"
expect "missing expired_at" 1 2026-10-08 "$TMP/noexp.yaml" "missing expired_at"
printf 'misconfigurations:\n  - paths: [a]\n    id: C\n    statement: x #1\n    expired_at: 2027-01-01\n' > "$TMP/nonid.yaml"
expect "entry not starting with id (block)" 1 2026-10-08 "$TMP/nonid.yaml" 'must start with "- id:"'
printf 'misconfigurations:\n  - {id: C, statement: "x #1", expired_at: 2027-01-01}\n' > "$TMP/flow.yaml"
expect "flow-style entry" 1 2026-10-08 "$TMP/flow.yaml" 'must start with "- id:"'
printf 'misconfigurations:\n  - id: C\n    statement: >-\n      no link\n      # see #12\n    expired_at: 2027-01-01\n' > "$TMP/cmt.yaml"
expect "comment inside statement is not a link" 1 2026-10-08 "$TMP/cmt.yaml" "no #NNNN"
printf '# top #99\nmisconfigurations:\n  # c #98\n  - id: C\n    paths:\n      - a\n      - b\n    statement: x #1\n    expired_at: 2027-01-01\n' > "$TMP/nested.yaml"
expect "nested paths list and comments are fine" 0 2026-10-08 "$TMP/nested.yaml" "1 entry OK"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2027-10-09\n' > "$TMP/cap-ok.yaml"
expect "exactly 366 days out is allowed" 0 2026-10-08 "$TMP/cap-ok.yaml"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2027-10-10\n' > "$TMP/cap-bad.yaml"
expect "367 days out fails" 1 2026-10-08 "$TMP/cap-bad.yaml" "more than 366 days"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2028-03-01\n' > "$TMP/leap-ok.yaml"
expect "cap counts a leap day: 2027-03-01 + 366 days is allowed" 0 2027-03-01 "$TMP/leap-ok.yaml"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2028-03-02\n' > "$TMP/leap-bad.yaml"
expect "cap counts a leap day: one day later fails" 1 2027-03-01 "$TMP/leap-bad.yaml" "more than 366 days"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2027-01-01\nvulnerabilities:\n- paths: [x]\n  id: CVE-1\n' > "$TMP/sec2.yaml"
expect "second section, different indent, is checked" 1 2026-10-08 "$TMP/sec2.yaml" "must start with"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2027-01-01\nvulnerabilities:\n- id: CVE-1\n  paths: [x]\n' > "$TMP/sec2b.yaml"
expect "second section entry missing date and link" 1 2026-10-08 "$TMP/sec2b.yaml" "CVE-1: missing expired_at"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n    expired_at: 2027-01-01\nvulnerabilities:\n- id: CVE-1\n  statement: y #2\n  expired_at: 2027-02-01\n' > "$TMP/sec2ok.yaml"
expect "two valid sections" 0 2026-10-08 "$TMP/sec2ok.yaml" "2 entries OK"
expect "missing file" 1 2026-10-08 "$TMP/nope.yaml"
expect "committed file is valid today" 0 "$(date +%Y-%m-%d)" "$REPO_ROOT/.trivyignore.yaml"
sh "$GATE" --self-test >/dev/null || { echo "  FAIL: --self-test"; fail=1; }
[[ $fail -eq 0 ]] && echo "check-trivyignore-expiry tests passed"
exit $fail
