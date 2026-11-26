#!/usr/bin/env bash
# Tests for scripts/backup.sh and scripts/restore.sh (#2626, #1464).
#
# Runs both scripts in container mode (VISIBAN_BACKUP_MODE=container) against
# stub pg_dump/psql binaries on PATH, so it needs no database and no Docker.
# The end-to-end proof against a real stack is step 9 of
# scripts/prod-compose-drill.sh; this file pins the failure handling that a
# live drill cannot provoke on demand: a failed, empty, truncated or
# non-Visiban dump must exit non-zero and leave nothing behind, retention must
# prune only old complete sets and never after a failure, and restore must
# refuse a damaged set before it touches anything.
#
# Both scripts run under `sh`, the shell their containers use (busybox ash in
# CI's alpine job, the Compose backup service's image too).
#
# Usage: bash scripts/tests/backup-restore.test.sh
# shellcheck disable=SC2015 # ok/bad always return 0, so `A && ok || bad` is a safe if/else
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP="$ROOT/scripts/backup.sh"
RESTORE="$ROOT/scripts/restore.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/backup-restore-2626.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()  { echo "  ok: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*" >&2; FAIL=$((FAIL + 1)); }

STUBS="$WORK/bin"
mkdir -p "$STUBS"
# pg_dump stub: behavior chosen by STUB_DUMP.
cat > "$STUBS/pg_dump" <<'EOF'
#!/bin/sh
case "${STUB_DUMP:-good}" in
  good)
    printf -- '-- PostgreSQL database dump\nCREATE TABLE public.django_migrations (id integer);\nCOPY public.boards (id) FROM stdin;\n1\n\\.\n-- PostgreSQL database dump complete\n\n' ;;
  fail) printf -- '-- PostgreSQL database dump\nCREATE TABLE public.django_migrations (id integer);\n'; echo "pg_dump: error: connection lost" >&2; exit 1 ;;
  empty) : ;;
  big) printf -- '-- PostgreSQL database dump\nCREATE TABLE public.django_migrations (id integer);\n'
       i=0; while [ $i -lt 20000 ]; do printf 'INSERT INTO public.boards VALUES (%s, '"'"'padding padding padding padding padding'"'"');\n' $i; i=$((i + 1)); done
       printf -- '-- PostgreSQL database dump complete\n' ;;
  truncated) printf -- '-- PostgreSQL database dump\nCREATE TABLE public.django_migrations (id integer);\nCOPY public.boards (id) FROM stdin;\n1\n' ;;
  notvisiban) printf -- '-- PostgreSQL database dump\nCREATE TABLE public.other (id integer);\n-- PostgreSQL database dump complete\n' ;;
esac
EOF
# psql stub: records stdin and argv; STUB_PSQL=fail makes it fail.
cat > "$STUBS/psql" <<'EOF'
#!/bin/sh
cat > "$STUB_PSQL_LOG"
printf '%s\n' "$@" > "$STUB_PSQL_LOG.args"
[ "${STUB_PSQL:-ok}" = ok ]
EOF
chmod +x "$STUBS/pg_dump" "$STUBS/psql"

export PATH="$STUBS:$PATH"
export VISIBAN_BACKUP_MODE=container
export MEDIA_DIR="$WORK/media"
export DATABASE_URL="postgres://visiban@db.invalid:5432/visiban"
mkdir -p "$MEDIA_DIR/attachments/2026/11"
printf 'drill attachment\n' > "$MEDIA_DIR/attachments/2026/11/a.txt"

sets() { find "$1" -mindepth 1 -maxdepth 1 -name 'visiban-*' -type d | wc -l | tr -d ' '; }
leftovers() { find "$1" -mindepth 1 -maxdepth 1 -name '.visiban-*' | wc -l | tr -d ' '; }

echo "backup: a good run"
OUT="$WORK/out-good"
if STUB_DUMP=good sh "$BACKUP" --output-dir "$OUT" --retention-days 0 2>"$WORK/log"; then
  ok "exit 0"
else
  bad "a good run exited non-zero: $(cat "$WORK/log")"
fi
SET="$(find "$OUT" -mindepth 1 -maxdepth 1 -name 'visiban-*' -type d | head -1)"
if [ -n "$SET" ] && [ -f "$SET/database.sql.gz" ] && [ -f "$SET/media.tar.gz" ] && [ -f "$SET/MANIFEST" ]; then
  ok "set has database.sql.gz, media.tar.gz and MANIFEST"
else
  bad "set is incomplete: $(ls -la "$OUT" "$SET" 2>&1)"
fi
if (cd "$SET" && { sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS; } >/dev/null 2>&1); then
  ok "SHA256SUMS verifies"
else
  bad "SHA256SUMS does not verify"
fi
perm="$(stat -c '%a' "$SET/database.sql.gz" 2>/dev/null || stat -f '%Lp' "$SET/database.sql.gz")"
[ "$perm" = 600 ] && ok "dump is mode 600" || bad "dump is mode $perm, not 600 (it holds all data)"
dperm="$(stat -c '%a' "$SET" 2>/dev/null || stat -f '%Lp' "$SET")"
[ "$dperm" = 700 ] && ok "set dir is mode 700" || bad "set dir is mode $dperm, not 700"
tar -tzf "$SET/media.tar.gz" | grep -q 'attachments/2026/11/a.txt' && ok "media archive holds the attachment" || bad "media archive lacks the attachment"
if grep -q 'db.invalid' "$WORK/log"; then bad "the log prints the DATABASE_URL"; else ok "DATABASE_URL is not logged"; fi

echo "backup: a dump far larger than a pipe buffer (an early grep match must not SIGPIPE the check)"
OUT="$WORK/out-big"
if STUB_DUMP=big sh "$BACKUP" --output-dir "$OUT" 2>"$WORK/log" && [ "$(sets "$OUT")" = 1 ]; then
  ok "a large good dump is kept"
else
  bad "a large good dump was rejected: $(tail -2 "$WORK/log")"
fi

for kind in fail empty truncated notvisiban; do
  echo "backup: a '$kind' dump is a failure and keeps nothing"
  OUT="$WORK/out-$kind"
  if STUB_DUMP=$kind sh "$BACKUP" --output-dir "$OUT" 2>"$WORK/log"; then
    bad "$kind: exited 0"
  else
    ok "$kind: exited non-zero"
  fi
  [ "$(sets "$OUT")" = 0 ] && ok "$kind: no visiban-* set kept" || bad "$kind: a set was kept: $(ls -a "$OUT")"
  [ "$(leftovers "$OUT")" = 0 ] && ok "$kind: no .partial left" || bad "$kind: a .partial was left: $(ls -a "$OUT")"
done

echo "backup: missing media directory is a failure; BACKUP_SKIP_MEDIA=1 allows it"
OUT="$WORK/out-nomedia"
if STUB_DUMP=good MEDIA_DIR="$WORK/absent" sh "$BACKUP" --output-dir "$OUT" 2>/dev/null; then
  bad "a missing media dir exited 0"
else
  ok "a missing media dir exits non-zero"
fi
[ "$(sets "$OUT")" = 0 ] && ok "and keeps nothing" || bad "a set was kept without media"
if STUB_DUMP=good BACKUP_SKIP_MEDIA=1 MEDIA_DIR="$WORK/absent" sh "$BACKUP" --output-dir "$OUT" 2>/dev/null \
   && [ "$(sets "$OUT")" = 1 ]; then
  ok "BACKUP_SKIP_MEDIA=1 writes a database-only set"
else
  bad "BACKUP_SKIP_MEDIA=1 did not write a set"
fi

echo "backup: retention prunes old complete sets only, and never after a failure"
OUT="$WORK/out-retention"
mkdir -p "$OUT/visiban-20200101T000000Z" "$OUT/unrelated-dir" "$OUT/visiban-notes"
touch -t 202001010000 "$OUT/visiban-20200101T000000Z" "$OUT/unrelated-dir" "$OUT/visiban-notes"
STUB_DUMP=fail sh "$BACKUP" --output-dir "$OUT" --retention-days 7 2>/dev/null
[ -d "$OUT/visiban-20200101T000000Z" ] && ok "a failed run prunes nothing" || bad "a failed run pruned an old set"
STUB_DUMP=good sh "$BACKUP" --output-dir "$OUT" --retention-days 7 2>/dev/null
[ ! -d "$OUT/visiban-20200101T000000Z" ] && ok "a set older than 7 days is pruned" || bad "the old set was not pruned"
[ -d "$OUT/unrelated-dir" ] && [ -d "$OUT/visiban-notes" ] && ok "non-set directories are never pruned" || bad "retention removed a directory that is not a backup set"
[ "$(sets "$OUT")" -ge 2 ] && ok "the new set is kept" || bad "the new set is missing"

echo "backup: a .partial left by a killed run is pruned; a recent one (a run in progress) is not"
OUT="$WORK/out-stale"
mkdir -p "$OUT/.visiban-20200101T000000Z.partial" "$OUT/.visiban-29990101T000000Z.partial"
printf 'all the data\n' > "$OUT/.visiban-20200101T000000Z.partial/database.sql.gz"
touch -t 202001010000 "$OUT/.visiban-20200101T000000Z.partial"
if STUB_DUMP=good sh "$BACKUP" --output-dir "$OUT" --retention-days 0 2>/dev/null; then ok "the run succeeds"; else bad "the run failed"; fi
[ ! -e "$OUT/.visiban-20200101T000000Z.partial" ] && ok "a stale .partial is removed" || bad "a stale .partial survived the next run"
[ -d "$OUT/.visiban-29990101T000000Z.partial" ] && ok "a fresh .partial (another run in progress) is kept" || bad "a fresh .partial was removed"
[ "$(sets "$OUT")" = 1 ] && ok "and the new set is kept" || bad "the new set is missing"

echo "backup: the scheduler stops on SIGTERM at once, not after its sleep"
OUT="$WORK/out-sched"
STUB_DUMP=good sh "$BACKUP" --output-dir "$OUT" --daily-at "$(date -u -v-1M +%H:%M 2>/dev/null || date -u -d '-1 min' +%H:%M)" 2>"$WORK/sched.log" &
sched_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'next run in' "$WORK/sched.log" 2>/dev/null && break; sleep 0.3; done
kill -TERM "$sched_pid" 2>/dev/null
stopped=0
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$sched_pid" 2>/dev/null || { stopped=1; break; }; sleep 0.3; done
if [ "$stopped" = 1 ]; then ok "the scheduler exited within 3s of SIGTERM"; else bad "the scheduler ignored SIGTERM during its sleep"; kill -KILL "$sched_pid" 2>/dev/null; fi
wait "$sched_pid" 2>/dev/null

echo "backup: argument validation"
sh "$BACKUP" --retention-days abc 2>/dev/null && bad "--retention-days abc accepted" || ok "--retention-days abc rejected"
sh "$BACKUP" --daily-at 25:00 2>/dev/null && bad "--daily-at 25:00 accepted" || ok "--daily-at 25:00 rejected"
VISIBAN_BACKUP_MODE=host sh "$BACKUP" --daily-at 03:00 2>/dev/null && bad "--daily-at accepted in host mode" || ok "--daily-at rejected in host mode"

echo "restore: a good set"
export STUB_PSQL_LOG="$WORK/psql.log"
rm -rf "$MEDIA_DIR"; mkdir -p "$MEDIA_DIR"; printf 'stale\n' > "$MEDIA_DIR/stale.txt"
if sh "$RESTORE" --yes "$SET" 2>"$WORK/log"; then ok "exit 0"; else bad "restore exited non-zero: $(cat "$WORK/log")"; fi
head -1 "$STUB_PSQL_LOG" | grep -q '^DROP SCHEMA IF EXISTS public CASCADE;' && ok "restore resets the public schema first" || bad "psql input does not start with the schema reset"
grep -q 'COPY public.boards' "$STUB_PSQL_LOG" && ok "psql receives the plain-SQL dump" || bad "psql did not receive the dump"
grep -qx -- '--single-transaction' "$STUB_PSQL_LOG.args" && grep -qx -- 'ON_ERROR_STOP=1' "$STUB_PSQL_LOG.args" \
  && ok "psql runs in one transaction with ON_ERROR_STOP" || bad "psql args lack --single-transaction/ON_ERROR_STOP: $(cat "$STUB_PSQL_LOG.args")"
[ -f "$MEDIA_DIR/attachments/2026/11/a.txt" ] && ok "media is restored" || bad "the attachment was not restored"
[ ! -e "$MEDIA_DIR/stale.txt" ] && ok "media not in the backup is removed" || bad "stale media survived the restore"

echo "restore: refusals"
rm -f "$STUB_PSQL_LOG"
sh "$RESTORE" "$SET" 2>/dev/null && bad "container mode without --yes ran" || ok "container mode without --yes is refused"
DAMAGED="$WORK/damaged"; cp -R "$SET" "$DAMAGED"; printf 'x' >> "$DAMAGED/media.tar.gz"
sh "$RESTORE" --yes "$DAMAGED" 2>/dev/null && bad "a damaged set was restored" || ok "a damaged set is refused"
[ ! -e "$STUB_PSQL_LOG" ] && ok "psql never ran for a refused set" || bad "psql ran before verification finished"
if STUB_PSQL=fail sh "$RESTORE" --yes "$SET" 2>/dev/null; then bad "a failing psql exited 0"; else ok "a failing psql exits non-zero"; fi

echo "restore: refusals that must happen before anything is touched"
expect_refused() { # expect_refused <label> <set-dir> [env assignments...]
  local label="$1" dir="$2"; shift 2
  rm -f "$STUB_PSQL_LOG"
  if env "$@" sh "$RESTORE" --yes "$dir" 2>/dev/null; then bad "$label: restore ran"; else ok "$label: refused"; fi
  [ ! -e "$STUB_PSQL_LOG" ] && ok "$label: psql never ran" || bad "$label: psql ran before the refusal"
}
UNLISTED="$WORK/unlisted"; cp -R "$SET" "$UNLISTED"
grep -v 'media.tar.gz' "$UNLISTED/SHA256SUMS" > "$UNLISTED/S.tmp"; mv "$UNLISTED/S.tmp" "$UNLISTED/SHA256SUMS"
printf 'x' >> "$UNLISTED/media.tar.gz"
expect_refused "media.tar.gz missing from SHA256SUMS" "$UNLISTED"
build_set_with_media() { # build_set_with_media <dir> <tar args...>; media.tar.gz from the given tree
  local dir="$1"; shift
  cp -R "$SET" "$dir"
  tar "$@" | gzip -c > "$dir/media.tar.gz"
  (cd "$dir" && { sha256sum database.sql.gz media.tar.gz 2>/dev/null || shasum -a 256 database.sql.gz media.tar.gz; } > SHA256SUMS)
}
mkdir -p "$WORK/evil/sub"; ln -s /etc "$WORK/evil/link"
build_set_with_media "$WORK/set-symlink" -cf - -C "$WORK/evil" .
expect_refused "a symlink in the media archive" "$WORK/set-symlink"
mkdir -p "$WORK/dotdot/a"; printf 'x\n' > "$WORK/dotdot/top.txt"
# -P keeps the leading ../ that GNU tar and bsdtar otherwise strip on create.
build_set_with_media "$WORK/set-dotdot" -P -cf - -C "$WORK/dotdot/a" ../top.txt 2>/dev/null \
  || build_set_with_media "$WORK/set-dotdot2" -cf - -C "$WORK/dotdot/a" ../top.txt
DOTDOT_SET="$WORK/set-dotdot"; [ -f "$DOTDOT_SET/media.tar.gz" ] || DOTDOT_SET="$WORK/set-dotdot2"
if gzip -dc "$DOTDOT_SET/media.tar.gz" | tar -tf - | grep -c '\.\./' > /dev/null; then
  expect_refused "a '..' member in the media archive" "$DOTDOT_SET"
else
  echo "  skip: this tar cannot write a '..' member, so the '..' refusal is not exercised here"
fi
expect_refused "a missing media directory (container mode)" "$SET" MEDIA_DIR="$WORK/absent-media"

# A real install has thousands of uploads. Each guard pipes a listing into
# grep; a bad member near the START of a long listing is the case where an
# early-exiting `grep -q` SIGPIPEs its producer and pipefail turns the refusal
# into a pass. Both guards get the large case.
echo "restore: a bad member early in a LARGE media archive is still refused"
mkdir -p "$WORK/bigtree/files"
(cd "$WORK/bigtree/files" && i=0 && while [ "$i" -lt 5000 ]; do : > "an-uploaded-attachment-with-a-realistic-name-$i.png"; i=$((i + 1)); done)
mkdir -p "$WORK/bigtree-link"; ln -s /etc "$WORK/bigtree-link/aaa-link"
# The link first, then 5000 plain files after it: ~300 KB of listing, several
# times a pipe buffer, so an early-exiting grep would leave its producer
# blocked on a full pipe and SIGPIPE it.
build_set_with_media "$WORK/set-big-symlink" -cf - -C "$WORK/bigtree-link" aaa-link -C "$WORK/bigtree" files
gzip -dc "$WORK/set-big-symlink/media.tar.gz" | tar -tvf - | head -1 | grep -c '^l' > /dev/null \
  && ok "fixture: the link is the first of $(gzip -dc "$WORK/set-big-symlink/media.tar.gz" | tar -tf - | wc -l | tr -d ' ') members" \
  || bad "fixture: the large archive does not start with the link"
expect_refused "a symlink first in a 5000-member media archive" "$WORK/set-big-symlink"
if [ -f "$DOTDOT_SET/media.tar.gz" ] && gzip -dc "$DOTDOT_SET/media.tar.gz" | tar -tf - | grep -c '\.\./' > /dev/null; then
  build_set_with_media "$WORK/set-big-dotdot" -P -cf - -C "$WORK/dotdot/a" ../top.txt -C "$WORK/bigtree" files 2>/dev/null
  expect_refused "a '..' member first in a 5000-member media archive" "$WORK/set-big-dotdot"
else
  echo "  skip: this tar cannot write a '..' member, so the large '..' refusal is not exercised here"
fi
# An absolute member path needs no special tar flag to fake: -P keeps it.
build_set_with_media "$WORK/set-big-abs" -P -cf - "$WORK/dotdot/top.txt" -C "$WORK/bigtree" files 2>/dev/null
if gzip -dc "$WORK/set-big-abs/media.tar.gz" | tar -tf - | head -1 | grep -c '^/' > /dev/null; then
  expect_refused "an absolute path first in a 5000-member media archive" "$WORK/set-big-abs"
else
  echo "  skip: this tar strips the leading / on create, so the absolute-path refusal is not exercised here"
fi

echo "restore: an unreadable set dir names the cause"
if [ "$(id -u)" != 0 ]; then
  NOREAD="$WORK/noread"; cp -R "$SET" "$NOREAD"; chmod 000 "$NOREAD"
  sh "$RESTORE" --yes "$NOREAD" 2>"$WORK/log" && bad "an unreadable set ran" || ok "an unreadable set is refused"
  grep -c 'run as root/owner' "$WORK/log" > /dev/null && ok "the error says to run as root/owner" || bad "the error does not name the cause: $(cat "$WORK/log")"
  chmod 700 "$NOREAD"
else
  echo "  skip: running as root, which can read any set dir"
fi

echo
echo "backup-restore.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
