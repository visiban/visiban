#!/bin/bash
# Post-edit hook: emit reminders to run relevant agents when sensitive files are modified.
# Receives the tool call JSON on stdin; the path is nested under tool_input
# (file_path, or notebook_path for NotebookEdit). Always exits 0 (informational):
# reminders go to the model as PostToolUse additionalContext JSON on stdout.
#
# The Python is passed via `python3 -c "$PY"` (heredoc only fills a variable), NOT
# as `python3 - <<EOF`: a heredoc replaces the
# hook's stdin, so json.load(sys.stdin) failed and the hook never fired (#2241,
# same defect class as #2230). Self-test: scripts/tests/post-edit-checks.test.sh

PY=$(cat <<'PYEOF'
import sys, json, re

try:
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
except Exception:
    sys.exit(0)
if not isinstance(file_path, str) or not file_path:
    sys.exit(0)

messages = []

# Agent reminders for sensitive backend files
if re.search(r"backend/.*/models\.py$", file_path):
    messages.append("⚠️  models.py modified — use the migration-check agent to verify migration safety")

if re.search(r"backend/.*/views\.py$", file_path):
    messages.append("⚠️  views.py modified — use the rbac-check and security-review agents")

if re.search(r"backend/.*/serializers\.py$", file_path):
    messages.append("⚠️  serializers.py modified — use the security-review agent")

if re.search(r"backend/.*/permissions\.py$", file_path):
    messages.append("⚠️  permissions.py modified — use the rbac-check and security-review agents")

# Same-commit test reminder: backend production source edited (not tests/migrations/management)
if (re.search(r"backend/", file_path)
        and file_path.endswith(".py")
        and not re.search(r"/(tests|migrations|management)/", file_path)
        and not file_path.endswith("settings.py")):
    messages.append(
        "📋 Backend source edited — update the corresponding test file in the SAME commit.\n"
        "   Run: cd backend && pytest <test_file> -q  before committing."
    )

# TypeScript type drift: frontend source edited (not test files)
if (re.search(r"frontend/src/", file_path)
        and re.search(r"\.(ts|tsx)$", file_path)
        and "/test/" not in file_path):
    messages.append(
        "📋 Frontend source edited — run `cd frontend && npx tsc --noEmit` before committing\n"
        "   to catch stale test fixtures and type drift."
    )

# Env var / settings rename guard
if re.search(r"backend/.*/settings\.py$", file_path):
    messages.append(
        "📋 settings.py modified — if any env var was added or renamed, grep for the old name:\n"
        "   grep -r 'OLD_VAR_NAME' . --include='*.yml' --include='*.py' --include='*.md'"
    )

if messages:
    # PostToolUse stdout is not shown to the model; additionalContext is.
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "\n".join(messages),
        }
    }))
PYEOF
)

python3 -c "$PY"
