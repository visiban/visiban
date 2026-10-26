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
version="${1:?usage: extract-release-notes.sh <version> [changelog-file]}"
file="${2:-CHANGELOG.md}"
awk -v v="$version" '
  index($0, "## [" v "]") == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' "$file" | sed '/^---[[:space:]]*$/d' | sed -e '/./,$!d'
