#!/usr/bin/env bash
# scripts/tests/check-ws-event-reachability.test.sh
#
# Unit test for scripts/check-ws-event-reachability.py — the gate that asserts
# every WebSocket event name is emitted, documented, and handled (#1078).
#
# The script's own --self-test already proves each *detector* fires against
# known-bad fixtures, and CI runs it immediately before the real invocation.
# This file covers the layer --self-test cannot: the command-line surface and
# the exit codes CI branches on. A gate that reports "no findings" because it
# could not find a file it needed is worse than no gate, so the fail-closed
# paths (exit 2) are asserted explicitly and kept distinct from the
# findings-exist path (exit 1).
#
# Run: bash scripts/tests/check-ws-event-reachability.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-ws-event-reachability.py"

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "SKIP: no python interpreter on PATH"; exit 0; }
[ -f "$GATE" ] || { echo "FAIL: $GATE not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# run_gate <args...> — captures combined output + exit code into $OUT / $RC
# without aborting the test under `set -e`.
run_gate() {
  set +e
  OUT="$("$PY" "$GATE" "$@" 2>&1)"
  RC=$?
  set -e
}

# --- --self-test passes on its own fixtures -------------------------------
# If this ever goes red the detectors have stopped detecting, and every green
# tick the real invocation produced since is meaningless.
run_gate --self-test
check "--self-test exits 0" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "--self-test reports every case passing" \
  "$(echo "$OUT" | grep -q "all .* cases passed" && echo 0 || echo 1)"

# --- the real repository reconciles ---------------------------------------
run_gate --root "$REPO_ROOT"
check "this checkout reconciles (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "clean run says so" \
  "$(echo "$OUT" | grep -q "all reconcile" && echo 0 || echo 1)"
check "clean run prints a per-channel tally" \
  "$(echo "$OUT" | grep -q "board channel:" && echo "$OUT" | grep -q "group channel:" && echo 0 || echo 1)"

# --- fail closed: --root pointing at a tree with no registry --------------
# Exit 2, NOT 0. An "I could not look" must never read as "I looked and it was
# fine" — that is exactly how a gate rots into decoration.
mkdir -p "$TMP/empty"
run_gate --root "$TMP/empty"
check "missing registry fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"
check "missing registry says why" \
  "$(echo "$OUT" | grep -q "cannot run" && echo 0 || echo 1)"

# --- fail closed: registry present but docs page missing ------------------
mkdir -p "$TMP/partial/backend/boards" "$TMP/partial/backend/groups"
cp "$REPO_ROOT/backend/boards/broadcast.py" "$TMP/partial/backend/boards/broadcast.py"
cp "$REPO_ROOT/backend/boards/consumers.py" "$TMP/partial/backend/boards/consumers.py"
cp "$REPO_ROOT/backend/groups/broadcast.py" "$TMP/partial/backend/groups/broadcast.py"
cp "$REPO_ROOT/backend/groups/consumers.py" "$TMP/partial/backend/groups/consumers.py"
run_gate --root "$TMP/partial"
check "missing docs page fails closed (exit 2)" "$([ "$RC" -eq 2 ] && echo 0 || echo 1)"

# --- findings exit 1, distinct from the fail-closed 2 ---------------------
# Copy the checkout's own inputs and delete one documented event's row, which
# must surface as a finding (exit 1) rather than an abort (exit 2).
mkdir -p "$TMP/drift"
( cd "$REPO_ROOT" && tar cf - \
    backend/boards backend/groups backend/git_lens \
    docs/api/websockets.md \
    frontend/src/components/Board/BoardView.tsx \
    frontend/src/hooks/useBoardSocket.ts \
    frontend/src/hooks/useGroupSocket.ts \
    frontend/src/pages/GroupDetail.tsx \
  ) | ( cd "$TMP/drift" && tar xf - )
"$PY" - "$TMP/drift/docs/api/websockets.md" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text()
marker = "| `card.moved` |"
start = text.index(marker)
end = text.index("\n", start) + 1
p.write_text(text[:start] + text[end:])
PY
run_gate --root "$TMP/drift"
check "an undocumented emitted event is a finding (exit 1)" "$([ "$RC" -eq 1 ] && echo 0 || echo 1)"
check "the finding names the event" \
  "$(echo "$OUT" | grep -q "card.moved" && echo 0 || echo 1)"
check "the finding names the docs page" \
  "$(echo "$OUT" | grep -q "docs/api/websockets.md" && echo 0 || echo 1)"

# --- unknown flag is a usage error, not a pass ----------------------------
run_gate --no-such-flag
check "unknown flag does not exit 0" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"

echo ""
if [ "$fail" -eq 0 ]; then
  echo "check-ws-event-reachability.test.sh: all $pass checks passed"
  exit 0
else
  echo "check-ws-event-reachability.test.sh: $fail failed, $pass passed"
  exit 1
fi
