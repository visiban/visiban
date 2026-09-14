#!/usr/bin/env bash
#
# check-memory-index.sh — budget and validate a Claude Code project memory store.
#
# Context: CLAUDE.md's "Memory discipline" section (global ~/.claude/CLAUDE.md)
# describes an append-mostly memory store whose MEMORY.md index keeps hitting
# its ~24.4 KB read limit, and calls out two failure modes that nothing
# automated ever caught: the index growing past budget, and index entries
# ([[wikilink]], [text](file.md), or bare [file.md]) that point at files which
# no longer exist. See GitLab issue #1095.
#
# This script is deliberately NOT a CI gate — the memory store lives on the
# developer's machine, not in the repo. It is meant to be run by hand or via
# `make memory-check`, and is wired into the release pre-flight checklist
# (.claude/skills/release/SKILL.md).
#
# Exit status:
#   0  — no FAIL conditions (WARN conditions may still have been printed)
#   1  — at least one FAIL condition: MEMORY.md over budget, or a dangling
#        index entry
#   2  — usage error
#
# Note on worktrees: the default --store path is derived from `git rev-parse
# --show-toplevel`, which returns the checkout you're standing in. Claude
# Code's memory store is keyed to the *primary* checkout path, so running
# this from a `scripts/wt`-created worktree will look for a store that
# doesn't exist there. Pass --store (or set MEMORY_STORE_DIR) explicitly in
# that case, or run it from the primary checkout.
#
set -euo pipefail

DEFAULT_BUDGET_BYTES=23800
DEFAULT_WARN_SIZE_BYTES=8192

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SELF="$SELF_DIR/$(basename "$0")"

usage() {
  cat <<'USAGE'
Usage: check-memory-index.sh [options]

Validates a Claude Code project memory store's MEMORY.md index:
  - FAILs if MEMORY.md exceeds its byte budget
  - FAILs if any index entry ([[wikilink]], [text](file.md), or bare
    [file.md]) in MEMORY.md points at a file that does not exist
  - WARNs (does not fail) on any memory file with no `description:`
    frontmatter field
  - WARNs (does not fail) on any memory file over the size-warning threshold
  - Reports store totals (file count, total bytes)

Options:
  --store PATH        Memory store directory to check.
                       Default: $MEMORY_STORE_DIR, or a path derived from
                       the current repo checkout under
                       ~/.claude/projects/<slugified-repo-path>/memory
  --budget BYTES       MEMORY.md byte budget. Default: $MEMORY_BUDGET_BYTES,
                       or 23800 (just under the ~24.4 KB read limit).
  --warn-size BYTES    Per-file size warning threshold. Default:
                       $MEMORY_WARN_SIZE_BYTES, or 8192.
  --self-test          Build a synthetic temp store (a clean one and a
                       deliberately broken one), run the checks against
                       both, and assert the expected pass/fail outcomes.
                       Touches nothing outside a mktemp directory, needs no
                       network. Exit 0 if all self-test assertions pass.
  -h, --help           Show this help.

Environment:
  MEMORY_STORE_DIR       same as --store
  MEMORY_BUDGET_BYTES     same as --budget
  MEMORY_WARN_SIZE_BYTES  same as --warn-size
USAGE
}

# Derive the default store path without hardcoding any one user's home
# directory or username: Claude Code names a project's memory directory
# after the absolute path of its checkout with "/" replaced by "-".
default_store_dir() {
  local repo_root slug
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  slug="$(printf '%s' "$repo_root" | tr '/' '-')"
  printf '%s/.claude/projects/%s/memory' "$HOME" "$slug"
}

# Print one target filename per line for every index entry found in $1,
# de-duplicated. Recognizes three link styles: [[wikilink]],
# [text](file.md), and bare [file.md]. External http(s) links are ignored.
extract_targets() {
  perl -ne '
    while (/\[\[([^\[\]]+)\]\]|\[([^\[\]]*)\]\(([^)\s]+)\)|\[([A-Za-z0-9_.\-]+\.md)\]/g) {
      my $t;
      if (defined $1)    { $t = $1; $t .= ".md" unless $t =~ /\.md$/; }
      elsif (defined $3) { $t = $3; }
      elsif (defined $4) { $t = $4; }
      next unless defined $t;
      next if $t =~ m{^https?://};
      $t =~ s/#.*$//;
      next if $t eq "";
      print "$t\n";
    }
  ' "$1" | sort -u
}

# True (exit 0) if $1's YAML frontmatter contains a `description:` field.
has_description() {
  local f="$1" first_line
  first_line="$(head -n1 "$f" 2>/dev/null || true)"
  [ "$first_line" = "---" ] || return 1
  awk 'NR==1{next} /^---$/{exit} {print}' "$f" | grep -qE '^description:'
}

run_check() {
  local store="$1" budget="$2" warn_size="$3"
  local mem="$store/MEMORY.md"
  local fail=0

  if [ ! -d "$store" ]; then
    echo "FAIL: memory store directory not found: $store"
    return 1
  fi
  if [ ! -f "$mem" ]; then
    echo "FAIL: index file not found: $mem"
    return 1
  fi

  local mem_size
  mem_size=$(wc -c < "$mem" | tr -d ' ')

  echo "== check-memory-index: $store =="
  echo "MEMORY.md: $mem_size bytes (budget: $budget bytes)"
  if [ "$mem_size" -gt "$budget" ]; then
    echo "FAIL: MEMORY.md exceeds byte budget: $mem_size bytes > $budget byte budget"
    fail=1
  fi

  echo
  echo "-- index entries (MEMORY.md) --"
  local missing_count=0
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    if [ ! -f "$store/$target" ]; then
      echo "FAIL: index entry references missing file: $target"
      missing_count=$((missing_count + 1))
      fail=1
    fi
  done < <(extract_targets "$mem")
  if [ "$missing_count" -eq 0 ]; then
    echo "ok: all index entries resolve to an existing file"
  fi

  echo
  echo "-- memory file warnings --"
  local total_files=0 total_bytes=0 warn_count=0 base sz f
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    [ "$base" = "MEMORY.md" ] && continue
    [ "$base" = "MEMORY-archive.md" ] && continue
    total_files=$((total_files + 1))
    sz=$(wc -c < "$f" | tr -d ' ')
    total_bytes=$((total_bytes + sz))
    if ! has_description "$f"; then
      echo "WARN: $base has no 'description:' frontmatter field (the only retrieval handle)"
      warn_count=$((warn_count + 1))
    fi
    if [ "$sz" -gt "$warn_size" ]; then
      echo "WARN: $base is $sz bytes (over the $warn_size-byte guidance — likely several facts, not one)"
      warn_count=$((warn_count + 1))
    fi
  done < <(find "$store" -maxdepth 1 -type f -name '*.md' -print0)
  if [ "$warn_count" -eq 0 ]; then
    echo "ok: no warnings"
  fi

  echo
  echo "-- store totals --"
  echo "memory files (excl. MEMORY.md, MEMORY-archive.md): $total_files"
  echo "total bytes (same set): $total_bytes"
  echo "MEMORY.md: $mem_size bytes"
  if [ -f "$store/MEMORY-archive.md" ]; then
    local arch_sz
    arch_sz=$(wc -c < "$store/MEMORY-archive.md" | tr -d ' ')
    echo "MEMORY-archive.md: $arch_sz bytes"
  else
    echo "MEMORY-archive.md: absent"
  fi

  return "$fail"
}

self_test() {
  local tmp pass=0 fail_n=0 out
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/memory-check-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  echo "== self-test: synthetic store in $tmp (real store untouched) =="

  # --- clean store: every link style resolves, well under budget ---
  local clean="$tmp/clean-store"
  mkdir -p "$clean"
  cat > "$clean/ok-file.md" <<'EOF'
---
name: ok-file
description: A well-formed memory file used only by check-memory-index.sh --self-test.
metadata:
  type: reference
---
Body text.
EOF
  cat > "$clean/MEMORY.md" <<'EOF'
# Test Memory
- [[ok-file]] wikilink form, target exists
- [ok-file.md](ok-file.md) markdown-link form, target exists
- [ok-file.md] bare-bracket form, target exists
EOF

  # --- broken store: dangling entries (all 3 styles) + forced over-budget,
  #     plus a missing-description file and an oversized file ---
  local broken="$tmp/broken-store"
  mkdir -p "$broken"
  cat > "$broken/present.md" <<'EOF'
---
name: present
description: Present and correctly referenced.
metadata:
  type: reference
---
Body.
EOF
  cat > "$broken/no-description.md" <<'EOF'
---
name: no-description
metadata:
  type: reference
---
Body with no description field — should WARN, not FAIL.
EOF
  perl -e 'print "x" x 9000' > "$broken/oversized.md"
  {
    printf -- '# Test Memory\n'
    printf -- '- [[present]] wikilink, present\n'
    printf -- '- [missing-md-link.md](missing-md-link.md) markdown-link, MISSING\n'
    printf -- '- [missing-bare.md] bare-bracket, MISSING\n'
    perl -e 'print "x" x 400'  # pad past the tiny forced budget below
  } > "$broken/MEMORY.md"

  echo "-- clean store (expect exit 0) --"
  if out=$("$SELF" --store "$clean" --budget "$DEFAULT_BUDGET_BYTES" --warn-size "$DEFAULT_WARN_SIZE_BYTES" 2>&1); then
    echo "  ok: clean store passed"
    pass=$((pass + 1))
  else
    echo "  FAIL: clean store should have passed"
    printf '%s\n' "$out" | while IFS= read -r line; do echo "    $line"; done
    fail_n=$((fail_n + 1))
  fi

  echo "-- broken store, budget=100 (expect exit 1) --"
  if out=$("$SELF" --store "$broken" --budget 100 --warn-size "$DEFAULT_WARN_SIZE_BYTES" 2>&1); then
    echo "  FAIL: broken store should have failed but exited 0"
    printf '%s\n' "$out" | while IFS= read -r line; do echo "    $line"; done
    fail_n=$((fail_n + 1))
  else
    echo "  ok: broken store failed as expected"
    pass=$((pass + 1))
    for needle in "missing-md-link.md" "missing-bare.md" "no-description.md" "oversized.md"; do
      if printf '%s' "$out" | grep -q -- "$needle"; then
        echo "  ok: report mentions $needle"
        pass=$((pass + 1))
      else
        echo "  FAIL: report does not mention $needle"
        fail_n=$((fail_n + 1))
      fi
    done
    if printf '%s' "$out" | grep -qi "budget"; then
      echo "  ok: report mentions budget overage"
      pass=$((pass + 1))
    else
      echo "  FAIL: report does not mention budget overage"
      fail_n=$((fail_n + 1))
    fi
  fi

  echo
  echo "self-test: $pass passed, $fail_n failed"
  [ "$fail_n" -eq 0 ]
}

# ---- argument parsing ------------------------------------------------------

STORE_DIR="${MEMORY_STORE_DIR:-}"
BUDGET_BYTES="${MEMORY_BUDGET_BYTES:-$DEFAULT_BUDGET_BYTES}"
WARN_SIZE_BYTES="${MEMORY_WARN_SIZE_BYTES:-$DEFAULT_WARN_SIZE_BYTES}"
DO_SELF_TEST=0

require_value() {
  if [ $# -lt 2 ]; then
    echo "error: $1 requires a value" >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --store)
      require_value "$@"
      STORE_DIR="$2"
      shift 2
      ;;
    --budget)
      require_value "$@"
      BUDGET_BYTES="$2"
      shift 2
      ;;
    --warn-size)
      require_value "$@"
      WARN_SIZE_BYTES="$2"
      shift 2
      ;;
    --self-test)
      DO_SELF_TEST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$DO_SELF_TEST" -eq 1 ]; then
  self_test
  exit $?
fi

if [ -z "$STORE_DIR" ]; then
  STORE_DIR="$(default_store_dir)"
fi

run_check "$STORE_DIR" "$BUDGET_BYTES" "$WARN_SIZE_BYTES"
exit $?
