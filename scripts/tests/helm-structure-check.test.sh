#!/usr/bin/env bash
# scripts/tests/helm-structure-check.test.sh — tests the targeted self-test of
# scripts/helm-structure-check.sh (#2493): each fixture names the check
# section(s) that must reject its damage, and only those run against it.
# Needs helm + yq (mikefarah v4); CI runs it in helm-template.
# Run: bash scripts/tests/helm-structure-check.test.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/helm-structure-check.sh"
cd "$REPO_ROOT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
n=0
# case <desc> <want: pass|fail> <fixture spec> [log substring]
case_() {
  local desc="$1" want="$2" spec="$3" needle="${4:-}" id got log
  n=$((n + 1)); id="c$n"
  [ -n "$spec" ] || id=control   # the worker's control case is keyed by its id
  SELF_TEST_CHART_DIR=helm/visiban bash "$GATE" --self-test-case "$TMP" "$id" "$spec" || true
  got="$(cat "$TMP/$id.status" 2>/dev/null || echo missing)"
  log="$(cat "$TMP/$id.log" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    echo "  FAIL: $desc (status=$got, want $want): $log"; fail=1; return
  fi
  if [ -n "$needle" ] && [[ "$log" != *"$needle"* ]]; then
    echo "  FAIL: $desc: log lacks '$needle': $log"; fail=1
  fi
}
HOOK='templates/tests/api-connection.yaml|s/helm.sh\/hook: test/helm.sh\/hook: pre-install/'
case_ "targeted section catches its defect" pass "migrate_placement|hook|$HOOK" "is detected (migrate_placement)"
case_ "unknown section FAILS, never skips" fail "no_such_section|hook|$HOOK" "unknown check section 'no_such_section'"
case_ "a typo of a real section FAILS" fail "migrate_placment|hook|$HOOK" "unknown check section"
case_ "empty section list FAILS" fail "|hook|$HOOK" "names no check section"
case_ "blank section list FAILS" fail "   |hook|$HOOK" "names no check section"
case_ "spec without a sections field FAILS" fail "hook" "names no check section"
case_ "a section that does not catch the defect FAILS" fail "image_pins|hook|$HOOK" "section(s) image_pins still passed"
case_ "every named section must catch it, not just one" fail "migrate_placement image_pins|hook|$HOOK" "image_pins still passed"
case_ "a fixture that changes nothing still FAILS" fail "migrate_placement|noop|templates/tests/api-connection.yaml|s/NO_SUCH_TEXT_2493/x/" "changed nothing"
case_ "a fixture that breaks rendering still FAILS" fail "migrate_placement|norender|templates/_helpers.tpl|s/{{- define/{{- definex/" "does not render"
case_ "control runs the whole check on the undamaged chart" pass "" "control: the undamaged chart passes"
# A section that fails only when run alone (hidden dependency on another
# section's global, an exit) must fail the control, not hide behind run_all_checks.
SELF_TEST_STANDALONE_SABOTAGE=image_pins case_ "control FAILS when a section fails alone on the undamaged chart" fail "" "image_pins fail ALONE"
# Every section run_all_checks runs is targetable, and the table names only
# known sections (the runtime check would fail the case anyway; this names the
# offender without a full --self-test run).
# The script's function definitions without its trailing dispatch/main block.
sed '/^if \[ "\${1:-}" = "--lint-tmp" \]/,$d' "$GATE" > "$TMP/lib.sh"
known="$(bash -c 'set -- helm/visiban; . "$0"; selftest_known_sections | tr "\n" " "; echo; selftest_define_fixtures; for f in "${SELF_TEST_FIXTURES[@]}"; do echo "${f%%|*}"; done' "$TMP/lib.sh")"
sections_line="$(head -1 <<< "$known")"
[ "$(wc -w <<< "$sections_line")" -ge 20 ] || { echo "  FAIL: selftest_known_sections returned too few sections: $sections_line"; fail=1; }
while IFS= read -r tags; do
  [ -n "${tags//[[:space:]]/}" ] || { echo "  FAIL: a table fixture names no section"; fail=1; continue; }
  for t in $tags; do
    [[ " $sections_line " == *" $t "* ]] || { echo "  FAIL: table fixture names unknown section '$t'"; fail=1; }
  done
done < <(tail -n +2 <<< "$known")
[ "$fail" -eq 0 ] && echo "helm-structure-check.test: all $n cases + table check pass"
exit "$fail"
