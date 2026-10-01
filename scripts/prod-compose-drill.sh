#!/usr/bin/env bash
#
# gate-selftest-exempt: this IS a live Docker boot drill — a synthetic
# --self-test would need to boot a second real stack, which defeats the point
# of proving the documented compose path actually starts. Step 4 below
# (NEGATIVE: a placeholder DJANGO_SECRET_KEY must be REJECTED) is the
# known-bad-input assertion docs/development/ci-gates.md asks for, run
# against the real compose file instead of a fixture.
#
# Production docker-compose boot drill (#1152).
#
# Visiban drills the Helm deploy path in CI (scripts/helm-install-drill.sh,
# scripts/helm-netpol-drill.sh) and had NO coverage of the docker-compose
# path — the path docs/getting-started/installation.md § Production
# Deployment and docs/administration/upgrade.md tell a single-server operator
# to run. A compose file can render perfectly under `docker compose config`
# and still crash-loop; this boots the UNMODIFIED docker-compose.prod.yml
# through the UNMODIFIED init-prod.sh — the exact two artifacts the docs
# name — from a .env filled exactly the way installation.md's "Step 1 —
# Clone and configure" block says to fill it (no drill-only accommodation:
# an override is exactly where a drift between "what the drill boots" and
# "what an operator boots" would hide), and proves:
#
#   1. the init step completes: migrate + collectstatic + admin creation all
#      succeed, and the one-time admin password is retrievable with the
#      EXACT command Step 3 of the docs documents;
#   2. the backend container clears every settings.py import-time boot
#      guard (DJANGO_SECRET_KEY, CORS_ALLOWED_ORIGINS, FRONTEND_URL, ...)
#      rather than crash-looping on one;
#   3. GET /api/health/readiness/ reports ready THROUGH nginx — the real
#      ingress path an operator's browser uses, not a container-internal
#      Docker healthcheck;
#   4. NEGATIVE: a boot with the chart's own placeholder DJANGO_SECRET_KEY
#      is REJECTED. A guard that stopped firing looks exactly like one that
#      never fires, so the fail-closed path is asserted, not assumed;
#   5. the stack survives `docker compose restart backend`.
#
# Images are BUILT FROM THE WORKING TREE with the exact production
# Dockerfiles (backend/Dockerfile.prod, frontend/Dockerfile.prod) and
# retagged as the ghcr.io/visiban/visiban/{backend,frontend}:${APP_VERSION}
# references docker-compose.prod.yml resolves — same approach
# scripts/helm-install-drill.sh already uses, and for the same reason: no
# override compose file, no CI-only env var read by the prod file.
#
# TLS is a PARAMETER (TLS_MODE=none, the default, or selfsigned — never
# letsencrypt in CI: that profile needs a real domain and ACME reachability
# on :80, so it is out of scope here and stays a manual smoke test).
#
# Known gap, deliberately deferred rather than folded in silently: #1152's
# own evidence comment also names (a) a `/` in DB_PASSWORD/REDIS_PASSWORD
# breaking the constructed DATABASE_URL/REDIS_URL, and (b) nginx not picking
# up a re-rendered config when init-prod.sh is re-run without a forced
# recreate. Both need a meaningfully separate scenario (a from-scratch
# db/valkey boot for (a); a second init-prod.sh pass for (b)) rather than a
# one-line addition here — tracked in #1229.
#
# Expects a working Docker daemon (dind in CI) with docker compose v2, curl,
# and openssl on PATH.
set -euo pipefail

PROD_COMPOSE_FILE="${PROD_COMPOSE_FILE:-docker-compose.prod.yml}"
# Own compose project, forced — NOT inherited from the environment. The
# compose file itself pins `name: visiban` (docs/getting-started/installation.md
# § Compose project names — dev and prod stacks must never share a project),
# and this drill's teardown runs `down -v`, which destroys the project's
# volumes. Overriding the pin here is what keeps a local run of this script
# from reaching for whatever "visiban" stack is already running on the
# machine; in CI the daemon is a throwaway dind, so this costs nothing there.
export COMPOSE_PROJECT_NAME="visiban-prod-drill"

# Host the drill reaches the published nginx port on. In CI the dind service
# is addressable as `docker`; locally the daemon publishes on the loopback.
PROBE_HOST="${PROBE_HOST:-docker}"
APP_VERSION="${APP_VERSION:-drill}"
BACKEND_IMAGE="ghcr.io/visiban/visiban/backend:${APP_VERSION}"
FRONTEND_IMAGE="ghcr.io/visiban/visiban/frontend:${APP_VERSION}"

# Which TLS posture to drill. `none` is the default so an unparameterized run
# matches the simplest documented path; `selfsigned` boots the OTHER nginx
# template (nginx/app.conf.template) under a real boot. `letsencrypt` is
# deliberately not drillable here — see the header comment.
TLS_MODE="${TLS_MODE:-none}"
case "${TLS_MODE}" in
  none|selfsigned) ;;
  *) echo "TLS_MODE must be 'none' or 'selfsigned' for the drill (got '${TLS_MODE}')" >&2; exit 2 ;;
esac

if [ "${TLS_MODE}" = "none" ]; then
  SCHEME="http"
  CURL=(curl -s)
else
  SCHEME="https"
  # The certificate is self-signed by construction, so verification failing
  # is the expected state, not a finding.
  CURL=(curl -s -k)
fi
BASE_URL="${SCHEME}://${PROBE_HOST}"
# The backend's readiness ceiling. Migrations against an empty database
# dominate this.
READY_TIMEOUT="${READY_TIMEOUT:-300}"
DJANGO_SUPERUSER_EMAIL_DEFAULT="admin@localhost"

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

compose() { docker compose -f "${PROD_COMPOSE_FILE}" "$@"; }

# ---- diagnostics + teardown -------------------------------------------------
dump_diagnostics() {
  echo "======== DIAGNOSTICS (prod compose stack did not reach a healthy state) ========" >&2
  compose ps -a 2>&1 | sed 's/^/  /' >&2 || true
  # backend-init runs migrate/collectstatic/ensure_site_admin and backend waits
  # on it, so its log is where a failed bootstrap shows up.
  for svc in backend-init backend nginx frontend-build db valkey; do
    echo "---- logs: ${svc} ----" >&2
    compose logs --tail=120 "${svc}" 2>&1 | sed 's/^/  /' >&2 || true
  done
}

# `down -v` unconditionally: the volumes are throwaway, and leaving a
# populated pgdata behind would let the NEXT run skip migrations and pass for
# the wrong reason.
teardown() {
  local status=$?
  [ "${status}" -eq 0 ] || dump_diagnostics
  log "tearing down (down -v)"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env nginx/active.conf.template
  # init-prod.sh mints the self-signed lineage into the checkout — a
  # generated artifact containing a private key. Leave neither it nor its
  # dirs behind for a later `git add -A`.
  rm -rf certbot
  return "${status}"
}
trap teardown EXIT

# ---- 0. per-commit images under the names the prod file resolves ----------
log "building ${BACKEND_IMAGE} from backend/Dockerfile.prod"
docker build -q \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}" \
  -t "${BACKEND_IMAGE}" -f backend/Dockerfile.prod backend >/dev/null
log "building ${FRONTEND_IMAGE} from frontend/Dockerfile.prod"
docker build -q \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}" \
  -t "${FRONTEND_IMAGE}" -f frontend/Dockerfile.prod frontend >/dev/null

# ---- 1. fill .env the way installation.md's "Step 1" block says to --------
# Every generated value below is created fresh, not hardcoded: a committed
# dummy secret is a credential-shaped string in the repo that some operator
# eventually copies. Hex for DB_PASSWORD/REDIS_PASSWORD now matches
# installation.md's own "Use hex, not base64" warning (added alongside
# init-prod.sh's matching reject-on-unsafe-chars guard) — `openssl rand
# -base64` puts a `/` in about half its outputs, which breaks the
# postgres://.../redis://... URLs these values are spliced into raw. This
# drill still can't exercise THAT failure mode from this already-running
# happy-path stack (Postgres only applies POSTGRES_PASSWORD on first init,
# so a slash-bearing password needs a from-scratch db/valkey boot); that
# negative case is tracked separately in #1229 rather than folded in here.
log "filling .env from .env.example"
gen_secret() { openssl rand -hex 32; }

cp .env.example .env
chmod 600 .env

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  # Drop both the live line and any commented-out form, then append.
  grep -v -E "^[[:space:]]*#?[[:space:]]*${key}=" .env > "${tmp}" || true
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  cat "${tmp}" > .env
  rm -f "${tmp}"
}

set_env DJANGO_SECRET_KEY "$(gen_secret)"
set_env DEBUG false
# The documented minimum: the domain name alone, no added localhost/127.0.0.1
# alias. Anything less faithful would mask exactly the class of defect this
# drill exists to catch (see #1152 for the healthcheck-Host-header history).
set_env ALLOWED_HOSTS "${PROBE_HOST}"
set_env CORS_ALLOWED_ORIGINS "${BASE_URL}"
set_env FRONTEND_URL "${BASE_URL}"
set_env SITE_DOMAIN "${PROBE_HOST}"
# installation.md's Step 1 block lists this as required ("the backend
# refuses to start while it is the example.com default" on 1.1.x; 1.2+
# downgrades that to a startup warning — see settings.py). Set it anyway so
# this drill's .env matches the documented block exactly rather than relying
# on the 1.2+ warning-only behavior to paper over an unset value.
set_env DEFAULT_FROM_EMAIL "noreply@${PROBE_HOST}"
set_env DB_PASSWORD "$(gen_secret)"
set_env REDIS_PASSWORD "$(gen_secret)"
set_env TLS_MODE "${TLS_MODE}"
set_env DOMAIN "${PROBE_HOST}"
set_env APP_VERSION "${APP_VERSION}"
set_env DJANGO_SUPERUSER_EMAIL "${DJANGO_SUPERUSER_EMAIL_DEFAULT}"

# ---- 2. boot through the documented entrypoint -----------------------------
#
# dind caveat: `docker compose` runs in THIS container but the daemon runs in
# the dind SERVICE container, and a bind mount's SOURCE path is resolved by
# the daemon — on its own filesystem, where our checkout does not exist.
# Docker's response to a missing bind source is to create it, as a
# DIRECTORY. nginx is the only service in this stack with bind mounts (its
# config template and the certbot webroots); everything else uses named
# volumes, which live in the daemon and work fine. So nginx alone comes up
# with a directory where its template should be and crash-loops on
# `envsubst: ... Is a directory`, while every other service reports healthy —
# a CI-mechanics failure that would otherwise be indistinguishable from a
# real one.
#
# The fix is to place the checkout on the daemon's filesystem at the SAME
# absolute path, so the relative sources in the compose file resolve to the
# real files. This runs TWICE on purpose: once before init-prod.sh so the
# daemon has the templates, and once after, because init-prod.sh's own `cp`
# of the selected template lands on THIS container's filesystem. The
# trailing `up -d --force-recreate nginx` then recreates nginx against the
# now-correct source. Doing it this way keeps the drill running the real
# init-prod.sh rather than a re-implementation of it.
daemon_shares_checkout() {
  local marker=".compose-drill-probe.$$" rc=0
  : > "${marker}"
  docker run --rm -v /:/host alpine:3 test -e "/host${PWD}/${marker}" || rc=$?
  rm -f "${marker}"
  return "${rc}"
}

sync_checkout_to_daemon() {
  if daemon_shares_checkout; then
    log "dind daemon already sees this checkout (shared builds volume) — skipping sync"
    return 0
  fi
  local paths=(nginx)
  if [ "${TLS_MODE}" != "none" ] && [ -d certbot ]; then
    paths+=(certbot)
  fi
  local targets
  targets="$(printf "'/host${PWD}/%s' " "${paths[@]}")"
  tar -C "$PWD" -cf - "${paths[@]}" 2>/dev/null \
    | docker run --rm -i -v /:/host alpine:3 \
        sh -c "rm -rf ${targets} && mkdir -p '/host${PWD}' && tar -C '/host${PWD}' -xf -" \
    >/dev/null
}

assert_template_on_daemon() {
  local kind
  kind="$(docker run --rm -v /:/host alpine:3 sh -c \
    "if [ -f '/host${PWD}/nginx/active.conf.template' ]; then echo file; \
     elif [ -d '/host${PWD}/nginx/active.conf.template' ]; then echo directory; \
     else echo missing; fi")"
  [ "${kind}" = "file" ] || fail \
    "nginx/active.conf.template is a ${kind} on the dind daemon, not a file — the \
bind mount would resolve to it and nginx dies on 'envsubst: ... Is a directory'."
}

log "syncing bind-mount sources onto the dind daemon filesystem"
sync_checkout_to_daemon

log "booting the stack via init-prod.sh (TLS_MODE=${TLS_MODE})"
bash init-prod.sh

log "re-syncing the rendered nginx template and recreating nginx"
compose stop nginx >/dev/null 2>&1 || true
sync_checkout_to_daemon
assert_template_on_daemon
# --no-deps is essential: without it compose recreates nginx's dependency
# chain too, which re-runs backend-init in the middle of the drill.
compose up -d --no-deps --force-recreate nginx

# ---- 3. the backend cleared its import-time boot guards --------------------
log "waiting for backend-init (migrate -> collectstatic -> ensure_site_admin)"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  state="$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk '$1=="backend-init"{print $2" "$3}')"
  case "${state}" in
    "exited 0") break ;;
    exited*) fail "backend-init exited non-zero: ${state}" ;;
  esac
  [ "$(date +%s)" -lt "${deadline}" ] || fail "backend-init did not complete within ${READY_TIMEOUT}s"
  sleep 3
done

# A boot-guard failure is an ImproperlyConfigured at settings import, so the
# container exits before serving anything. A crash-looping container can
# read as "starting" for a long time in `compose ps`, so assert on the
# traceback text as well as on liveness.
if compose logs backend 2>&1 | grep -q "ImproperlyConfigured"; then
  compose logs backend 2>&1 | grep -B2 "ImproperlyConfigured" | sed 's/^/  /' >&2
  fail "backend refused to start on a settings.py import-time boot guard"
fi

# The one-time admin password, retrieved with the EXACT command
# docs/getting-started/installation.md § Step 3 documents.
# ensure_site_admin now runs in the long-running `backend` container (see
# docker-compose.prod.yml's own comment on the `backend` service) rather
# than the one-shot backend-init container it originally ran in — a file
# written in backend-init vanished with that container, so the documented
# `exec backend cat ...` found nothing on a fresh install. That defect is
# already fixed upstream; this assertion is a regression guard against it
# reappearing, not a description of a live risk — "admin creation succeeds"
# still isn't enough on its own, since a future refactor could move the
# write back to a container the backend service doesn't share.
log "reading the bootstrapped admin password the documented way"
admin_password="$(compose exec -T backend cat /tmp/visiban_admin_password 2>/dev/null | tr -d '\r\n')"
[ -n "${admin_password}" ] || fail \
  "'docker compose exec backend cat /tmp/visiban_admin_password' returned nothing — \
the documented admin-password retrieval path (docs/getting-started/installation.md § Step 3) is broken. \
See #1152."

# ---- 4. readiness through nginx --------------------------------------------
log "waiting for GET /api/health/readiness/ to report ready at ${BASE_URL}"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE_URL}/api/health/readiness/")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || {
    "${CURL[@]}" "${BASE_URL}/api/health/readiness/" | sed 's/^/  /' >&2 || true
    fail "/api/health/readiness/ did not go ready through nginx within ${READY_TIMEOUT}s"
  }
  sleep 3
done
readyz="$("${CURL[@]}" "${BASE_URL}/api/health/readiness/")"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"${readyz}" || \
  fail "readiness 200 but status is not ok: ${readyz}"
log "readiness reports ok through nginx — the real ingress path, not a container-internal probe"

# ---- 5. NEGATIVE: the placeholder DJANGO_SECRET_KEY guard fails closed -----
# db/valkey are already up and healthy from the run above, so this is a
# single one-off `compose run` against the real image and the real settings
# module — not a fixture standing in for either.
log "NEGATIVE: booting backend-init with the placeholder DJANGO_SECRET_KEY"
set +e
insecure_log="$(compose run --rm -T -e DJANGO_SECRET_KEY=change-me-in-production backend-init 2>&1)"
insecure_rc=$?
set -e
[ "${insecure_rc}" -ne 0 ] || fail \
  "backend-init with the placeholder DJANGO_SECRET_KEY ('change-me-in-production') SUCCEEDED — \
the fail-closed guard in backend/visiban/settings.py is not firing"
grep -q "DJANGO_SECRET_KEY must be set to a secure random value" <<<"${insecure_log}" || fail \
  "the placeholder-key run failed, but not for the SECRET_KEY reason — the guard may be masked by \
an unrelated error. Log: $(head -5 <<<"${insecure_log}")"
log "placeholder DJANGO_SECRET_KEY is rejected, and for the right reason"

# ---- 6. the stack survives a restart of the backend ------------------------
# The failure this catches: a container that only boots because a sibling
# was mid-initialization the first time — an ordering accident rather than a
# dependency. backend-init has exited by now, so this restart runs against
# the steady state an operator's `systemctl restart` (or the documented
# upgrade step 4, `up -d --force-recreate backend`) would.
log "restarting the backend container"
compose restart backend
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE_URL}/api/health/readiness/")" = "200" ]; do
  [ "$(date +%s)" -lt "${deadline}" ] || fail "/api/health/readiness/ did not recover within ${READY_TIMEOUT}s after restarting backend"
  sleep 3
done
if compose logs backend 2>&1 | grep -q "ImproperlyConfigured"; then
  fail "backend refused to start on a boot guard AFTER restart"
fi
log "stack recovered after 'docker compose restart backend'"

log "prod compose drill passed (TLS_MODE=${TLS_MODE})"
