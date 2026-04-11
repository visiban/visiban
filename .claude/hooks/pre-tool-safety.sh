#!/usr/bin/env bash
# PreToolUse safety hook — blocks edits to lock files and migration files,
# warns on CI config and .env files.
#
# Receives tool input on stdin as JSON with a "file_path" field.

set -euo pipefail

FILE_PATH=$(cat | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

BASENAME=$(basename "$FILE_PATH")

# Block: lock files
case "$BASENAME" in
  package-lock.json|yarn.lock|pnpm-lock.yaml|uv.lock|Pipfile.lock|poetry.lock|Cargo.lock|go.sum)
    echo "BLOCKED: Do not edit lock files directly. Use the package manager instead."
    exit 2
    ;;
esac

# Block: migration files (Django)
if [[ "$FILE_PATH" == */migrations/[0-9]*.py ]]; then
  echo "BLOCKED: Do not edit migration files directly. Use Django makemigrations."
  exit 2
fi

# Warn: CI config
case "$BASENAME" in
  .gitlab-ci.yml|.github/workflows/*|Dockerfile|docker-compose*.yml)
    echo "WARNING: Editing CI/infrastructure config. Double-check before proceeding."
    exit 0
    ;;
esac

# Warn: environment files
case "$BASENAME" in
  .env|.env.*|*.env)
    echo "WARNING: Editing environment file. Never commit secrets."
    exit 0
    ;;
esac

exit 0
