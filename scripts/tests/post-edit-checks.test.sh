#!/usr/bin/env bash
# scripts/tests/post-edit-checks.test.sh
#
# Self-test for .claude/hooks/post-edit-checks.sh (#2241): real-shaped PostToolUse
# payloads (path nested under tool_input) must produce reminders. Before the fix a
# heredoc replaced the hook's stdin, so every payload gave rc=0 and no output.
#
# Run: bash scripts/tests/post-edit-checks.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/post-edit-checks.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out"
fail=0

run() { printf '%s' "$1" | bash "$HOOK" >"$OUT" 2>/dev/null; RC=$?; }
expect_msg() { # <desc> <substring>
  if [[ "$RC" -ne 0 ]]; then echo "  FAIL: $1 (rc=$RC)"; fail=$((fail + 1)); return; fi
  if ! python3 -c '
import json, sys
c = json.load(open(sys.argv[1]))["hookSpecificOutput"]["additionalContext"]
sys.exit(0 if sys.argv[2] in c else 1)' "$OUT" "$2" 2>/dev/null; then
    echo "  FAIL: $1 (no reminder containing: $2)"; fail=$((fail + 1)); return
  fi
  echo "  ok: $1"
}
expect_silent() { # <desc>
  if [[ "$RC" -ne 0 || -s "$OUT" ]]; then
    echo "  FAIL: $1 (rc=$RC, output: $(cat "$OUT"))"; fail=$((fail + 1)); return
  fi
  echo "  ok: $1"
}

echo "post-edit-checks.sh"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/backend/boards/models.py"}}'
expect_msg "models.py Edit -> migration-check reminder" "migration-check"
run '{"tool_name":"Write","tool_input":{"file_path":"/r/backend/boards/views.py"}}'
expect_msg "views.py Write -> rbac-check reminder" "rbac-check"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/backend/boards/serializers.py"}}'
expect_msg "serializers.py -> security-review reminder" "security-review"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/backend/boards/permissions.py"}}'
expect_msg "permissions.py -> rbac-check reminder" "rbac-check"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/frontend/src/components/A.tsx"}}'
expect_msg "frontend tsx -> tsc reminder" "tsc --noEmit"
run '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"/r/backend/boards/models.py"}}'
expect_msg "notebook_path is read" "migration-check"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/backend/boards/tests/test_a.py"}}'
expect_silent "test file -> silent"
run '{"tool_name":"Edit","tool_input":{"file_path":"/r/docs/index.md"}}'
expect_silent "unrelated file -> silent"
run 'not json'
expect_silent "malformed payload -> silent, rc 0"
run '{"tool_name":"Edit"}'
expect_silent "missing tool_input -> silent"

if [[ "$fail" -ne 0 ]]; then echo "FAILED: $fail"; exit 1; fi
echo "all passed"
