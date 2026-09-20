#!/usr/bin/env bash
#
# gate-selftest-exempt: this IS a live kind-cluster boot drill — a synthetic
# --self-test would need to boot a second real cluster, which defeats the
# point of proving the chart actually starts. Its own step 4 (NEGATIVE: a
# placeholder-SECRET_KEY install must be REJECTED) already is the
# known-bad-input assertion #1093 asks for, run against the real chart
# instead of a fixture. See docs/development/ci-gates.md.
#
# Runtime deploy smoke test for the Visiban Helm chart on a kind cluster (#1116).
#
# The half scripts/helm-structure-check.sh cannot reach: actually BOOT the chart.
# A chart renders green and crash-loops; a hook is declared and never fires; an
# env var is wired and rejected by the app at import time. #1038 was all three at
# once, and it was found by a human upgrading production by hand because nothing
# in CI had ever started this chart.
#
# What it asserts, in order:
#   1. ONE `helm install` of the chart's own defaults completes on a cluster with
#      no pre-existing database — the documented quick-start path, end to end.
#      This step is #1117's acceptance criterion: it used to require a two-phase
#      `install --no-hooks` + `upgrade` workaround, because the migrate Job was a
#      pre-install hook and Helm runs those before it creates the PostgreSQL it
#      needs.
#   2. `helm test` passes — the same hook operators run, so CI and operators
#      verify one invariant rather than two drifting approximations of it.
#   3. The one-time admin password is retrievable from the shared emptyDir, which
#      is the documented way an operator gets their first login.
#   4. NEGATIVE: an install carrying the chart's placeholder SECRET_KEY is
#      REJECTED. A guard that stopped firing looks exactly like one that never
#      fires, so the fail-closed path is asserted, not assumed.
#   5. UPGRADE: rotating DJANGO_SECRET_KEY in a single `helm upgrade` succeeds —
#      #1038 blocker 2 at runtime, on the path that actually broke.
#   6. HA: scaling to three backend replicas rolls out, so the advisory lock in
#      `manage.py migrate_with_lock` serializes concurrent migrate init
#      containers instead of deadlocking them (#1117).
#   7. `helm uninstall` removes everything the chart created — the property a
#      hook-annotated PostgreSQL would have broken, and the reason #1117 was
#      fixed with an init container rather than by hook-annotating the database.
#
# Images are BUILT FROM THE WORKING TREE and side-loaded into kind, not pulled
# from a registry. The MR pipeline's image jobs are `--no-push`, so there is no
# per-commit image to pull; and drilling the HEAD chart against the last released
# image would mean a red here is version skew rather than a deploy regression —
# which is the failure mode that makes a drill get ignored.
#
# Requires: docker, kind, kubectl, helm.
# Usage:   bash scripts/helm-install-drill.sh
# Env:     KIND_CLUSTER   cluster name (default visiban-install)
#          KEEP_CLUSTER=1 skip teardown, to poke at a failed run
#          EXTRA_HELM_ARGS  appended to every install/upgrade. Escape hatch for a
#                           local machine whose kernel the bundled datastore
#                           images do not tolerate. Valkey 9.x dies with
#                           "Fatal: Can't initialize Background Jobs. Error
#                           message: Operation not permitted" on some arm64 VMs
#                           (Rancher Desktop / Lima) — pthread_create denied by
#                           the host's seccomp profile, a property of the host,
#                           not of the chart. Bitnami no longer publishes
#                           versioned tags, so there is no older image to pin;
#                           point the drill at an out-of-band instance instead:
#                             EXTRA_HELM_ARGS="--set valkey.enabled=false \
#                               --set externalRedis.url=redis://my-valkey:6379/0 \
#                               --set externalRedis.cacheUrl=redis://my-valkey:6379/1"
#                           CI does not set it, so CI always drills the shipped
#                           defaults on amd64.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$REPO_ROOT/helm/visiban"
CLUSTER="${KIND_CLUSTER:-visiban-install}"
RELEASE="drill"
NAMESPACE="visiban-drill"
TAG="drill-$(date +%s)"
BACKEND_IMAGE="visiban-drill/backend:${TAG}"
FRONTEND_IMAGE="visiban-drill/frontend:${TAG}"
SECRET_KEY_A="drill-secret-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SECRET_KEY_B="drill-secret-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

step()  { echo; echo "▶ $*"; }
ok()    { echo "  ✓ $*"; }
die()   { echo "  ✗ FAIL: $*" >&2; dump_diagnostics; exit 1; }

dump_diagnostics() {
  echo >&2
  echo "─── diagnostics ──────────────────────────────────────────" >&2
  kubectl -n "$NAMESPACE" get pods,jobs -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo >&2
  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp 2>&1 | tail -30 | sed 's/^/  /' >&2 || true
  # Logs from anything not cleanly Succeeded — the crash-loop is almost always
  # the whole story, and hunting for it by hand costs a re-run.
  #
  # `.status.phase` alone is NOT enough: a pod reads "Running" as soon as its
  # containers have started, regardless of whether they are actually Ready.
  # A container stuck failing its readiness probe (the case that matters most
  # here) is phase=Running with containerStatuses[*].ready=false, and the old
  # phase-only check skipped it — silently discarding the one log that would
  # have explained the failure.
  for pod in $(kubectl -n "$NAMESPACE" get pods -o name 2>/dev/null); do
    local phase ready all_ready
    phase="$(kubectl -n "$NAMESPACE" get "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || echo '')"
    ready="$(kubectl -n "$NAMESPACE" get "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{" "}{end}' 2>/dev/null || echo '')"
    all_ready="true"
    [ -z "$ready" ] && all_ready="false"
    for r in $ready; do [ "$r" = "true" ] || all_ready="false"; done
    if [ "$phase" = "Succeeded" ]; then
      continue
    fi
    if [ "$phase" = "Running" ] && [ "$all_ready" = "true" ]; then
      continue
    fi
    echo >&2; echo "  ── logs: $pod (phase=$phase ready=$all_ready)" >&2
    kubectl -n "$NAMESPACE" logs "$pod" --all-containers --tail=60 2>&1 | sed 's/^/    /' >&2 || true
  done
}

teardown() {
  if [ "${KEEP_CLUSTER:-0}" = "1" ]; then
    echo; echo "KEEP_CLUSTER=1 — leaving cluster '$CLUSTER' up. Remove with: kind delete cluster --name $CLUSTER"
    return
  fi
  echo; echo "▶ Tearing down"
  kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}
trap teardown EXIT

# Shared install arguments. Everything that is not under test is pinned here so
# a failure is attributable to the chart rather than to drill configuration.
install_args() {
  # shellcheck disable=SC2086
  [ -n "${EXTRA_HELM_ARGS:-}" ] && printf '%s\n' ${EXTRA_HELM_ARGS}
  cat <<ARGS
--namespace $NAMESPACE
--create-namespace
--set backend.image.repository=visiban-drill/backend
--set backend.image.tag=$TAG
--set backend.image.pullPolicy=Never
--set frontend.image.repository=visiban-drill/frontend
--set frontend.image.tag=$TAG
--set frontend.image.pullPolicy=Never
--set backend.settings.allowedHosts=drill.visiban.local
--set backend.settings.corsAllowedOrigins=http://drill.visiban.local
--set backend.settings.frontendUrl=http://drill.visiban.local
--set backend.settings.siteDomain=drill.visiban.local
--set backend.settings.forceInsecureCookies=true
--set backend.email.backend=console
--set backend.mediaPersistence.enabled=false
--set postgresql.primary.persistence.enabled=false
--set ingress.enabled=false
ARGS
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
  command -v "$bin" >/dev/null || { echo "ERROR: $bin not on PATH" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
step "Building images from the working tree (tag $TAG)"
# ---------------------------------------------------------------------------
docker build -q -t "$BACKEND_IMAGE"  -f "$REPO_ROOT/backend/Dockerfile"  "$REPO_ROOT/backend"  >/dev/null
ok "backend built"
docker build -q -t "$FRONTEND_IMAGE" -f "$REPO_ROOT/frontend/Dockerfile" "$REPO_ROOT/frontend" >/dev/null
ok "frontend built"

# ---------------------------------------------------------------------------
step "Creating kind cluster '$CLUSTER'"
# ---------------------------------------------------------------------------
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
# apiServerAddress 0.0.0.0 so the API server is reachable from outside the
# Docker host — required under kind-in-dind, harmless locally.
cat <<EOF | kind create cluster --name "$CLUSTER" --config=- --wait 120s
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: "0.0.0.0"
EOF
retarget_kubeconfig "$CLUSTER"
kubectl cluster-info >/dev/null || die "the cluster came up but is not reachable from this container"
kind load docker-image "$BACKEND_IMAGE" "$FRONTEND_IMAGE" --name "$CLUSTER"
ok "cluster up, reachable, images side-loaded"

# ---------------------------------------------------------------------------
step "1. Install the release in ONE helm install (#1117)"
# ---------------------------------------------------------------------------
# This is the whole point of #1117, so it is a single `helm install` of the
# chart's own defaults against a cluster with no database — exactly the command
# in docs/getting-started/kubernetes.md § 3, with no override that avoids the
# path an operator actually takes.
#
# It used to be a two-phase `install --no-hooks` + `upgrade` workaround: the
# migrate Job was a `pre-install` hook, Helm runs pre-install hooks BEFORE it
# creates any release resource, and so the hook resolved the bundled PostgreSQL
# Service before that Service existed and died on "could not translate host
# name". Migrations now run in the backend pod's `migrate` init container, which
# starts after Helm has applied the entire release and retries until the database
# answers. If this step ever needs a workaround again, that is the regression.
# shellcheck disable=SC2046  # install_args is deliberately word-split
helm install "$RELEASE" "$CHART" $(install_args) \
  --set-string secret.djangoSecretKey="$SECRET_KEY_A" \
  --wait --timeout 10m \
  || die "a single 'helm install' of the chart defaults did not complete — this is #1117's acceptance criterion; check the backend pod's migrate init container"
ok "one-shot fresh install completed"

kubectl -n "$NAMESPACE" rollout status "deployment/${RELEASE}-visiban-backend"  --timeout=180s >/dev/null \
  || die "backend Deployment never became available"
kubectl -n "$NAMESPACE" rollout status "deployment/${RELEASE}-visiban-frontend" --timeout=180s >/dev/null \
  || die "frontend Deployment never became available"
ok "both Deployments report available"

# ---------------------------------------------------------------------------
step "2. helm test"
# ---------------------------------------------------------------------------
helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m \
  || die "helm test failed — the install is up but not serving (see probe output above)"
ok "helm test passed: backend ready and the nginx upstream resolves"

# ---------------------------------------------------------------------------
step "3. One-time admin password is retrievable"
# ---------------------------------------------------------------------------
# The bootstrap init container writes it to an emptyDir the backend container
# also mounts, so `kubectl exec ... cat` is the documented first-login path. If
# the shared volume is dropped in a refactor the deploy still looks perfectly
# healthy and the operator simply cannot log in.
BACKEND_POD="$(kubectl -n "$NAMESPACE" get pod \
  -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}')"
ADMIN_PW="$(kubectl -n "$NAMESPACE" exec "$BACKEND_POD" -c backend -- \
  sh -c 'cat /run/visiban/admin_password 2>/dev/null || true' | tr -d '\r\n')"
[ -n "$ADMIN_PW" ] \
  || die "admin password file is empty or absent at /run/visiban/admin_password — the shared emptyDir between the bootstrap init container and the backend container is broken, and a fresh install has no reachable login"
ok "admin password retrievable (${#ADMIN_PW} chars)"

# ---------------------------------------------------------------------------
step "4. NEGATIVE: the placeholder SECRET_KEY guard fails closed"
# ---------------------------------------------------------------------------
# Two guards claim to reject it: templates/_validate.tpl at render time and
# backend/visiban/settings.py at import time. Either one passing this install is
# a regression — #1038 began with a live install running on the literal
# placeholder key, which is session-forgery territory.
# shellcheck disable=SC2046
if helm install "${RELEASE}-insecure" "$CHART" $(install_args) \
     --set-string secret.djangoSecretKey="change-me-in-production" \
     --wait --timeout 3m >/tmp/insecure-install.log 2>&1; then
  helm uninstall "${RELEASE}-insecure" --namespace "$NAMESPACE" >/dev/null 2>&1 || true
  die "an install with the chart's placeholder SECRET_KEY SUCCEEDED — the fail-closed guard is not firing (#1038)"
fi
grep -qi "djangoSecretKey" /tmp/insecure-install.log \
  || die "the placeholder install failed, but not for the SECRET_KEY reason — the guard may be masked by an unrelated error. Log: $(head -5 /tmp/insecure-install.log)"
ok "placeholder SECRET_KEY is rejected, and for the right reason"
helm uninstall "${RELEASE}-insecure" --namespace "$NAMESPACE" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
step "5. UPGRADE: rotate DJANGO_SECRET_KEY in a single helm upgrade"
# ---------------------------------------------------------------------------
# #1038 blocker 2, at runtime — re-proved against the #1117 shape.
#
# It used to be carried by a hook-managed bootstrap Secret at a lower hook-weight
# than the migrate Job, because a pre-upgrade hook otherwise read the PREVIOUS
# revision's Secret. With migrations in the pod there is one Secret, and the
# guarantee comes from two places instead: Helm applies a Secret before a
# Deployment, and the pod template carries a checksum over the Secret's contents
# so a rotation actually forces a rollout. Without that checksum this upgrade
# would "succeed" while replacing no pod at all — which is why the assertion
# below checks the ROLLOUT, not just helm's exit code.
PODS_BEFORE="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=backend \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort | tr '\n' ' ')"

# shellcheck disable=SC2046  # install_args is deliberately word-split
helm upgrade "$RELEASE" "$CHART" $(install_args) \
  --set-string secret.djangoSecretKey="$SECRET_KEY_B" \
  --wait --timeout 10m \
  || die "helm upgrade with a rotated DJANGO_SECRET_KEY failed — the migrate init container could not start against the rotated Secret (#1038 blocker 2)"
ok "secret rotation applied in one upgrade"

PODS_AFTER="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=backend \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort | tr '\n' ' ')"
[ "$PODS_BEFORE" != "$PODS_AFTER" ] \
  || die "the backend pods were not replaced by the rotation ($PODS_AFTER) — the checksum/secret pod-template annotation is missing or constant, so the running app and the migrate init container both keep the OLD key (#1038 blocker 2)"
ok "the rotation replaced the backend pods, so the new key is actually in effect"

ROTATED="$(kubectl -n "$NAMESPACE" get secret "${RELEASE}-visiban" \
  -o jsonpath='{.data.django-secret-key}' | base64 -d)"
[ "$ROTATED" = "$SECRET_KEY_B" ] \
  || die "the runtime Secret still holds the old key after upgrade"
ok "runtime Secret holds the rotated key"

helm test "$RELEASE" --namespace "$NAMESPACE" --timeout 5m \
  || die "helm test failed after the upgrade — the rotated release does not serve"
ok "helm test passes after the upgrade"

# ---------------------------------------------------------------------------
step "6. HA: three backend replicas migrate without deadlocking"
# ---------------------------------------------------------------------------
# Migrations moved into the backend pod in #1117, so with backendReplicaCount > 1
# every replica runs `manage.py migrate_with_lock` at the same time. The advisory
# lock is what makes that safe; a lock taken on the wrong connection, or a
# transaction-scoped one, shows up here as a rollout that never completes.
#
# Stated plainly, because a drill that oversells itself stops being read: the
# schema is ALREADY migrated at this point, so what three concurrent replicas
# exercise is the lock's acquire / wait / release path and the fact that a
# waiting replica does eventually start — not concurrent DDL. Genuinely
# concurrent DDL is covered by the backend unit tests against a real PostgreSQL
# (backend/boards/tests/test_migrate_with_lock.py); running it here would need a
# second full install and doubles the job's cluster time for the same signal.
# shellcheck disable=SC2046
helm upgrade "$RELEASE" "$CHART" $(install_args) \
  --set-string secret.djangoSecretKey="$SECRET_KEY_B" \
  --set backendReplicaCount=3 \
  --wait --timeout 10m \
  || die "the release did not roll out at backendReplicaCount=3 — concurrent migrate init containers are not being serialized correctly (#1117)"

READY="$(kubectl -n "$NAMESPACE" get deployment "${RELEASE}-visiban-backend" -o jsonpath='{.status.readyReplicas}')"
[ "${READY:-0}" = "3" ] \
  || die "only ${READY:-0}/3 backend replicas became ready — a replica that lost the migration lock race never started"
ok "3/3 backend replicas migrated and became ready"

# ---------------------------------------------------------------------------
step "7. helm uninstall removes everything the chart created"
# ---------------------------------------------------------------------------
# #1117 acceptance criterion 4, and the reason the fix is an init container
# rather than a `pre-install` annotation on templates/postgresql.yaml. Helm does
# not record hook resources in the release, so hook-annotating the PostgreSQL
# StatefulSet, Service and Secret would have left all three running after an
# uninstall — a worse surprise than the bug being fixed. This asserts the
# property directly instead of trusting the reasoning.
#
# PVCs are deliberately excluded: the chart documents that it does NOT delete
# them (data survives an uninstall on purpose), and this drill runs with
# persistence disabled anyway.
helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait --timeout 5m \
  || die "helm uninstall failed"

LEFTOVERS="$(kubectl -n "$NAMESPACE" get deploy,statefulset,svc,secret,job,configmap,networkpolicy,pdb \
  -l "app.kubernetes.io/instance=${RELEASE}" \
  -o name 2>/dev/null | grep -v '^$' || true)"
if [ -n "$LEFTOVERS" ]; then
  echo "  leftover objects:" >&2
  echo "$LEFTOVERS" | sed 's/^/    /' >&2
  die "helm uninstall left release-owned objects behind — something in the chart is annotated as a Helm hook, which Helm does not track in the release (#1117 acceptance criterion 4)"
fi
ok "uninstall left nothing behind"

echo
echo "PASSED: one-shot fresh install, serves, fails closed on a placeholder key, rotates secrets in place, migrates safely at 3 replicas, and uninstalls clean"
