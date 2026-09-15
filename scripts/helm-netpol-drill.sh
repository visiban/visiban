#!/usr/bin/env bash
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
# it long outlives the one workload that demonstrated it.)
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
docker build -q -t "visiban-netpol/backend:${TAG}"  -f "$REPO_ROOT/backend/Dockerfile"  "$REPO_ROOT/backend"  >/dev/null
docker build -q -t "visiban-netpol/frontend:${TAG}" -f "$REPO_ROOT/frontend/Dockerfile" "$REPO_ROOT/frontend" >/dev/null
ok "images built"

# ---------------------------------------------------------------------------
step "Creating kind cluster '$CLUSTER' with NO default CNI, then installing Calico"
# ---------------------------------------------------------------------------
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
cat <<EOF | kind create cluster --name "$CLUSTER" --config=- --wait 60s
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

kind load docker-image "visiban-netpol/backend:${TAG}" "visiban-netpol/frontend:${TAG}" --name "$CLUSTER"

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

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES NetworkPolicy enforcement violation(s)" >&2
  exit 1
fi
echo "PASSED: the chart's NetworkPolicies are enforced, allow exactly the intended clients, and deny the rest"
