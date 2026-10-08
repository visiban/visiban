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
printf 'misconfigurations:\n  - id: C\n    statement: x\n    expired_at: 2030-01-01\n' > "$TMP/nolink.yaml"
expect "no issue link" 1 2026-10-08 "$TMP/nolink.yaml" "no #NNNN"
printf 'misconfigurations:\n  - id: C\n    statement: x #1\n' > "$TMP/noexp.yaml"
expect "missing expired_at" 1 2026-10-08 "$TMP/noexp.yaml" "missing expired_at"
printf 'misconfigurations:\n  - paths: [a]\n    id: C\n    statement: x #1\n    expired_at: 2030-01-01\n' > "$TMP/nonid.yaml"
expect "entry not starting with id (block)" 1 2026-10-08 "$TMP/nonid.yaml" 'must start with "- id:"'
printf 'misconfigurations:\n  - {id: C, statement: "x #1", expired_at: 2030-01-01}\n' > "$TMP/flow.yaml"
expect "flow-style entry" 1 2026-10-08 "$TMP/flow.yaml" 'must start with "- id:"'
printf 'misconfigurations:\n  - id: C\n    statement: >-\n      no link\n      # see #12\n    expired_at: 2030-01-01\n' > "$TMP/cmt.yaml"
expect "comment inside statement is not a link" 1 2026-10-08 "$TMP/cmt.yaml" "no #NNNN"
printf '# top #99\nmisconfigurations:\n  # c #98\n  - id: C\n    paths:\n      - a\n      - b\n    statement: x #1\n    expired_at: 2030-01-01\n' > "$TMP/nested.yaml"
expect "nested paths list and comments are fine" 0 2026-10-08 "$TMP/nested.yaml" "1 entry OK"
expect "missing file" 1 2026-10-08 "$TMP/nope.yaml"
expect "committed file is valid today" 0 "$(date +%Y-%m-%d)" "$REPO_ROOT/.trivyignore.yaml"
sh "$GATE" --self-test >/dev/null || { echo "  FAIL: --self-test"; fail=1; }
[[ $fail -eq 0 ]] && echo "check-trivyignore-expiry tests passed"
exit $fail
