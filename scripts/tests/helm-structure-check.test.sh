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
# A pool worker (--run-case) reuses the parent's directory; only the parent owns it.
if [ "${1:-}" = "--run-case" ]; then TMP="${HELM_TEST_TMP:?}"
else TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; export HELM_TEST_TMP="$TMP"; fi
fail=0
# The cases are independent (each runs --self-test-case in its own result
# directory, #2522), so they run through a bounded xargs -P pool, the same
# mechanism --self-test uses (#2420). Two cases are a full check (the control
# and the standalone-sabotage control, ~100 s each); the rest are one render
# plus one section. Serially that summed to ~156 s; concurrently it is the
# slowest single case. The two full-check cases are defined first so they start
# first. Workers report through files and always exit 0 (a non-zero xargs child
# would stop the pool early); a case with no status file is a FAILURE.
# Output is printed in definition order, whatever order the cases finished in.
CASE_DESC=(); CASE_WANT=(); CASE_SPEC=(); CASE_NEEDLE=(); CASE_SABOTAGE=()
# case_ <desc> <want: pass|fail> <fixture spec> [log substring] [sabotage section]
case_() {
  CASE_DESC+=("$1"); CASE_WANT+=("$2"); CASE_SPEC+=("$3"); CASE_NEEDLE+=("${4:-}"); CASE_SABOTAGE+=("${5:-}")
}
HOOK='templates/tests/api-connection.yaml|s/helm.sh\/hook: test/helm.sh\/hook: pre-install/'
case_ "control runs the whole check on the undamaged chart" pass "" "control: the undamaged chart passes"
# A section that fails only when run alone (hidden dependency on another
# section's global, an exit) must fail the control, not hide behind run_all_checks.
case_ "control FAILS when a section fails alone on the undamaged chart" fail "" "image_pins fail ALONE" image_pins
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

# run_case <i>: run case i in <TMP>/r<i>; write r<i>/verdict ("ok" or a FAIL line).
run_case() {
  local i="$1" dir="$TMP/r$1" id want got log needle
  mkdir -p "$dir"
  want="${CASE_WANT[$i]}"; needle="${CASE_NEEDLE[$i]}"
  id="c$i"; [ -n "${CASE_SPEC[$i]}" ] || id=control   # the worker's control case is keyed by its id
  SELF_TEST_STANDALONE_SABOTAGE="${CASE_SABOTAGE[$i]}" SELF_TEST_CHART_DIR=helm/visiban \
    bash "$GATE" --self-test-case "$dir" "$id" "${CASE_SPEC[$i]}" || true
  got="$(cat "$dir/$id.status" 2>/dev/null || echo missing)"
  log="$(cat "$dir/$id.log" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    echo "  FAIL: ${CASE_DESC[$i]} (status=$got, want $want): $log" > "$dir/verdict"
  elif [ -n "$needle" ] && [[ "$log" != *"$needle"* ]]; then
    echo "  FAIL: ${CASE_DESC[$i]}: log lacks '$needle': $log" > "$dir/verdict"
  else
    echo ok > "$dir/verdict"
  fi
}
if [ "${1:-}" = "--run-case" ]; then run_case "$2"; exit 0; fi

# Worker count: TEST_JOBS, else the CPU count (nproc on Linux/busybox, sysctl
# on macOS/BSD), else 4. 1 is serial.
jobs="${TEST_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
case "$jobs" in ''|*[!0-9]*|0) jobs=4 ;; esac
n="${#CASE_DESC[@]}"
for ((i = 0; i < n; i++)); do echo "$i"; done \
  | xargs -P "$jobs" -n 1 bash "${BASH_SOURCE[0]}" --run-case \
  || { echo "  FAIL: the worker pool itself failed"; fail=1; }
for ((i = 0; i < n; i++)); do
  v="$(cat "$TMP/r$i/verdict" 2>/dev/null || echo "  FAIL: ${CASE_DESC[$i]}: worker died without a verdict")"
  [ "$v" = ok ] || { echo "$v"; fail=1; }
done
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
