#!/bin/sh
# Usage: scripts/cap-release-notes.sh <max-bytes> <full-notes-url> < notes > capped
#        scripts/cap-release-notes.sh --self-test
#
# Caps a release body for the github-release CI job (#2537). GitHub refuses a
# Release body over 125,000 characters, and the job ran `gh release create` on
# the whole dated CHANGELOG section: 1.3.0-alpha.1 (501 fragments since v1.2.0)
# is ~179,000 characters, so the job would have failed after the tag was pushed
# and the GitLab Release was already live. The GitLab Release (1,000,000) and
# CHANGELOG.md keep the full text; only the GitHub copy is capped.
#
# Under the cap the input passes through unchanged. Over it:
#   - everything except the fragment entries under `### Added`, `### Changed`
#     and `### Fixed` is kept whole: the roll-up summary (its own `###`
#     headings included), every heading, and all of `### Security`, which an
#     upgrader must never lose to a length limit;
#   - those three categories are filled in order with whole entries (an entry
#     is a `- ` line plus its continuation lines) until the next one does not
#     fit; nothing after that point is kept, so what is shown is a prefix;
#   - every category that lost entries ends with a line saying how many and
#     linking <full-notes-url>.
# If the kept-whole part alone is over the cap, the output is a pointer to
# <full-notes-url>. Lengths are bytes (LC_ALL=C): a byte count is never below
# the character count GitHub enforces, so the cap holds for any UTF-8 input.
# POSIX sh + awk only: it runs on alpine/busybox.
set -eu

if [ "${1:-}" = "--self-test" ]; then
  self="$0"
  t="$(mktemp -d)"
  trap 'rm -rf "$t"' EXIT
  fail() { echo "SELF-TEST FAILED: cap-release-notes.sh: $*" >&2; exit 1; }
  url='https://gitlab.com/visiban/visiban/-/releases/v9.9.9'
  big="$(printf '%0300d' 0 | tr 0 x)"
  {
    printf '%s\n' '**Summary.** Upgrade urgency: recommended.' '' '### Highlights' '- headline one' ''
    printf '%s\n' '### Added'
    for i in 1 2 3 4 5; do printf -- '- added %s %s\n' "$i" "$big"; done
    printf -- '- added 6 multi\n  continuation of added 6\n'
    printf '\n%s\n' '### Changed'
    for i in 1 2 3; do printf -- '- changed %s %s\n' "$i" "$big"; done
    printf '\n%s\n' '### Fixed'
    for i in 1 2 3 4; do printf -- '- fixed %s %s\n' "$i" "$big"; done
    printf '\n%s\n' '### Security'
    for i in 1 2; do printf -- '- security %s %s\n' "$i" "$big"; done
  } > "$t/in.md"
  in_bytes=$(wc -c < "$t/in.md" | tr -d ' ')

  # 1. Under the cap: byte-identical.
  sh "$self" "$in_bytes" "$url" < "$t/in.md" > "$t/same.md"
  cmp -s "$t/in.md" "$t/same.md" || fail "a body at the cap must pass through unchanged"

  # 2a. The size guarantee holds at every cap, not one: a note's blank-note-blank
  # emit once overshot the reserve by a byte at caps a single test point missed.
  # Short, varied entries and a step of 1, so some caps leave under 3 bytes of slack.
  { for s in Added Changed Fixed; do
      printf '### %s\n' "$s"
      for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf -- '- %s %0*d\n' "$s" "$i" 0; done
      printf '\n'
    done; } > "$t/short.md"
  short_bytes=$(wc -c < "$t/short.md" | tr -d ' ')
  c=520
  while [ "$c" -le "$short_bytes" ]; do
    sh "$self" "$c" "$url" < "$t/short.md" > "$t/sz.md"
    s=$(wc -c < "$t/sz.md" | tr -d ' ')
    [ "$s" -le "$c" ] || fail "cap $c gave $s bytes"
    c=$((c + 1))
  done

  # 2b. Over the cap: under it, Security + summary whole, whole-entry prefix, notes.
  cap=2400
  sh "$self" "$cap" "$url" < "$t/in.md" > "$t/cut.md"
  out_bytes=$(wc -c < "$t/cut.md" | tr -d ' ')
  [ "$out_bytes" -le "$cap" ] || fail "output is $out_bytes bytes, over the $cap cap"
  for want in '**Summary.** Upgrade urgency: recommended.' '- headline one' '### Added' \
              '### Changed' '### Fixed' '### Security' "- security 1 $big" "- security 2 $big" \
              "- added 1 $big"; do
    grep -qxF -- "$want" "$t/cut.md" || fail "missing kept line: $(printf '%.40s' "$want")"
  done
  grep -q '^- changed\|^- fixed' "$t/cut.md" && fail "entries after the cut point must not be kept"
  # Every kept entry line is a whole input line, and kept entries are an in-order prefix.
  grep '^- added' "$t/cut.md" | while IFS= read -r l; do
    grep -qxF -- "$l" "$t/in.md" || fail "an entry was split: $(printf '%.40s' "$l")"
  done
  n_added=$(grep -c '^- added' "$t/cut.md")
  [ "$(grep '^- added' "$t/cut.md" | sed 's/^- added \([0-9]\).*/\1/' | tr -d '\n')" = \
    "$(seq 1 "$n_added" | tr -d '\n')" ] || fail "kept entries are not an in-order prefix"
  grep -qF "_$((6 - n_added)) more Added entries are not shown" "$t/cut.md" || fail "Added count note"
  grep -qF '_3 more Changed entries are not shown' "$t/cut.md" || fail "Changed count note"
  grep -qF '_4 more Fixed entries are not shown' "$t/cut.md" || fail "Fixed count note"
  [ "$(grep -cF "$url" "$t/cut.md")" -eq 3 ] || fail "each note must link the full notes"
  # The Security heading still follows the Fixed note, not the other way round.
  awk '/more Fixed entries/{f=NR} /^### Security$/{s=NR} END{exit !(f && s && f<s)}' "$t/cut.md" \
    || fail "the Fixed note must sit inside the Fixed section"

  # 3. A multi-line entry is kept whole or dropped whole, never split.
  { printf '### Added\n- a\n  cont a\n- b %s\n  cont b\n' "$big"; } > "$t/ml.md"
  sh "$self" 300 "$url" < "$t/ml.md" > "$t/ml-out.md"
  grep -qx '  cont a' "$t/ml-out.md" || fail "multi-line entry lost its continuation"
  grep -q 'cont b' "$t/ml-out.md" && fail "a dropped entry left its continuation behind"

  # 3b. A summary with its own "### Added" heading: its note stays in the summary's
  # category, and the real Added section gets its own note.
  { printf '### Added\n- s %s\n\n### Highlights\n- h\n\n### Added\n' "$big"
    printf -- '- real %s\n' "$big" "$big"; } > "$t/dup.md"
  sh "$self" 500 "$url" < "$t/dup.md" > "$t/dup-out.md"
  awk '/^### Highlights$/{h=NR} /more Added entries/{n++; if(!first) first=NR}
       END{exit !(n==2 && first<h)}' "$t/dup-out.md" || fail "a repeated category heading must get its own note"

  # 4. Kept-whole part over the cap: a pointer, under the cap.
  sh "$self" 500 "$url" < "$t/in.md" > "$t/ptr.md"
  [ "$(wc -c < "$t/ptr.md" | tr -d ' ')" -le 500 ] || fail "pointer output over the cap"
  grep -qF "$url" "$t/ptr.md" || fail "pointer must link the full notes"

  # 5. Bad arguments are refused.
  sh "$self" abc "$url" < "$t/in.md" > /dev/null 2>&1 && fail "a non-numeric cap must be refused"
  sh "$self" 1000 < "$t/in.md" > /dev/null 2>&1 && fail "a missing URL must be refused"

  echo "SELF-TEST OK: cap-release-notes.sh"
  exit 0
fi

max="${1:?usage: cap-release-notes.sh <max-bytes> <full-notes-url>}"
url="${2:?usage: cap-release-notes.sh <max-bytes> <full-notes-url>}"
case "$max" in ''|*[!0-9]*) echo "cap-release-notes.sh: max-bytes must be a positive integer" >&2; exit 2 ;; esac

LC_ALL=C awk -v max="$max" -v url="$url" '
  function note(sec, n) {
    return "_" n " more " sec " entries are not shown here: GitHub limits a release body to 125,000 characters. Full notes: " url "_"
  }
  {
    line[NR] = $0
    if ($0 ~ /^#+ /) {
      # Categories are keyed by heading OCCURRENCE, not by name: a roll-up summary
      # with its own "### Added" heading is a separate category whose note lands in
      # it, not at the real Added section.
      insec = 0
      if ($0 == "### Added" || $0 == "### Changed" || $0 == "### Fixed") {
        insec = ++nsec; secname[nsec] = substr($0, 5)
      }
      cur = 0; ent[NR] = 0
    } else if (insec && $0 ~ /^- /) {
      cur = ++nent; ent[NR] = cur; entsec[cur] = insec; entsize[cur] = 0
    } else {
      ent[NR] = insec ? cur : 0
    }
    secof[NR] = insec
    total += length($0) + 1
    if (ent[NR]) entsize[ent[NR]] += length($0) + 1
    else fixed += length($0) + 1
  }
  END {
    if (total <= max) { for (i = 1; i <= NR; i++) print line[i]; exit }
    # Reserve room for one note per trimmable category (worst-case count width).
    # +3: a note mid-file is emitted as blank line, note, blank line.
    reserve = 0
    for (s = 1; s <= nsec; s++) reserve += length(note(secname[s], nent)) + 3
    budget = max - fixed - reserve
    if (budget < 0) {
      print "The release notes are too long for a GitHub release body. Full notes: " url
      exit
    }
    open = 1
    for (e = 1; e <= nent; e++) {
      if (open && entsize[e] <= budget) { keep[e] = 1; budget -= entsize[e] }
      else { open = 0; dropped[entsec[e]]++ }
    }
    for (i = 1; i <= NR; i++) {
      # Leaving a trimmable category (next heading): close it with its note.
      if (line[i] ~ /^#+ / && prev && dropped[prev]) {
        if (lastblank == 0) print ""
        print note(secname[prev], dropped[prev]); print ""
        dropped[prev] = 0
      }
      if (line[i] ~ /^#+ /) prev = secof[i]
      if (ent[i] == 0 || keep[ent[i]]) { print line[i]; lastblank = (line[i] == "") }
    }
    if (prev && dropped[prev]) {
      if (lastblank == 0) print ""
      print note(secname[prev], dropped[prev])
    }
  }
'
