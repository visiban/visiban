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

echo
echo "backup-restore.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
