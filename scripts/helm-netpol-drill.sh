#!/usr/bin/env bash
#
# gate-selftest-exempt: a live Calico kind-cluster enforcement drill — a
# synthetic --self-test would need a second real cluster with NetworkPolicy
# enforcement, which is what this drill IS. Its own NEGATIVE and CONTROL
# cases below (denied-pod, then policies-deleted-so-it-succeeds) already are
# the known-bad/known-good pair #1093 asks for, run against real Calico
# instead of a fixture. See docs/development/ci-gates.md.
#
# NetworkPolicy ENFORCEMENT drill for the Visiban Helm chart (#1116).
#
# Why this is a SEPARATE cluster from scripts/helm-install-drill.sh:
#
# kind's default CNI (kindnetd) DOES NOT IMPLEMENT NetworkPolicy. That is by
# design, per the kindnet project — it is not a bug and not a version issue. So
# on the install drill's cluster the chart's five policy objects are admitted by
# the API server, reported by `kubectl get netpol`, and then silently ignored. A
# policy that selects the wrong pods, or omits a legitimate client, passes every
# other gate in this repo.
#
# That is exactly how the migrate Job came to be missing from the datastore
# allow-list: templates/networkpolicy.yaml named only `component: backend`, while
# the pre-install migrate hook ran with `component: migrate`. Every install with
# networkPolicy.enabled=true — the documented production setting — hung at the
# migrate hook on Calico or Cilium, and looked perfect on kind. (#1117 removed
# that Job; migrations are now an init container of the backend pod and so carry
# `component: backend`. The omission SHAPE is what this drill guards against, and
# it long outlives the one workload that demonstrated it.) The allow-list is now
# `backend` plus `scheduler` — the scheduled-job CronJob pods (#1157) — and both
# are probed below.
#
# This drill therefore builds its own cluster with disableDefaultCNI + Calico and
# asserts BEHAVIOR, not manifest shape:
#
#   POSITIVE  backend reaches PostgreSQL and Valkey   <- also covers the migrate
#             and bootstrap init containers, which share the backend pod's labels
#   NEGATIVE  an unlabeled pod is denied
#   NEGATIVE  a wrong-component pod is denied
#   CONTROL   the unlabeled pod CAN still reach the frontend (so "denied" is not
#             just "this cluster has no working pod network")
#   CONTROL   with the policies deleted, the previously-denied pod CAN reach
#             PostgreSQL (so "denied" came from the policy, not from Calico
#             being misconfigured or the datastore being down)
#
# Then PUBLIC DEMO MODE (#1180): the release is upgraded to values-demo.yaml,
# which adds an EGRESS policy for every datastore client (TruePPM ADR-1197 D7):
#   POSITIVE  the demo seed hook itself reached PostgreSQL through both the
#             ingress allow-list and the egress policy (the upgrade completes)
#   POSITIVE  backend- and demo-seed-labeled pods still reach PostgreSQL and
#             Valkey BY SERVICE NAME (so DNS is allowed too)
#   NEGATIVE  the same pods cannot open a connection to an address outside the
#             pod network (the kind node's API server port, which needs no
#             internet access to be reachable, so the drill is deterministic)
#   CONTROL   an unlabeled pod CAN reach that same address (so "denied" meant
#             the egress policy, not an unreachable target), and after the
#             policies are deleted a backend-labeled pod can too
#
# Without those two controls a completely broken CNI scores a perfect run, and
# the drill would be worse than nothing: it would testify to isolation it never
# observed.
#
# Requires: docker, kind, kubectl, helm.
# Usage:   bash scripts/helm-netpol-drill.sh
# Env:     KIND_CLUSTER   cluster name (default visiban-netpol)
#          CALICO_VERSION the Calico manifest to install
#          KEEP_CLUSTER=1 skip teardown
#          EXTRA_HELM_ARGS  appended to install/upgrade — same host-kernel
#                           escape hatch as scripts/helm-install-drill.sh; see
#                           the note there. CI does not set it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$REPO_ROOT/helm/visiban"
CLUSTER="${KIND_CLUSTER:-visiban-netpol}"
CALICO_VERSION="${CALICO_VERSION:-v3.28.2}"
RELEASE="netpol"
NAMESPACE="visiban-netpol"
TAG="netpol-$(date +%s)"
PROBE_IMAGE="busybox:1.36"

FAILURES=0

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
die()  { echo "  ✗ FATAL: $*" >&2; exit 1; }

teardown() {
  if [ "${KEEP_CLUSTER:-0}" = "1" ]; then
    echo; echo "KEEP_CLUSTER=1 — leaving cluster '$CLUSTER' up."
    return
  fi
  echo; echo "▶ Tearing down"
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}
trap teardown EXIT

# Run a one-shot probe pod carrying $labels and try to open a TCP connection.
# Echoes ALLOWED or DENIED. A policy denial manifests as the connection hanging
# until the timeout, so `nc -w` IS the verdict — which is also why every negative
# result needs a control before it means anything.
probe() {
  local name="$1" labels="$2" host="$3" port="$4"
  kubectl -n "$NAMESPACE" delete pod "$name" --ignore-not-found --now >/dev/null 2>&1 || true
  if kubectl -n "$NAMESPACE" run "$name" \
       --image="$PROBE_IMAGE" --labels="$labels" --restart=Never --rm -i --quiet \
       --command -- sh -c "nc -z -w 5 $host $port" >/dev/null 2>&1; then
    echo ALLOWED
  else
    echo DENIED
  fi
}

expect() {
  local want="$1" got="$2" what="$3"
  if [ "$got" = "$want" ]; then
    ok "$what: $got (expected)"
  else
    bad "$what: got $got, expected $want"
  fi
}

# kind-in-dind kubeconfig fixup.
#
# kind writes a kubeconfig whose server is https://127.0.0.1:<port>. That is
# correct when the Docker daemon is local. In CI the daemon is the `docker:dind`
# SERVICE container and this script runs in a DIFFERENT container, so the API
# server is reachable at the service hostname, not at our own loopback — and
# without this every kubectl and helm call dies with "connection refused" AFTER
# the cluster has come up perfectly, which reads like a broken cluster and is
# not.
#
# The cluster is created with apiServerAddress 0.0.0.0 so it binds beyond the
# dind container's loopback; the serving cert therefore does not carry the
# service hostname as a SAN, so TLS verification is turned off for this
# connection. That is acceptable here and nowhere else: the "cluster" is a
# throwaway created seconds ago inside the job's own dind, on a private bridge
# network, and torn down at exit.
retarget_kubeconfig() {
  local cluster="$1" host="${APISERVER_HOST:-}"
  [ -z "$host" ] && return 0
  [ "$host" = "127.0.0.1" ] && return 0

  local port
  port="$(kubectl config view -o jsonpath="{.clusters[?(@.name=='kind-${cluster}')].cluster.server}" | sed 's|.*:||')"
  if [ -z "$port" ]; then
    echo "  ! could not read the API server port from the kubeconfig; leaving it untouched" >&2
    return 0
  fi

  kubectl config set-cluster "kind-${cluster}" \
    --server="https://${host}:${port}" \
    --insecure-skip-tls-verify=true >/dev/null
  kubectl config unset "clusters.kind-${cluster}.certificate-authority-data" >/dev/null
  echo "  ↳ kubeconfig retargeted to https://${host}:${port} (kind-in-dind)"
}


for bin in docker kind kubectl helm; do
  command -v "$bin" >/dev/null || die "$bin not on PATH"
done

# ---------------------------------------------------------------------------
step "Building images from the working tree (tag $TAG)"
# ---------------------------------------------------------------------------
docker build -q --build-arg "BASE_REGISTRY=${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX:-docker.io/library}" -t "visiban-netpol/backend:${TAG}"  -f "$REPO_ROOT/backend/Dockerfile"  "$REPO_ROOT/backend"  >/dev/null
docker build -q --build-arg "BASE_REGISTRY=${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX:-docker.io/library}" -t "visiban-netpol/frontend:${TAG}" -f "$REPO_ROOT/frontend/Dockerfile" "$REPO_ROOT/frontend" >/dev/null
ok "images built"

# ---------------------------------------------------------------------------
step "Pre-pulling cluster images through the GitLab Dependency Proxy (#1198)"
# ---------------------------------------------------------------------------
# See scripts/helm-install-drill.sh for the full rationale: the dind daemon
# this script talks to has no credentials of its own, CI's .helm-drill-base
# before_script logs it in, and locally (no CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX)
# this whole step is a no-op.
KIND_IMAGE_ARGS=()
EXTRA_LOAD_IMAGES=()
if [ -n "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX:-}" ]; then
  KINDEST_NODE_TAG="${KINDEST_NODE_TAG:-v1.31.2}"  # matches KUBECTL_VERSION's minor
  docker pull -q "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/kindest/node:${KINDEST_NODE_TAG}"
  docker tag "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/kindest/node:${KINDEST_NODE_TAG}" "kindest/node:${KINDEST_NODE_TAG}"
  KIND_IMAGE_ARGS=(--image "kindest/node:${KINDEST_NODE_TAG}")

  # In-cluster images: the chart's own postgres/valkey defaults (see
  # helm-install-drill.sh), plus this drill's own busybox probe pods below.
  docker pull -q "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/postgres:17"
  docker tag "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/postgres:17" "postgres:17"
  docker pull -q "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/bitnami/valkey:latest"
  docker tag "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/bitnami/valkey:latest" "registry-1.docker.io/bitnami/valkey:latest"
  docker pull -q "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/${PROBE_IMAGE}"
  docker tag "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/${PROBE_IMAGE}" "${PROBE_IMAGE}"
  EXTRA_LOAD_IMAGES=("postgres:17" "registry-1.docker.io/bitnami/valkey:latest" "${PROBE_IMAGE}")
  ok "kindest/node, postgres, valkey, busybox pulled via the Dependency Proxy"
fi

# ---------------------------------------------------------------------------
step "Creating kind cluster '$CLUSTER' with NO default CNI, then installing Calico"
# ---------------------------------------------------------------------------
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
cat <<EOF | kind create cluster --name "$CLUSTER" --config=- --wait 60s "${KIND_IMAGE_ARGS[@]}"
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  # The entire point of this drill. With kindnetd in place the policies below are
  # admitted and ignored, and every assertion in this file becomes a no-op that
  # reports success.
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
  apiServerAddress: "0.0.0.0"
EOF
retarget_kubeconfig "$CLUSTER"
kubectl cluster-info >/dev/null || die "the cluster came up but is not reachable from this container"

kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" >/dev/null
echo "  waiting for Calico to become ready (this is the slow part)..."
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s >/dev/null \
  || die "Calico never became ready — without an enforcing CNI this drill cannot assert anything"
kubectl wait --for=condition=Ready nodes --all --timeout=300s >/dev/null
ok "Calico is enforcing"

kind load docker-image "visiban-netpol/backend:${TAG}" "visiban-netpol/frontend:${TAG}" "${EXTRA_LOAD_IMAGES[@]}" --name "$CLUSTER"

# ---------------------------------------------------------------------------
step "Installing the chart with networkPolicy.enabled=true"
# ---------------------------------------------------------------------------
# A single `helm install`, as of #1117 — the migrate pre-install hook that made
# a one-shot install impossible is gone.
#
# The install is itself the first assertion of this drill: the backend pod's
# `migrate` init container has to reach PostgreSQL THROUGH the enforced policies
# before any pod can become ready. Before #1116 the allow-list named only
# `component: backend` while the migrate workload ran as `component: migrate`, so
# this step hung until the Job exhausted its backoff.
release_args() {
  # shellcheck disable=SC2086
  [ -n "${EXTRA_HELM_ARGS:-}" ] && printf '%s\n' ${EXTRA_HELM_ARGS}
  cat <<ARGS
--namespace $NAMESPACE
--create-namespace
--set backend.image.repository=visiban-netpol/backend
--set backend.image.tag=$TAG
--set backend.image.pullPolicy=Never
--set frontend.image.repository=visiban-netpol/frontend
--set frontend.image.tag=$TAG
--set frontend.image.pullPolicy=Never
--set-string secret.djangoSecretKey=netpol-drill-key-aaaaaaaaaaaaaaaaaaaaaaaa
--set backend.settings.allowedHosts=netpol.visiban.local
--set backend.settings.corsAllowedOrigins=http://netpol.visiban.local
--set backend.settings.frontendUrl=http://netpol.visiban.local
--set backend.settings.siteDomain=netpol.visiban.local
--set backend.settings.forceInsecureCookies=true
--set backend.email.backend=console
--set backend.mediaPersistence.enabled=false
--set postgresql.primary.persistence.enabled=false
--set ingress.enabled=false
--set networkPolicy.enabled=true
ARGS
}

# shellcheck disable=SC2046  # release_args is deliberately word-split
helm install "$RELEASE" "$CHART" $(release_args) --wait --timeout 10m \
  || die "the release did not roll out with NetworkPolicy ENFORCED — a workload that needs a datastore is missing from the allow-list in templates/networkpolicy.yaml (#1116)"
ok "rolled out under enforced NetworkPolicy — the migrate init container reached PostgreSQL"

PG_SVC="${RELEASE}-postgresql"
VALKEY_SVC="${RELEASE}-valkey-primary"
FRONTEND_SVC="${RELEASE}-visiban-frontend"
NAME_LABEL="app.kubernetes.io/name=visiban"
INSTANCE_LABEL="app.kubernetes.io/instance=${RELEASE}"

# ---------------------------------------------------------------------------
step "POSITIVE probes — legitimate clients reach the datastores"
# ---------------------------------------------------------------------------
expect ALLOWED "$(probe probe-backend-pg "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=backend" "$PG_SVC" 5432)" \
  "backend -> PostgreSQL"
expect ALLOWED "$(probe probe-backend-valkey "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=backend" "$VALKEY_SVC" 6379)" \
  "backend -> Valkey"
# The `backend` probes above are what now covers migrations: since #1117 they run
# in the backend pod's `migrate` init container, under the backend pod's labels.
# There is no longer a separate `component: migrate` workload, so it must NOT be
# in the allow-list — see the negative probe for it below.
#
# `component: scheduler` is the second legitimate client: the pods of the
# scheduled-job CronJobs (templates/cronjobs.yaml, #1157), which run management
# commands against PostgreSQL. The probes carry the label directly rather than
# waiting on a CronJob run, so they prove the allow-list whether or not the
# drill's values enable scheduledJobs. The static half — the CronJob pod label
# actually being `scheduler` — is helm-structure-check.sh section 7.
expect ALLOWED "$(probe probe-scheduler-pg "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=scheduler" "$PG_SVC" 5432)" \
  "scheduler -> PostgreSQL (#1157)"
expect ALLOWED "$(probe probe-scheduler-valkey "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=scheduler" "$VALKEY_SVC" 6379)" \
  "scheduler -> Valkey (#1157)"

# ---------------------------------------------------------------------------
step "NEGATIVE probes — everything else is denied"
# ---------------------------------------------------------------------------
expect DENIED "$(probe probe-unlabeled-pg "drill=unlabeled" "$PG_SVC" 5432)" \
  "unlabeled pod -> PostgreSQL"
expect DENIED "$(probe probe-unlabeled-valkey "drill=unlabeled" "$VALKEY_SVC" 6379)" \
  "unlabeled pod -> Valkey"
# The frontend is nginx and holds no database connection. If it can reach
# PostgreSQL, the allow-list has been widened past its purpose.
expect DENIED "$(probe probe-frontend-pg "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=frontend" "$PG_SVC" 5432)" \
  "frontend -> PostgreSQL"
# `component: migrate` was a real workload until #1117 and is not one any more.
# Re-adding it to the allow-list would widen the policy for a pod that does not
# exist, which is exactly the kind of leftover nobody notices in a diff.
expect DENIED "$(probe probe-migrate-pg "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=migrate" "$PG_SVC" 5432)" \
  "retired 'migrate' component -> PostgreSQL (#1117)"

# ---------------------------------------------------------------------------
step "DEMO MODE — upgrade to values-demo.yaml, egress is denied (#1180)"
# ---------------------------------------------------------------------------
# The upgrade is itself the first demo assertion: its post-upgrade seed hook
# (component demo-seed) must migrate and seed THROUGH the enforced ingress
# allow-lists and the new egress policy, or `--wait` times out on the hook.
# shellcheck disable=SC2046  # release_args is deliberately word-split
helm upgrade "$RELEASE" "$CHART" $(release_args) \
  -f "$CHART/values-demo.yaml" \
  --set-string demo.loginHint.password=netpol-visitor-pw-1 \
  --set-string demo.adminPassword=netpol-admin-password-1 \
  --set-string demo.memberPassword=netpol-member-password-1 \
  --wait --timeout 12m \
  || die "the demo upgrade did not complete under enforced NetworkPolicy — the demo-seed hook could not reach a datastore (allow-list or egress policy)"
ok "demo seed hook ran under enforced ingress AND egress policy"

# An address outside the pod network that any pod can normally reach without
# internet access: the kind control-plane node's API server port.
NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
[ -n "$NODE_IP" ] || die "could not read the node's InternalIP for the egress probe"

expect ALLOWED "$(probe probe-demo-control-external "drill=unlabeled" "$NODE_IP" 6443)" \
  "unlabeled pod -> ${NODE_IP}:6443 (control: the target is reachable)"
for component in backend demo-seed; do
  expect ALLOWED "$(probe "probe-demo-${component}-pg" "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=${component}" "$PG_SVC" 5432)" \
    "demo: ${component} -> PostgreSQL by Service name (DNS + datastore egress allowed)"
  expect ALLOWED "$(probe "probe-demo-${component}-valkey" "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=${component}" "$VALKEY_SVC" 6379)" \
    "demo: ${component} -> Valkey"
  expect DENIED "$(probe "probe-demo-${component}-external" "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=${component}" "$NODE_IP" 6443)" \
    "demo: ${component} -> ${NODE_IP}:6443 (outside the cluster's pod network)"
done
# A backend pod in demo mode must not reach the frontend either: the egress
# policy allows DNS and the datastores, nothing else.
expect DENIED "$(probe probe-demo-backend-frontend "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=backend" "$FRONTEND_SVC" 80)" \
  "demo: backend -> frontend"

# ---------------------------------------------------------------------------
step "CONTROL 1 — a denied pod still has working networking"
# ---------------------------------------------------------------------------
# The frontend policy has no `from` clause, so anything may reach it on :80. If
# the same unlabeled pod that was denied PostgreSQL can reach the frontend, then
# DENIED above meant "the policy stopped it", not "this pod has no network".
expect ALLOWED "$(probe probe-control-frontend "drill=unlabeled" "$FRONTEND_SVC" 80)" \
  "unlabeled pod -> frontend (control)"

# ---------------------------------------------------------------------------
step "CONTROL 2 — with the policies deleted, the denied path opens"
# ---------------------------------------------------------------------------
# The strongest available control. If PostgreSQL is simply down, or Calico is
# dropping everything, this probe stays DENIED and every negative result above
# is revealed as meaningless.
kubectl -n "$NAMESPACE" delete networkpolicy --all >/dev/null
# Calico programs policy removal asynchronously; without a settle window this
# control flakes DENIED and gets blamed on the drill rather than on the wait.
sleep 10
expect ALLOWED "$(probe probe-control-nopolicy "drill=unlabeled" "$PG_SVC" 5432)" \
  "unlabeled pod -> PostgreSQL with policies removed (control)"
expect ALLOWED "$(probe probe-control-demo-egress "${NAME_LABEL},${INSTANCE_LABEL},app.kubernetes.io/component=backend" "$NODE_IP" 6443)" \
  "backend-labeled pod -> ${NODE_IP}:6443 with policies removed (control: the demo denial was the egress policy)"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES NetworkPolicy enforcement violation(s)" >&2
  exit 1
fi
echo "PASSED: the chart's NetworkPolicies are enforced, allow exactly the intended clients, deny the rest, and in demo mode deny egress beyond DNS and the datastores"
