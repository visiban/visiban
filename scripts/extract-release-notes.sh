#!/bin/sh
# Usage: scripts/extract-release-notes.sh <version> [changelog-file]
#
# Prints the body of CHANGELOG.md's dated "## [<version>]" section, for the
# github-release CI job (#1995). The section opens with the approved roll-up
# summary on a stable feature release, followed by the assembled ### categories.
# Blank lines are kept (so the summary's paragraphs and lists render); `---`
# dividers and leading blank lines are dropped, and $(...) in the caller drops
# trailing ones. POSIX sh + awk + sed only: it runs on alpine/busybox.
# Used by BOTH the job and release.sh's --self-test, so they cannot drift.
set -eu

if [ "${1:-}" = "--self-test" ]; then
  # Builds a known-bad-for-a-naive-extractor changelog (summary + categories +
  # divider + a following section) and proves the extractor returns exactly
  # the dated section, summary first, with no divider and no next section.
  t="$(mktemp)"
  trap 'rm -f "$t"' EXIT
  printf '%s\n' '# Changelog' '' '## [Unreleased]' '' '---' '' \
    '## [1.2.0] — 2026-11-01' '' '### Highlights' '' '- Big thing' '' \
    '### Added' '- n' '' '---' '' '## [1.1.0] — 2026-06-06' '- old' > "$t"
  got="$(sh "$0" 1.2.0 "$t")"
  want="$(printf '%s\n' '### Highlights' '' '- Big thing' '' '### Added' '- n')"
  [ "$got" = "$want" ] || { echo "SELF-TEST FAILED: extract-release-notes.sh (got '$got')" >&2; exit 1; }
  [ -z "$(sh "$0" 9.9.9 "$t")" ] || { echo "SELF-TEST FAILED: extract-release-notes.sh unknown version must be empty" >&2; exit 1; }
  echo "SELF-TEST OK: extract-release-notes.sh"
  exit 0
fi

version="${1:?usage: extract-release-notes.sh <version> [changelog-file]}"
file="${2:-CHANGELOG.md}"
awk -v v="$version" '
  index($0, "## [" v "]") == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' "$file" | sed '/^---[[:space:]]*$/d' | sed -e '/./,$!d'
