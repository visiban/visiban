#!/bin/bash
# Post-edit hook: emit reminders to run relevant agents when sensitive files are modified.
# Receives the tool call JSON on stdin. Exit 0 = informational; exit 2 = block.

python3 - <<'PYEOF'
import sys, json, re

try:
    data = json.load(sys.stdin)
    file_path = data.get("tool_input", {}).get("file_path", "")
except Exception:
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
    print("\n".join(messages))

PYEOF
