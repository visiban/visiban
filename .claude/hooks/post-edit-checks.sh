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

if re.search(r"backend/.*/models\.py$", file_path):
    messages.append("⚠️  models.py modified — use the migration-check agent to verify migration safety")

if re.search(r"backend/.*/views\.py$", file_path):
    messages.append("⚠️  views.py modified — use the rbac-check and security-review agents")

if re.search(r"backend/.*/serializers\.py$", file_path):
    messages.append("⚠️  serializers.py modified — use the security-review agent")

if re.search(r"backend/.*/permissions\.py$", file_path):
    messages.append("⚠️  permissions.py modified — use the rbac-check and security-review agents")

if messages:
    print("\n".join(messages))

PYEOF
