#!/bin/sh
# shellcheck shell=dash
#
# gate-selftest-exempt: not a gate — the operator backup tool. Its known-bad
# cases are scripts/tests/backup-restore.test.sh; the live round-trip is
# scripts/prod-compose-drill.sh step 9.
#
# Back up a Visiban install: the PostgreSQL database and the uploaded media
# (#2626 Compose, #1464 Helm). Restore with scripts/restore.sh. Operator guide:
# docs/administration/backup-and-restore.md.
#
# One backup set per run, as a directory:
#
#   <output-dir>/visiban-<UTC timestamp>/
#     database.sql.gz   plain-SQL pg_dump (--no-owner --no-privileges), gzip
#     media.tar.gz      tar of MEDIA_ROOT (/app/media), gzip
#     SHA256SUMS        checksums of the two archives
#     MANIFEST          when, which mode, and the database dump's size
#
# Plain SQL on purpose: it restores with `psql` (scripts/restore.sh), needs no
# pg_restore version match, and the same format comes out of every mode below.
#
# Modes — the dump, the checks and the layout are identical in all of them:
#
#   host (default)  run on the Docker Compose host, next to
#                   docker-compose.prod.yml. Talks to the stack with
#                   `docker compose exec`/`run` and streams both archives to
#                   the host, so it needs no bind mount and no healthy Django
#                   app (the backend image is used only for its /app/media
#                   volume mount, with `tar` as the entrypoint).
#   container       VISIBAN_BACKUP_MODE=container: run inside a postgres image
#                   that can reach the database (DATABASE_URL or PG* env) and
#                   has MEDIA_DIR mounted. Used by the Compose `backup`
#                   profile's scheduler and by the Helm backup CronJob.
#
# A run FAILS (non-zero exit, nothing kept) when the dump command fails, the
# dump is empty or lacks pg_dump's completion trailer (truncated), either
# archive fails its gzip/tar integrity test, or the set cannot be moved into
# place. The set is written to a hidden .partial directory and renamed only
# after every check passes, so a directory named visiban-* is always complete.
# Retention runs only after a successful backup, so a failing schedule never
# prunes the last good sets.
#
# Backups hold every board, card and attachment: files are created 0600 and
# directories 0700 (umask 077). No password is ever printed or put on argv.
#
# Usage:
#   scripts/backup.sh [--output-dir DIR] [--retention-days N]
#                     [--compose-file FILE] [--daily-at HH:MM]
#
#   --output-dir DIR      where backup sets go (default: $BACKUP_DIR, else
#                         ./backups in host mode, /backups in container mode)
#   --retention-days N    delete visiban-* sets older than N days after a
#                         successful run; 0 keeps everything (default:
#                         $BACKUP_RETENTION_DAYS, else 14)
#   --compose-file FILE   host mode only (default: docker-compose.prod.yml in
#                         the checkout this script lives in)
#   --daily-at HH:MM      container mode only: stay running and back up every
#                         day at HH:MM UTC (the Compose scheduler). A failed run
#                         is logged, recorded in <output-dir>/.last-failure
#                         (the scheduler's healthcheck reads it) and retried at
#                         the next slot; it never exits the loop.
#
# Environment (container mode):
#   DATABASE_URL          a postgres connection URL (user, optional password and
#                         port, host, database), or the libpq
#                         PGHOST/PGUSER/PGDATABASE/PGPASSWORD variables
#   DATABASE_URL_PASSWORD password when DATABASE_URL carries none (Helm
#                         postgresql.auth.existingSecret); exported as PGPASSWORD
#   MEDIA_DIR             media root to archive (default /app/media)
#   BACKUP_SKIP_MEDIA=1   back up the database only (no media volume to read)
set -eu
# pipefail is what makes a failed pg_dump fail the run instead of producing a
# short archive. busybox ash (the Compose image) and bash have it; an older
# dash (Debian's /bin/sh, the Helm image's) may not, so re-run under bash there.
if ! (set -o pipefail) 2>/dev/null; then
  if [ -z "${VISIBAN_BACKUP_REEXEC:-}" ] && command -v bash >/dev/null 2>&1; then
    VISIBAN_BACKUP_REEXEC=1 exec bash "$0" "$@"
  fi
  echo "backup: this shell has no 'set -o pipefail'; run it with bash or busybox sh" >&2
  exit 1
fi
# shellcheck disable=SC3040 # guarded above
set -o pipefail

umask 077

MODE="${VISIBAN_BACKUP_MODE:-host}"
OUTPUT_DIR="${BACKUP_DIR:-}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE_ARG=""
DAILY_AT=""

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --output-dir) [ $# -ge 2 ] || die "--output-dir needs a value"; OUTPUT_DIR="$2"; shift 2 ;;
    --retention-days) [ $# -ge 2 ] || die "--retention-days needs a value"; RETENTION_DAYS="$2"; shift 2 ;;
    --compose-file) [ $# -ge 2 ] || die "--compose-file needs a value"; COMPOSE_FILE_ARG="$2"; shift 2 ;;
    --daily-at) [ $# -ge 2 ] || die "--daily-at needs a value"; DAILY_AT="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$RETENTION_DAYS" in
  ''|*[!0-9]*) die "--retention-days must be a whole number of days (got '$RETENTION_DAYS')" ;;
esac
case "$MODE" in
  host|container) ;;
  *) die "VISIBAN_BACKUP_MODE must be 'host' or 'container' (got '$MODE')" ;;
esac
if [ -n "$DAILY_AT" ]; then
  [ "$MODE" = container ] || die "--daily-at is for container mode (the Compose scheduler); on a host, use the scheduler profile or cron"
  printf '%s\n' "$DAILY_AT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' \
    || die "--daily-at must be HH:MM in 24-hour UTC (got '$DAILY_AT')"
fi

# ---- mode-specific producers: each writes ONE stream to stdout -------------
if [ "$MODE" = host ]; then
  command -v docker >/dev/null 2>&1 || die "docker is not on PATH (host mode runs next to the Compose stack)"
  [ -n "$OUTPUT_DIR" ] || OUTPUT_DIR="./backups"
  # Resolve before changing directory, so a relative --output-dir is relative
  # to where the operator ran the command.
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
  if [ -n "$COMPOSE_FILE_ARG" ]; then
    COMPOSE_FILE_PATH="$(cd "$(dirname "$COMPOSE_FILE_ARG")" && pwd)/$(basename "$COMPOSE_FILE_ARG")"
  else
    COMPOSE_FILE_PATH="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.prod.yml"
  fi
  [ -f "$COMPOSE_FILE_PATH" ] || die "compose file not found: $COMPOSE_FILE_PATH"
  # Compose reads .env from the compose file's directory (DB_PASSWORD etc.).
  cd "$(dirname "$COMPOSE_FILE_PATH")"
  compose() { docker compose -f "$COMPOSE_FILE_PATH" "$@"; }

  # The db service's own superuser (POSTGRES_USER in docker-compose.prod.yml)
  # over the container's local socket: no password crosses the CLI.
  dump_database() {
    compose exec -T db pg_dump -U visiban -d visiban --no-owner --no-privileges
  }
  archive_media() {
    compose run --rm --no-deps -T --entrypoint tar backend -czf - -C /app/media .
  }
  SKIP_MEDIA=0
else
  [ -n "$OUTPUT_DIR" ] || OUTPUT_DIR="/backups"
  mkdir -p "$OUTPUT_DIR"
  MEDIA_DIR="${MEDIA_DIR:-/app/media}"
  SKIP_MEDIA="${BACKUP_SKIP_MEDIA:-0}"
  if [ -n "${DATABASE_URL_PASSWORD:-}" ] && [ -z "${PGPASSWORD:-}" ]; then
    PGPASSWORD="$DATABASE_URL_PASSWORD"
    export PGPASSWORD
  fi
  # libpq reads the URL from the environment-held variable; it is never echoed.
  dump_database() {
    if [ -n "${DATABASE_URL:-}" ]; then
      pg_dump --no-owner --no-privileges --dbname="$DATABASE_URL"
    else
      pg_dump --no-owner --no-privileges
    fi
  }
  archive_media() {
    [ -d "$MEDIA_DIR" ] || { log "ERROR: media directory $MEDIA_DIR does not exist"; return 1; }
    # tar | gzip, not `tar -z`: bsdtar pads a -z stream to its block size,
    # which `gzip -t` below rejects as trailing garbage.
    tar -cf - -C "$MEDIA_DIR" . | gzip -c
  }
fi

# ---- one backup run --------------------------------------------------------
PARTIAL=""
cleanup_partial() {
  if [ -n "$PARTIAL" ] && [ -d "$PARTIAL" ]; then
    rm -rf "$PARTIAL"
  fi
  PARTIAL=""
}

# Returns non-zero (never exits) so the scheduler loop can record the failure
# and carry on; the one-shot path turns that into the script's exit status.
run_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="visiban-$stamp"
  final="$OUTPUT_DIR/$name"
  [ ! -e "$final" ] || { log "ERROR: $final already exists"; return 1; }
  PARTIAL="$OUTPUT_DIR/.$name.partial"
  rm -rf "$PARTIAL"
  mkdir -p "$PARTIAL" || return 1

  log "dumping the database to $final/database.sql.gz"
  if ! dump_database | gzip -c > "$PARTIAL/database.sql.gz"; then
    log "ERROR: pg_dump failed; nothing kept"
    cleanup_partial; return 1
  fi
  if ! gzip -t "$PARTIAL/database.sql.gz"; then
    log "ERROR: the database archive fails its gzip integrity test; nothing kept"
    cleanup_partial; return 1
  fi
  dump_bytes="$(gzip -dc "$PARTIAL/database.sql.gz" | wc -c | tr -d ' ')"
  if [ "$dump_bytes" -eq 0 ]; then
    log "ERROR: the database dump is empty; nothing kept"
    cleanup_partial; return 1
  fi
  # pg_dump writes this trailer as its very last line. A dump cut short (disk
  # full, connection dropped, process killed) does not end with it.
  if ! gzip -dc "$PARTIAL/database.sql.gz" | tail -n 5 | grep -q '^-- PostgreSQL database dump complete'; then
    log "ERROR: the database dump is truncated (no 'PostgreSQL database dump complete' trailer); nothing kept"
    cleanup_partial; return 1
  fi
  # A dump of a database Visiban never migrated is complete but useless.
  # grep -c reads to the end; -q would exit on the first match and SIGPIPE
  # gzip, which pipefail would report as a missing table on any real dump.
  if ! gzip -dc "$PARTIAL/database.sql.gz" | grep -c 'CREATE TABLE public.django_migrations' > /dev/null; then
    log "ERROR: the dump holds no django_migrations table — this is not a Visiban database; nothing kept"
    cleanup_partial; return 1
  fi

  if [ "$SKIP_MEDIA" = 1 ]; then
    log "BACKUP_SKIP_MEDIA=1: database only, no media archive"
  else
    log "archiving media to $final/media.tar.gz"
    if ! archive_media > "$PARTIAL/media.tar.gz"; then
      log "ERROR: the media archive failed; nothing kept"
      cleanup_partial; return 1
    fi
    if ! gzip -t "$PARTIAL/media.tar.gz" || ! tar -tzf "$PARTIAL/media.tar.gz" > /dev/null; then
      log "ERROR: the media archive fails its integrity test; nothing kept"
      cleanup_partial; return 1
    fi
  fi

  (
    cd "$PARTIAL"
    if [ -f media.tar.gz ]; then sha256sum database.sql.gz media.tar.gz; else sha256sum database.sql.gz; fi > SHA256SUMS
    {
      echo "created_utc=$stamp"
      echo "mode=$MODE"
      echo "database_dump_bytes=$dump_bytes"
      echo "media_included=$([ "$SKIP_MEDIA" = 1 ] && echo no || echo yes)"
      echo "format=plain-sql-gzip+tar-gzip"
    } > MANIFEST
  ) || { log "ERROR: could not write SHA256SUMS/MANIFEST; nothing kept"; cleanup_partial; return 1; }

  if ! mv "$PARTIAL" "$final"; then
    log "ERROR: could not move the finished set into place; nothing kept"
    cleanup_partial; return 1
  fi
  PARTIAL=""
  log "OK: $final ($dump_bytes bytes of SQL)"

  if [ "$RETENTION_DAYS" -gt 0 ]; then
    # Only complete sets match: `visiban-` plus a timestamp, never a .partial.
    find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type d -name 'visiban-[0-9]*T[0-9]*Z' \
      -mtime +"$RETENTION_DAYS" -print | while IFS= read -r old; do
        log "retention: removing $old (older than $RETENTION_DAYS days)"
        rm -rf "$old"
      done
  fi
  return 0
}

trap cleanup_partial EXIT
trap 'cleanup_partial; exit 130' INT TERM

if [ -z "$DAILY_AT" ]; then
  run_backup
  exit $?
fi

# ---- container scheduler: every day at HH:MM UTC ----------------------------
target_h="${DAILY_AT%%:*}"; target_m="${DAILY_AT##*:}"
target_s=$(( ${target_h#0} * 3600 + ${target_m#0} * 60 ))
log "scheduler: daily backup at $DAILY_AT UTC into $OUTPUT_DIR (retention ${RETENTION_DAYS}d)"
while :; do
  now="$(date -u +%s)"
  next=$(( now - now % 86400 + target_s ))
  [ "$next" -gt "$now" ] || next=$(( next + 86400 ))
  log "scheduler: next run in $(( next - now ))s"
  sleep $(( next - now ))
  if run_backup; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$OUTPUT_DIR/.last-success"
    rm -f "$OUTPUT_DIR/.last-failure"
  else
    date -u +%Y-%m-%dT%H:%M:%SZ > "$OUTPUT_DIR/.last-failure"
    log "scheduler: this run FAILED; the container is now unhealthy until a run succeeds"
  fi
done
