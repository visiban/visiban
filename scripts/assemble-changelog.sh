#!/usr/bin/env bash
# assemble-changelog.sh — Collect changelog.d/ fragments into CHANGELOG.md
#
# Called by scripts/release.sh before the version rotation step, or manually
# when you want to preview what the assembled changelog will look like.
#
# Usage:
#   scripts/assemble-changelog.sh            # assemble and delete fragments
#   scripts/assemble-changelog.sh --dry-run  # preview without modifying files
#   scripts/assemble-changelog.sh --self-test  # prove filename validation
#                                               # and assembly still work (#1093)
#
# Fragment files must be named: <slug>.<type>.md
# where <type> is one of: added, changed, fixed, security
#
# The script appends entries to the existing [Unreleased] section headings in
# CHANGELOG.md (creating subsection headings as needed) and removes the
# consumed fragment files.
#
# --self-test (#1093): this is the script behind the motivating incident in
# the house-rule issue — a version-dotted slug like "1.1.fixed.md" is the
# exact known-bad shape that must still be rejected, not silently assembled
# with a mis-split type. Runs entirely against a synthetic CHANGELOG.md and
# changelog.d/ built in a temp directory via the CHANGELOG_OVERRIDE /
# FRAG_DIR_OVERRIDE env vars below — it never touches this repo's real
# CHANGELOG.md or changelog.d/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Overridable so --self-test can point the exact same assembly logic at a
# synthetic fixture tree instead of the real repository.
CHANGELOG="${CHANGELOG_OVERRIDE:-$REPO_ROOT/CHANGELOG.md}"
FRAG_DIR="${FRAG_DIR_OVERRIDE:-$REPO_ROOT/changelog.d}"
DRY_RUN=false

self_test() {
  local st_root
  st_root="$(mktemp -d)"
  # Double-quoted so the path is baked into the trap command now — st_root is
  # local to this function and goes out of scope once it returns, and under
  # `set -u` a single-quoted 'rm -rf "$st_root"' would fail to expand later.
  # shellcheck disable=SC2064 # intentional early expansion, see comment above
  trap "rm -rf '$st_root'" EXIT

  echo "=== assemble-changelog.sh --self-test ==="

  mkdir -p "$st_root/changelog.d"
  cat > "$st_root/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01
- Initial release
EOF

  # --- Case 1: known-bad — a version-dotted slug ("1.1.fixed.md") must be
  # rejected, not silently mis-split into an unrecognized type and swallowed.
  echo "- something broke" > "$st_root/changelog.d/1.1.fixed.md"
  local rc=0
  local out
  out=$(CHANGELOG_OVERRIDE="$st_root/CHANGELOG.md" FRAG_DIR_OVERRIDE="$st_root/changelog.d" \
    bash "$0" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SELF-TEST FAILED: version-dotted fragment slug '1.1.fixed.md' was NOT rejected." >&2
    echo "$out" >&2
    exit 1
  fi
  if ! echo "$out" | grep -q "Invalid fragment filename"; then
    echo "SELF-TEST FAILED: rejection happened but not via the filename validation message expected." >&2
    echo "$out" >&2
    exit 1
  fi
  rm -f "$st_root/changelog.d/1.1.fixed.md"
  echo "Case 1 OK: version-dotted slug '1.1.fixed.md' is rejected, not silently assembled."

  # --- Case 2: known-good — a valid fragment assembles cleanly and is
  # removed, proving the detection logic isn't just rejecting everything.
  echo "- a real fix" > "$st_root/changelog.d/434.fixed.md"
  rc=0
  out=$(CHANGELOG_OVERRIDE="$st_root/CHANGELOG.md" FRAG_DIR_OVERRIDE="$st_root/changelog.d" \
    bash "$0" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SELF-TEST FAILED: a validly-named fragment (434.fixed.md) was rejected." >&2
    echo "$out" >&2
    exit 1
  fi
  if [ -f "$st_root/changelog.d/434.fixed.md" ]; then
    echo "SELF-TEST FAILED: consumed fragment 434.fixed.md was not removed." >&2
    exit 1
  fi
  if ! grep -q "### Fixed" "$st_root/CHANGELOG.md" || ! grep -q "a real fix" "$st_root/CHANGELOG.md"; then
    echo "SELF-TEST FAILED: entry was not assembled into CHANGELOG.md's [Unreleased] section." >&2
    cat "$st_root/CHANGELOG.md" >&2
    exit 1
  fi
  echo "Case 2 OK: a validly-named fragment assembles into CHANGELOG.md and is removed."

  echo "=== assemble-changelog.sh --self-test: PASSED ==="
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# ── Validate ──────────────────────────────────────────────────────────────────

if [[ ! -f "$CHANGELOG" ]]; then
  echo "ERROR: $CHANGELOG not found." >&2
  exit 1
fi

if ! grep -q "## \[Unreleased\]" "$CHANGELOG"; then
  echo "ERROR: CHANGELOG.md has no [Unreleased] section." >&2
  exit 1
fi

# Collect fragment files (ignore README.md and .gitkeep)
FRAGMENTS=()
for f in "$FRAG_DIR"/*.md; do
  [[ ! -f "$f" ]] && continue
  [[ "$(basename "$f")" == "README.md" ]] && continue
  FRAGMENTS+=("$f")
done

if [[ ${#FRAGMENTS[@]} -eq 0 ]]; then
  echo "No changelog fragments to assemble."
  exit 0
fi

# ── Validate fragment filenames ───────────────────────────────────────────────

VALID_TYPES="added changed fixed security"
ERRORS=0

for f in "${FRAGMENTS[@]}"; do
  base="$(basename "$f")"
  if ! echo "$base" | grep -qE '^[a-zA-Z0-9_-]+\.(added|changed|fixed|security)\.md$'; then
    echo "ERROR: Invalid fragment filename: $base" >&2
    echo "  Expected: <issue-or-slug>.<type>.md" >&2
    echo "  Valid types: $VALID_TYPES" >&2
    echo "  Examples: 434.fixed.md, my-feature.added.md" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [[ ! -s "$f" ]]; then
    echo "ERROR: Empty fragment file: $base" >&2
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ $ERRORS -gt 0 ]]; then
  echo "Aborting — fix the $ERRORS error(s) above." >&2
  exit 1
fi

# ── Group fragments by type ──────────────────────────────────────────────────

# Use temp files instead of associative arrays (bash 3 compat)
TMP_ADDED=$(mktemp)
TMP_CHANGED=$(mktemp)
TMP_FIXED=$(mktemp)
TMP_SECURITY=$(mktemp)
trap 'rm -f "$TMP_ADDED" "$TMP_CHANGED" "$TMP_FIXED" "$TMP_SECURITY"' EXIT

for f in "${FRAGMENTS[@]}"; do
  base="$(basename "$f")"
  type="$(echo "$base" | sed 's/\.md$//' | rev | cut -d. -f1 | rev)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == "- "* ]] || [[ "$line" == "  "* ]]; then
      echo "$line"
    else
      echo "- $line"
    fi
  done < "$f" >> "$(eval echo "\$TMP_$(echo "$type" | tr '[:lower:]' '[:upper:]')")"
done

# ── Preview mode ──────────────────────────────────────────────────────────────

if $DRY_RUN; then
  echo "=== Dry run — entries that would be added ==="
  echo
  for type in added changed fixed security; do
    tmpfile="$(eval echo "\$TMP_$(echo "$type" | tr '[:lower:]' '[:upper:]')")"
    if [[ -s "$tmpfile" ]]; then
      case "$type" in
        added)    echo "### Added" ;;
        changed)  echo "### Changed" ;;
        fixed)    echo "### Fixed" ;;
        security) echo "### Security" ;;
        *)        echo "### ${type^}" ;;
      esac
      cat "$tmpfile"
      echo
    fi
  done
  echo "=== ${#FRAGMENTS[@]} fragment(s) would be consumed ==="
  exit 0
fi

# ── Insert entries into CHANGELOG.md ──────────────────────────────────────────
#
# For each type with entries, use Python for reliable multi-line text insertion.
# Python is available in CI (alpine + apk add python3) and on dev machines.
# This avoids fragile awk/sed multi-line insertion bugs.

python3 - "$CHANGELOG" "$TMP_ADDED" "$TMP_CHANGED" "$TMP_FIXED" "$TMP_SECURITY" << 'PYEOF'
import sys, os, re

changelog_path = sys.argv[1]
tmp_files = {
    "### Added":    sys.argv[2],
    "### Changed":  sys.argv[3],
    "### Fixed":    sys.argv[4],
    "### Security": sys.argv[5],
}

# Canonical heading order
HEADING_ORDER = ["### Added", "### Changed", "### Fixed", "### Security"]

# Read new entries per type (skip empty)
new_entries = {}
for heading, path in tmp_files.items():
    content = open(path).read().strip()
    if content:
        new_entries[heading] = content

if not new_entries:
    sys.exit(0)

# Read the changelog
with open(changelog_path) as f:
    lines = f.readlines()

# Find [Unreleased] block boundaries
unreleased_start = None
unreleased_end = None  # line index of next "## [" section (exclusive)
for i, line in enumerate(lines):
    if line.startswith("## [Unreleased]"):
        unreleased_start = i
        continue
    if unreleased_start is not None and line.startswith("## ["):
        unreleased_end = i
        break

if unreleased_start is None:
    print("ERROR: No [Unreleased] section found.", file=sys.stderr)
    sys.exit(1)

if unreleased_end is None:
    unreleased_end = len(lines)

# Extract the unreleased block as a working copy
block = lines[unreleased_start:unreleased_end]

# For each heading with entries, insert them
for heading in HEADING_ORDER:
    if heading not in new_entries:
        continue
    entry_lines = new_entries[heading] + "\n"

    # Find the heading in the block
    heading_idx = None
    for i, line in enumerate(block):
        if line.strip() == heading:
            heading_idx = i
            break

    if heading_idx is not None:
        # Find the last bullet line under this heading (lines starting with "- " or "  ")
        last_bullet = heading_idx
        for i in range(heading_idx + 1, len(block)):
            stripped = block[i]
            if stripped.startswith("- ") or stripped.startswith("  "):
                last_bullet = i
            elif stripped.strip() == "":
                continue  # skip blank lines within a section
            else:
                break  # hit the next heading or non-bullet content

        # Insert after last_bullet
        block.insert(last_bullet + 1, entry_lines)
    else:
        # Heading doesn't exist — insert in canonical order
        # Find the first heading in the block that comes AFTER this one
        insert_before = None
        my_order = HEADING_ORDER.index(heading)
        for i, line in enumerate(block):
            if line.strip() in HEADING_ORDER:
                their_order = HEADING_ORDER.index(line.strip())
                if their_order > my_order:
                    insert_before = i
                    break

        new_section = "\n" + heading + "\n" + entry_lines
        if insert_before is not None:
            block.insert(insert_before, new_section)
        else:
            # Append at end of block
            block.append(new_section)

# Reassemble
result = lines[:unreleased_start] + block + lines[unreleased_end:]

with open(changelog_path, "w") as f:
    f.writelines(result)
PYEOF

# ── Clean up fragments ───────────────────────────────────────────────────────

for f in "${FRAGMENTS[@]}"; do
  rm "$f"
done

echo "Assembled ${#FRAGMENTS[@]} fragment(s) into CHANGELOG.md and removed them from changelog.d/."
