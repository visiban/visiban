#!/usr/bin/env bash
#
# Structural invariants for the Visiban Helm chart (#1116).
#
# `helm lint` and `helm template` prove the chart RENDERS. They do not prove the
# rendered manifests still honor the runtime contract a deploy depends on. That
# gap is not hypothetical: #1038 found the chart could not deploy 1.1 at all —
# an OIDC_SECRET/OIDC_CLIENT_SECRET env-var name mismatch that silently disabled
# SSO, a pre-upgrade hook ordering bug that made SECRET_KEY rotation impossible,
# and zero email wiring — and every one of those rendered green. It was found by
# a human upgrading production by hand.
#
# This script asserts that contract statically, with no cluster, so the same
# class of defect fails in the lint stage instead of at deploy time. The runtime
# half lives in scripts/helm-install-drill.sh.
#
# Requires: helm, yq (mikefarah v4) on PATH.
#
# Modes:
#   bash scripts/helm-structure-check.sh [chart-dir]   # assert the contract
#   bash scripts/helm-structure-check.sh --self-test   # prove it can still fail
#
# ---------------------------------------------------------------------------
# Self-test (#1093)
# ---------------------------------------------------------------------------
# This gate's failure mode is a GREEN pipeline over a chart that no longer holds
# the contract, so "it passed" is not evidence that it can still fail. The
# --self-test mode injects each defect class into a throwaway copy of the chart
# and asserts the corresponding section rejects it.
#
# SCOPE, stated plainly because a self-test that looks comprehensive and is not
# is worse than none: the fixtures cover sections 1, 2, 3, 4 and 6. Section 5
# (probe paths) and section 7 (NetworkPolicy client coverage) are asserted
# against the real chart only — see the notes on those sections.

set -euo pipefail

CHART_DIR="${1:-helm/visiban}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Values the chart's render-time guards (templates/_validate.tpl) demand before
# it will render at all. Arbitrary — only the wiring downstream is asserted.
RENDER_ARGS=(
  --set-string secret.djangoSecretKey=structure-check-not-a-real-secret
  --set backend.settings.allowedHosts=structure-check.visiban.local
  --set backend.email.backend=smtp
  --set backend.email.host=smtp.visiban.local
  --set backend.email.fromAddress=noreply@visiban.local
  # OIDC is behind a serverUrl conditional, so the default render never reaches
  # the OIDC env block — and that block is where #1038's blocker 1 lived. Turn
  # it on so section 3 actually sees those variables.
  --set backend.oauth.oidc.serverUrl=https://idp.visiban.local/realms/visiban
  # The NetworkPolicies are off by default; section 7 needs them rendered.
  --set networkPolicy.enabled=true
)

RELEASE="visiban"
FAILURES=0
RENDERED=""
# The chart directory that produced $RENDERED. Section 2 re-renders that SAME
# chart with a rotated secret, so under --self-test it must follow the damaged
# copy, not CHART_DIR — otherwise the fixture damages one chart while the check
# reads another and reports a clean pass.
CHART_UNDER_TEST="$CHART_DIR"

fail() {
  echo "  ✗ FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "  ✓ $*"
}

section() {
  echo
  echo "── $* ─────────────────────────────────────────"
}

render() {
  local chart="$1" out="$2"
  CHART_UNDER_TEST="$chart"
  if ! helm template "$RELEASE" "$chart" "${RENDER_ARGS[@]}" > "$out" 2>/tmp/helm-render-err.txt; then
    echo "ERROR: helm template failed for chart '$chart':" >&2
    cat /tmp/helm-render-err.txt >&2
    exit 1
  fi
}

# Pull one document out of the render by kind + a name substring. yq's document
# separation is what makes this safe against a name that appears in two kinds.
doc() {
  local kind="$1" name_match="$2"
  yq "select(.kind == \"$kind\" and (.metadata.name | test(\"$name_match\")))" "$RENDERED"
}

# ---------------------------------------------------------------------------
# 1. Migrations run inside the backend pod, never from an install-phase hook.
# ---------------------------------------------------------------------------
# This IS the #1117 fix. Helm runs pre-install hooks BEFORE it creates any
# release resource, so a migrate Job annotated `pre-install` resolves the bundled
# PostgreSQL Service before that Service exists: every `helm install` with the
# chart's own default values failed on "could not translate host name",
# unconditionally, on the documented quick-start path. `helm upgrade` hid it,
# because PostgreSQL already existed from the previous revision.
#
# Two invariants, and the second is the one a refactor is most likely to undo:
#
#   a) NOTHING in the render carries an install/upgrade-phase hook annotation.
#      This also happens to be the static proof that `helm uninstall` removes
#      everything the chart created: hook resources are precisely what Helm does
#      NOT record in the release, so a hook-annotated StatefulSet or Secret
#      outlives the uninstall. `helm.sh/hook: test` is exempt — a test hook is
#      instantiated only by `helm test` and is never part of an install.
#
#   b) The backend pod runs migrate in an init container, ordered before the
#      `bootstrap` init container (which needs migrated tables) and therefore
#      before the app container. Init-container order in a pod spec is list
#      order, so this is a real ordering assertion, not a formality.
MIGRATE_COMMAND="migrate_with_lock"

check_migrate_placement() {
  section "1. Migrations run in the backend pod, not in an install-phase hook"

  # Every hook annotation in the render, with the document's kind and name, so a
  # violation names the offending object rather than just its existence.
  local hooks bad=0
  hooks="$(yq 'select(.metadata.annotations."helm.sh/hook" != null)
               | .kind + "/" + .metadata.name + " " + .metadata.annotations."helm.sh/hook"' "$RENDERED" \
           | grep -vE '^(null|---)?$' || true)"
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    # Field 2 is the comma-joined hook list.
    local phases="${entry##* }"
    if [ "$phases" != "test" ]; then
      fail "'$entry' is an install-phase Helm hook. Hooks run before Helm creates the release's own resources (so a database client cannot reach the bundled PostgreSQL on a fresh install, #1117) and are not tracked in the release (so 'helm uninstall' leaves them behind)"
      bad=1
    fi
  done <<< "$hooks"
  [ "$bad" -eq 0 ] && pass "no install-phase hooks — every resource is an ordinary, uninstallable release resource"

  # Init container ORDER, read as a list so position is meaningful.
  local init_cmds migrate_idx=-1 bootstrap_idx=-1 idx=0
  init_cmds="$(doc Deployment 'backend$' \
    | yq '.spec.template.spec.initContainers[] | (.command // []) | join(" ")')"

  if [ -z "$init_cmds" ]; then
    fail "backend Deployment declares no init containers — nothing applies migrations before the app container starts"
    return
  fi

  while IFS= read -r cmd; do
    case "$cmd" in
      *"manage.py $MIGRATE_COMMAND"*) [ "$migrate_idx" -lt 0 ] && migrate_idx=$idx ;;
      *"manage.py ensure_site_admin"*) [ "$bootstrap_idx" -lt 0 ] && bootstrap_idx=$idx ;;
    esac
    idx=$((idx + 1))
  done <<< "$init_cmds"

  if [ "$migrate_idx" -lt 0 ]; then
    fail "no backend init container runs 'manage.py $MIGRATE_COMMAND' — with the migrate hook Job gone (#1117) nothing would apply migrations at all"
  else
    pass "backend init container $migrate_idx runs 'manage.py $MIGRATE_COMMAND'"
  fi

  if [ "$bootstrap_idx" -lt 0 ]; then
    fail "no backend init container runs 'manage.py ensure_site_admin' — a fresh install would have no admin account to log in with"
  elif [ "$migrate_idx" -ge 0 ] && [ "$migrate_idx" -gt "$bootstrap_idx" ]; then
    fail "the migrate init container (position $migrate_idx) runs AFTER bootstrap (position $bootstrap_idx) — ensure_site_admin needs migrated tables and would crash-loop on every fresh install"
  else
    pass "migrate is ordered before the bootstrap init container"
  fi
}

# ---------------------------------------------------------------------------
# 2. A secret rotated in one `helm upgrade` reaches the pod that migrates.
# ---------------------------------------------------------------------------
# #1038 blocker 2, re-proved against the #1117 shape. It used to be guaranteed by
# a hook-managed bootstrap Secret at a lower hook-weight than the migrate Job.
# With migrations in the pod there is only ONE Secret, and two things have to
# hold instead:
#
#   a) every container in the backend pod reads the chart's runtime Secret, so
#      the value in effect is the one Helm has just applied (Helm applies a
#      Secret before a Deployment); and
#   b) the pod template carries a checksum over the Secret's contents, so that
#      rotating a value actually CHANGES the pod template and forces a rollout.
#      Without (b) `helm upgrade` writes the new Secret, no pod is replaced, the
#      running app keeps the old key indefinitely, and the migrate init container
#      — which only runs when a pod is created — never sees the rotation at all.
#
# (b) is asserted by rendering the chart TWICE with different secret values and
# requiring the annotation to differ. A checksum that is present but constant
# passes every single-render check and provides nothing.
check_secret_rotation_reaches_migrate() {
  section "2. A rotated Secret reaches the migrating pod"

  local runtime_name refs
  runtime_name="$(yq 'select(.kind == "Secret" and (.metadata.name | test("visiban$"))) | .metadata.name' "$RENDERED" | head -1)"
  if [ -z "$runtime_name" ] || [ "$runtime_name" = "null" ]; then
    fail "no chart-managed runtime Secret rendered"
    return
  fi

  # Every secretKeyRef across the backend pod — app container AND init
  # containers, since the migrate init container is now one of them. The email
  # password is allowed to come from elsewhere (backend.email.existingSecret is
  # an operator-supplied Secret), so it is excluded by name rather than by
  # position — an index-based check breaks the moment a variable is inserted.
  # The parentheses around the two sources are load-bearing: yq binds `|` tighter
  # than `,` inside a collect, so `[a, b | f]` filters only `b` and passes every
  # env entry of `a` through raw. That is not a hypothetical — it is what this
  # expression did on its first run, reporting 14 "violations" whose names were
  # fragments of unrelated YAML.
  refs="$(doc Deployment 'backend$' \
    | yq '[(.spec.template.spec.containers[].env[], .spec.template.spec.initContainers[].env[])
           | select(.name != "EMAIL_HOST_PASSWORD")
           | .valueFrom.secretKeyRef.name] | map(select(. != null)) | unique | .[]')"

  if [ -z "$refs" ]; then
    fail "backend pod has no secretKeyRef env at all — it cannot reach the database"
    return
  fi

  local bad=0
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if [ "$ref" != "$runtime_name" ]; then
      fail "backend pod reads Secret '$ref', expected the chart's runtime Secret '$runtime_name' — anything else is either not reconciled before the pod starts or not deleted by 'helm uninstall'"
      bad=1
    fi
  done <<< "$refs"
  [ "$bad" -eq 0 ] && pass "all backend pod secret refs point at '$runtime_name'"

  # (b) the checksum must exist AND vary with the secret contents.
  local sum_a sum_b alt_rendered
  sum_a="$(doc Deployment 'backend$' | yq '.spec.template.metadata.annotations."checksum/secret" // ""')"
  if [ -z "$sum_a" ] || [ "$sum_a" = "null" ]; then
    fail "backend pod template carries no checksum/secret annotation — rotating a secret would change no field of the pod template, so no pod is replaced and the migrate init container never re-runs with the new value (#1038 blocker 2)"
    return
  fi

  alt_rendered="$(mktemp)"
  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
        --set-string secret.djangoSecretKey=structure-check-ROTATED-key-value \
        > "$alt_rendered" 2>/dev/null; then
    fail "the rotation render failed — cannot prove the checksum varies"
    rm -f "$alt_rendered"
    return
  fi
  sum_b="$(yq 'select(.kind == "Deployment" and (.metadata.name | test("backend$")))
               | .spec.template.metadata.annotations."checksum/secret" // ""' "$alt_rendered")"
  rm -f "$alt_rendered"

  if [ "$sum_a" = "$sum_b" ]; then
    fail "checksum/secret is identical across two renders with DIFFERENT djangoSecretKey values — the annotation is constant, so it forces no rollout and buys nothing"
  else
    pass "checksum/secret changes when a secret value changes, so a rotation forces a rollout"
  fi
}

# ---------------------------------------------------------------------------
# 3. Chart env vars ↔ the code that reads them.
# ---------------------------------------------------------------------------
# #1038 blocker 1 verbatim: the chart injected OIDC_SECRET, settings.py read
# OIDC_CLIENT_SECRET, so _OIDC_ENABLED stayed False, the provider was never
# registered, the login button never appeared — and there was no error anywhere,
# because an env var nothing reads is not an error. Both directions matter:
#   forward  — every var the chart injects must be read somewhere in backend/
#   backward — a curated list of vars a production deploy cannot go without must
#              still be wired (this is #1038 blocker 3, "no email env vars at
#              all", which the forward direction cannot see)
#
# The backward list is deliberately short and explicit rather than derived from
# settings.py: most env vars settings.py reads are legitimately not chart-
# exposed, so a derived list would be all false positives and would be silenced.
REQUIRED_ENV=(
  DJANGO_SECRET_KEY DATABASE_URL ALLOWED_HOSTS REDIS_URL REDIS_CACHE_URL
  EMAIL_BACKEND DEFAULT_FROM_EMAIL EMAIL_VERIFICATION
  FRONTEND_URL SITE_DOMAIN
)

check_env_contract() {
  section "3. Chart env vars are read by backend code"

  # Scoped to Visiban's own workloads by component label. The bundled PostgreSQL
  # and Valkey set their own env (POSTGRES_DB, VALKEY_TLS_ENABLED, ...) which is
  # read by those images, not by backend/ — sweeping the whole render would make
  # this section all false positives, and a section that is always red is a
  # section nobody reads.
  local names
  names="$(yq 'select(.kind == "Deployment" or .kind == "Job")
               | select(.spec.template.metadata.labels."app.kubernetes.io/component"
                        | . == "backend")
               | .spec.template.spec.containers[].env[].name,
                 (.spec.template.spec.initContainers[]?.env[]?.name // "")' "$RENDERED" \
             | grep -vE '^(null|---)?$' | sort -u)"

  # Match an actual LOOKUP — env("X"), env.bool("X"), os.getenv("X"),
  # os.environ["X"] — not a bare mention of the name. The difference is
  # load-bearing: settings.py names "OIDC_SECRET" in a deprecation warning whose
  # own comment says the old name is no longer read, so a substring grep would
  # accept the chart re-introducing exactly the #1038 defect this section exists
  # to catch. (It did, on the first run of the self-test.)
  #
  # Flattened to one line first because a lookup is routinely split across lines
  # by the formatter — EMAIL_BACKEND is written as `env(\n    "EMAIL_BACKEND",`
  # — and a per-line grep silently misses every one of those.
  local blob
  blob="$(mktemp)"
  find "$REPO_ROOT/backend" -name '*.py' -exec cat {} + | tr '\n' ' ' > "$blob"

  local unread=0
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if ! grep -qE "(env|env\.[a-z_]+|os\.getenv|os\.environ\.get)\([[:space:]]*[\"']${name}[\"']|os\.environ\[[[:space:]]*[\"']${name}[\"']" "$blob"; then
      fail "chart injects '$name' but nothing under backend/ LOOKS IT UP — the value silently reaches nothing, which is #1038 blocker 1 verbatim"
      unread=$((unread + 1))
    fi
  done <<< "$names"
  rm -f "$blob"
  [ "$unread" -eq 0 ] && pass "$(wc -l <<< "$names" | tr -d ' ') rendered env vars all have a reader in backend/"

  local missing=0
  for name in "${REQUIRED_ENV[@]}"; do
    if ! grep -qFx -- "$name" <<< "$names"; then
      fail "required env var '$name' is not wired by the chart — a deploy cannot be configured without it (#1038)"
      missing=$((missing + 1))
    fi
  done
  [ "$missing" -eq 0 ] && pass "all ${#REQUIRED_ENV[@]} required env vars are wired"
}

# ---------------------------------------------------------------------------
# 4. The frontend's nginx upstream must be the release-scoped Service.
# ---------------------------------------------------------------------------
# nginx resolves a literal proxy_pass host ONCE at startup. The host baked into
# the published frontend image's own nginx.conf is `backend` — correct under
# docker-compose, absent in Kubernetes. If the chart's ConfigMap ever stops
# overriding it, or renders the bare name, every frontend pod crash-loops with
# "host not found in upstream" and the SPA is simply down. TruePPM's equivalent
# drill caught exactly this shape on a real chart.
check_nginx_upstream() {
  section "4. nginx proxies to the release-scoped backend Service"

  # Derived from the render, not composed by hand: visiban.fullname collapses
  # the release name into the chart name when one contains the other, so a
  # hardcoded "<release>-visiban-backend" is wrong for a release actually named
  # "visiban" — and a check that is wrong at the defaults gets deleted, not fixed.
  local conf expected
  expected="$(yq 'select(.kind == "Service" and (.metadata.name | test("backend$"))) | .metadata.name' "$RENDERED" | head -1)"
  if [ -z "$expected" ]; then
    fail "no backend Service rendered — nothing for the frontend to proxy to"
    return
  fi
  conf="$(doc ConfigMap 'nginx$' | yq '.data."nginx.conf"')"

  if [ -z "$conf" ] || [ "$conf" = "null" ]; then
    fail "no nginx ConfigMap rendered — the frontend would fall back to the image-baked compose config"
    return
  fi

  local hosts bad=0 count=0
  hosts="$(grep -oE 'proxy_pass[[:space:]]+http://[^:;]+' <<< "$conf" | awk '{print $2}' | sed 's|http://||' | sort -u)"
  if [ -z "$hosts" ]; then
    fail "nginx config has no proxy_pass at all — /api/ would be served by the SPA catch-all"
    return
  fi
  while IFS= read -r host; do
    [ -z "$host" ] && continue
    count=$((count + 1))
    if [ "$host" != "$expected" ]; then
      fail "nginx proxy_pass targets '$host', expected the release-scoped Service '$expected' — nginx resolves the upstream at startup, so a compose-only host crash-loops every frontend pod"
      bad=1
    fi
  done <<< "$hosts"
  [ "$bad" -eq 0 ] && pass "all $count proxy_pass upstreams target '$expected'"

  # The Deployment has to actually MOUNT the ConfigMap over the baked file — a
  # rendered-but-unmounted config is the same outage with a healthier-looking diff.
  local mounted
  mounted="$(doc Deployment 'frontend$' \
    | yq '[.spec.template.spec.volumes[] | .configMap.name] | map(select(. != null)) | .[]')"
  if ! grep -q "nginx" <<< "$mounted"; then
    fail "frontend Deployment does not mount the nginx ConfigMap — the image-baked compose config would be used instead"
  else
    pass "frontend Deployment mounts the nginx ConfigMap"
  fi
}

# ---------------------------------------------------------------------------
# 5. Probe paths must be routes the backend actually serves.
# ---------------------------------------------------------------------------
# A renamed health URL makes every backend pod fail its readiness gate: the
# rollout hangs until progressDeadlineSeconds and the chart says nothing useful.
# Not fixture-covered — the assertion is a grep against the real urls.py, and a
# fixture would have to fake that file, testing the fake rather than the rule.
check_probe_paths() {
  section "5. Probe paths exist in backend/visiban/urls.py"

  local urls="$REPO_ROOT/backend/visiban/urls.py"
  if [ ! -f "$urls" ]; then
    fail "cannot find $urls"
    return
  fi

  local paths
  paths="$(doc Deployment 'backend$' \
    | yq '[.spec.template.spec.containers[].livenessProbe.httpGet.path,
           .spec.template.spec.containers[].readinessProbe.httpGet.path] | unique | .[]')"

  if [ -z "$paths" ]; then
    fail "backend Deployment declares no HTTP probes"
    return
  fi

  local bad=0
  while IFS= read -r p; do
    [ -z "$p" ] || [ "$p" = "null" ] && continue
    # urls.py declares routes without the leading slash.
    local route="${p#/}"
    if ! grep -qF "\"$route\"" "$urls"; then
      fail "probe path '$p' has no matching route in urls.py — every pod would fail its gate and the rollout would hang"
      bad=1
    fi
  done <<< "$paths"
  [ "$bad" -eq 0 ] && pass "all probe paths resolve to declared routes"
}

# ---------------------------------------------------------------------------
# 6. Transport limits must clear the application's own upload cap.
# ---------------------------------------------------------------------------
# If nginx or the ingress caps the body BELOW the app cap, an over-size upload
# dies at the edge with a bare 413 and Django never sees the request — so the
# user gets no message naming the real limit, and the app's own, friendlier
# rejection is unreachable. Both limits are derived from
# backend.settings.maxUploadSizeBytes; this proves the derivation still holds
# after any values-file tidy-up, which is exactly how such a limit regresses.
check_transport_limits() {
  section "6. Transport limits clear the application upload cap"

  local app_bytes app_mb nginx_mb ingress_mb conf
  app_bytes="$(doc Deployment 'backend$' \
    | yq '.spec.template.spec.containers[].env[] | select(.name == "MAX_UPLOAD_SIZE_BYTES") | .value' \
    | tr -d '"' | head -1)"
  if [ -z "$app_bytes" ] || [ "$app_bytes" = "null" ]; then
    fail "MAX_UPLOAD_SIZE_BYTES is not wired — the app cap is invisible to the chart and the transport limits cannot be checked against it"
    return
  fi
  app_mb=$(( (app_bytes + 1048575) / 1048576 ))

  conf="$(doc ConfigMap 'nginx$' | yq '.data."nginx.conf"')"
  nginx_mb="$(grep -oE 'client_max_body_size[[:space:]]+[0-9]+[Mm]' <<< "$conf" | grep -oE '[0-9]+' | head -1)"
  if [ -z "$nginx_mb" ]; then
    fail "nginx declares no client_max_body_size — it inherits the 1m default and 413s every upload above 1 MB against a ${app_mb} MB app cap"
  elif [ "$nginx_mb" -lt "$app_mb" ]; then
    fail "nginx client_max_body_size is ${nginx_mb}M but the app accepts ${app_mb} MB — uploads between the two die at the edge with a bare 413"
  else
    pass "nginx client_max_body_size ${nginx_mb}M clears the ${app_mb} MB app cap"
  fi

  ingress_mb="$(doc Ingress '.' | yq '.metadata.annotations."nginx.ingress.kubernetes.io/proxy-body-size" // ""' | grep -oE '[0-9]+' | head -1)"
  if [ -z "$ingress_mb" ]; then
    fail "ingress declares no proxy-body-size annotation — ingress-nginx defaults to 1m, and /api reaches the app through the ingress on a default install"
  elif [ "$ingress_mb" -lt "$app_mb" ]; then
    fail "ingress proxy-body-size is ${ingress_mb}m but the app accepts ${app_mb} MB"
  else
    pass "ingress proxy-body-size ${ingress_mb}m clears the ${app_mb} MB app cap"
  fi
}

# ---------------------------------------------------------------------------
# 7. Every workload that opens a datastore connection is in the allow-list.
# ---------------------------------------------------------------------------
# The NetworkPolicies name their allowed clients by `app.kubernetes.io/component`,
# so ADDING a template that talks to PostgreSQL or Valkey breaks isolation
# without touching networkpolicy.yaml. That is precisely how the migrate Job was
# omitted before #1116: on kind's default kindnetd the policies are admitted and
# ignored, so it passed every gate, and on Calico the migrate hook hung. (That
# Job is gone as of #1117 — migrations run as an init container of the backend
# pod, so they are covered by `backend` — but the omission shape it demonstrates
# is exactly what this section exists to catch for the NEXT such template.)
#
# Not fixture-covered: the assertion is a set comparison over the real chart's
# rendered workloads, and a fixture chart would have its own workload set —
# proving the fixture's arithmetic rather than the chart's coverage. The runtime
# proof is scripts/helm-netpol-drill.sh, which asserts behavior on Calico.
#
# `frontend` is deliberately NOT a datastore client: it is nginx, it holds no
# database connection, and listing it would widen the policy for nothing.
# `frontend` is nginx: it holds no database connection, and listing it would
# widen the policy for nothing. `test` is the `helm test` probe, which talks to
# the backend Service and never to a datastore. `postgresql` is the chart's own
# StatefulSet — it is the datastore this policy protects, not a client of it.
NON_DATASTORE_COMPONENTS=(frontend test postgresql)

check_netpol_coverage() {
  section "7. NetworkPolicy datastore allow-list covers every datastore client"

  local allowed components
  allowed="$(yq 'select(.kind == "NetworkPolicy" and (.metadata.name | test("allow-backend-postgresql$")))
                 | [.spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"] | .[]' "$RENDERED" | sort -u)"

  if [ -z "$allowed" ]; then
    fail "the PostgreSQL NetworkPolicy allows no component at all — every client is denied"
    return
  fi

  # Every distinct component VISIBAN renders as a workload, from the POD template
  # labels — which is what a NetworkPolicy selects on, not the object's own
  # labels. Scoped by app.kubernetes.io/name to Visiban's own workloads: the
  # bundled PostgreSQL and Valkey are the datastores being protected, not clients
  # of them, and the valkey subchart labels its StatefulSet component "primary".
  local own_name
  own_name="$(doc Deployment 'backend$' | yq '.spec.template.metadata.labels."app.kubernetes.io/name"')"
  components="$(yq "select(.kind == \"Deployment\" or .kind == \"Job\" or .kind == \"StatefulSet\")
                    | select(.spec.template.metadata.labels.\"app.kubernetes.io/name\" == \"$own_name\")
                    | .spec.template.metadata.labels.\"app.kubernetes.io/component\"" "$RENDERED" \
                 | grep -vFx -e 'null' -e '---' | sort -u)"

  local bad=0
  while IFS= read -r c; do
    [ -z "$c" ] && continue
    local skip=0
    for known in "${NON_DATASTORE_COMPONENTS[@]}"; do
      [ "$c" = "$known" ] && skip=1
    done
    [ "$skip" -eq 1 ] && continue
    if ! grep -qFx -- "$c" <<< "$allowed"; then
      fail "workload component '$c' is neither in the datastore allow-list nor in NON_DATASTORE_COMPONENTS — if it opens a database connection it is denied on an enforcing CNI; if it does not, add it to the exclusion list in this script and say why"
      bad=1
    fi
  done <<< "$components"
  [ "$bad" -eq 0 ] && pass "every datastore-client component is allowed: $(tr '\n' ' ' <<< "$allowed")"

  # Valkey's allow-list must match PostgreSQL's — the backend pod holds
  # connections to each, and a policy pair that disagrees is a deploy that
  # half-works.
  local valkey_allowed
  valkey_allowed="$(yq 'select(.kind == "NetworkPolicy" and (.metadata.name | test("allow-backend-valkey$")))
                        | [.spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"] | .[]' "$RENDERED" | sort -u)"
  if [ "$valkey_allowed" != "$allowed" ]; then
    fail "the Valkey and PostgreSQL allow-lists differ (valkey: $(tr '\n' ' ' <<< "$valkey_allowed"); postgresql: $(tr '\n' ' ' <<< "$allowed"))"
  else
    pass "Valkey and PostgreSQL allow-lists agree"
  fi
}

# ---------------------------------------------------------------------------
# 8. Every `manage.py <command>` the chart invokes must exist.
# ---------------------------------------------------------------------------
# The chart runs three Django management commands across the backend pod's init
# containers and its app container. One is built into Django; the other two,
# `migrate_with_lock` (#1117) and `ensure_site_admin`, are Visiban's own.
# Renaming or moving either crash-loops an init container on EVERY deploy — no
# pod ever reaches Ready — and nothing else in this repo connects the chart's
# string literal to the command that has to answer it. The command name is not in
# any Python import graph, so a rename tool will not catch it either.
check_manage_commands() {
  section "8. manage.py commands named by the chart exist"

  # Django's own; not shipped under backend/*/management/commands/.
  local builtin="migrate collectstatic makemigrations shell dbshell createsuperuser"

  local invoked bad=0 count=0
  # Read from the RENDER, not from the template source. Every other section
  # here asserts against rendered manifests, and a section that reads the chart
  # directory instead cannot be exercised by the self-test at all — its fixture
  # damages a copy while the check keeps reading the original. (This one did,
  # and reported a clean pass on a deliberately broken chart.)
  # Join each command array to one line before matching: yq emits short arrays
  # in flow style (["python", "manage.py", "migrate"]) and long ones as block
  # sequences, so any line-oriented match handles only half the render.
  invoked="$(yq '.. | select(has("command")) | .command | join(" ")' "$RENDERED" \
            | sed -n 's/.*manage\.py \([a-z_][a-z_]*\).*/\1/p' | sort -u)"

  if [ -z "$invoked" ]; then
    fail "the chart invokes no manage.py command at all — migrations and the admin bootstrap would never run"
    return
  fi

  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    count=$((count + 1))
    case " $builtin " in *" $cmd "*) continue ;; esac
    if ! find "$REPO_ROOT/backend" -path "*/management/commands/$cmd.py" -print -quit | grep -q .; then
      fail "chart runs 'manage.py $cmd' but no management command by that name exists under backend/ — the init container crash-loops on every deploy"
      bad=1
    fi
  done <<< "$invoked"
  [ "$bad" -eq 0 ] && pass "all $count invoked manage.py commands resolve"
}

run_all_checks() {
  check_migrate_placement
  check_secret_rotation_reaches_migrate
  check_env_contract
  check_nginx_upstream
  check_probe_paths
  check_transport_limits
  check_netpol_coverage
  check_manage_commands
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
self_test() {
  echo "helm-structure-check.sh --self-test: proving each section can still fail"
  echo

  local tmp passes=0 selftest_failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # Each fixture is (name, sed-program applied to a chart file, file).
  # Run the FULL check against the damaged chart and require a non-zero exit —
  # asserting on the exit code rather than on message text, so a reworded
  # failure message does not silently disarm the fixture.
  local fixtures=(
    # 1a: an install-phase hook comes back — #1117 verbatim. Re-annotating an
    # existing hook is the cheapest faithful injection: it needs no newline in
    # the replacement, which matters because BSD and busybox sed disagree about
    # \n on the right-hand side and this file has to run on both.
    "1 install-phase hook reintroduced|templates/tests/api-connection.yaml|s/helm.sh\/hook: test/helm.sh\/hook: pre-install/"
    # 1b: nothing applies migrations any more.
    "1 migrate init container has no command|templates/backend-deployment.yaml|/command: \[\"python\", \"manage.py\", \"migrate_with_lock\"\]/d"
    # 1c: migrate ordered AFTER the bootstrap init container, which needs the
    # tables migrate creates. Swapped via a temporary token so the two
    # substitutions cannot chase each other on the same line.
    "1 migrate ordered after bootstrap|templates/backend-deployment.yaml|s/\"migrate_with_lock\"]/\"ZZSWAP\"]/; s/\"ensure_site_admin\"]/\"migrate_with_lock\"]/; s/\"ZZSWAP\"]/\"ensure_site_admin\"]/"
    # 2a: the backend pod stops reading the chart's own runtime Secret.
    "2 backend reads a foreign Secret|templates/_backend-env.tpl|s/name: {{ \$secret }}/name: not-the-runtime-secret/"
    # 2b: the checksum is present but constant, so it forces no rollout and a
    # rotated secret never reaches a newly created pod.
    "2 secret checksum frozen|templates/backend-deployment.yaml|s/| sha256sum }}/| trunc 0 }}/"
    "3 env var name drift (#1038 blocker 1)|templates/_backend-env.tpl|s/- name: OIDC_CLIENT_SECRET/- name: OIDC_SECRET/"
    "3 required env removed (#1038 blocker 3)|templates/_backend-env.tpl|/- name: EMAIL_BACKEND/,+1d"
    "4 nginx upstream|templates/frontend-configmap.yaml|s|http://{{ include \"visiban.fullname\" . }}-backend|http://backend|g"
    "6 transport limit below app cap|templates/frontend-configmap.yaml|s/client_max_body_size {{ include \"visiban.transportBodyLimitMB\" . }}M;/client_max_body_size 1M;/"
    "8 renamed manage.py command|templates/backend-deployment.yaml|s/\"manage.py\", \"ensure_site_admin\"/\"manage.py\", \"ensure_admin_site\"/"
  )

  for fixture in "${fixtures[@]}"; do
    local name file prog broken
    name="${fixture%%|*}"
    file="$(cut -d'|' -f2 <<< "$fixture")"
    prog="$(cut -d'|' -f3- <<< "$fixture")"

    broken="$tmp/$(echo "$name" | tr ' #()' '____')"
    rm -rf "$broken"
    # Copied WHOLE, subchart tarballs included: Chart.yaml declares postgresql
    # and valkey as dependencies, so a copy without charts/ fails to render at
    # all — and a render failure is indistinguishable from a detection unless
    # the two are separated, as they are below. That mistake scored a perfect
    # 6/6 on the first run of this self-test; the control is what exposed it.
    cp -R "$CHART_DIR" "$broken"
    sed -i.bak "$prog" "$broken/$file"
    rm -f "$broken/$file.bak"
    # A fixture that changes nothing is a fixture that proves nothing — and an
    # unanchored sed silently becomes one the moment the line it targets is
    # reworded. Compare against the pristine copy rather than trusting sed's
    # exit status, which is 0 for "no lines matched".
    if diff -q "$CHART_DIR/$file" "$broken/$file" >/dev/null 2>&1; then
      echo "  ✗ SELF-TEST FAIL: fixture '$name' changed nothing in $file — its sed program no longer matches" >&2
      selftest_failures=$((selftest_failures + 1))
      continue
    fi

    # A fixture must RENDER and then FAIL the contract. A fixture that merely
    # breaks `helm template` proves nothing about this script — helm already
    # catches that — so it is reported as a broken fixture, not a pass.
    if ! helm template "$RELEASE" "$broken" "${RENDER_ARGS[@]}" > "$tmp/rendered.yaml" 2>"$tmp/render-err.txt"; then
      echo "  ✗ SELF-TEST FAIL: fixture '$name' does not render, so it cannot exercise the check:" >&2
      sed 's/^/      /' "$tmp/render-err.txt" >&2
      selftest_failures=$((selftest_failures + 1))
      continue
    fi

    # CHART_UNDER_TEST must follow the DAMAGED copy: section 2 re-renders it to
    # prove the secret checksum varies, and pointing that re-render at the
    # pristine chart would report a clean pass on a broken one.
    if ( RENDERED="$tmp/rendered.yaml"; CHART_UNDER_TEST="$broken"; FAILURES=0; run_all_checks >/dev/null 2>&1; [ "$FAILURES" -eq 0 ] ); then
      echo "  ✗ SELF-TEST FAIL: '$name' was injected and the check still passed" >&2
      selftest_failures=$((selftest_failures + 1))
    else
      echo "  ✓ '$name' is detected"
      passes=$((passes + 1))
    fi
  done

  # Control: the UNDAMAGED chart (minus subcharts) must pass. Without this, a
  # check that fails on everything would score a perfect self-test.
  local control="$tmp/control"
  cp -R "$CHART_DIR" "$control"
  if ( RENDERED="$tmp/control.yaml"; render "$control" "$RENDERED"; FAILURES=0; run_all_checks >/dev/null 2>&1; [ "$FAILURES" -eq 0 ] ); then
    echo "  ✓ control: the undamaged chart passes"
    passes=$((passes + 1))
  else
    echo "  ✗ SELF-TEST FAIL: the undamaged chart does not pass — every fixture result above is meaningless" >&2
    selftest_failures=$((selftest_failures + 1))
  fi

  echo
  if [ "$selftest_failures" -gt 0 ]; then
    echo "SELF-TEST FAILED: $selftest_failures of $((passes + selftest_failures)) cases" >&2
    exit 1
  fi
  echo "SELF-TEST PASSED: $passes/$passes cases"
}

# ---------------------------------------------------------------------------

if [ "${1:-}" = "--self-test" ]; then
  CHART_DIR="${2:-helm/visiban}"
  self_test
  exit 0
fi

command -v helm >/dev/null || { echo "ERROR: helm not on PATH" >&2; exit 1; }
command -v yq   >/dev/null || { echo "ERROR: yq (mikefarah v4) not on PATH" >&2; exit 1; }

echo "helm-structure-check.sh: asserting the deploy contract for '$CHART_DIR'"
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
render "$CHART_DIR" "$RENDERED"

run_all_checks

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES deploy-contract violation(s)" >&2
  exit 1
fi
echo "PASSED: the rendered chart honors the deploy contract"
