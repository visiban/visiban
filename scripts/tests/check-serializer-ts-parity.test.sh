#!/usr/bin/env bash
# scripts/tests/check-serializer-ts-parity.test.sh
#
# CLI-contract test for scripts/check-serializer-ts-parity.py — the serializer <->
# TypeScript interface parity gate (#1079).
#
# Division of labour with the gate's own `--self-test`: that mode covers the
# detection *logic* (every finding kind, the suppression machinery, the
# self-invalidating staleness rule) against in-process fixtures. This file covers
# the *command-line surface* that CI actually depends on — exit codes, argument
# handling, and the fail-safe behaviour on a missing or unreadable input. A gate
# whose logic is perfect but which exits 0 on a missing schema is still a gate
# that silently stops gating, which is the failure mode #1093 exists to prevent.
#
# Fixture runs pass --no-suppressions: the real SUPPRESSIONS table pins twelve
# mismatches in the *real* schema, so against a synthetic fixture every one of
# them would correctly report as stale and mask what the test is asserting.
#
# Run: bash scripts/tests/check-serializer-ts-parity.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-serializer-ts-parity.py"

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }

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

# run_gate <args...> — captures combined output + exit code into $OUT and $RC.
run_gate() {
  set +e
  OUT="$("$PYTHON" "$GATE" "$@" 2>&1)"
  RC=$?
  set -e
}

# The gate maps five schema components onto five interfaces, and treats a missing
# one as a hard error rather than a silent pass — so every fixture has to define
# all five. These helpers emit a minimal, matching pair.
write_types() { # write_types <path> [extra-card-field-line]
  cat > "$1" <<TS
export interface BoardUser { id: number; }
export interface Board { id: number; }
export interface Card { id: number; ${2:-} }
export interface User { id: number; }
export interface BoardMembership { id: number; }
TS
}

write_schema() { # write_schema <path> <card-properties-json>
  cat > "$1" <<JSON
{"components": {"schemas": {
  "BoardUser":       {"properties": {"id": {"type": "integer"}}},
  "Board":           {"properties": {"id": {"type": "integer"}}},
  "Card":            {"properties": $2},
  "CurrentUser":     {"properties": {"id": {"type": "integer"}}},
  "BoardMembership": {"properties": {"id": {"type": "integer"}}}
}}}
JSON
}

# --- The gate's own self-test must pass -----------------------------------
run_gate --self-test
check "--self-test exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "--self-test reports PASSED" "$(echo "$OUT" | grep -q "self-test: PASSED" && echo 0 || echo 1)"

# --- A matching schema/interface pair is clean ----------------------------
write_types "$TMP/ok.ts"
write_schema "$TMP/ok.json" '{"id": {"type": "integer"}}'
run_gate --schema "$TMP/ok.json" --types "$TMP/ok.ts" --no-suppressions
check "matching pair exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "matching pair reports OK" "$(echo "$OUT" | grep -q "parity: OK" && echo 0 || echo 1)"

# --- A serializer field absent from TypeScript blocks ---------------------
# This is #1079's headline acceptance criterion: add a field to a serializer,
# don't add it to the interface, get a red pipeline.
write_types "$TMP/missing.ts"
write_schema "$TMP/missing.json" '{"id": {"type": "integer"}, "new_field": {"type": "string"}}'
run_gate --schema "$TMP/missing.json" --types "$TMP/missing.ts" --no-suppressions
check "schema field missing from TS exits 1" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "schema field missing from TS names the field" "$(echo "$OUT" | grep -q "new_field" && echo 0 || echo 1)"

# --- A TypeScript field absent from the schema blocks ---------------------
# The reverse direction: a stale interface field the API no longer sends.
write_types "$TMP/extra.ts" "ghost: string;"
write_schema "$TMP/extra.json" '{"id": {"type": "integer"}}'
run_gate --schema "$TMP/extra.json" --types "$TMP/extra.ts" --no-suppressions
check "TS field missing from schema exits 1" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "TS field missing from schema names the field" "$(echo "$OUT" | grep -q "ghost" && echo 0 || echo 1)"

# --- A type-family mismatch blocks ----------------------------------------
# The quiet one: the field exists on both sides, so every type check passes,
# and the client still reads a string where an integer is sent.
write_types "$TMP/family.ts" "count: number;"
write_schema "$TMP/family.json" '{"id": {"type": "integer"}, "count": {"type": "string"}}'
run_gate --schema "$TMP/family.json" --types "$TMP/family.ts" --no-suppressions
check "type-family mismatch exits 1" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "type-family mismatch names the field" "$(echo "$OUT" | grep -q "count" && echo 0 || echo 1)"

# --- A missing schema component is an error, never a pass -----------------
# Guards the rename footgun: if a component is renamed and COMPONENT_MAP is not
# updated, the gate must go red, not quietly stop checking that component.
write_types "$TMP/stale.ts"
cat > "$TMP/stale.json" <<'JSON'
{"components": {"schemas": {"Board": {"properties": {"id": {"type": "integer"}}}}}}
JSON
run_gate --schema "$TMP/stale.json" --types "$TMP/stale.ts" --no-suppressions
check "missing schema component exits 2 (usage/env error)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Fail-safe: missing types file ----------------------------------------
run_gate --schema "$TMP/ok.json" --types "$TMP/does-not-exist.ts"
check "missing types file exits 2" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Fail-safe: missing schema file ---------------------------------------
run_gate --schema "$TMP/does-not-exist.json" --types "$TMP/ok.ts"
check "missing schema file exits 2" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Fail-safe: malformed schema JSON -------------------------------------
echo 'not json {{{' > "$TMP/garbage.json"
run_gate --schema "$TMP/garbage.json" --types "$TMP/ok.ts"
check "malformed schema JSON exits 2" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- Every suppression cites a real issue number --------------------------
# A marker pointing at nothing is worse than no marker: it reads as tracked when
# it is not. Cheap structural guard; it cannot confirm the issue is open.
BAD_ISSUES="$(grep -c "issue=0\|issue=None" "$GATE" || true)"
check "no placeholder issue numbers in SUPPRESSIONS" "$([ "$BAD_ISSUES" -eq 0 ] && echo 0 || echo 1)"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "check-serializer-ts-parity.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-serializer-ts-parity.test.sh: $fail failed, $pass passed"
  exit 1
fi
