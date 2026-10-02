#!/usr/bin/env bash
# scripts/tests/check-broadcast-deferral.test.sh
#
# Unit test for scripts/check-broadcast-deferral.py — the gate that asserts every
# board/group-scoped write broadcasts, after commit, from a closure holding plain
# data (#1143).
#
# The script's own --self-test already proves each *detector* fires against
# known-bad fixtures, and CI runs it immediately before the real invocation.
# This file covers what --self-test cannot: the command-line surface, the four
# exit codes CI branches on, and — specifically — that exit 3 ("unhandled
# pattern, hand it to the broadcast-check agent") is neither silently a pass nor
# indistinguishable from a real finding.
#
# Run: bash scripts/tests/check-broadcast-deferral.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-broadcast-deferral.py"

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "SKIP: no python interpreter on PATH"; exit 0; }
[ -f "$GATE" ] || { echo "FAIL: $GATE not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() {
  local desc="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

run_gate() {
  set +e
  OUT="$("$PY" "$GATE" "$@" 2>&1)"
  RC=$?
  set -e
}

copy_tree() {
  mkdir -p "$1"
  ( cd "$REPO_ROOT" && tar cf - \
      backend/boards backend/groups backend/git_lens \
  ) | ( cd "$1" && tar xf - )
}

# --- --self-test passes on its own fixtures -------------------------------
run_gate --self-test
check "--self-test exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "--self-test reports every case passing" \
  "$(echo "$OUT" | grep -q "all .* cases passed" && echo 0 || echo 1)"

# --- the real repository is clean ------------------------------------------
run_gate --root "$REPO_ROOT"
check "this checkout broadcasts every write after commit (exit 0)" \
  "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "clean run says so" \
  "$(echo "$OUT" | grep -q "after commit, with a plain-data closure" && echo 0 || echo 1)"
check "clean run prints a tally" \
  "$(echo "$OUT" | grep -q "emit site(s)" && echo 0 || echo 1)"

# --- fail closed: --root with no backend tree -----------------------------
# Exit 2, NOT 0. "I could not look" must never read as "I looked and it was
# fine."
mkdir -p "$TMP/empty"
run_gate --root "$TMP/empty"
check "missing backend tree fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"
check "missing backend tree says why" \
  "$(echo "$OUT" | grep -q "cannot run" && echo 0 || echo 1)"

# --- findings exit 1 ------------------------------------------------------
# Delete the broadcast from LabelViewSet.perform_destroy. The write stays, so
# this isolates detector 1: a mutation no other client will ever hear about.
copy_tree "$TMP/drift"
"$PY" - "$TMP/drift/backend/boards/views/labels.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = p.read_text().splitlines(keepends=True)
hits = [i for i, l in enumerate(lines) if "EVT_LABEL_DELETED" in l]
assert hits, "fixture drift: labels.py no longer emits label.deleted"
for i in reversed(hits):
    lines[i] = "            pass\n"
p.write_text("".join(lines))
PY
run_gate --root "$TMP/drift"
check "a write with no broadcast is a finding (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "the finding names the handler" \
  "$(echo "$OUT" | grep -q "LabelViewSet::destroy" && echo 0 || echo 1)"
check "the finding says the UI goes stale" \
  "$(echo "$OUT" | grep -q "reaches no broadcast" && echo 0 || echo 1)"

# --- an undeferred raw broadcast is a finding, not a defer ----------------
copy_tree "$TMP/undeferred"
"$PY" - "$TMP/undeferred/backend/boards/views/boards.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
needle = "            transaction.on_commit(_broadcast_created)"
assert needle in text, "fixture drift: boards.py on_commit(_broadcast_created) gone"
p.write_text(text.replace(needle, "            _broadcast_created()", 1))
PY
run_gate --root "$TMP/undeferred"
check "a broadcast outside on_commit is a finding (exit 1)" \
  "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "the finding names on_commit" \
  "$(echo "$OUT" | grep -q "transaction.on_commit()" && echo 0 || echo 1)"

# --- defers exit 3, distinct from both 0 and 1 ---------------------------
# on_commit handed a callable the checker cannot resolve must go to the
# broadcast-check agent, not through. Added ALONGSIDE the existing registration
# rather than replacing it, so nothing else in the tree becomes a finding —
# findings outrank defers in the exit code, and this case has to isolate 3.
copy_tree "$TMP/defer"
"$PY" - "$TMP/defer/backend/boards/views/boards.py" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
needle = "            transaction.on_commit(_broadcast_created)"
assert needle in text, "fixture drift: boards.py on_commit(_broadcast_created) gone"
p.write_text(text.replace(
    needle,
    needle + "\n            transaction.on_commit(HOOKS[0])",
    1,
))
PY
run_gate --root "$TMP/defer"
check "an unclassifiable registration defers (exit 3), not passes" \
  "$([ "$RC" -eq 3 ] && echo 0 || echo 1)"
check "the defer names the agent to run" \
  "$(echo "$OUT" | grep -q "broadcast-check" && echo 0 || echo 1)"
check "the defer says it is not a pass" \
  "$(echo "$OUT" | grep -q "not a pass" && echo 0 || echo 1)"

# --- unknown flag is a usage error, not a pass ----------------------------
run_gate --no-such-flag
check "unknown flag does not exit 0" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"

# --- fail closed: a module symlinked outside --root (#1377) -----------------
# The path helper must refuse to read through a symlink that leaves the tree
# under audit; that is "cannot run" (exit 2), never a clean or finding result.
copy_tree "$TMP/escape"
echo "x = 1" > "$TMP/outside.py"
rm "$TMP/escape/backend/boards/views/labels.py"
ln -s "$TMP/outside.py" "$TMP/escape/backend/boards/views/labels.py"
run_gate --root "$TMP/escape"
check "symlink escaping --root fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"
check "symlink escape says cannot run" \
  "$(echo "$OUT" | grep -q "cannot run" && echo 0 || echo 1)"

echo ""
if [ "$fail" -eq 0 ]; then
  echo "check-broadcast-deferral.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-broadcast-deferral.test.sh: $fail failed, $pass passed"
  exit 1
fi
