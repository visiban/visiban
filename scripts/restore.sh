#!/bin/sh
# shellcheck shell=dash
#
# gate-selftest-exempt: not a gate — the operator restore tool. Its known-bad
# cases are scripts/tests/backup-restore.test.sh; the live round-trip is
# scripts/prod-compose-drill.sh step 9.
#
# Restore a Visiban backup set written by scripts/backup.sh (#2626, #1464).
# Operator guide: docs/administration/backup-and-restore.md.
#
# DESTRUCTIVE: the target database's `public` schema and the target media
# directory are emptied and replaced with the backup's contents. Use it on a
# fresh install (the restore drill's case) or to roll an install back.
#
#   scripts/restore.sh [--yes] [--skip-media] [--compose-file FILE] <backup-set-dir>
#
# The backup set is verified before anything is touched: SHA256SUMS must
# match, and the SQL dump must end with pg_dump's completion trailer.
#
# The database is restored with `psql` (the dump is plain SQL, not a
# pg_restore archive) in ONE transaction that first drops and re-creates the
# `public` schema: an error anywhere rolls the whole restore back and leaves
# the database as it was. Dropping the schema, not the database, needs only
# the database owner's rights, so the same command works on the bundled
# PostgreSQL and on a managed one.
#
# Modes (the same as scripts/backup.sh):
#   host (default)  on the Compose host. Stops every running service but `db`
#                   and `certbot` (the `scheduler` and `backup` profiles too;
#                   stopping `valkey` empties its tmpfs cache), restores the
#                   database and the media volume, then `docker compose up -d`
#                   and restarts whatever else was running. backend-init runs
#                   `migrate`, so a backup from an older release is upgraded on
#                   the way up. Needs Docker Compose 2.20+ (`--profile '*'`).
#   container       VISIBAN_BACKUP_MODE=container: inside a postgres image with
#                   DATABASE_URL (or PG* env) and MEDIA_DIR mounted read-write.
#                   Stops nothing: scale the backend to zero first (see the
#                   Kubernetes section of the guide). Requires --yes.
#
# Options:
#   --yes                 do not ask for confirmation
#   --skip-media          restore the database only
#   --compose-file FILE   host mode only (default: docker-compose.prod.yml in
#                         the checkout this script lives in)
set -eu
# pipefail is what makes a failed pg_dump fail the run instead of producing a
# short archive. busybox ash (the Compose image) and bash have it; an older
# dash (Debian's /bin/sh, the Helm image's) may not, so re-run under bash there.
if ! (set -o pipefail) 2>/dev/null; then
  if [ -z "${VISIBAN_BACKUP_REEXEC:-}" ] && command -v bash >/dev/null 2>&1; then
    VISIBAN_BACKUP_REEXEC=1 exec bash "$0" "$@"
  fi
  echo "restore: this shell has no 'set -o pipefail'; run it with bash or busybox sh" >&2
  exit 1
fi
# shellcheck disable=SC3040 # guarded above
set -o pipefail

umask 077

MODE="${VISIBAN_BACKUP_MODE:-host}"
ASSUME_YES=0
SKIP_MEDIA=0
COMPOSE_FILE_ARG=""
SET_DIR=""

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --skip-media) SKIP_MEDIA=1; shift ;;
    --compose-file) [ $# -ge 2 ] || die "--compose-file needs a value"; COMPOSE_FILE_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$SET_DIR" ] || die "only one backup set may be given"; SET_DIR="$1"; shift ;;
  esac
done

[ -n "$SET_DIR" ] || die "usage: scripts/restore.sh [--yes] [--skip-media] <backup-set-dir>"
[ -d "$SET_DIR" ] || die "backup set not found: $SET_DIR"
SET_DIR="$(cd "$SET_DIR" && pwd)"
case "$MODE" in
  host|container) ;;
  *) die "VISIBAN_BACKUP_MODE must be 'host' or 'container' (got '$MODE')" ;;
esac

DUMP="$SET_DIR/database.sql.gz"
MEDIA="$SET_DIR/media.tar.gz"
[ -f "$DUMP" ] || die "$DUMP is missing — not a scripts/backup.sh set"
[ -f "$SET_DIR/SHA256SUMS" ] || die "$SET_DIR/SHA256SUMS is missing — cannot verify the set"
if [ "$SKIP_MEDIA" = 0 ] && [ ! -f "$MEDIA" ]; then
  die "$MEDIA is missing (a database-only set?) — pass --skip-media to restore the database alone"
fi

# ---- verify before touching anything ---------------------------------------
log "verifying $SET_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$SET_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "SHA256SUMS does not match — the set is damaged"
else
  (cd "$SET_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "SHA256SUMS does not match — the set is damaged"
fi
gzip -dc "$DUMP" | tail -n 5 | grep -q '^-- PostgreSQL database dump complete' \
  || die "the database dump is truncated (no completion trailer)"

# ---- mode-specific consumers: each reads ONE stream on stdin ---------------
if [ "$MODE" = host ]; then
  command -v docker >/dev/null 2>&1 || die "docker is not on PATH"
  if [ -n "$COMPOSE_FILE_ARG" ]; then
    COMPOSE_FILE_PATH="$(cd "$(dirname "$COMPOSE_FILE_ARG")" && pwd)/$(basename "$COMPOSE_FILE_ARG")"
  else
    COMPOSE_FILE_PATH="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.prod.yml"
  fi
  [ -f "$COMPOSE_FILE_PATH" ] || die "compose file not found: $COMPOSE_FILE_PATH"
  cd "$(dirname "$COMPOSE_FILE_PATH")"
  compose() { docker compose -f "$COMPOSE_FILE_PATH" "$@"; }
  TARGET="the Compose stack in $(pwd)"
  run_psql() {
    compose exec -T db psql -U visiban -d visiban -X -q -v ON_ERROR_STOP=1 --single-transaction
  }
  # Runs as the backend image's own user, so restored files are owned the
  # way the backend expects. The command string is fixed; nothing is spliced.
  extract_media() {
    compose run --rm --no-deps -T --entrypoint sh backend -c \
      'find /app/media -mindepth 1 -delete && tar -xzf - -C /app/media'
  }
else
  [ "$ASSUME_YES" = 1 ] || die "container mode is non-interactive: pass --yes"
  MEDIA_DIR="${MEDIA_DIR:-/app/media}"
  if [ -n "${DATABASE_URL_PASSWORD:-}" ] && [ -z "${PGPASSWORD:-}" ]; then
    PGPASSWORD="$DATABASE_URL_PASSWORD"
    export PGPASSWORD
  fi
  TARGET="the database in DATABASE_URL/PG* and $MEDIA_DIR"
  run_psql() {
    if [ -n "${DATABASE_URL:-}" ]; then
      psql -X -q -v ON_ERROR_STOP=1 --single-transaction --dbname="$DATABASE_URL"
    else
      psql -X -q -v ON_ERROR_STOP=1 --single-transaction
    fi
  }
  extract_media() {
    [ -d "$MEDIA_DIR" ] || { log "ERROR: media directory $MEDIA_DIR does not exist"; return 1; }
    find "$MEDIA_DIR" -mindepth 1 -delete && tar -xzf - -C "$MEDIA_DIR"
  }
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf 'This REPLACES all data in %s with %s.\nType "restore" to continue: ' "$TARGET" "$SET_DIR" >&2
  read -r answer || answer=""
  [ "$answer" = restore ] || die "not confirmed; nothing changed"
fi

if [ "$MODE" = host ]; then
  # Stop everything that could write to the database or media while they are
  # replaced: every RUNNING service in any profile (`scheduler` and `backup`
  # included) except `db`, and certbot, which touches neither. Stopping valkey
  # also empties its tmpfs cache, which is keyed to the replaced data.
  # `--profile '*'` needs Docker Compose 2.20 or newer.
  running="$(compose --profile '*' ps --services --status running | grep -vx -e db -e certbot || true)"
  if [ -n "$running" ]; then
    log "stopping: $(echo "$running" | tr '\n' ' ')"
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    compose --profile '*' stop $running
  fi
  compose up -d --wait db
fi

log "restoring the database (one transaction; any error rolls it back)"
{
  printf 'DROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n'
  gzip -dc "$DUMP"
} | run_psql > /dev/null || die "the database restore failed and was rolled back; the database is unchanged"

if [ "$SKIP_MEDIA" = 1 ]; then
  log "--skip-media: media left as it was"
else
  log "restoring media"
  extract_media < "$MEDIA" || die "the media restore failed — the database IS restored; re-run with the same set to retry media"
fi

if [ "$MODE" = host ]; then
  log "starting the stack (backend-init runs migrate first)"
  compose up -d
  if [ -n "$running" ]; then
    # Bring back what was running before, opt-in profiles included (naming a
    # profiled service enables its profile).
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    compose up -d $running
  fi
fi
log "OK: restored $SET_DIR — run the post-restore checks in docs/administration/backup-and-restore.md"
