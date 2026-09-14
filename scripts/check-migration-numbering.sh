#!/usr/bin/env bash
# Detects Django migration-number collisions between the current branch and
# a target branch (default: origin/main).
#
# Why: two branches cut off the same point on main can each add a migration
# at the same next sequential number (e.g. both add 0042_...). Django applies
# whichever merges first without complaint; the second branch's migration
# silently never runs. This script fails the build if the branch introduces
# a migration file whose app + number prefix already exists on the target
# branch under a different filename.
#
# Usage:
#   scripts/check-migration-numbering.sh [--target-ref <ref>] [--no-fetch] [--self-test]
#
#   --target-ref <ref>  Git ref to compare against (default: origin/main, or
#                        origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME in CI).
#   --no-fetch           Skip the `git fetch` step (assumes the target ref is
#                        already up to date locally — used by --self-test and
#                        for local ad-hoc runs).
#   --self-test           Build a synthetic git repo in a temp directory,
#                        prove the check both fires on a genuine collision and
#                        passes on a clean tree, then exit. Ignores all other
#                        flags and does not touch the real repository.
#
# Exit codes: 0 = no collision (or skipped), 1 = collision found or error.

set -euo pipefail

TARGET_REF=""
NO_FETCH=0
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target-ref)
      TARGET_REF="$2"
      shift 2
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    --self-test)
      SELF_TEST=1
      shift
      ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Prints, one per line, "<app_dir>/<number>|<file>" for every migration file
# that exists at $2 (a git ref) under $1 (a repo root, "." for the working
# tree via git ls-files, or a ref for git ls-tree).
#
# We only need the branch-side list from the working tree (git diff already
# gives us that) — this helper is used for the target ref.
list_migrations_at_ref() {
  local ref="$1"
  # `git ls-tree` pathspecs are literal/prefix matches, not wildmatch (unlike
  # `git diff`/`git log`), so list everything and filter with a regex instead.
  git ls-tree -r --name-only "$ref" 2>/dev/null \
    | grep -E '^backend/[^/]+/migrations/[^/]+\.py$' \
    | grep -v '/migrations/__init__\.py$' || true
}

# Runs the actual collision check. Assumes the target ref is already fetched
# and reachable locally. Prints findings and returns 1 on collision.
run_check() {
  local target_ref="$1"

  local base
  base=$(git merge-base "$target_ref" HEAD 2>/dev/null || true)
  if [ -z "$base" ]; then
    echo "INFO — could not determine merge base with $target_ref; skipping migration-numbering check."
    return 0
  fi

  local new_files
  new_files=$(git diff --name-only --diff-filter=A "$base" HEAD -- 'backend/*/migrations/*.py' \
    | grep -v '/migrations/__init__\.py$' || true)

  if [ -z "$new_files" ]; then
    echo "INFO — no new migration files on this branch; nothing to check."
    return 0
  fi

  local target_files
  target_files=$(list_migrations_at_ref "$target_ref")

  local found_collision=0
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local app_dir base_name number
    app_dir=$(dirname "$f")
    base_name=$(basename "$f")
    number=$(echo "$base_name" | grep -oE '^[0-9]+' || true)
    if [ -z "$number" ]; then
      # Not a numbered migration (e.g. a squashed migration file) — skip.
      continue
    fi

    local match
    match=$(echo "$target_files" | grep -E "^${app_dir}/${number}_" || true)
    if [ -n "$match" ]; then
      while IFS= read -r m; do
        [ -z "$m" ] && continue
        if [ "$(basename "$m")" != "$base_name" ]; then
          echo "ERROR — migration number collision detected:"
          echo "  branch:  $f"
          echo "  $target_ref: $m"
          echo "  Both claim migration number $number in $app_dir. Renumber the branch's" \
               "migration to the next free number in that app before merging."
          found_collision=1
        fi
      done <<< "$match"
    fi
  done <<< "$new_files"

  if [ "$found_collision" -eq 1 ]; then
    return 1
  fi

  echo "OK — no migration-number collisions against $target_ref."
  return 0
}

self_test() {
  local tmp
  tmp=$(mktemp -d)
  # Double-quoted so the path is baked into the trap command now — the
  # `local tmp` above goes out of scope when this function returns, and
  # under `set -u` a single-quoted 'rm -rf "$tmp"' would fail to expand at
  # trap-fire time.
  # shellcheck disable=SC2064 # intentional early expansion, see comment above
  trap "rm -rf '$tmp'" EXIT

  echo "=== self-test: setting up synthetic repo in $tmp ==="
  git init --quiet -b main "$tmp"
  (
    cd "$tmp"
    git config user.email "self-test@example.com"
    git config user.name "self-test"

    mkdir -p backend/testapp/migrations
    touch backend/testapp/migrations/__init__.py
    echo "# initial" > backend/testapp/migrations/0001_initial.py
    git add -A
    git commit --quiet -m "initial migration"

    # Branch A (simulates the feature branch under test): adds 0002_add_a.py
    git checkout --quiet -b branch-a main
    echo "# add a" > backend/testapp/migrations/0002_add_a.py
    git add -A
    git commit --quiet -m "branch-a: add field a"

    # Main moves on: a different branch merges first and lands 0002_add_b.py
    git checkout --quiet main
    echo "# add b" > backend/testapp/migrations/0002_add_b.py
    git add -A
    git commit --quiet -m "main: add field b"

    echo "--- Case 1: expect COLLISION (both branch-a and main claim 0002 in testapp) ---"
    git checkout --quiet branch-a
    if run_check main; then
      echo "SELF-TEST FAILED: expected a collision to be detected, but check passed." >&2
      exit 1
    else
      echo "Collision correctly detected."
    fi

    echo "--- Case 2: expect CLEAN (branch-c adds a non-colliding number) ---"
    git checkout --quiet -b branch-c main
    echo "# add c" > backend/testapp/migrations/0003_add_c.py
    git add -A
    git commit --quiet -m "branch-c: add field c"
    if run_check main; then
      echo "Clean tree correctly passed."
    else
      echo "SELF-TEST FAILED: expected no collision, but check failed." >&2
      exit 1
    fi
  )

  echo "=== self-test: PASSED ==="
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

if [ -z "$TARGET_REF" ]; then
  BRANCH="${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-main}"
  TARGET_REF="origin/${BRANCH}"
  if [ "$NO_FETCH" -eq 0 ]; then
    git fetch origin "$BRANCH" --depth=100
  fi
fi

run_check "$TARGET_REF"
