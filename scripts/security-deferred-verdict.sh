#!/bin/sh
# Accepted-risk verdict for one `security::deferred` issue (#1521).
#
# Extracted verbatim in behavior from .claude/skills/pre-release/SKILL.md Step 1.5 so the
# regex + calendar/expiry logic is committed, self-tested code instead of an untested
# markdown snippet (the repo's per-gate-script self-test rule, docs/development/ci-gates.md).
#
# Usage:
#   security-deferred-verdict.sh            # candidate lines on stdin
#   security-deferred-verdict.sh --self-test
#
# Input (stdin): zero or more lines of the form `<author>|Accepted risk: accepted-by: @<h>; reason: <r>; expires: YYYY-MM-DD`
#   (the caller pre-filters description/comment lines that start with "Accepted risk:" and
#   prefixes the author's username).
# Env: TODAY (YYYY-MM-DD, default today) and CAP (latest acceptable expiry, default today + 1 year).
# Output: one line, `ACCEPTED note-by=<author> accepted-by=@<h> expires=<date>` (exit 0),
#   or `BLOCKER` / `BLOCKER (expiry too far out; max 1 year)` (exit 1). Exit 2 on usage error.
#
# Why a fixed-field regex then awk: the regex enforces field order and shape (an expires
# that is not last, or a ';' in reason, never matches); awk does the calendar check because
# a date like 2099-02-30 is shape-valid. POSIX sh/awk only: runs on BSD awk (macOS) and
# gawk/mawk (Linux). Dates compare as strings, which is correct for zero-padded ISO dates.

verdict() {
  TODAY=${TODAY:-$(date +%F)}
  CAP=${CAP:-$(date -v+1y +%F 2>/dev/null || date -d '+1 year' +%F)}   # BSD (macOS) or GNU date
  grep -E '^[^|]+\|Accepted risk: accepted-by: @[A-Za-z0-9_.-]+; reason: [^;]*[^; ]; expires: [0-9]{4}-[0-9]{2}-[0-9]{2} *$' \
    | sed -E 's/^([^|]+)\|.*accepted-by: (@[A-Za-z0-9_.-]+);.*expires: ([0-9-]{10}) *$/\1 \2 \3/' \
    | awk -v t="$TODAY" -v cap="$CAP" '{ split($3,a,"-"); y=a[1]+0; m=a[2]+0; d=a[3]+0
        dim=(m==2)?(((y%4==0&&y%100!=0)||y%400==0)?29:28):((m==4||m==6||m==9||m==11)?30:31)
        if (m<1||m>12||d<1||d>dim||$3<t) next
        if ($3>cap) { far=1; next }
        if (!ok) { ok=1; line="ACCEPTED note-by=" $1 " accepted-by=" $2 " expires=" $3 } }
        END{ print ok ? line : (far ? "BLOCKER (expiry too far out; max 1 year)" : "BLOCKER") }'
}

self_test() {
  fails=0; n=0
  NL='
'
  # expect <name> <expected verdict> <input lines>
  expect() {
    n=$((n+1))
    got=$(printf '%s\n' "$3" | TODAY=2026-10-08 CAP=2027-10-08 verdict)
    if [ "$got" != "$2" ]; then
      echo "FAIL [$1]: expected '$2', got '$got'" >&2; fails=$((fails+1))
    fi
  }
  P='alice|Accepted risk: accepted-by: @bob; reason: '
  expect valid          'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-01' "${P}fixed next sprint; expires: 2027-01-01"
  expect expired        'BLOCKER' "${P}ok; expires: 2026-10-07"
  expect expires-today  'ACCEPTED note-by=alice accepted-by=@bob expires=2026-10-08' "${P}ok; expires: 2026-10-08"
  expect leap-day       'ACCEPTED note-by=alice accepted-by=@bob expires=2027-02-28' "${P}ok; expires: 2027-02-28"
  expect blank-reason   'BLOCKER' "alice|Accepted risk: accepted-by: @bob; reason:  ; expires: 2027-01-01"
  expect empty-reason   'BLOCKER' "alice|Accepted risk: accepted-by: @bob; reason: ; expires: 2027-01-01"
  expect blank-accepted 'BLOCKER' "alice|Accepted risk: accepted-by: ; reason: ok; expires: 2027-01-01"
  expect no-at-handle   'BLOCKER' "alice|Accepted risk: accepted-by: bob; reason: ok; expires: 2027-01-01"
  expect month-13       'BLOCKER' "${P}ok; expires: 2099-13-45"
  expect feb-30         'BLOCKER' "${P}ok; expires: 2099-02-30"
  expect feb-29-nonleap 'BLOCKER' "${P}ok; expires: 2027-02-29"
  expect two-expires    'BLOCKER' "${P}ok; expires: 2027-01-01; expires: 2027-01-02"
  expect semicolon      'BLOCKER' "${P}a; b; expires: 2027-01-01"
  expect too-far        'BLOCKER (expiry too far out; max 1 year)' "${P}ok; expires: 2099-01-01"
  expect no-note        'BLOCKER' ""
  expect wrong-order    'BLOCKER' "alice|Accepted risk: reason: ok; accepted-by: @bob; expires: 2027-01-01"
  expect trailing-space 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-01' "${P}ok; expires: 2027-01-01  "
  expect multi-first-ok 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-01' "${P}ok; expires: 2027-01-01${NL}${P}ok; expires: 2026-01-01"
  expect multi-bad-then-ok 'ACCEPTED note-by=carol accepted-by=@dan expires=2027-03-03' "${P}ok; expires: 2026-01-01${NL}carol|Accepted risk: accepted-by: @dan; reason: ok; expires: 2027-03-03"
  expect multi-far-then-ok 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-01' "${P}ok; expires: 2099-01-01${NL}${P}ok; expires: 2027-01-01"
  expect multi-all-bad  'BLOCKER' "${P}ok; expires: 2026-01-01${NL}${P}ok; expires: 2099-13-45"
  # CAP boundary is inclusive: exactly cap is accepted, cap+1 day is too far out
  got=$(printf '%s\n' "${P}ok; expires: 2027-10-08" | TODAY=2026-10-08 CAP=2027-10-08 verdict)
  n=$((n+1)); [ "$got" = 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-10-08' ] || { echo "FAIL [cap-inclusive]: got '$got'" >&2; fails=$((fails+1)); }
  got=$(printf '%s\n' "${P}ok; expires: 2027-10-09" | TODAY=2026-10-08 CAP=2027-10-08 verdict)
  n=$((n+1)); [ "$got" = 'BLOCKER (expiry too far out; max 1 year)' ] || { echo "FAIL [cap-plus-one]: got '$got'" >&2; fails=$((fails+1)); }
  if [ "$fails" -ne 0 ]; then echo "security-deferred-verdict self-test: $fails of $n case(s) FAILED" >&2; return 1; fi
  echo "security-deferred-verdict self-test: all $n cases passed"
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  "") out=$(verdict); echo "$out"; case "$out" in ACCEPTED*) exit 0 ;; *) exit 1 ;; esac ;;
  *) echo "usage: $0 [--self-test]  (candidate lines on stdin)" >&2; exit 2 ;;
esac
