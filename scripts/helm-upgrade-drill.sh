#!/usr/bin/env bash
#
# gate-selftest-exempt: this IS a live kind-cluster upgrade drill — a synthetic
# --self-test would have to install two real releases, which is the drill. Its
# tag resolver has its own --self-test (scripts/resolve-last-ga-tag.sh), run
# by the CI job before this script.
#
# Helm upgrade drill (#2463): last GA chart + images -> HEAD chart + images.
#
# helm-install proves a FRESH install of the HEAD chart boots. Nothing proved
# that `helm upgrade` of an existing, populated release works: a values or
# template change that breaks upgrade (an immutable selector, a renamed Secret
# key, a StatefulSet volumeClaimTemplate edit) or a migration that breaks on a
# populated last-release schema shipped unnoticed.
#
#   1. Resolve the latest GA tag (scripts/resolve-last-ga-tag.sh; never
#      hardcoded). Its chart version comes from that tag's Chart.yaml.
#   2. `helm install` the PUBLISHED chart (oci://ghcr.io/visiban/charts/visiban
#      at that version; the tag's own helm/visiban source if the OCI pull
#      fails) with the PUBLISHED images ghcr.io/visiban/visiban/*:<tag>.
#   3. Seed (seed_demo_data --wipe --force), add a drill user with a known
#      password, snapshot board/card/movement/user counts.
#   4. `helm upgrade` to the HEAD chart with the HEAD images from
#      backend/Dockerfile and frontend/Dockerfile (the release Dockerfiles,
#      not Dockerfile.prod), using the SAME values file, the way an operator
#      upgrades. In CI those are THIS commit's per-commit kaniko images
#      (backend-docker-build / frontend-docker-build), pulled by digest and
#      revision-checked by scripts/drill-image.sh, never rebuilt in dind
#      (#2492); run locally, they are built from the working tree.
#   5. Assert: the new backend pod's `migrate` init container exited 0 on the
#      HEAD image, `migrate --check` is clean, counts unchanged, readiness ok,
#      the drill user can still log in.
#
# PostgreSQL persistence stays ON (unlike helm-install): the database pod may
# be recreated by the upgrade, and the data must survive that.
#
# Requires: docker, kind, kubectl, helm.
# Usage:   bash scripts/helm-upgrade-drill.sh
# Env:     UPGRADE_FROM_TAG  skip resolution and upgrade from this tag
#          KIND_CLUSTER      cluster name (default visiban-upgrade)
#          KEEP_CLUSTER=1    skip teardown
#          EXTRA_HELM_ARGS   appended to install and upgrade (local escape hatch,
#                            same as helm-install-drill.sh; CI does not set it)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
HEAD_CHART="$REPO_ROOT/helm/visiban"
CLUSTER="${KIND_CLUSTER:-visiban-upgrade}"
RELEASE="drill"
NAMESPACE="visiban-upgrade-drill"
TAG="upgrade-drill-$(date +%s)"
HEAD_BACKEND="visiban-drill/backend:${TAG}"
HEAD_FRONTEND="visiban-drill/frontend:${TAG}"
DRILL_HOST="drill.visiban.local"

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
die()  { echo "  ✗ FAIL: $*" >&2; dump_diagnostics; exit 1; }

dump_diagnostics() {
  echo "─── diagnostics ──────────────────────────────────────────" >&2
  kubectl -n "$NAMESPACE" get pods,jobs,pvc -o wide 2>&1 | sed 's/^/  /' >&2 || true
  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp 2>&1 | tail -30 | sed 's/^/  /' >&2 || true
  for pod in $(kubectl -n "$NAMESPACE" get pods -o name 2>/dev/null); do
    echo "  ── logs: $pod" >&2
    kubectl -n "$NAMESPACE" logs "$pod" --all-containers --tail=40 2>&1 | sed 's/^/    /' >&2 || true
  done
}

# Per-run scratch dir (#1646): never a hardcoded system temp path.
RUN_TMP="$(mktemp -d)"
export TMPDIR="$RUN_TMP"

teardown() {
  rm -rf "$RUN_TMP"
  if [ "${KEEP_CLUSTER:-0}" = "1" ]; then
    echo "KEEP_CLUSTER=1 — leaving cluster '$CLUSTER' up. Remove with: kind delete cluster --name $CLUSTER"
    return
  fi
  echo; echo "▶ Tearing down"
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}
trap teardown EXIT

# kind-in-dind kubeconfig fixup — same as helm-install-drill.sh (see the full
# rationale there): the API server is in the dind service container, not on
# this container's loopback.
retarget_kubeconfig() {
  local cluster="$1" host="${APISERVER_HOST:-}" port
  [ -z "$host" ] && return 0
  [ "$host" = "127.0.0.1" ] && return 0
  port="$(kubectl config view -o jsonpath="{.clusters[?(@.name=='kind-${cluster}')].cluster.server}" | sed 's|.*:||')"
  [ -n "$port" ] || return 0
  kubectl config set-cluster "kind-${cluster}" --server="https://${host}:${port}" --insecure-skip-tls-verify=true >/dev/null
  kubectl config unset "clusters.kind-${cluster}.certificate-authority-data" >/dev/null
}

# Reads `<block>.image` (postgresql: a string) or `<block>.image.{repository,tag}`
# (valkey) from a values.yaml, so the pre-pull follows each chart's own pins.
values_image() {
  local file="$1" block="$2" body repo tag
  body="$(sed -n "/^${block}:/,/^[a-zA-Z]/p" "$file")"
  repo="$(printf '%s\n' "$body" | sed -n -E 's/^  image:[[:space:]]*"?([^"[:space:]]+)"?[[:space:]]*$/\1/p' | head -1)"
  if [ -n "$repo" ]; then printf '%s\n' "$repo"; return; fi
  repo="$(printf '%s\n' "$body" | grep -m1 '^[[:space:]]*repository:' | sed -E 's/^[[:space:]]*repository:[[:space:]]*"?([^"[:space:]]*)"?.*/\1/')"
  tag="$(printf '%s\n' "$body" | grep -m1 '^[[:space:]]*tag:' | sed -E 's/^[[:space:]]*tag:[[:space:]]*"?([^"[:space:]]*)"?.*/\1/')"
  [ -n "$repo" ] && [ -n "$tag" ] || die "could not read ${block} image from $file"
  printf '%s:%s\n' "$repo" "$tag"
}

# The operator's values file: identical for install and upgrade. Only keys
# present in both the released and the HEAD chart schema belong here.
cat > "$RUN_TMP/values-drill.yaml" <<VALUES
secret:
  djangoSecretKey: "upgrade-drill-secret-key-$(openssl rand -hex 16)"
backend:
  settings:
    allowedHosts: ${DRILL_HOST}
    corsAllowedOrigins: http://${DRILL_HOST}
    frontendUrl: http://${DRILL_HOST}
    siteDomain: ${DRILL_HOST}
    forceInsecureCookies: true
  email:
    backend: console
  mediaPersistence:
    enabled: false
postgresql:
  auth:
    password: "upgrade-drill-db-$(openssl rand -hex 8)"
ingress:
  enabled: false
VALUES
DRILL_PW="$(openssl rand -hex 24)"

helm_args() {
  # shellcheck disable=SC2086
  [ -n "${EXTRA_HELM_ARGS:-}" ] && printf '%s\n' ${EXTRA_HELM_ARGS}
  printf '%s\n' --namespace "$NAMESPACE" -f "$RUN_TMP/values-drill.yaml"
}

backend_pod_on() {
  # The Ready backend pod running image $1 — never `exec deploy/...`, which can
  # land on a pod the rollout is still terminating.
  kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=backend \
    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{" "}{.spec.containers[?(@.name=="backend")].image}{"\n"}{end}' \
    | awk -v img="$1" '$2==img{print $1; exit}'
}

probe() {
  local pod="$1" mode="$2"
  { printf 'DRILL_HOST = "%s"\nDRILL_PASSWORD = "%s"\n' "$DRILL_HOST" "$DRILL_PW"
    cat "$REPO_ROOT/scripts/upgrade-drill-probe.py"; } \
    | kubectl -n "$NAMESPACE" exec -i "$pod" -c backend -- python - "$mode"
}

for bin in docker kind kubectl helm git openssl; do
  command -v "$bin" >/dev/null || { echo "ERROR: $bin not on PATH" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
step "1. Resolve the last GA release"
# ---------------------------------------------------------------------------
FROM_TAG="${UPGRADE_FROM_TAG:-$(bash "$REPO_ROOT/scripts/resolve-last-ga-tag.sh")}"
[ -n "$FROM_TAG" ] || die "could not resolve the last GA tag"
FROM_CHART_VERSION="$(git show "${FROM_TAG}:helm/visiban/Chart.yaml" | awk '/^version:/{print $2}' | tr -d '"')"
FROM_BACKEND="ghcr.io/visiban/visiban/backend:${FROM_TAG}"
FROM_FRONTEND="ghcr.io/visiban/visiban/frontend:${FROM_TAG}"
FROM_CHART="$RUN_TMP/from-chart/visiban"
mkdir -p "$RUN_TMP/from-chart"
if helm pull oci://ghcr.io/visiban/charts/visiban --version "$FROM_CHART_VERSION" --untar -d "$RUN_TMP/from-chart" >/dev/null 2>&1; then
  ok "chart: published oci://ghcr.io/visiban/charts/visiban:${FROM_CHART_VERSION}"
else
  # In CI the published chart is the thing under test: operators upgrade from
  # it, so a missing or unpullable chart is a real failure, not a fallback.
  [ "${CI:-}" != "true" ] || die "OCI pull of oci://ghcr.io/visiban/charts/visiban:${FROM_CHART_VERSION} failed; was the ${FROM_TAG} chart published?"
  echo "  ! OCI pull of chart ${FROM_CHART_VERSION} failed; using helm/visiban at ${FROM_TAG} (the source it was packaged from; local runs only)"
  git archive "$FROM_TAG" helm/visiban | tar -x -C "$RUN_TMP/from-chart" --strip-components=1
fi
[ -f "$FROM_CHART/Chart.yaml" ] || die "no chart staged at $FROM_CHART"
ok "upgrade path: ${FROM_TAG} (chart ${FROM_CHART_VERSION}) -> HEAD $(git rev-parse --short HEAD)"

# ---------------------------------------------------------------------------
step "2. Images: HEAD from this commit, pull the release"
# ---------------------------------------------------------------------------
# CI: the per-commit kaniko images (DRILL_BACKEND_IMAGE / DRILL_FRONTEND_IMAGE
# from backend-docker-build / frontend-docker-build), pulled by digest and
# checked against CI_COMMIT_SHA; locally: built from the working tree. See
# scripts/drill-image.sh (#2492).
# shellcheck source=scripts/drill-image.sh
. "$REPO_ROOT/scripts/drill-image.sh"
drill_image DRILL_BACKEND_IMAGE "$HEAD_BACKEND" "$REPO_ROOT/backend/Dockerfile" "$REPO_ROOT/backend" \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}" \
  || die "HEAD backend image unavailable"
drill_image DRILL_FRONTEND_IMAGE "$HEAD_FRONTEND" "$REPO_ROOT/frontend/Dockerfile" "$REPO_ROOT/frontend" \
  --build-arg "BASE_REGISTRY=${DOCKERHUB_MIRROR:-docker.io/library}" \
  || die "HEAD frontend image unavailable"
ok "HEAD images ready (release Dockerfiles)"
docker pull -q "$FROM_BACKEND" >/dev/null  || die "could not pull $FROM_BACKEND — was ${FROM_TAG} published?"
docker pull -q "$FROM_FRONTEND" >/dev/null || die "could not pull $FROM_FRONTEND"
ok "release images pulled"

LOAD_IMAGES=("$HEAD_BACKEND" "$HEAD_FRONTEND" "$FROM_BACKEND" "$FROM_FRONTEND")
KIND_IMAGE_ARGS=()
if [ -n "${DOCKERHUB_MIRROR:-}" ]; then
  # Same pre-pull as helm-install-drill.sh (#1198), for BOTH charts' datastore
  # pins: an upgrade that moves the postgres or valkey tag must not live-pull.
  KINDEST_NODE_TAG="${KINDEST_NODE_TAG:-v1.31.2}"
  docker pull -q "${DOCKERHUB_MIRROR}/kindest/node:${KINDEST_NODE_TAG}" >/dev/null
  docker tag "${DOCKERHUB_MIRROR}/kindest/node:${KINDEST_NODE_TAG}" "kindest/node:${KINDEST_NODE_TAG}"
  KIND_IMAGE_ARGS=(--image "kindest/node:${KINDEST_NODE_TAG}")
  for img in $( { values_image "$FROM_CHART/values.yaml" postgresql; values_image "$FROM_CHART/values.yaml" valkey
                  values_image "$HEAD_CHART/values.yaml" postgresql; values_image "$HEAD_CHART/values.yaml" valkey; } | sort -u); do
    docker pull -q "${DOCKERHUB_MIRROR}/${img}" >/dev/null
    docker tag "${DOCKERHUB_MIRROR}/${img}" "$img"
    LOAD_IMAGES+=("$img")
  done
  ok "kindest/node and datastore images pulled via the Dependency Proxy"
fi

# ---------------------------------------------------------------------------
step "Creating kind cluster '$CLUSTER'"
# ---------------------------------------------------------------------------
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
cat <<EOF | kind create cluster --name "$CLUSTER" --config=- --wait 120s ${KIND_IMAGE_ARGS[@]+"${KIND_IMAGE_ARGS[@]}"}
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: "0.0.0.0"
EOF
retarget_kubeconfig "$CLUSTER"
kubectl cluster-info >/dev/null || die "cluster up but unreachable from this container"
kind load docker-image "${LOAD_IMAGES[@]}" --name "$CLUSTER"
ok "cluster up, images side-loaded"

# ---------------------------------------------------------------------------
step "3. helm install ${FROM_TAG} and seed it"
# ---------------------------------------------------------------------------
# shellcheck disable=SC2046  # helm_args is deliberately word-split
helm install "$RELEASE" "$FROM_CHART" $(helm_args) --create-namespace \
  --set backend.image.repository=ghcr.io/visiban/visiban/backend --set-string backend.image.tag="$FROM_TAG" \
  --set frontend.image.repository=ghcr.io/visiban/visiban/frontend --set-string frontend.image.tag="$FROM_TAG" \
  --wait --timeout 12m \
  || die "helm install of the ${FROM_TAG} chart did not complete"
POD="$(backend_pod_on "$FROM_BACKEND")"
[ -n "$POD" ] || die "no running backend pod on $FROM_BACKEND"
kubectl -n "$NAMESPACE" exec "$POD" -c backend -- python manage.py seed_demo_data --wipe --force >/dev/null \
  || die "seed_demo_data failed on ${FROM_TAG}"
probe "$POD" create-user >/dev/null || die "could not create the drill user on ${FROM_TAG}"
BEFORE="$(probe "$POD" counts | grep '^COUNTS ')"
case "$BEFORE" in
  *"boards=0 "*|*"cards=0 "*|*"movements=0 "*) die "seed produced an empty dataset ($BEFORE) — the drill would prove nothing" ;;
esac
ok "before upgrade: $BEFORE"

# ---------------------------------------------------------------------------
step "4. helm upgrade to the HEAD chart and images"
# ---------------------------------------------------------------------------
# shellcheck disable=SC2046
helm upgrade "$RELEASE" "$HEAD_CHART" $(helm_args) \
  --set backend.image.repository=visiban-drill/backend --set-string backend.image.tag="$TAG" \
  --set backend.image.pullPolicy=Never \
  --set frontend.image.repository=visiban-drill/frontend --set-string frontend.image.tag="$TAG" \
  --set frontend.image.pullPolicy=Never \
  --wait --timeout 12m \
  || die "helm upgrade from ${FROM_TAG} to the HEAD chart failed"
kubectl -n "$NAMESPACE" rollout status "deployment/${RELEASE}-visiban-backend" --timeout=300s >/dev/null \
  || die "backend Deployment did not finish rolling out after the upgrade"
POD="$(backend_pod_on "$HEAD_BACKEND")"
[ -n "$POD" ] || die "no running backend pod on the HEAD image after the upgrade"
MIGRATE_EXIT="$(kubectl -n "$NAMESPACE" get pod "$POD" \
  -o jsonpath='{.status.initContainerStatuses[?(@.name=="migrate")].state.terminated.exitCode}')"
[ "$MIGRATE_EXIT" = "0" ] || die "migrate init container on the HEAD pod exited '${MIGRATE_EXIT}' (expected 0)"
ok "migrate init container exited 0 on $HEAD_BACKEND"
kubectl -n "$NAMESPACE" exec "$POD" -c backend -- python manage.py migrate --check >/dev/null \
  || die "migrate --check reports unapplied migrations after the upgrade"

# ---------------------------------------------------------------------------
step "5. Data, readiness and login survived"
# ---------------------------------------------------------------------------
AFTER="$(probe "$POD" counts | grep '^COUNTS ')"
ok "after upgrade:  $AFTER"
[ "$BEFORE" = "$AFTER" ] || die "seeded data changed across the upgrade: before '$BEFORE', after '$AFTER'"
probe "$POD" health || die "readiness not ok after the upgrade"
probe "$POD" login  || die "the drill user created on ${FROM_TAG} cannot log in after the upgrade"
ok "helm upgrade drill passed: ${FROM_TAG} -> HEAD, data intact, readiness ok, login ok"
