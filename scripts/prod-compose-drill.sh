#!/usr/bin/env bash
#
# gate-selftest-exempt: this IS a live Docker boot drill — a synthetic
# --self-test would need to boot a second real stack, which defeats the point
# of proving the documented compose path actually starts. Steps 2 and 6
# below (NEGATIVE: a URL-unsafe DB_PASSWORD/REDIS_PASSWORD, and a placeholder
# DJANGO_SECRET_KEY, must each be REJECTED) are the known-bad-input
# assertions docs/development/ci-gates.md asks for, run against the real
# init-prod.sh and compose file instead of a fixture.
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
#   1. STATIC: init-prod.sh restarts nginx AFTER its final `up -d` (#1229).
#      `up -d` leaves a running nginx on its old config because nginx's own
#      compose config never changes, so without the restart, re-running
#      init-prod.sh to change TLS_MODE or regenerate a cert silently keeps
#      serving the old config. Checked textually, on every run, because a
#      live check cannot see it: step 3 below force-recreates nginx itself
#      (the dind template re-sync), which masks init-prod.sh's own restart.
#      A live StartedAt-advances check was considered and left out: it needs
#      a second full `init-prod.sh` pass (which re-starts backend-init), is
#      only observable where the daemon shares the checkout (not CI's dind),
#      and so would protect nothing in CI that the static check does not;
#   2. NEGATIVE, pre-boot: the REAL init-prod.sh REJECTS a DB_PASSWORD, and
#      separately a REDIS_PASSWORD, containing `/` (#1229). Compose splices
#      these raw into postgres:// and redis:// URLs and cannot percent-encode,
#      and `openssl rand -base64` emits `/` about half the time. Asserts the
#      exit is non-zero, the message names the variable (right reason, not
#      just any failure), and that nothing was started (the guard fires
#      before the boot, not after);
#   3. the init step completes: migrate + collectstatic + admin creation all
#      succeed, and the one-time admin password is retrievable with the
#      EXACT command Step 3 of the docs documents;
#   4. the backend container clears every settings.py import-time boot
#      guard (DJANGO_SECRET_KEY, CORS_ALLOWED_ORIGINS, FRONTEND_URL, ...)
#      rather than crash-looping on one;
#   5. GET /api/health/readiness/ reports ready THROUGH nginx — the real
#      ingress path an operator's browser uses, not a container-internal
#      Docker healthcheck;
#   6. NEGATIVE: a boot with the chart's own placeholder DJANGO_SECRET_KEY
#      is REJECTED. A guard that stopped firing looks exactly like one that
#      never fires, so the fail-closed path is asserted, not assumed;
#   7. the stack survives `docker compose restart backend`;
#   8. the first-run user journey works THROUGH nginx (#1364): site-config,
#      the SPA and a deep-link fallback, login with the bootstrapped admin
#      password, the forced password change and re-login, board create, and a
#      WebSocket upgrade (101) on /ws/boards/<id>/.
#   9. BACKUP AND RESTORE (#2626, #1464; TLS_MODE=none leg only — the
#      restore path does not depend on the nginx template): seed boards, cards,
#      movements and an attachment, back up with scripts/backup.sh, destroy
#      every volume, boot a FRESH install through init-prod.sh, restore with
#      scripts/restore.sh, and assert the counts, every attachment's bytes
#      (read back through Django's storage) and a seeded user's login all came
#      back. Also asserts a truncated dump is refused before it touches data.
#      This is the one restore drill for both issues: the Helm side's backup
#      runs the same scripts/backup.sh, and its chart wiring is asserted by
#      scripts/helm-structure-check.sh section 22.
#
# Images are THIS COMMIT's builds of the exact production Dockerfiles
# (backend/Dockerfile.prod, frontend/Dockerfile.prod), retagged as the
# ghcr.io/visiban/visiban/{backend,frontend}:${APP_VERSION} references
# docker-compose.prod.yml resolves — same approach
# scripts/helm-install-drill.sh uses, and for the same reason: no override
# compose file, no CI-only env var read by the prod file. In CI they are the
# per-commit kaniko images (backend-docker-build-prod /
# frontend-docker-build-prod), pulled by digest and checked against
# CI_COMMIT_SHA by scripts/drill-image.sh, never rebuilt in dind (#2492); run
# locally, or in a CI project with no container registry, they are built from
# the working tree.
#
# TLS is a PARAMETER (TLS_MODE=none, the default, or selfsigned — never
# letsencrypt in CI: that profile needs a real domain and ACME reachability
# on :80, so it is out of scope here and stays a manual smoke test).
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

# ---- 1. STATIC: init-prod.sh restarts nginx after its final `up -d` --------
# Takes the script path as $1 so the check can be exercised against a mutated
# copy. Comment lines are dropped first (init-prod.sh's own comments quote
# `up -d`). The last `up -d` is the one that matters — the letsencrypt branch
# has its own — and it must be followed by a restart/force-recreate of nginx.
# The `|| true`s matter: under pipefail a no-match grep would abort the script
# at the assignment and the named failure messages below would never print.
assert_nginx_restart_after_up() {
  local script="$1" last_up last_restart
  last_up="$(grep -v -E '^[[:space:]]*#' "${script}" | grep -n -E 'compose .*[[:space:]]up[[:space:]]+-d' | tail -1 | cut -d: -f1 || true)"
  last_restart="$(grep -v -E '^[[:space:]]*#' "${script}" \
    | grep -n -E 'compose .*(restart[[:space:]]+nginx|up .*--force-recreate .*nginx)' | tail -1 | cut -d: -f1 || true)"
  [ -n "${last_up}" ] || fail \
    "${script} has no 'docker compose ... up -d' — the drill's static nginx-restart check cannot find the stack start (#1229)"
  [ -n "${last_restart}" ] || fail \
    "${script} no longer restarts nginx — re-running it to change TLS_MODE or regenerate a certificate would silently leave a running nginx on its OLD config, because 'up -d' does not recreate it (#1229)"
  [ "${last_restart}" -gt "${last_up}" ] || fail \
    "${script} restarts nginx BEFORE its final 'up -d' (restart at non-comment line ${last_restart}, up -d at ${last_up}) — the restart no longer follows the start, so a re-run keeps serving the OLD nginx config (#1229)"
}

log "STATIC: init-prod.sh restarts nginx after its final 'up -d'"
assert_nginx_restart_after_up init-prod.sh
log "init-prod.sh restarts nginx after 'up -d' — a re-run picks up a re-rendered config"

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
  rm -f .env nginx/active.conf.template "${JAR:-}" "${BODY:-}"
  rm -rf "${BACKUP_DRILL_DIR:-/nonexistent-2626}" "${container_set_parent:-/nonexistent-2626}"
  # Step 9's Compose backup service writes ./.backup-drill-container as root
  # (on the daemon's filesystem under dind); a failure mid-step leaves that
  # copy of the data behind, so remove it the way step 9 does, through a
  # root container.
  docker run --rm -v /:/host alpine:3 rm -rf "/host${PWD}/.backup-drill-container" >/dev/null 2>&1 || true
  # init-prod.sh mints the self-signed lineage into the checkout — a
  # generated artifact containing a private key. Leave neither it nor its
  # dirs behind for a later `git add -A`.
  rm -rf certbot
  return "${status}"
}
trap teardown EXIT

# ---- 0. per-commit images under the names the prod file resolves ----------
# In CI: the per-commit kaniko build of Dockerfile.prod (DRILL_*_PROD_IMAGE,
# digest-pinned, revision-checked against this commit). Locally: built from the
# working tree. See scripts/drill-image.sh (#2492).
# shellcheck source=scripts/drill-image.sh
. scripts/drill-image.sh
log "${BACKEND_IMAGE} from backend/Dockerfile.prod"
drill_image DRILL_BACKEND_PROD_IMAGE "${BACKEND_IMAGE}" backend/Dockerfile.prod backend \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}"
log "${FRONTEND_IMAGE} from frontend/Dockerfile.prod"
drill_image DRILL_FRONTEND_PROD_IMAGE "${FRONTEND_IMAGE}" frontend/Dockerfile.prod frontend \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}"

# ---- fill .env the way installation.md's "Step 1" block says to --------
# Every generated value below is created fresh, not hardcoded: a committed
# dummy secret is a credential-shaped string in the repo that some operator
# eventually copies. Hex for DB_PASSWORD/REDIS_PASSWORD now matches
# installation.md's own "Use hex, not base64" warning (added alongside
# init-prod.sh's matching reject-on-unsafe-chars guard) — `openssl rand
# -base64` puts a `/` in about half its outputs, which breaks the
# postgres://.../redis://... URLs these values are spliced into raw. The
# reject-on-unsafe-chars guard itself is asserted in step 2, below.
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

# ---- 2. NEGATIVE: URL-unsafe DB_PASSWORD / REDIS_PASSWORD fail closed ------
# Runs the REAL init-prod.sh, but from a scratch directory holding a copy of
# the drill's .env with one password swapped for a slash-bearing one: the
# script reads ./.env, so the drill's own .env (and nginx/active.conf.template)
# is never touched and the happy-path boot below starts from a clean slate. The
# guard sits ahead of every cp/docker call in init-prod.sh, so the scratch dir
# needs nothing else — and an empty scratch dir afterwards is itself evidence
# that the guard fired before any rendering.
assert_unsafe_password_rejected() {
  local var="$1" script="${PWD}/init-prod.sh" scratch rc out
  scratch="$(mktemp -d)"
  grep -v -E "^[[:space:]]*#?[[:space:]]*${var}=" .env > "${scratch}/.env" || true
  # Shaped like `openssl rand -base64 32` output that happens to contain `/`.
  printf '%s=%s\n' "${var}" 'abc/def+ghi=' >> "${scratch}/.env"
  set +e
  out="$(cd "${scratch}" && bash "${script}" 2>&1)"
  rc=$?
  set -e
  if [ -e "${scratch}/nginx" ]; then
    rm -rf "${scratch}"
    fail "init-prod.sh rendered nginx config with an unsafe ${var} — the guard did not fire before the boot (#1229)"
  fi
  rm -rf "${scratch}"
  [ "${rc}" -ne 0 ] || fail \
    "init-prod.sh with a '/' in ${var} SUCCEEDED — the constructed DATABASE_URL/REDIS_URL would be broken and the backend could not start; the unsafe-password guard in init-prod.sh is not firing (#1229)"
  grep -q "${var} contains a character" <<<"${out}" || fail \
    "init-prod.sh with a '/' in ${var} failed, but not at the unsafe-password guard — it may be masked by an unrelated error. Output: $(head -5 <<<"${out}")"
  grep -q "openssl rand -hex 32" <<<"${out}" || fail \
    "the ${var} rejection no longer tells the operator to regenerate with 'openssl rand -hex 32' (#1229). Output: $(head -5 <<<"${out}")"
  # Pre-boot means nothing was started for this project.
  [ -z "$(compose ps -a -q 2>/dev/null)" ] || fail \
    "containers exist after init-prod.sh rejected ${var} — the guard must fire BEFORE anything boots (#1229)"
}

log "NEGATIVE: init-prod.sh with a '/' in DB_PASSWORD / REDIS_PASSWORD"
assert_unsafe_password_rejected DB_PASSWORD
assert_unsafe_password_rejected REDIS_PASSWORD
log "unsafe DB_PASSWORD and REDIS_PASSWORD are rejected pre-boot, and for the right reason"

# ---- 3. boot through the documented entrypoint -----------------------------
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

# ---- 4. the backend cleared its import-time boot guards --------------------
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

# ---- 5. readiness through nginx --------------------------------------------
log "waiting for GET /api/health/readiness/ to report ready at ${BASE_URL}"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
# Wait for status "ok", not just HTTP 200: a still-starting Valkey now yields
# 200 {"status": "degraded"} (#1465) instead of 503.
until "${CURL[@]}" "${BASE_URL}/api/health/readiness/" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; do
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

# ---- 6. NEGATIVE: the placeholder DJANGO_SECRET_KEY guard fails closed -----
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

# ---- 7. the stack survives a restart of the backend ------------------------
# The failure this catches: a container that only boots because a sibling
# was mid-initialization the first time — an ordering accident rather than a
# dependency. backend-init has exited by now, so this restart runs against
# the steady state an operator's `systemctl restart` (or the documented
# upgrade step 4, `up -d --force-recreate backend`) would.
log "restarting the backend container"
compose restart backend
deadline=$(( $(date +%s) + READY_TIMEOUT ))
# Wait for status "ok", not just HTTP 200: a still-starting Valkey now yields
# 200 {"status": "degraded"} (#1465) instead of 503.
until "${CURL[@]}" "${BASE_URL}/api/health/readiness/" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; do
  [ "$(date +%s)" -lt "${deadline}" ] || fail "/api/health/readiness/ did not recover within ${READY_TIMEOUT}s after restarting backend"
  sleep 3
done
if compose logs backend 2>&1 | grep -q "ImproperlyConfigured"; then
  fail "backend refused to start on a boot guard AFTER restart"
fi
log "stack recovered after 'docker compose restart backend'"

# ---- 8. the stack carries real user traffic through nginx (#1364) ----------
# Readiness proves nginx reaches the backend; it does not prove the ingress
# carries an authenticated session, a CSRF-checked write, or a WebSocket
# upgrade. A broken `proxy_set_header Upgrade` block, a CORS/CSRF trusted-origin
# mismatch, or a first-login flow that never completes would all pass steps
# 1-7. This walks the first-run path an operator takes, every request through
# the published nginx port (${BASE_URL}), as a browser would:
#   site-config -> SPA and a deep-link fallback -> login with the bootstrapped
#   admin password -> forced password change -> re-login -> board create ->
#   WebSocket upgrade on /ws/boards/<id>/.
# Session auth + CSRF (the SPA's own mode): every step-8 HTTP request goes
# through http_status, which sends Origin and Referer, because Django's CSRF
# check requires a matching Referer on HTTPS and CSRF_TRUSTED_ORIGINS is
# BASE_URL. (The WebSocket handshake sends Origin only: the Channels origin
# gate reads Origin, and there is no CSRF check on it.)
# Under TLS_MODE=selfsigned (CI's second leg, #2561) every request also goes
# through ${CURL[@]}, which adds -k for the self-signed certificate; PROBE_HOST
# is DOMAIN, so the certificate's name already matches and no --resolve is needed. Passwords go to curl on stdin (--data @-), never argv, so they are
# not readable from the process list.
JAR="$(mktemp)"

http_status() { # http_status <expected> <label> <curl args...>; prints body to $BODY
  local expected="$1" label="$2" code
  shift 2
  rm -f "${BODY:-}"
  BODY="$(mktemp)"
  code="$("${CURL[@]}" -o "${BODY}" -w '%{http_code}' -b "${JAR}" -c "${JAR}" \
    -H "Origin: ${BASE_URL}" -H "Referer: ${BASE_URL}/" "$@")" || code="curl-failed"
  if [ "${code}" != "${expected}" ]; then
    echo "  response body (first 300 bytes):" >&2
    head -c 300 "${BODY}" | sed 's/^/    /' >&2 || true
    echo >&2
    rm -f "${BODY}"
    fail "${label}: expected HTTP ${expected} through nginx, got ${code} (#1364)"
  fi
}
csrf_token() { awk '$6=="csrftoken"{print $7}' "${JAR}" | tail -1; }
json_post() { # json_post <expected> <label> <path> <body on stdin; use a here-string, never a pipe>
  local expected="$1" label="$2" path="$3"
  http_status "${expected}" "${label}" -X POST -H 'Content-Type: application/json' \
    -H "X-CSRFToken: $(csrf_token)" --data @- "${BASE_URL}${path}"
}

log "USER JOURNEY: site-config, SPA, deep link"
http_status 200 "GET /api/v1/auth/site-config/" "${BASE_URL}/api/v1/auth/site-config/"
grep -q '"registration_open"' "${BODY}" || fail "site-config payload lacks registration_open: $(head -c 200 "${BODY}")"
http_status 200 "GET / (SPA)" "${BASE_URL}/"
grep -q '<div id="root"' "${BODY}" || fail "GET / did not serve the SPA index.html"
http_status 200 "GET /boards/1 (deep link)" "${BASE_URL}/boards/1"
grep -q '<div id="root"' "${BODY}" || fail "a deep link did not fall back to index.html — nginx try_files is broken"

log "USER JOURNEY: login with the bootstrapped admin password"
# json_post reads its body from a here-string, not a pipe: a pipe would run it in
# a subshell and lose $BODY (and delete the parent's previous body file).
json_post 200 "POST /api/v1/auth/login/ (bootstrapped admin)" /api/v1/auth/login/ \
  <<<"$(printf '{"username":"admin","password":"%s"}' "${admin_password}")"
http_status 200 "GET /api/v1/auth/user/" "${BASE_URL}/api/v1/auth/user/"
grep -Eq '"must_change_password"[[:space:]]*:[[:space:]]*true' "${BODY}" || fail \
  "the bootstrapped admin is not flagged must_change_password — the forced first-login change would never be offered: $(head -c 300 "${BODY}")"

log "USER JOURNEY: forced password change, then re-login with the new password"
# Prefix keeps the hex from ever being all digits (NumericPasswordValidator).
new_password="Drill-$(gen_secret)"
json_post 200 "POST /api/v1/auth/change-password/" /api/v1/auth/change-password/ \
  <<<"$(printf '{"current_password":"%s","new_password":"%s"}' "${admin_password}" "${new_password}")"
http_status 200 "POST /api/v1/auth/logout/" -X POST -H "X-CSRFToken: $(csrf_token)" "${BASE_URL}/api/v1/auth/logout/"
: > "${JAR}"
json_post 200 "re-login with the new password" /api/v1/auth/login/ \
  <<<"$(printf '{"username":"admin","password":"%s"}' "${new_password}")"
http_status 200 "GET /api/v1/auth/user/ after change" "${BASE_URL}/api/v1/auth/user/"
if grep -Eq '"must_change_password"[[:space:]]*:[[:space:]]*true' "${BODY}"; then
  fail "must_change_password is still true after a successful change"
fi

log "USER JOURNEY: board create"
json_post 201 "POST /api/v1/boards/" /api/v1/boards/ <<<'{"name":"Compose drill board"}'
board_id="$(grep -o '"id"[[:space:]]*:[[:space:]]*[0-9]*' "${BODY}" | head -1 | grep -o '[0-9]*$' || true)"
[ -n "${board_id}" ] || fail "board create returned no id: $(head -c 300 "${BODY}")"

log "USER JOURNEY: WebSocket upgrade through nginx on /ws/boards/${board_id}/"
# A real handshake with the session cookie and a valid Origin. 101 proves nginx
# forwards Upgrade and the origin gate passes. It does NOT prove the session
# authenticated: BoardConsumer accepts and then closes 4001/4003 for an
# unauthorized user, so that refusal comes after the 101. curl then waits on
# the open socket, so cap it with -m and read the status line from the dumped
# headers (exit 28 on the cap is expected).
ws_headers="$(mktemp)"
"${CURL[@]}" --http1.1 -m 5 -o /dev/null -D "${ws_headers}" -b "${JAR}" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H "Origin: ${BASE_URL}" \
  "${BASE_URL}/ws/boards/${board_id}/" || true
ws_status="$(head -1 "${ws_headers}" | tr -d '\r' | awk '{print $2}')"
if [ "${ws_status}" != "101" ]; then
  echo "  handshake response headers:" >&2
  sed 's/^/    /' "${ws_headers}" >&2 || true
  rm -f "${ws_headers}"
  fail "WebSocket upgrade on /ws/boards/${board_id}/ returned '${ws_status:-no response}', not 101 — nginx is not forwarding Upgrade, or the origin gate refused the handshake (#1364)"
fi
rm -f "${ws_headers}" "${BODY:-}"
log "the first-run user journey works through nginx: login, forced change, board create, WebSocket 101"

# ---- 9. backup, wipe, fresh install, restore (#2626, #1464) ---------------
# The documented operator path end to end: scripts/backup.sh in host mode (it
# streams both archives out of the containers, so it needs no bind mount and
# works against CI's dind daemon), then scripts/restore.sh into a brand-new
# install. COMPOSE_PROJECT_NAME (exported above) is inherited by both scripts,
# so they act on this drill's stack and nothing else.
wait_ready_through_nginx() { # wait_ready_through_nginx <label>
  local deadline
  deadline=$(( $(date +%s) + READY_TIMEOUT ))
  until "${CURL[@]}" "${BASE_URL}/api/health/readiness/" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; do
    [ "$(date +%s)" -lt "${deadline}" ] || fail "/api/health/readiness/ not ok within ${READY_TIMEOUT}s ($1)"
    sleep 3
  done
}

if [ "${TLS_MODE}" = "none" ]; then
  # Same probe the upgrade drills pipe into the backend; the password is
  # prepended on stdin, never argv or env.
  probe() {
    { printf 'DRILL_HOST = "%s"\nDRILL_PASSWORD = "%s"\n' "${PROBE_HOST}" "${new_password}"
      cat scripts/upgrade-drill-probe.py; } \
      | compose exec -T backend python - "$1"
  }

  log "BACKUP: seeding boards, cards, movements, a user and an attachment"
  compose exec -T backend python manage.py seed_demo_data --wipe --force >/dev/null
  probe create-user >/dev/null
  probe seed-attachment >/dev/null
  before_counts="$(probe counts | grep '^COUNTS ')"
  before_files="$(probe attachments | grep '^ATTACHMENTS ')"
  case "${before_counts} ${before_files}" in
    *"boards=0 "*|*"cards=0 "*|*"movements=0 "*|*"count=0 "*)
      fail "the seed produced an empty dataset (${before_counts}; ${before_files}) — the restore drill would prove nothing" ;;
  esac
  log "seeded: ${before_counts}; ${before_files}"

  BACKUP_DRILL_DIR="$(mktemp -d)"
  log "BACKUP: scripts/backup.sh (host mode)"
  bash scripts/backup.sh --compose-file "${PROD_COMPOSE_FILE}" --output-dir "${BACKUP_DRILL_DIR}" --retention-days 0
  backup_set="$(find "${BACKUP_DRILL_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'visiban-*' | head -1)"
  [ -n "${backup_set}" ] || fail "scripts/backup.sh exited 0 but wrote no visiban-* set in ${BACKUP_DRILL_DIR}"
  for f in database.sql.gz media.tar.gz SHA256SUMS MANIFEST; do
    [ -s "${backup_set}/${f}" ] || fail "the backup set lacks ${f}"
  done
  # grep -c, not -q: -q exits on the first match and SIGPIPEs tar under pipefail.
  tar -tzf "${backup_set}/media.tar.gz" | grep -c 'backup-drill' > /dev/null \
    || fail "media.tar.gz does not contain the seeded attachment"

  # The Compose `backup` service is the scheduled path, and container mode is
  # what the Helm CronJob runs: prove it against this real PostgreSQL too, as
  # a one-shot (arguments replace the service's --daily-at command). It
  # bind-mounts ./scripts/backup.sh and BACKUP_DIR, whose source paths resolve
  # on the daemon (see the dind caveat above): put the script there, and read
  # the set back through a helper container, the way sync_checkout_to_daemon
  # writes nginx/.
  log "BACKUP: the Compose backup service once (container mode, the scheduler's and the Helm CronJob's path)"
  container_backup_dir="${PWD}/.backup-drill-container"
  if ! daemon_shares_checkout; then
    tar -C "$PWD" -cf - scripts/backup.sh \
      | docker run --rm -i -v /:/host alpine:3 sh -c "mkdir -p '/host${PWD}' && tar -C '/host${PWD}' -xf -" \
      >/dev/null
  fi
  BACKUP_DIR="${container_backup_dir}" compose --profile backup run --rm --no-deps -T backup --retention-days 0
  container_set_parent="$(mktemp -d)"
  docker run --rm -v /:/host:ro alpine:3 tar -C "/host${container_backup_dir}" -cf - . \
    | tar -C "${container_set_parent}" -xf -
  docker run --rm -v /:/host alpine:3 rm -rf "/host${container_backup_dir}"
  container_set="$(find "${container_set_parent}" -mindepth 1 -maxdepth 1 -type d -name 'visiban-*' | head -1)"
  [ -n "${container_set}" ] || fail "the Compose backup service exited 0 but wrote no visiban-* set"
  for f in database.sql.gz media.tar.gz SHA256SUMS MANIFEST; do
    [ -s "${container_set}/${f}" ] || fail "the Compose backup service's set lacks ${f}"
  done
  grep -qx 'mode=container' "${container_set}/MANIFEST" \
    || fail "the Compose backup service's set is not a container-mode set: $(cat "${container_set}/MANIFEST")"
  tar -tzf "${container_set}/media.tar.gz" | grep -c 'backup-drill' > /dev/null \
    || fail "the Compose backup service's media.tar.gz does not contain the seeded attachment"

  log "NEGATIVE: scripts/restore.sh refuses a truncated dump before touching anything"
  truncated_set="${BACKUP_DRILL_DIR}/truncated"
  mkdir -p "${truncated_set}"
  # `|| true`: head closing the pipe early SIGPIPEs gzip, which pipefail reports.
  { gzip -dc "${backup_set}/database.sql.gz" || true; } | head -n 50 | gzip -c > "${truncated_set}/database.sql.gz"
  cp "${backup_set}/media.tar.gz" "${truncated_set}/"
  (cd "${truncated_set}" && sha256sum database.sql.gz media.tar.gz > SHA256SUMS)
  if bash scripts/restore.sh --compose-file "${PROD_COMPOSE_FILE}" --yes "${truncated_set}" > /dev/null 2>&1; then
    fail "scripts/restore.sh accepted a truncated dump"
  fi
  [ "$(probe counts | grep '^COUNTS ')" = "${before_counts}" ] \
    || fail "a refused restore changed the database"

  log "RESTORE: destroying every volume and booting a FRESH install"
  compose down -v --remove-orphans >/dev/null
  sync_checkout_to_daemon
  bash init-prod.sh
  compose stop nginx >/dev/null 2>&1 || true
  sync_checkout_to_daemon
  assert_template_on_daemon
  compose up -d --no-deps --force-recreate nginx
  wait_ready_through_nginx "fresh install before restore"
  fresh_counts="$(probe counts | grep '^COUNTS ')"
  [ "${fresh_counts}" != "${before_counts}" ] \
    || fail "the 'fresh' install already holds the seeded data (${fresh_counts}) — the volumes were not destroyed, so a restore would prove nothing"

  assert_restored() { # assert_restored <label>
    wait_ready_through_nginx "after restore ($1)"
    after_counts="$(probe counts | grep '^COUNTS ')"
    after_files="$(probe attachments | grep '^ATTACHMENTS ' || true)"
    [ "${after_counts}" = "${before_counts}" ] \
      || fail "$1: boards/cards/movements/users did not survive backup and restore: before '${before_counts}', after '${after_counts}'"
    [ "${after_files}" = "${before_files}" ] \
      || fail "$1: attachments did not survive backup and restore (rows or file bytes): before '${before_files}', after '${after_files:-probe failed — a row whose file is missing}'"
    probe login >/dev/null || fail "$1: the user seeded before the backup cannot log in after the restore"
    log "backup and restore round-trip ($1): ${after_counts}; ${after_files}; seeded user logs in"
  }

  # The container-mode set first, into the empty install, so the counts it
  # must reproduce cannot already be there; then the host-mode set over it.
  # restore.sh drops the schema in the same transaction, so the second restore
  # proves its own set too.
  log "RESTORE: scripts/restore.sh with the Compose backup service's set into the fresh install"
  bash scripts/restore.sh --compose-file "${PROD_COMPOSE_FILE}" --yes "${container_set}"
  assert_restored "container-mode set"
  log "RESTORE: scripts/restore.sh with the host-mode set"
  bash scripts/restore.sh --compose-file "${PROD_COMPOSE_FILE}" --yes "${backup_set}"
  assert_restored "host-mode set"
fi

log "prod compose drill passed (TLS_MODE=${TLS_MODE})"
