#!/usr/bin/env bash
#
# gate-selftest-exempt: this IS a live Docker upgrade drill — a synthetic
# --self-test would have to boot two real releases, which is the drill. Its
# tag resolver has its own --self-test (scripts/resolve-last-ga-tag.sh), run
# by the CI job before this script.
#
# Compose upgrade drill (#2463): last GA release -> HEAD, with data in it.
#
# compose-prod-drill proves a FRESH HEAD install boots. Nothing proved that an
# existing install survives the upgrade an operator actually runs
# (docs/administration/upgrade.md): a migration that is fine on an empty
# database but breaks on a populated last-release schema shipped unnoticed.
#
#   1. Resolve the latest GA tag (scripts/resolve-last-ga-tag.sh; never
#      hardcoded) and stage THAT tag's docker-compose.prod.yml and .env.example
#      in a scratch project directory, the way an operator's install looks.
#   2. Boot it from the PUBLISHED release image
#      (ghcr.io/visiban/visiban/backend:<tag>, what that compose file pulls).
#   3. Seed it (seed_demo_data --wipe --force) and add a drill user with a
#      known password; snapshot board/card/movement/user counts.
#   4. Upgrade the way the upgrade guide says: replace the compose file with
#      HEAD's, set APP_VERSION to the HEAD image, `docker compose up -d`. The
#      HEAD image is built here from backend/Dockerfile — the Dockerfile the
#      release job publishes from, not Dockerfile.prod — because MR pipelines
#      push no per-commit image and a fix only in Dockerfile.prod never ships.
#   5. Assert: backend-init (migrate) exited 0 on the HEAD image,
#      `migrate --check` reports nothing unapplied, counts are unchanged,
#      readiness is ok and the drill user can still log in.
#
# Scope: db, valkey, backend-init, backend. nginx and the frontend carry no
# data and are booted at HEAD by compose-prod-drill; leaving them out also
# keeps this drill free of the dind bind-mount sync that drill needs.
#
# A HEAD compose file that moves PostgreSQL to a new major fails step 4 on the
# old data directory. That is a real upgrade break (it needs a documented
# dump/restore), not drill noise.
#
# Usage:  bash scripts/compose-upgrade-drill.sh
# Env:    UPGRADE_FROM_TAG  skip resolution and upgrade from this tag
#         KEEP_STACK=1      leave the stack up for inspection
#         READY_TIMEOUT     seconds per wait (default 300)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

export COMPOSE_PROJECT_NAME="visiban-upgrade-drill"
READY_TIMEOUT="${READY_TIMEOUT:-300}"
DRILL_HOST="upgrade-drill.visiban.local"
HEAD_TAG="upgrade-drill-head-$(date +%s)"
IMAGE_REPO="ghcr.io/visiban/visiban/backend"

log()  { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Scratch project directory: holds .env and the compose file, so a local run
# never touches the checkout's own .env.
RUN_DIR="$(mktemp -d)"
compose() { docker compose -f "${RUN_DIR}/docker-compose.prod.yml" --project-directory "${RUN_DIR}" "$@"; }

teardown() {
  local status=$?
  if [ "${status}" -ne 0 ]; then
    echo "======== DIAGNOSTICS ========" >&2
    compose ps -a 2>&1 | sed 's/^/  /' >&2 || true
    for svc in backend-init backend db; do
      echo "---- logs: ${svc} ----" >&2
      compose logs --tail=80 "${svc}" 2>&1 | sed 's/^/  /' >&2 || true
    done
  fi
  if [ "${KEEP_STACK:-0}" = "1" ]; then
    echo "KEEP_STACK=1 — stack left up; project dir ${RUN_DIR}"
    return "${status}"
  fi
  log "tearing down (down -v)"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${RUN_DIR}"
  return "${status}"
}
trap teardown EXIT

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v -E "^[[:space:]]*#?[[:space:]]*${key}=" "${RUN_DIR}/.env" > "${tmp}" || true
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  cat "${tmp}" > "${RUN_DIR}/.env"
  rm -f "${tmp}"
}

# The datastore images in the compose file (postgres, valkey) go through
# DOCKERHUB_MIRROR (#1198) and are re-tagged to the bare name the file uses.
prepull_dockerhub_images() {
  [ -n "${DOCKERHUB_MIRROR:-}" ] || return 0
  local img
  sed -n -E 's/^[[:space:]]*image:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "${RUN_DIR}/docker-compose.prod.yml" \
    | grep -E '^(postgres|valkey/valkey):' | sort -u \
    | while read -r img; do
        docker pull -q "${DOCKERHUB_MIRROR}/${img}" >/dev/null
        docker tag "${DOCKERHUB_MIRROR}/${img}" "${img}"
      done
}

# Runs scripts/upgrade-drill-probe.py inside the backend container.
probe() {
  local mode="$1"
  { printf 'DRILL_HOST = "%s"\nDRILL_PASSWORD = "%s"\n' "${DRILL_HOST}" "${DRILL_PW}"
    cat "${REPO_ROOT}/scripts/upgrade-drill-probe.py"; } \
    | compose exec -T backend python - "${mode}"
}

wait_backend_init() {
  local want_image="$1" deadline state
  deadline=$(( $(date +%s) + READY_TIMEOUT ))
  while :; do
    state="$(compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk '$1=="backend-init"{print $2" "$3}')"
    case "${state}" in
      "exited 0") break ;;
      exited*) fail "backend-init (migrate) exited non-zero on ${want_image}: ${state}" ;;
    esac
    [ "$(date +%s)" -lt "${deadline}" ] || fail "backend-init did not complete within ${READY_TIMEOUT}s on ${want_image}"
    sleep 3
  done
  local ran
  ran="$(docker inspect --format '{{.Config.Image}}' "$(compose ps -a -q backend-init)")"
  [ "${ran}" = "${want_image}" ] || fail "backend-init ran ${ran}, expected ${want_image} — the upgrade did not recreate it"
}

wait_ready() {
  local deadline
  deadline=$(( $(date +%s) + READY_TIMEOUT ))
  until probe health >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "${deadline}" ] || { probe health >&2 || true; fail "readiness not ok within ${READY_TIMEOUT}s ($1)"; }
    sleep 3
  done
}

counts() { probe counts | grep '^COUNTS '; }

# ── 1. resolve and stage the last release ────────────────────────────────────
FROM_TAG="${UPGRADE_FROM_TAG:-$(bash "${REPO_ROOT}/scripts/resolve-last-ga-tag.sh")}"
[ -n "${FROM_TAG}" ] || fail "could not resolve the last GA tag"
FROM_IMAGE="${IMAGE_REPO}:${FROM_TAG}"
TO_IMAGE="${IMAGE_REPO}:${HEAD_TAG}"
log "upgrade path: ${FROM_TAG} (published ${FROM_IMAGE}) -> HEAD $(git rev-parse --short HEAD) (built ${TO_IMAGE})"

git archive "${FROM_TAG}" docker-compose.prod.yml .env.example | tar -x -C "${RUN_DIR}"
cp "${RUN_DIR}/.env.example" "${RUN_DIR}/.env"
chmod 600 "${RUN_DIR}/.env"
gen_secret() { openssl rand -hex 32; }
set_env DJANGO_SECRET_KEY "$(gen_secret)"
set_env DEBUG false
set_env ALLOWED_HOSTS "${DRILL_HOST}"
set_env CORS_ALLOWED_ORIGINS "http://${DRILL_HOST}"
set_env FRONTEND_URL "http://${DRILL_HOST}"
set_env SITE_DOMAIN "${DRILL_HOST}"
set_env DEFAULT_FROM_EMAIL "noreply@${DRILL_HOST}"
set_env DB_PASSWORD "$(gen_secret)"
set_env REDIS_PASSWORD "$(gen_secret)"
set_env TLS_MODE none
set_env DOMAIN "${DRILL_HOST}"
set_env APP_VERSION "${FROM_TAG}"
DRILL_PW="$(gen_secret)"

# Build HEAD first: a broken HEAD image should fail before two boots.
log "building ${TO_IMAGE} from backend/Dockerfile (the release Dockerfile)"
docker build -q --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}" \
  -t "${TO_IMAGE}" -f backend/Dockerfile backend >/dev/null

log "pulling the published release image ${FROM_IMAGE}"
docker pull -q "${FROM_IMAGE}" >/dev/null || fail "could not pull ${FROM_IMAGE} — was ${FROM_TAG} published?"
prepull_dockerhub_images

# ── 2. boot the last release ─────────────────────────────────────────────────
log "booting ${FROM_TAG}"
compose up -d db valkey backend || fail "docker compose up of ${FROM_TAG} failed (see diagnostics)"
wait_backend_init "${FROM_IMAGE}"
wait_ready "${FROM_TAG}"

# ── 3. seed and snapshot ─────────────────────────────────────────────────────
log "seeding demo data on ${FROM_TAG}"
compose exec -T backend python manage.py seed_demo_data --wipe --force >/dev/null
probe create-user >/dev/null
before="$(counts)"
log "before upgrade: ${before}"
case "${before}" in
  *"boards=0 "*|*"cards=0 "*|*"movements=0 "*) fail "seed produced an empty dataset (${before}) — the drill would prove nothing" ;;
esac

# ── 4. upgrade to HEAD ───────────────────────────────────────────────────────
log "upgrading: HEAD docker-compose.prod.yml, APP_VERSION=${HEAD_TAG}, up -d"
cp "${REPO_ROOT}/docker-compose.prod.yml" "${RUN_DIR}/docker-compose.prod.yml"
set_env APP_VERSION "${HEAD_TAG}"
prepull_dockerhub_images
# `up -d` blocks on backend-init (service_completed_successfully), so a failed
# migrate surfaces here first.
compose up -d --remove-orphans db valkey backend \
  || fail "docker compose up on HEAD failed — usually backend-init (migrate) on the ${FROM_TAG} schema; see diagnostics"
wait_backend_init "${TO_IMAGE}"
log "backend-init (migrate) exited 0 on the HEAD image"
compose exec -T backend python manage.py migrate --check >/dev/null \
  || fail "migrate --check reports unapplied migrations after the upgrade"

# ── 5. assert ────────────────────────────────────────────────────────────────
wait_ready "HEAD"
after="$(counts)"
log "after upgrade:  ${after}"
[ "${before}" = "${after}" ] || fail "seeded data changed across the upgrade: before '${before}', after '${after}'"
probe login || fail "the drill user created on ${FROM_TAG} cannot log in after the upgrade"
log "compose upgrade drill passed: ${FROM_TAG} -> HEAD, data intact, readiness ok, login ok"
