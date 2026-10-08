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
  # CAP derives from TODAY (not the wall clock) so an overridden TODAY keeps the two consistent.
  # BSD date (-j -f) then GNU date (-d); busybox date can't parse this, leaving CAP empty, which
  # makes every date "too far out" -- fail closed. Not self-tested: not portable across all three.
  CAP=${CAP:-$(date -j -v+1y -f %F "$TODAY" +%F 2>/dev/null || date -d "$TODAY +1 year" +%F 2>/dev/null)}
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
  expect feb-28-nonleap 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-02-28' "${P}ok; expires: 2027-02-28"
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
  # Month/day range and leap rules. Each case pins one clause of the awk calendar check so
  # dropping it (m<1, m>12, d<1, a 30-day month, Feb length, the %4/%100/%400 rules) is caught.
  expect month-00       'BLOCKER' "${P}ok; expires: 2027-00-15"
  expect day-00         'BLOCKER' "${P}ok; expires: 2027-01-00"
  expect apr-31         'BLOCKER' "${P}ok; expires: 2027-04-31"
  expect jun-31         'BLOCKER' "${P}ok; expires: 2027-06-31"
  expect sep-31         'BLOCKER' "${P}ok; expires: 2027-09-31"
  expect nov-31         'BLOCKER' "${P}ok; expires: 2027-11-31"
  expect apr-30-ok      'ACCEPTED note-by=alice accepted-by=@bob expires=2027-04-30' "${P}ok; expires: 2027-04-30"
  expect month-13-plain 'BLOCKER' "${P}ok; expires: 2027-13-01"
  expect jan-31-ok      'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-31' "${P}ok; expires: 2027-01-31"
  expect jan-32         'BLOCKER' "${P}ok; expires: 2027-01-32"
  # leap years need a wider window, so these set TODAY/CAP themselves
  expectc() { # name want today cap input
    n=$((n+1))
    got=$(printf '%s\n' "$5" | TODAY=$3 CAP=$4 verdict)
    if [ "$got" != "$2" ]; then
      echo "FAIL [$1]: expected '$2', got '$got'" >&2; fails=$((fails+1))
    fi
  }
  expectc leap-2028     'ACCEPTED note-by=alice accepted-by=@bob expires=2028-02-29' 2027-10-08 2028-10-08 "${P}ok; expires: 2028-02-29"
  expectc leap-2028-30  'BLOCKER' 2027-10-08 2028-10-08 "${P}ok; expires: 2028-02-30"
  expectc leap-2000     'ACCEPTED note-by=alice accepted-by=@bob expires=2000-02-29' 1999-10-08 2000-10-08 "${P}ok; expires: 2000-02-29"
  expectc nonleap-2100  'BLOCKER' 2099-10-08 2100-10-08 "${P}ok; expires: 2100-02-29"
  # handle and author shape
  expect handle-empty   'BLOCKER' "alice|Accepted risk: accepted-by: @; reason: ok; expires: 2027-01-01"
  expect handle-badchar 'BLOCKER' "alice|Accepted risk: accepted-by: @b*b; reason: ok; expires: 2027-01-01"
  expect author-empty   'BLOCKER' "|Accepted risk: accepted-by: @bob; reason: ok; expires: 2027-01-01"
  # CAP boundary is inclusive: exactly cap is accepted, cap+1 day is too far out
  got=$(printf '%s\n' "${P}ok; expires: 2027-10-08" | TODAY=2026-10-08 CAP=2027-10-08 verdict)
  n=$((n+1)); [ "$got" = 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-10-08' ] || { echo "FAIL [cap-inclusive]: got '$got'" >&2; fails=$((fails+1)); }
  got=$(printf '%s\n' "${P}ok; expires: 2027-10-09" | TODAY=2026-10-08 CAP=2027-10-08 verdict)
  n=$((n+1)); [ "$got" = 'BLOCKER (expiry too far out; max 1 year)' ] || { echo "FAIL [cap-plus-one]: got '$got'" >&2; fails=$((fails+1)); }
  # Run the script as a process: assert stdout AND exit code (the contract callers rely on).
  self=$0
  cli() { # name want_out want_rc stdin args...
    cn=$1; wo=$2; wr=$3; ci=$4; shift 4
    n=$((n+1))
    co=$(printf '%s\n' "$ci" | TODAY=2026-10-08 CAP=2027-10-08 sh "$self" "$@" 2>/dev/null); cr=$?
    if [ "$co" != "$wo" ] || [ "$cr" -ne "$wr" ]; then
      echo "FAIL [cli-$cn]: expected '$wo' rc=$wr, got '$co' rc=$cr" >&2; fails=$((fails+1))
    fi
  }
  cli accepted 'ACCEPTED note-by=alice accepted-by=@bob expires=2027-01-01' 0 "${P}ok; expires: 2027-01-01"
  cli blocker  'BLOCKER' 1 "${P}ok; expires: 2026-01-01"
  cli empty    'BLOCKER' 1 ""
  cli badarg   '' 2 "" --bogus
  if [ "$fails" -ne 0 ]; then echo "security-deferred-verdict self-test: $fails of $n case(s) FAILED" >&2; return 1; fi
  echo "security-deferred-verdict self-test: all $n cases passed"
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  "") out=$(verdict); echo "$out"; case "$out" in ACCEPTED*) exit 0 ;; *) exit 1 ;; esac ;;
  *) echo "usage: $0 [--self-test]  (candidate lines on stdin)" >&2; exit 2 ;;
esac
