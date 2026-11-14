#!/usr/bin/env bash
# PreToolUse safety hook for Edit|Write|NotebookEdit.
#
#   - blocks edits to lock files and Django migration files
#   - blocks edits inside a main checkout that is on the repo's default branch
#     (code changes belong in a worktree or feature branch; #2230)
#   - warns on CI/infrastructure config and .env files
#
# Payload (stdin) is JSON; the target path is nested under tool_input:
#   {"tool_name":"Edit","tool_input":{"file_path":"/abs/path"}}
# NotebookEdit uses tool_input.notebook_path. Blocks exit 2 with the message on
# STDERR (that is the stream Claude Code feeds back to the model).
#
# Override the default-branch guard for a deliberate one-off:
#   ALLOW_DEFAULT_BRANCH_EDIT=1
#
# The guard fails open: any git error or malformed payload exits 0, so a broken
# hook can never block all editing. Self-test: scripts/tests/pre-tool-safety.test.sh

set -uo pipefail

# Read the payload via python3 -c (not a heredoc, which would replace stdin).
FILE_PATH=$(python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d.get('tool_input') or {}
print(t.get('file_path') or t.get('notebook_path') or '')
" 2>/dev/null || true)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

BASENAME=$(basename "$FILE_PATH")

# Block: lock files
case "$BASENAME" in
  package-lock.json|yarn.lock|pnpm-lock.yaml|uv.lock|Pipfile.lock|poetry.lock|Cargo.lock|go.sum)
    echo "BLOCKED: Do not edit lock files directly. Use the package manager instead." >&2
    exit 2
    ;;
esac

# Block: migration files (Django)
if [[ "$FILE_PATH" == */migrations/[0-9]*.py ]]; then
  echo "BLOCKED: Do not edit migration files directly. Use Django makemigrations." >&2
  exit 2
fi

# Block: main checkout on the default branch.
if [[ "${ALLOW_DEFAULT_BRANCH_EDIT:-}" != "1" ]]; then
  # Walk up to the nearest existing directory; Write may create new dirs.
  DIR=$(dirname "$FILE_PATH")
  while [[ -n "$DIR" && "$DIR" != "/" && "$DIR" != "." && ! -d "$DIR" ]]; do
    DIR=$(dirname "$DIR")
  done
  if [[ -d "$DIR" ]] && git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_DIR_ABS=$(git -C "$DIR" rev-parse --absolute-git-dir 2>/dev/null || true)
    COMMON_REL=$(git -C "$DIR" rev-parse --git-common-dir 2>/dev/null || true)
    COMMON_ABS=""
    if [[ -n "$COMMON_REL" ]]; then
      COMMON_ABS=$(cd "$DIR" && cd "$COMMON_REL" 2>/dev/null && pwd -P || true)
    fi
    GIT_DIR_REAL=""
    [[ -n "$GIT_DIR_ABS" ]] && GIT_DIR_REAL=$(cd "$GIT_DIR_ABS" 2>/dev/null && pwd -P || true)
    # Linked worktrees have a git-dir distinct from the common dir: allow.
    if [[ -n "$GIT_DIR_REAL" && -n "$COMMON_ABS" && "$GIT_DIR_REAL" == "$COMMON_ABS" ]]; then
      BRANCH=$(git -C "$DIR" branch --show-current 2>/dev/null || true)
      DEFAULT=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)
      DEFAULT="${DEFAULT#origin/}"
      [[ -z "$DEFAULT" ]] && DEFAULT="main"
      if [[ -n "$BRANCH" && "$BRANCH" == "$DEFAULT" ]]; then
        echo "BLOCKED: $FILE_PATH is in the main checkout on '$BRANCH'. Code changes go in a worktree: scripts/wt new <issue> (or git checkout -b <prefix>/<name>). Override: ALLOW_DEFAULT_BRANCH_EDIT=1." >&2
        exit 2
      fi
    fi
  fi
fi

# Warn: CI config. The old `.github/workflows/*` pattern was matched against the
# basename and could never match, so match on the full path instead.
case "$BASENAME" in
  .gitlab-ci.yml|Dockerfile|docker-compose*.yml)
    echo "WARNING: Editing CI/infrastructure config. Double-check before proceeding." >&2
    exit 0
    ;;
esac
if [[ "$FILE_PATH" == */.github/workflows/* ]]; then
  echo "WARNING: Editing CI/infrastructure config. Double-check before proceeding." >&2
  exit 0
fi

# Warn: environment files
case "$BASENAME" in
  .env|.env.*|*.env)
    echo "WARNING: Editing environment file. Never commit secrets." >&2
    exit 0
    ;;
esac

exit 0
