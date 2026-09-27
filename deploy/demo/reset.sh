#!/usr/bin/env bash
# Nightly reset for the hosted demo (#1034): tear the stack down including its
# volumes, bring it back up, and reseed. Run from cron at 00:00 UTC — see
# visiban-demo-reset.cron and README.md.
#
# DESTRUCTIVE: `down -v` deletes the database and uploaded media. Only ever
# run this on the dedicated demo host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Refuse to run anywhere that is not configured as a demo: a mistaken cron
# entry on a real install must not wipe it.
if ! grep -qE '^DEMO_MODE=(true|True|1)$' .env 2>/dev/null; then
  echo "reset.sh: DEMO_MODE is not enabled in $REPO_ROOT/.env; refusing to wipe volumes." >&2
  exit 1
fi

COMPOSE=(docker compose -f docker-compose.prod.yml -f deploy/demo/docker-compose.demo.yml)

echo "[$(date -u +%FT%TZ)] demo reset: tearing down"
"${COMPOSE[@]}" down -v --remove-orphans

echo "[$(date -u +%FT%TZ)] demo reset: starting"
"${COMPOSE[@]}" up -d

# Wait for the backend healthcheck (migrations run first in backend-init).
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T backend python -c \
    'import urllib.request; urllib.request.urlopen("http://localhost:8000/api/health/liveness/")' \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
if [[ "${ready:-0}" != "1" ]]; then
  echo "reset.sh: backend did not become healthy within 5 minutes" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] demo reset: seeding"
# --force: DEBUG is false on this stack; safe because reset.sh just wiped the
# database and refuses to run unless DEMO_MODE is on. Passwords are read from
# the container environment (DEMO_LOGIN_PASSWORD / DEMO_MEMBER_PASSWORD).
"${COMPOSE[@]}" exec -T backend python manage.py seed_demo_data --force --wipe --demo-site

echo "[$(date -u +%FT%TZ)] demo reset: done"
