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
# is worse than none: the fixtures cover sections 1, 2, 3, 4, 6, 8, 9, 10, 11,
# 12 and 13. Section 5 (probe paths) is asserted against the real chart only,
# and section 7 (NetworkPolicy client coverage) is fixture-covered only
# through the demo render in section 9 — see the notes on those sections.

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
  # The scheduled-job CronJobs (#1157) are off by default, and every one of
  # them opens a database connection — section 7 must see their pods, and
  # section 8 must see the manage.py commands they run. Prune jobs are off
  # individually, so turn them on too.
  --set scheduledJobs.enabled=true
  --set scheduledJobs.pruneBoardEvents.enabled=true
  --set scheduledJobs.pruneNotifications.enabled=true
)

# Public demo mode (#1180) renders a second shape of the chart: the shipped
# values-demo.yaml plus the secrets it deliberately leaves out. Read from the
# chart UNDER TEST (the damaged copy during --self-test), never from CHART_DIR.
demo_args() {
  local chart="$1"
  printf '%s\n' \
    -f "$chart/values-demo.yaml" \
    --set-string secret.djangoSecretKey=structure-check-not-a-real-secret \
    --set-string demo.loginHint.password=structure-check-visitor-pw \
    --set-string demo.adminPassword=structure-check-admin-pw \
    --set-string demo.memberPassword=structure-check-member-pw
}

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
    # The ONE exemption (#1180): the public-demo seed Job, a POST-install/
    # POST-upgrade hook. #1117's defect was a PRE-install hook reaching for a
    # database Helm had not created yet; a post-install hook runs after the whole
    # release exists and its migrate init container waits for the database. It
    # must still delete itself on success, or it outlives `helm uninstall`.
    if [ "$phases" = "post-install,post-upgrade" ] && [[ "$entry" == Job/*-demo-seed\ * ]]; then
      local name="${entry#Job/}"; name="${name%% *}"
      local policy
      policy="$(yq "select(.kind == \"Job\" and .metadata.name == \"$name\") | .metadata.annotations.\"helm.sh/hook-delete-policy\" // \"\"" "$RENDERED")"
      if [[ ",$policy," != *",hook-succeeded,"* ]]; then
        fail "demo seed hook '$name' has hook-delete-policy '$policy' without hook-succeeded — Helm does not track hook resources, so a completed seed Job would outlive 'helm uninstall'"
        bad=1
      fi
      continue
    fi
    if [ "$phases" != "test" ]; then
      fail "'$entry' is an install-phase Helm hook. Hooks run before Helm creates the release's own resources (so a database client cannot reach the bundled PostgreSQL on a fresh install, #1117) and are not tracked in the release (so 'helm uninstall' leaves them behind)"
      bad=1
    fi
  done <<< "$hooks"
  [ "$bad" -eq 0 ] && pass "no install-phase hooks — every resource is an ordinary, uninstallable release resource (the demo seed hook excepted, and self-deleting)"

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
  # `demo-seed` (#1180) is the public-demo seed hook: a backend-image pod with
  # its own seed-only variables, so it is held to the same contract.
  names="$(yq 'select(.kind == "Deployment" or .kind == "Job")
               | select(.spec.template.metadata.labels."app.kubernetes.io/component"
                        | . == "backend" or . == "demo-seed")
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
  # The Trello import cap (VISIBAN_IMPORT_MAX_SIZE, #456) is usually the larger
  # of the two app caps; the transport limits must clear whichever is bigger.
  local import_bytes
  import_bytes="$(doc Deployment 'backend$' \
    | yq '.spec.template.spec.containers[].env[] | select(.name == "VISIBAN_IMPORT_MAX_SIZE") | .value' \
    | tr -d '"' | head -1)"
  if [ -z "$import_bytes" ] || [ "$import_bytes" = "null" ]; then
    fail "VISIBAN_IMPORT_MAX_SIZE is not wired — the Trello import cap is invisible to the chart"
    return
  fi
  if [ "$import_bytes" -gt "$app_bytes" ]; then
    app_bytes="$import_bytes"
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
# the backend Service and never to a datastore. `postgresql` and `valkey` are the
# chart's own StatefulSets (#1200 moved Valkey off the Bitnami subchart and onto
# this chart's labels) — they are the datastores these policies protect, not
# clients of them.
NON_DATASTORE_COMPONENTS=(frontend test postgresql valkey)

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
  # labels. Scoped by app.kubernetes.io/name to Visiban's own workloads; the
  # bundled PostgreSQL and Valkey carry that name too and are excluded through
  # NON_DATASTORE_COMPONENTS, because they are the datastores being protected.
  local own_name
  own_name="$(doc Deployment 'backend$' | yq '.spec.template.metadata.labels."app.kubernetes.io/name"')"
  # A CronJob's pod template is one level deeper (.spec.jobTemplate.spec.template);
  # normalize it to the same path so the scheduled jobs (#1157) are covered.
  components="$(yq "select(.kind == \"Deployment\" or .kind == \"Job\" or .kind == \"StatefulSet\" or .kind == \"CronJob\")
                    | (select(.kind == \"CronJob\") | .spec.jobTemplate.spec.template) // .spec.template
                    | select(.metadata.labels.\"app.kubernetes.io/name\" == \"$own_name\")
                    | .metadata.labels.\"app.kubernetes.io/component\"" "$RENDERED" \
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

# ---------------------------------------------------------------------------
# 9. Public demo mode (#1180): off means absent, on means one coherent shape.
# ---------------------------------------------------------------------------
# Three renders:
#
#   a) the main render (demo OFF, the default): NOTHING demo-shaped may appear —
#      no demo-seed workload, no DEMO_* env, no demo Secret or egress policy.
#      "helm upgrade on an existing release changes nothing" is this assertion.
#   b) values-demo.yaml: sections 1, 3, 7 and 8 re-run against it (so the seed
#      hook and reset CronJob are held to the same hook, env, NetworkPolicy and
#      manage.py contracts as everything else), plus the demo invariants:
#        - DEMO_MODE=true reaches the backend (TruePPM #3932: a chart that
#          rendered demo mode and set the variable nowhere);
#        - the countdown's DEMO_RESET_SCHEDULE IS the CronJob's schedule, and the
#          CronJob runs in UTC, Forbid, like the countdown assumes;
#        - the seed hook and the reset run the identical pod spec, and that spec
#          is the whole-database reset command;
#        - demo passwords reach pods only through secretKeyRef;
#        - the egress policy selects exactly the datastore clients and opens
#          nothing outside the cluster (no ipBlock);
#        - the `helm test` fence probe exists and goes through the frontend.
#   c) values-demo.yaml with demo.reset.enabled=false: no reset CronJob, and
#      DEMO_RESET_SCHEDULE rendered EMPTY so the login page promises nothing.
render_demo() {
  local out="$1"; shift
  local args=()
  while IFS= read -r a; do
    # `--set-json demo.loginHint=null` is applied BEFORE --set-string, so the
    # base password below would then be set on a nil map and Helm would fail to
    # parse the flags — for the wrong reason. Drop it for that one case.
    if [[ "$a" == demo.loginHint.password=* && " $* " == *"demo.loginHint=null"* ]]; then
      unset 'args[${#args[@]}-1]'
      continue
    fi
    args+=("$a")
  done < <(demo_args "$CHART_UNDER_TEST")
  helm template "$RELEASE" "$CHART_UNDER_TEST" "${args[@]}" "$@" > "$out" 2>/tmp/helm-demo-render-err.txt
}

check_demo_mode() {
  section "9. Public demo mode: absent by default, coherent when on (#1180)"

  # (a) demo off
  local leaks
  leaks="$(yq '[select(.metadata.labels."app.kubernetes.io/component" == "demo-seed"
                       or (.kind == "Secret" and (.metadata.name | test("-demo$")))
                       or (.kind == "NetworkPolicy" and (.metadata.name | test("demo-egress$")))
                       or (.kind == "Pod" and (.metadata.name | test("demo-read-only$"))))
                | .kind + "/" + .metadata.name] | .[]' "$RENDERED" | grep -vE '^(---)?$' || true)"
  if [ -n "$leaks" ]; then
    fail "demo objects render with demo.enabled=false: $(tr '\n' ' ' <<< "$leaks")— an upgrade of an existing release would create them"
  else
    pass "demo.enabled=false renders no demo object"
  fi
  if yq '.. | select(tag == "!!map") | select(has("name") and (has("value") or has("valueFrom"))) | .name' "$RENDERED" \
       | grep -qE '^(DEMO_[A-Z_]+|NUM_PROXIES)$'; then
    fail "DEMO_*/NUM_PROXIES env renders with demo off and numProxies unset — the default render must be unchanged (#1180)"
  else
    pass "no DEMO_* or NUM_PROXIES env in the default render"
  fi

  # (b) demo on
  local demo_rendered saved="$RENDERED"
  demo_rendered="$(mktemp)"
  if ! render_demo "$demo_rendered"; then
    fail "values-demo.yaml (with its secrets supplied) does not render: $(head -3 /tmp/helm-demo-render-err.txt)"
    rm -f "$demo_rendered"; return
  fi
  RENDERED="$demo_rendered"
  echo "  (re-running sections 1, 3, 7 and 8 against the demo render)"
  check_migrate_placement
  check_env_contract
  check_netpol_coverage
  check_manage_commands
  section "9. Public demo mode (continued)"

  local backend_env
  backend_env="$(doc Deployment 'backend$' | yq '.spec.template.spec.containers[0].env')"
  if [ "$(yq '.[] | select(.name == "DEMO_MODE") | .value' <<< "$backend_env")" != "true" ]; then
    fail "the backend container does not get DEMO_MODE=true in demo mode — the write fence is OFF while the login page publishes a credential"
  else
    pass "DEMO_MODE=true reaches the backend container"
  fi

  # The login page publishes DEMO_LOGIN_PASSWORD from the backend pod, so a
  # rotated demo.loginHint.password must replace that pod — otherwise the page
  # advertises the old password while the seed sets the new one.
  if [ -z "$(doc Deployment 'backend$' | yq '.spec.template.metadata.annotations."checksum/demo-secret" // ""')" ]; then
    fail "the backend pod template carries no checksum/demo-secret — rotating the published password would not roll the pods, and the login page would keep showing the old one"
  else
    pass "the demo Secret is checksummed into the backend pod template"
  fi

  local countdown cron tz policy
  countdown="$(yq '.[] | select(.name == "DEMO_RESET_SCHEDULE") | .value' <<< "$backend_env")"
  cron="$(yq 'select(.kind == "CronJob" and (.metadata.name | test("demo-reset$"))) | .spec.schedule' "$RENDERED")"
  tz="$(yq 'select(.kind == "CronJob" and (.metadata.name | test("demo-reset$"))) | .spec.timeZone' "$RENDERED")"
  policy="$(yq 'select(.kind == "CronJob" and (.metadata.name | test("demo-reset$"))) | .spec.concurrencyPolicy' "$RENDERED")"
  if [ -z "$cron" ]; then
    fail "no demo reset CronJob renders with demo.reset.enabled=true"
  elif [ "$countdown" != "$cron" ]; then
    fail "the backend's DEMO_RESET_SCHEDULE ('$countdown') differs from the reset CronJob's schedule ('$cron') — visitors would be shown a countdown to a reset that does not happen then (TruePPM ADR-1197 D9)"
  else
    pass "DEMO_RESET_SCHEDULE and the reset CronJob share one schedule ('$cron')"
  fi
  if [ -n "$cron" ] && { [ "$tz" != "Etc/UTC" ] || [ "$policy" != "Forbid" ]; }; then
    fail "the reset CronJob runs with timeZone '$tz' / concurrencyPolicy '$policy'; it must be Etc/UTC (the backend computes the countdown in UTC) and Forbid (two overlapping wipes delete each other's rows)"
  elif [ -n "$cron" ]; then
    pass "the reset CronJob runs in Etc/UTC with concurrencyPolicy Forbid"
  fi

  local seed_spec reset_spec
  seed_spec="$(yq 'select(.kind == "Job" and (.metadata.name | test("demo-seed$"))) | .spec.template.spec' "$RENDERED")"
  reset_spec="$(yq 'select(.kind == "CronJob" and (.metadata.name | test("demo-reset$"))) | .spec.jobTemplate.spec.template.spec' "$RENDERED")"
  if [ -z "$seed_spec" ] || [ "$seed_spec" = "null" ]; then
    fail "no demo seed hook Job renders in demo mode"
  elif [ "$seed_spec" != "$reset_spec" ]; then
    fail "the reset CronJob's pod spec differs from the seed hook's — the reset must be exactly the install-time seed, or the published login can end up pointing at an account the reset did not re-password"
  else
    pass "the seed hook and the reset CronJob run the identical pod spec"
  fi
  if ! yq '.containers[0].command | join(" ")' <<< "$seed_spec" | grep -q 'manage.py seed_demo_data .*--demo-site.*--reset-database'; then
    fail "the demo seed does not run 'seed_demo_data ... --demo-site --reset-database' — without the database reset, sessions and visitor leftovers survive the reset"
  else
    pass "the seed/reset command is the whole-database demo reset"
  fi

  local literal
  literal="$(yq '.. | select(tag == "!!map") | select(has("name") and has("value")) | select(.name | test("^DEMO_.*PASSWORD$")) | .name' "$RENDERED" | grep -vE '^(---)?$' || true)"
  if [ -n "$literal" ]; then
    fail "demo password(s) rendered as literal env values: $(sort -u <<< "$literal" | tr '\n' ' ')— they must come from the demo Secret"
  else
    pass "every DEMO_*PASSWORD reaches its pod through a secretKeyRef"
  fi

  local egress selected allowed
  egress="$(yq 'select(.kind == "NetworkPolicy" and (.metadata.name | test("demo-egress$")))' "$RENDERED")"
  if [ -z "$egress" ]; then
    fail "no demo egress NetworkPolicy renders in demo mode (TruePPM ADR-1197 D7)"
  else
    selected="$(yq '.spec.podSelector.matchExpressions[] | select(.key == "app.kubernetes.io/component") | .values[]' <<< "$egress" | sort -u)"
    allowed="$(yq 'select(.kind == "NetworkPolicy" and (.metadata.name | test("allow-backend-postgresql$")))
                   | [.spec.ingress[].from[].podSelector.matchLabels."app.kubernetes.io/component"] | .[]' "$RENDERED" | sort -u)"
    if [ "$(yq '.spec.policyTypes | join(",")' <<< "$egress")" != "Egress" ]; then
      fail "the demo egress policy does not declare policyTypes [Egress]"
    elif [ "$selected" != "$allowed" ]; then
      fail "the demo egress policy selects ($(tr '\n' ' ' <<< "$selected")) but the datastore clients are ($(tr '\n' ' ' <<< "$allowed")) — a datastore client outside it keeps unrestricted egress"
    elif yq '.. | select(tag == "!!map") | select(has("ipBlock"))' <<< "$egress" | grep -q .; then
      fail "the demo egress policy contains an ipBlock — it may only allow DNS and the release's own datastores"
    else
      pass "the demo egress policy covers every datastore client and opens nothing outside the cluster"
    fi
  fi

  local probe_target
  probe_target="$(yq 'select(.kind == "Pod" and (.metadata.name | test("demo-read-only$"))) | .spec.containers[0].env[] | select(.name == "FRONTEND") | .value' "$RENDERED")"
  local frontend_svc
  frontend_svc="$(yq 'select(.kind == "Service" and (.metadata.name | test("frontend$"))) | .metadata.name' "$RENDERED" | head -1)"
  if [ -z "$probe_target" ]; then
    fail "no demo-read-only helm test renders in demo mode — nothing proves the fence after a deploy"
  elif [[ "$probe_target" != "http://${frontend_svc}:"* ]]; then
    fail "the demo helm test targets '$probe_target', not the frontend Service '$frontend_svc' — it must cross the nginx a visitor's request crosses"
  else
    pass "the demo helm test goes through the frontend Service"
  fi

  # (c) reset disabled
  local off_rendered
  off_rendered="$(mktemp)"
  if render_demo "$off_rendered" --set demo.reset.enabled=false; then
    local off_sched off_cron
    off_sched="$(yq 'select(.kind == "Deployment" and (.metadata.name | test("backend$"))) | .spec.template.spec.containers[0].env[] | select(.name == "DEMO_RESET_SCHEDULE") | .value' "$off_rendered")"
    off_cron="$(yq 'select(.kind == "CronJob" and (.metadata.name | test("demo-reset$"))) | .metadata.name' "$off_rendered")"
    if [ -n "$off_cron" ]; then
      fail "demo.reset.enabled=false still renders the reset CronJob '$off_cron'"
    elif [ -n "$off_sched" ]; then
      fail "demo.reset.enabled=false renders DEMO_RESET_SCHEDULE='$off_sched' — the login page would promise a reset that never runs"
    else
      pass "demo.reset.enabled=false: no CronJob, DEMO_RESET_SCHEDULE rendered empty"
    fi
  else
    fail "values-demo.yaml with demo.reset.enabled=false does not render: $(head -3 /tmp/helm-demo-render-err.txt)"
  fi

  RENDERED="$saved"
  rm -f "$demo_rendered" "$off_rendered"
}

# ---------------------------------------------------------------------------
# 10. The demo render guards fail closed (#1180).
# ---------------------------------------------------------------------------
# templates/_validate.tpl refuses demo values that would publish a credential
# on a writable instance, or give a public demo a path out (SSO, SMTP, a media
# PVC, no egress policy). A guard that stopped firing looks exactly like one
# that never fires, so each is asserted: the render must FAIL, and fail with
# its own message — a render that fails for an unrelated reason would otherwise
# pass for the wrong one. The positive control is section 9's demo render.
# Each case: name|message the render must fail with|helm flag[|helm flag...],
# each flag one `--flag=value` token. The demo's secrets arrive as --set-string,
# which Helm applies AFTER every --set, so a case that overrides one of them
# must use --set-string (or --set-json, applied later still) to win.
DEMO_GUARD_CASES=(
  "loginHint set while demo.enabled is false|demo.loginHint is set but demo.enabled is false|--set=demo.enabled=false"
  "loginHint.password missing|are not both set|--set-string=demo.loginHint.password="
  "loginHint.username missing|are not both set|--set-string=demo.loginHint.username="
  "loginHint null|are not both set|--set-json=demo.loginHint=null"
  "username outside the charset|demo.loginHint.username may contain only|--set-string=demo.loginHint.username=vis\"itor"
  "username collides with a seeded account|must not be admin, maya or jordan|--set-string=demo.loginHint.username=Admin"
  "password with a quote|demo.loginHint.password must be 8-128|--set-string=demo.loginHint.password=has\"quote1"
  "password too short|demo.loginHint.password must be 8-128|--set-string=demo.loginHint.password=short"
  "admin password missing|demo.adminPassword is required|--set-string=demo.adminPassword="
  "member password missing|demo.memberPassword is required|--set-string=demo.memberPassword="
  "admin password equals the published one|must differ from demo.loginHint.password|--set-string=demo.adminPassword=structure-check-visitor-pw"
  "OIDC configured|an SSO/OAuth provider is configured|--set=backend.oauth.oidc.serverUrl=https://idp.example.test"
  "GitHub OAuth configured|an SSO/OAuth provider is configured|--set=backend.oauth.github.clientId=abc"
  "SMTP backend|real SMTP is configured|--set=backend.email.backend=smtp"
  "SMTP host|real SMTP is configured|--set=backend.email.host=smtp.example.test|--set=backend.email.fromAddress=noreply@visiban.test"
  "media PVC writable|backend.mediaPersistence.enabled is true|--set=backend.mediaPersistence.enabled=true"
  "DEBUG on|backend.settings.debug is|--set-string=backend.settings.debug=true"
  "DEBUG on via a non-'true' truthy string|backend.settings.debug is|--set-string=backend.settings.debug=yes"
  "DEBUG on via a nonzero integer string|backend.settings.debug is|--set-string=backend.settings.debug=2"
  "DEBUG on via a negative integer string|backend.settings.debug is|--set-string=backend.settings.debug=-1"
  "DEBUG on via a padded truthy string|backend.settings.debug is|--set-string=backend.settings.debug= yes "
  "NetworkPolicy off|networkPolicy.enabled is false|--set=networkPolicy.enabled=false"
  "external database|postgresql.enabled and/or valkey.enabled is false|--set=valkey.enabled=false"
  "numProxies unset|backend.settings.numProxies is not set|--set-json=backend.settings.numProxies=null"
  "numProxies zero|backend.settings.numProxies is less than 1|--set=backend.settings.numProxies=0"
  "reset schedule the backend cannot evaluate|demo.reset.schedule must be a minute/hour cron|--set-string=demo.reset.schedule=0 0 1 * *"
  "malformed user throttle rate|demo.throttle.userRate must look like|--set=demo.throttle.userRate=lots"
  "unsafe-allowedHosts opt-in (#1360)|backend.settings.allowUnsafeHosts is true|--set=backend.settings.allowUnsafeHosts=true"
)

check_demo_guards() {
  section "10. Demo render guards fail closed (#1180)"
  local case_ name expect out bad=0
  out="$(mktemp)"
  for case_ in "${DEMO_GUARD_CASES[@]}"; do
    local fields=()
    IFS='|' read -r -a fields <<< "$case_"
    name="${fields[0]}"
    expect="${fields[1]}"
    local flags=("${fields[@]:2}")
    if render_demo "$out" "${flags[@]}"; then
      fail "demo guard '$name' did not fire: the render SUCCEEDED with ${flags[*]}"
      bad=1
    elif ! grep -qF -- "$expect" /tmp/helm-demo-render-err.txt; then
      fail "demo guard '$name' failed the render, but not with its own message ('$expect'): $(head -2 /tmp/helm-demo-render-err.txt | tr '\n' ' ')"
      bad=1
    fi
  done
  rm -f "$out"
  [ "$bad" -eq 0 ] && pass "all ${#DEMO_GUARD_CASES[@]} demo guards refuse their render, each with its own message"
}

# ---------------------------------------------------------------------------
# 11. Every rendered image carries a pinned tag (#1200).
# ---------------------------------------------------------------------------
# The Helm-side twin of scripts/check-compose-image-pins.sh. The bundled Valkey
# ran the Bitnami subchart's default `bitnami/valkey:latest` on main: every
# install and every pod reschedule pulled whatever `latest` meant that day
# (Valkey 9.x on 2026-09-27, while Compose pinned 8), with no diff and no
# pipeline event. Nothing caught it because the tag was never in this repo — it
# came from a subchart default — so the assertion is on the RENDER, not on
# values.yaml.
#
# A reference is pinned when it carries a digest, or a tag other than `latest`
# after the last `/` (so `registry:5000/img` is untagged, not tagged `5000/img`).
# Checked on three renders: the chart's plain defaults (the quick-start path),
# the main render above (every optional workload on), and values-demo.yaml.
#
# Also asserted here: the bundled-Valkey render guards (_validate.tpl,
# visiban.valkeyGuards). Until chart 0.5.0 the `valkey` block configured the
# Bitnami subchart, so an existing values file can still ask for replicas, a
# password or a Bitnami image; each must fail the render, not be ignored.
# name|message the render must fail with|helm flag[|helm flag...]
VALKEY_GUARD_CASES=(
  "replication architecture|the bundled Valkey is standalone only|--set=valkey.architecture=replication"
  "auth enabled without a password source (#1211)|no password source is set|--set=valkey.auth.enabled=true"
  "auth with both password and existingSecret (#1211)|are both set|--set=valkey.auth.enabled=true|--set=valkey.auth.password=x|--set=valkey.auth.existingSecret=y"
  "non-Docker-Hub registry key|valkey.image.registry is|--set=valkey.image.registry=quay.io"
  "Bitnami repository|a Bitnami image|--set=valkey.image.repository=bitnamilegacy/valkey"
  "latest tag|valkey.image must name a repository and a pinned tag|--set=valkey.image.tag=latest"
  "empty tag|valkey.image must name a repository and a pinned tag|--set-string=valkey.image.tag="
  "null tag|valkey.image must name a repository and a pinned tag|--set-json=valkey.image.tag=null"
  "reuse-values from a subchart release|a Bitnami image|--set=valkey.image.registry=registry-1.docker.io|--set=valkey.image.repository=bitnami/valkey|--set=valkey.image.tag=latest"
)

# The other half of the guards' contract: the fix a guard PRINTS must clear it.
# `helm upgrade --reuse-values` from a subchart-era release carries the
# subchart's registry-1.docker.io / bitnami/valkey / latest, and before this
# case the printed fix left the registry behind and the guard looped on it.
VALKEY_GUARD_FIX_ARGS=(
  --set valkey.image.registry=registry-1.docker.io
  --set valkey.image.repository=bitnami/valkey
  --set valkey.image.tag=latest
  --set valkey.image.repository=valkey/valkey
  --set valkey.image.tag=8-alpine
)

unpinned_images() {
  yq '.. | select(tag == "!!map" and has("image")) | .image | select(tag == "!!str")' "$1" \
    | grep -vE '^(---)?$' | sort -u | while IFS= read -r ref; do
      case "$ref" in *@sha256:*) continue ;; esac
      local after_host="${ref##*/}"
      case "$after_host" in
        *:*) [ "${after_host##*:}" = "latest" ] && echo "$ref (tagged latest)" ;;
        *)   echo "$ref (no tag, resolves to latest)" ;;
      esac
    done
  return 0
}

check_image_pins() {
  section "11. Every rendered image carries a pinned tag (#1200)"

  local default_out demo_out
  default_out="$(mktemp)"; demo_out="$(mktemp)"
  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" \
         --set-string secret.djangoSecretKey=structure-check-not-a-real-secret \
         --set backend.settings.allowedHosts=structure-check.visiban.local \
         > "$default_out" 2>/tmp/helm-default-render-err.txt; then
    fail "the chart's default values do not render: $(cat /tmp/helm-default-render-err.txt)"
    rm -f "$default_out" "$demo_out"
    return
  fi
  if ! render_demo "$demo_out"; then
    fail "values-demo.yaml does not render: $(cat /tmp/helm-demo-render-err.txt)"
    rm -f "$default_out" "$demo_out"
    return
  fi

  local label file bad=0 found total
  for pair in "default:$default_out" "main:$RENDERED" "demo:$demo_out"; do
    label="${pair%%:*}"; file="${pair#*:}"
    total="$(yq '.. | select(tag == "!!map" and has("image")) | .image | select(tag == "!!str")' "$file" | grep -cvE '^(---)?$' || true)"
    if [ "$total" -eq 0 ]; then
      fail "the $label render contains no image at all — the check scanned nothing"
      bad=1
      continue
    fi
    found="$(unpinned_images "$file")"
    if [ -n "$found" ]; then
      while IFS= read -r line; do
        fail "$label render: image $line — its version changes under the release on any pod reschedule; pin a released tag"
      done <<< "$found"
      bad=1
    fi
  done
  rm -f "$default_out" "$demo_out"
  [ "$bad" -eq 0 ] && pass "every image in the default, main and demo renders is pinned"

  # The bundled-Valkey guards: a leftover bitnami/valkey subchart value that
  # would change what runs must fail the render with its own message, never be
  # silently ignored. Same case shape as section 10.
  local case_ name expect out gbad=0
  out="$(mktemp)"
  for case_ in "${VALKEY_GUARD_CASES[@]}"; do
    local fields=()
    IFS='|' read -r -a fields <<< "$case_"
    name="${fields[0]}"; expect="${fields[1]}"
    local flags=("${fields[@]:2}")
    if helm template "$RELEASE" "$CHART_UNDER_TEST" \
         --set-string secret.djangoSecretKey=structure-check-not-a-real-secret \
         --set backend.settings.allowedHosts=structure-check.visiban.local \
         "${flags[@]}" > "$out" 2>/tmp/helm-valkey-guard-err.txt; then
      fail "valkey guard '$name' did not fire: the render SUCCEEDED with ${flags[*]}"
      gbad=1
    elif ! grep -qF -- "$expect" /tmp/helm-valkey-guard-err.txt; then
      fail "valkey guard '$name' failed the render, but not with its own message ('$expect'): $(head -2 /tmp/helm-valkey-guard-err.txt | tr '\n' ' ')"
      gbad=1
    fi
  done
  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" \
         --set-string secret.djangoSecretKey=structure-check-not-a-real-secret \
         --set backend.settings.allowedHosts=structure-check.visiban.local \
         "${VALKEY_GUARD_FIX_ARGS[@]}" > "$out" 2>/tmp/helm-valkey-guard-err.txt; then
    fail "the fix the Valkey image guard prints does not clear it on a --reuse-values-shaped render: $(grep -m1 'Visiban:' /tmp/helm-valkey-guard-err.txt)"
    gbad=1
  fi
  rm -f "$out"
  [ "$gbad" -eq 0 ] && pass "all ${#VALKEY_GUARD_CASES[@]} bundled-Valkey guards refuse their render, each with its own message, and the printed fix clears them"
}

# ---------------------------------------------------------------------------
# 11b. The bundled Valkey's password stays in Secrets (#1211).
# ---------------------------------------------------------------------------
# valkey.auth.enabled=true is opt-in. The password must reach pods ONLY through
# a secretKeyRef — never a ConfigMap, a plain env `value`, or a URL the chart
# renders — and every Valkey client and the server itself must read the SAME
# Secret key, or the install boots with a backend that cannot authenticate.
# Rendered twice: the chart-managed valkey.auth.password (a stress password
# holding "/" and "@", the #1229 characters that split a URL spliced in raw),
# and valkey.auth.existingSecret together with secret.existingSecret.
#
# Asserted per render:
#   a) the password appears nowhere in the render as plaintext — ConfigMap,
#      env value, args, annotations — (chart-managed case; the existingSecret
#      case renders no password at all, by construction);
#   b) every backend-image container that gets REDIS_URL also gets
#      REDIS_URL_PASSWORD from the expected Secret and key, and REDIS_URL /
#      REDIS_CACHE_URL carry no credentials of their own;
#   c) the Valkey container reads REDISCLI_AUTH from that same Secret and key,
#      and starts with --requirepass "$REDISCLI_AUTH";
#   d) backend/ actually LOOKS UP REDIS_URL_PASSWORD (section 3's rule — its
#      own render has auth off, so it never sees this variable).
# And once, on the chart's plain defaults: auth off renders none of it.
VALKEY_AUTH_STRESS_PW='$structure/check@pw:1211#x'

check_valkey_auth() {
  section "11b. The bundled Valkey's password stays in Secrets (#1211)"

  local out err bad=0 mode
  out="$(mktemp)"; err="$(mktemp)"
  for mode in chart-managed existing-secret; do
    local extra=() want_secret want_key
    if [ "$mode" = chart-managed ]; then
      extra=(--set valkey.auth.enabled=true --set-string "valkey.auth.password=$VALKEY_AUTH_STRESS_PW")
      want_secret=""; want_key="valkey-password"  # name read from the render below
    else
      extra=(--set valkey.auth.enabled=true --set valkey.auth.existingSecret=sc-valkey
             --set valkey.auth.existingSecretPasswordKey=sc-key --set secret.existingSecret=sc-runtime)
      want_secret="sc-valkey"; want_key="sc-key"
    fi
    if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" "${extra[@]}" \
          > "$out" 2>"$err"; then
      fail "$mode: the valkey.auth.enabled=true render failed: $(grep -m1 -v '^$' "$err")"
      bad=1; continue
    fi

    if [ "$mode" = chart-managed ]; then
      want_secret="$(yq 'select(.kind == "Secret" and .metadata.labels."app.kubernetes.io/component" == "valkey") | .metadata.name' "$out" | grep -vE '^(---)?$' || true)"
      if [ -z "$want_secret" ] || [ "$(wc -l <<< "$want_secret" | tr -d ' ')" -ne 1 ]; then
        fail "$mode: expected exactly one chart-managed Valkey password Secret, found: '${want_secret//$'\n'/, }'"
        bad=1; continue
      fi
    elif yq 'select(.kind == "Secret" and .metadata.labels."app.kubernetes.io/component" == "valkey") | .metadata.name' "$out" | grep -qvE '^(---)?$'; then
      fail "$mode: the chart renders its own Valkey password Secret although valkey.auth.existingSecret is set"
      bad=1
    fi

    # a) No plaintext password anywhere in the render.
    if grep -qF -- "$VALKEY_AUTH_STRESS_PW" "$out"; then
      fail "$mode: the Valkey password appears as plaintext in the render ($(grep -nF -- "$VALKEY_AUTH_STRESS_PW" "$out" | head -1 | cut -c1-80)…) — it must reach pods only through a secretKeyRef"
      bad=1
    fi

    # b) Every backend-image container with REDIS_URL also reads the password
    # from the expected Secret key, and the URLs carry no credentials.
    local rows cname has_pw pw_ref url_bad clients=0
    rows="$(yq '
      select(.kind == "Deployment" or .kind == "Job" or .kind == "CronJob")
      | (.spec.template // .spec.jobTemplate.spec.template) as $t
      | ($t.spec.containers + ($t.spec.initContainers // []))[]
      | select((.env // []) | map(.name) | contains(["REDIS_URL"]))
      | [ .name,
          ((.env | map(select(.name == "REDIS_URL_PASSWORD")) | length) > 0),
          ((.env | map(select(.name == "REDIS_URL_PASSWORD"))[0].valueFrom.secretKeyRef // {} | (.name // "") + "/" + (.key // ""))),
          ((.env | map(select(.name == "REDIS_URL" or .name == "REDIS_CACHE_URL") | (.value // "") | test("@")) | any))
        ] | @tsv' "$out" | grep -vE '^(---)?$' || true)"
    while IFS=$'\t' read -r cname has_pw pw_ref url_bad; do
      [ -z "$cname" ] && continue
      clients=$((clients + 1))
      if [ "$has_pw" != "true" ]; then
        fail "$mode: container '$cname' gets REDIS_URL but no REDIS_URL_PASSWORD — it cannot authenticate to the bundled Valkey"
        bad=1
      elif [ "$pw_ref" != "$want_secret/$want_key" ]; then
        fail "$mode: container '$cname' reads REDIS_URL_PASSWORD from '$pw_ref', want secretKeyRef '$want_secret/$want_key'"
        bad=1
      fi
      if [ "$url_bad" = "true" ]; then
        fail "$mode: container '$cname' renders credentials into REDIS_URL/REDIS_CACHE_URL as a plain env value"
        bad=1
      fi
    done <<< "$rows"
    if [ "$clients" -eq 0 ]; then
      fail "$mode: no container in the render gets REDIS_URL — the client query matched nothing"
      bad=1
    fi

    # No pod-template annotation may carry anything derived from the password:
    # `get pods` is a weaker permission than `get secrets`, and an unsalted
    # hash of a weak password cracks offline (security-review on #1211).
    local pw_sum
    if command -v sha256sum >/dev/null; then
      pw_sum="$(printf '%s' "$VALKEY_AUTH_STRESS_PW" | sha256sum | cut -d' ' -f1)"
    else
      pw_sum="$(printf '%s' "$VALKEY_AUTH_STRESS_PW" | shasum -a 256 | cut -d' ' -f1)"
    fi
    if [ -z "$pw_sum" ]; then
      fail "$mode: could not hash the stress password (no sha256sum or shasum) — the password-hash check would prove nothing"
      bad=1
    elif grep -qF -- "$pw_sum" "$out"; then
      fail "$mode: a sha256 of the Valkey password appears in the render (an annotation?) — crackable offline by anyone who can read pods"
      bad=1
    fi

    # c) The server reads the same Secret key and requires it.
    local server_ref server_cmd
    server_ref="$(yq 'select(.kind == "StatefulSet" and .spec.template.metadata.labels."app.kubernetes.io/component" == "valkey")
                      | .spec.template.spec.containers[0].env // [] | map(select(.name == "REDISCLI_AUTH"))[0].valueFrom.secretKeyRef // {}
                      | (.name // "") + "/" + (.key // "")' "$out" | grep -vE '^(---)?$' || true)"
    server_cmd="$(yq 'select(.kind == "StatefulSet" and .spec.template.metadata.labels."app.kubernetes.io/component" == "valkey")
                      | .spec.template.spec.containers[0].command | join(" ")' "$out" | grep -vE '^(---)?$' || true)"
    if [ "$server_ref" != "$want_secret/$want_key" ]; then
      fail "$mode: the Valkey container reads REDISCLI_AUTH from '$server_ref', want secretKeyRef '$want_secret/$want_key' — the server and its clients must share one password"
      bad=1
    fi
    case "$server_cmd" in
      *'--requirepass "$REDISCLI_AUTH"'*) ;;
      *) fail "$mode: the Valkey container does not start with --requirepass \"\$REDISCLI_AUTH\" — it would run without a password while the backend presents one"; bad=1 ;;
    esac
  done

  # d) The backend reads REDIS_URL_PASSWORD (same lookup rule as section 3).
  if ! find "$REPO_ROOT/backend" -name '*.py' -exec cat {} + | tr '\n' ' ' \
       | grep -qE "(env|env\.[a-z_]+|os\.getenv|os\.environ\.get)\([[:space:]]*[\"']REDIS_URL_PASSWORD[\"']"; then
    fail "the chart injects REDIS_URL_PASSWORD but nothing under backend/ looks it up — the backend would connect without a password"
    bad=1
  fi

  # Auth off (the default) renders none of it, so existing installs are unchanged.
  if helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" > "$out" 2>/dev/null \
     && grep -qE 'REDIS_URL_PASSWORD|REDISCLI_AUTH|valkey-auth|requirepass' "$out"; then
    fail "the default render (valkey.auth.enabled=false) contains Valkey auth wiring — auth must be opt-in"
    bad=1
  fi
  rm -f "$out" "$err"
  [ "$bad" -eq 0 ] && pass "valkey.auth: the password reaches the server and every client only via one secretKeyRef, never as plaintext; chart-managed and existingSecret both; off by default"
}

# ---------------------------------------------------------------------------
# 11c. An external Valkey/Redis password stays in a Secret (#1361).
# ---------------------------------------------------------------------------
# The external-instance half of 11b. With valkey.enabled=false and
# externalRedis.existingSecret set, every backend-image container that gets
# REDIS_URL must also get REDIS_URL_PASSWORD from that Secret and key — one
# client without it connects unauthenticated and fails only at runtime — and
# the URLs keep their (ACL) username but carry no password.
#
# Backward compatibility is asserted too, because it is half the issue: with
# existingSecret unset, a password embedded in externalRedis.url is rendered
# exactly as given and NO REDIS_URL_PASSWORD appears (settings.py refuses a
# URL password when REDIS_URL_PASSWORD is also set, so emitting it here would
# break every pre-#1361 install). And the two render guards fail closed: a
# URL password alongside existingSecret, and existingSecret with the bundled
# Valkey on.
check_external_redis_auth() {
  section "11c. An external Valkey/Redis password stays in a Secret (#1361)"

  local out err bad=0
  out="$(mktemp)"; err="$(mktemp)"
  local ext=(--set valkey.enabled=false
             --set-string 'externalRedis.url=rediss://sc-user@sc-redis.example:6380/0'
             --set-string 'externalRedis.cacheUrl=rediss://sc-user@sc-redis.example:6380/1')

  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" "${ext[@]}" \
        --set externalRedis.existingSecret=sc-redis --set externalRedis.existingSecretPasswordKey=sc-redis-key \
        > "$out" 2>"$err"; then
    fail "the externalRedis.existingSecret render failed: $(grep -m1 -v '^$' "$err")"
    bad=1
  else
    local rows cname pw_ref url_bad clients=0
    rows="$(yq '
      select(.kind == "Deployment" or .kind == "Job" or .kind == "CronJob")
      | (.spec.template // .spec.jobTemplate.spec.template) as $t
      | ($t.spec.containers + ($t.spec.initContainers // []))[]
      | select((.env // []) | map(.name) | contains(["REDIS_URL"]))
      | [ .name,
          ((.env | map(select(.name == "REDIS_URL_PASSWORD"))[0].valueFrom.secretKeyRef // {} | (.name // "") + "/" + (.key // ""))),
          ((.env | map(select(.name == "REDIS_URL" or .name == "REDIS_CACHE_URL") | (.value // "") | test("://[^/@]*:[^/@]*@")) | any))
        ] | @tsv' "$out" | grep -vE '^(---)?$' || true)"
    while IFS=$'\t' read -r cname pw_ref url_bad; do
      [ -z "$cname" ] && continue
      clients=$((clients + 1))
      if [ "$pw_ref" != "sc-redis/sc-redis-key" ]; then
        fail "container '$cname' gets REDIS_URL but reads REDIS_URL_PASSWORD from '$pw_ref', want secretKeyRef 'sc-redis/sc-redis-key' — it cannot authenticate to the external instance"
        bad=1
      fi
      if [ "$url_bad" = "true" ]; then
        fail "container '$cname' renders a password into REDIS_URL/REDIS_CACHE_URL as a plain env value"
        bad=1
      fi
    done <<< "$rows"
    if [ "$clients" -eq 0 ]; then
      fail "no container in the externalRedis render gets REDIS_URL — the client query matched nothing"
      bad=1
    fi
    if ! grep -qF 'rediss://sc-user@sc-redis.example:6380/0' "$out"; then
      fail "externalRedis.url (with its ACL username) is not rendered as given"
      bad=1
    fi
  fi

  # Backward compatibility: a password kept in the URL, no existingSecret.
  local legacy='redis://:sc-legacy-pw@sc-redis.example:6379/0'
  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" --set valkey.enabled=false \
        --set-string "externalRedis.url=$legacy" \
        --set-string 'externalRedis.cacheUrl=redis://:sc-legacy-pw@sc-redis.example:6379/1' \
        > "$out" 2>"$err"; then
    fail "a pre-#1361 externalRedis.url carrying its own password no longer renders: $(grep -m1 -v '^$' "$err")"
    bad=1
  else
    if grep -q 'REDIS_URL_PASSWORD' "$out"; then
      fail "without externalRedis.existingSecret the render still sets REDIS_URL_PASSWORD — settings.py would refuse the URL's own password and every pre-#1361 install would crash"
      bad=1
    fi
    if ! grep -qF -- "$legacy" "$out"; then
      fail "a pre-#1361 externalRedis.url is no longer rendered unchanged"
      bad=1
    fi
  fi

  # The render guards fail closed.
  if helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" --set valkey.enabled=false \
       --set-string 'externalRedis.url=redis://sc-user:sc-url-pw@sc-redis.example:6379/0' \
       --set-string 'externalRedis.cacheUrl=redis://sc-redis.example:6379/1' \
       --set externalRedis.existingSecret=sc-redis > /dev/null 2>"$err"; then
    fail "externalRedis.existingSecret with a password still in externalRedis.url renders — two password sources must fail the render"
    bad=1
  elif grep -qF 'sc-url-pw' "$err"; then
    fail "the two-password-sources render error echoes the URL's password"
    bad=1
  fi
  if helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
       --set externalRedis.existingSecret=sc-redis > /dev/null 2>&1; then
    fail "externalRedis.existingSecret with the bundled Valkey on renders — the Secret would be silently ignored"
    bad=1
  fi

  rm -f "$out" "$err"
  [ "$bad" -eq 0 ] && pass "externalRedis: the password reaches every client only via existingSecret; URL-embedded passwords still render unchanged; both misconfigurations fail the render"
}

# ---------------------------------------------------------------------------
# 12. Every pod hardens like the bundled Valkey (#1210, #1224).
# ---------------------------------------------------------------------------
# #1200 hardened the bundled Valkey StatefulSet (runAsNonRoot, a read-only root
# filesystem, no Linux capabilities). #1210 brought the bundled PostgreSQL
# StatefulSet and the backend Deployment — its migrate/collectstatic/bootstrap
# init containers included — up to the same bar. #1224 brought the frontend
# (nginx) Deployment up to the same bar too, so this now asserts it on EVERY
# long-running or scheduled workload the chart renders, with no exclusions
# (the scheduledJobs CronJobs, and the demo seed Job / reset CronJob
# included), so the next new template does not quietly regress below it.
#
# Checked on the main render (every optional workload on, including the
# scheduledJobs CronJobs) AND the demo render (the demo seed Job and reset
# CronJob) — the same two renders section 11 already produces.
#
# Two assertions per pod: pod-level securityContext.runAsNonRoot is true, and
# EVERY container (containers and initContainers) drops the ALL capability.
# Not asserted here: readOnlyRootFilesystem and the numeric runAsUser/Group —
# backend.securityContext, postgresql.securityContext and
# frontend.securityContext are deliberately overridable so an operator on an
# unusual image can relax them, so a chart default is not a contract this
# script can enforce without also failing a legitimate override.
check_pod_hardening() {
  section "12. Every pod hardens like the bundled Valkey (#1210, #1224)"

  local query
  query='
    select((.kind == "Deployment" or .kind == "StatefulSet" or .kind == "Job" or .kind == "CronJob"))
    | .kind as $k | .metadata.name as $n
    | (.spec.template // .spec.jobTemplate.spec.template) as $t
    | ($t.spec.securityContext.runAsNonRoot // false) as $podNonRoot
    | ($t.spec.containers + ($t.spec.initContainers // [])) as $cs
    | $cs[]
    | [$k, $n, .name, $podNonRoot, ((.securityContext.capabilities.drop // []) | contains(["ALL"]))] | @tsv
  '

  local demo_out
  demo_out="$(mktemp)"
  if ! render_demo "$demo_out"; then
    fail "values-demo.yaml does not render: $(cat /tmp/helm-demo-render-err.txt)"
    rm -f "$demo_out"
    return
  fi

  local label file k n cname nonroot dropall bad=0 checked=0
  for pair in "main:$RENDERED" "demo:$demo_out"; do
    label="${pair%%:*}"; file="${pair#*:}"
    while IFS=$'\t' read -r k n cname nonroot dropall; do
      [ -z "$k" ] && continue
      checked=$((checked + 1))
      if [ "$nonroot" != "true" ]; then
        fail "$label render: $k/$n's pod securityContext does not set runAsNonRoot: true (container $cname)"
        bad=1
      fi
      if [ "$dropall" != "true" ]; then
        fail "$label render: $k/$n container '$cname' does not drop the ALL capability"
        bad=1
      fi
    done < <(yq "$query" "$file" | grep -vE '^(---)?$')
  done
  rm -f "$demo_out"

  if [ "$checked" -eq 0 ]; then
    fail "the hardening check scanned zero containers — the query matched nothing"
    return
  fi
  [ "$bad" -eq 0 ] && pass "every pod in the main and demo renders sets runAsNonRoot and drops ALL capabilities ($checked containers checked)"
}

# ---------------------------------------------------------------------------
# 13. Database credentials are percent-encoded into database-url.
# ---------------------------------------------------------------------------
# The chart splices the database username and password into a postgres:// URL.
# Raw, a "/" (about half of all `openssl rand -base64` outputs) or "?", "#",
# "[", "]" splits it in the wrong place and the backend refuses to start; "%"
# and a space are mis-decoded. visiban.urlCredential encodes them. Asserted on
# both the bundled-PostgreSQL and externalDatabase branches, against a password
# holding every character class that matters — including "+", which urlquery
# already escapes and a space, which urlquery turns into "+" and the helper must
# rewrite to %20.
check_database_url_encoding() {
  section "13. Database credentials are percent-encoded in database-url"

  local vals out got expected_pw bad=0
  vals="$(mktemp)"; out="$(mktemp)"
  # Single-quoted YAML so every character reaches the chart verbatim.
  cat > "$vals" <<'VALUES'
postgresql:
  auth:
    username: 'us er'
    password: 'a/b+c d@e:f?g#h%i[j]k'
externalDatabase:
  host: db.example.com
  port: 5432
  database: visiban
  username: 'us er'
  password: 'a/b+c d@e:f?g#h%i[j]k'
VALUES
  expected_pw='a%2Fb%2Bc%20d%40e%3Af%3Fg%23h%25i%5Bj%5Dk'

  local mode extra expected
  for mode in bundled external; do
    if [ "$mode" = bundled ]; then
      extra=()
      expected="postgres://us%20er:${expected_pw}@${RELEASE}-postgresql:5432/"
    else
      extra=(--set postgresql.enabled=false)
      expected="postgres://us%20er:${expected_pw}@db.example.com:5432/visiban"
    fi
    if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" -f "$vals" \
          ${extra[@]+"${extra[@]}"} > "$out" 2>/tmp/helm-dburl-err.txt; then
      fail "database-url render ($mode) failed: $(head -2 /tmp/helm-dburl-err.txt | tr '\n' ' ')"
      bad=1; continue
    fi
    got="$(yq 'select(.kind == "Secret" and (.metadata.name | test("visiban$"))) | .stringData."database-url"' "$out")"
    case "$got" in
      "$expected"*) ;;
      *) fail "database-url ($mode) is not percent-encoded as expected: want prefix '$expected', got '$got'"; bad=1 ;;
    esac
  done
  rm -f "$vals" "$out"
  [ "$bad" -eq 0 ] && pass "database-url percent-encodes the username and password on the bundled and external branches"
}

# Render a chart's NOTES.txt with no cluster: `helm template` skips NOTES.txt,
# so copy the chart and add NOTES.txt as a template whose every line is a YAML
# comment, then print just that file. Each source line is prefixed, so the
# template actions are the real NOTES.txt's; a NOTES.txt this cannot render
# fails loudly instead of passing. Extra args are helm flags.
render_notes() {
  local chart="$1" t rc=0; shift
  t="$(mktemp -d)"
  cp -R "$chart" "$t/chart"
  sed 's/^/# /' "$t/chart/templates/NOTES.txt" > "$t/chart/templates/zz-notes-probe.yaml"
  helm template "$RELEASE" "$t/chart" "${RENDER_ARGS[@]}" "$@" \
    --show-only templates/zz-notes-probe.yaml | sed 's/^# //' || rc=$?
  rm -rf "$t"
  return "$rc"
}

# ---------------------------------------------------------------------------
# 14. ALLOWED_HOSTS holds operator-configured hosts only (#1230).
# ---------------------------------------------------------------------------
# The frontend nginx is a catch-all (`server_name _`) that forwards the client's
# Host header, so a localhost/127.0.0.1 entry appended by the chart lets any
# client that reaches the frontend Service directly (NodePort/LoadBalancer,
# host-less Ingress) send `Host: localhost` and be accepted -- defeating the pin
# to the public domain. The in-pod callers that used to need it (kubelet probes,
# helm tests) send an explicit Host instead, so this section also proves every
# backend probe's Host is one ALLOWED_HOSTS accepts: removing the widening
# without moving the callers would take every pod out of rotation.
#
# The operator-opt-in half (#1360): a "*" or loopback entry the operator lists
# themselves re-opens the same exposure, so the render must FAIL on each one
# unless backend.settings.allowUnsafeHosts=true -- matched per exact entry, so
# a hostname that merely contains "localhost" must still render.
check_allowed_hosts_not_widened() {
  section "14. ALLOWED_HOSTS is operator-configured hosts only"

  local expected="structure-check.visiban.local" got bad=0
  got="$(doc Deployment 'backend$' \
    | yq '.spec.template.spec.containers[] | select(.name == "backend")
          | .env[] | select(.name == "ALLOWED_HOSTS") | .value')"
  if [ "$got" != "$expected" ]; then
    fail "ALLOWED_HOSTS renders '$got', want exactly the configured '$expected' -- the chart must not append localhost/127.0.0.1 behind a catch-all nginx that forwards the client Host"
    bad=1
  fi

  local hosts h
  hosts="$(doc Deployment 'backend$' \
    | yq '.spec.template.spec.containers[].livenessProbe.httpGet.httpHeaders[]?
            | select(.name == "Host") | .value,
          .spec.template.spec.containers[].readinessProbe.httpGet.httpHeaders[]?
            | select(.name == "Host") | .value')"
  if [ -z "$hosts" ]; then
    fail "backend probes send no explicit Host header -- kubelet would send <podIP>:<port>, which ALLOWED_HOSTS rejects"
    bad=1
  fi
  while IFS= read -r h; do
    [ -z "$h" ] && continue
    case ",$got," in
      *",$h,"*) ;;
      *) fail "backend probe sends Host '$h', which is not in ALLOWED_HOSTS ('$got') -- every pod would fail its probe"; bad=1 ;;
    esac
  done <<< "$hosts"

  # Value shapes beyond the single host: each is rendered on its own and must
  # (a) pass ALLOWED_HOSTS through verbatim and (b) hand the probes a Host that
  # Django's own matcher accepts -- a leading-dot entry matches the bare domain
  # and its subdomains, "*" matches anything.
  local shape want_probe out probe_hosts allowed ok errf
  errf="$(mktemp)"
  for shape in 'a.com,b.com|a.com' '.a.com|a.com' '*|localhost'; do
    allowed="${shape%%|*}"; want_probe="${shape##*|}"
    out="$(mktemp)"
    # "*" is refused by the #1360 guard unless opted in; the opt-in is what
    # lets this shape prove the probe-Host fallback still works.
    if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
          --set-string "backend.settings.allowedHosts=${allowed//,/\\,}" \
          --set backend.settings.allowUnsafeHosts=true > "$out" 2>"$errf"; then
      fail "allowedHosts='$allowed' does not render: $(head -2 "$errf" | tr '\n' ' ')"
      bad=1; rm -f "$out"; continue
    fi
    got="$(yq 'select(.kind == "Deployment" and (.metadata.name | test("backend$")))
               | .spec.template.spec.containers[] | select(.name == "backend")
               | .env[] | select(.name == "ALLOWED_HOSTS") | .value' "$out")"
    [ "$got" = "$allowed" ] || { fail "allowedHosts='$allowed' renders ALLOWED_HOSTS='$got', want it verbatim"; bad=1; }
    probe_hosts="$(yq 'select(.kind == "Deployment" and (.metadata.name | test("backend$")))
               | .spec.template.spec.containers[].readinessProbe.httpGet.httpHeaders[]?
               | select(.name == "Host") | .value' "$out")"
    [ "$probe_hosts" = "$want_probe" ] || { fail "allowedHosts='$allowed': probe Host is '$probe_hosts', want '$want_probe'"; bad=1; }
    ok=0
    [ "$allowed" = "*" ] && ok=1
    case ",$allowed," in *",$probe_hosts,"*) ok=1 ;; esac
    case ",$allowed," in *",.$probe_hosts,"*) ok=1 ;; esac
    [ "$ok" -eq 1 ] || { fail "allowedHosts='$allowed': probe Host '$probe_hosts' would be rejected by Django"; bad=1; }
    rm -f "$out"
  done

  rm -f "$errf"

  # Empty value: the render-time guard must refuse it.
  if helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
       --set-string 'backend.settings.allowedHosts= ' >/dev/null 2>&1; then
    fail "an empty/blank allowedHosts rendered -- Django would reject every request and no pod would become ready"
    bad=1
  fi

  # Catch-all / loopback entries (#1360): each must fail the render with the
  # guard's own message when the opt-in is left at its default. Deliberately
  # does NOT pass allowUnsafeHosts=false, so a default flipped to true in
  # values.yaml is caught too.
  local unsafe
  errf="$(mktemp)"
  for unsafe in '*' 'localhost' 'LocalHost' ' localhost ' '.localhost' '..localhost' \
                'localhost.localdomain' 'ip6-localhost' '127.0.0.1' '.127.0.0.1' '0.0.0.0' '0' \
                '[::1]' '::1' '[0:0:0:0:0:0:0:1]' '[0::1]' '[::]' '::' '[::ffff:127.0.0.1]' 'a.com,localhost'; do
    if helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
         --set-string "backend.settings.allowedHosts=${unsafe//,/\\,}" >/dev/null 2>"$errf"; then
      fail "allowedHosts='$unsafe' rendered -- a catch-all/loopback entry re-opens Host-header poisoning (#1360) and must need backend.settings.allowUnsafeHosts=true"
      bad=1
    elif ! grep -qF "backend.settings.allowUnsafeHosts=true" "$errf"; then
      fail "allowedHosts='$unsafe' failed the render, but not with the #1360 guard's message: $(head -3 "$errf" | tr '\n' ' ')"
      bad=1
    fi
  done
  # Exact-entry match: hostnames that merely contain a loopback name render.
  for unsafe in 'localhost.example.com' 'mylocalhost' '127.0.0.1.nip.io' '.example.com' '10.0.0.1'; do
    if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
         --set-string "backend.settings.allowedHosts=$unsafe" >/dev/null 2>"$errf"; then
      fail "allowedHosts='$unsafe' was refused -- the #1360 guard must match whole entries, not substrings: $(head -3 "$errf" | tr '\n' ' ')"
      bad=1
    fi
  done
  # The opt-in is not silent: NOTES.txt must name the entries (#1360). `helm
  # template` never renders NOTES.txt, and `helm install --dry-run=client`
  # still dials the cluster on Helm 3.16 (CI's pin) despite its help text, so
  # render_notes renders the real NOTES.txt offline as a comment-only template.
  # A NOTES warning that silently disappeared would otherwise leave every gate
  # green.
  local notes
  if ! notes="$(render_notes "$CHART_UNDER_TEST" \
         --set-string 'backend.settings.allowedHosts=a.com\,LocalHost\,*' \
         --set backend.settings.allowUnsafeHosts=true 2>"$errf")"; then
    fail "NOTES.txt does not render with the opt-in: $(head -3 "$errf" | tr '\n' ' ')"
    bad=1
  elif ! grep -qF 'WARNING: backend.settings.allowedHosts contains "localhost", "*"' <<< "$notes"; then
    fail "allowUnsafeHosts=true with 'a.com,LocalHost,*': NOTES.txt does not warn naming \"localhost\", \"*\" -- the opt-in would be silent (#1360)"
    bad=1
  fi
  if ! notes="$(render_notes "$CHART_UNDER_TEST" --set backend.settings.allowUnsafeHosts=true 2>"$errf")"; then
    fail "NOTES.txt does not render with the opt-in and safe hosts: $(head -3 "$errf" | tr '\n' ' ')"
    bad=1
  elif grep -qF 'WARNING: backend.settings.allowedHosts contains' <<< "$notes"; then
    fail "NOTES.txt warns about unsafe allowedHosts entries when there are none (allowedHosts=structure-check.visiban.local)"
    bad=1
  fi
  # The opt-in renders, and passes the entries through verbatim.
  if ! helm template "$RELEASE" "$CHART_UNDER_TEST" "${RENDER_ARGS[@]}" \
       --set-string 'backend.settings.allowedHosts=a.com\,localhost' \
       --set backend.settings.allowUnsafeHosts=true >/dev/null 2>"$errf"; then
    fail "allowedHosts='a.com,localhost' with allowUnsafeHosts=true does not render: $(head -3 "$errf" | tr '\n' ' ')"
    bad=1
  fi
  rm -f "$errf"

  [ "$bad" -eq 0 ] && pass "ALLOWED_HOSTS is exactly the configured hosts, every backend probe sends one of them, and catch-all/loopback entries need the explicit opt-in"
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
  check_demo_mode
  check_demo_guards
  check_image_pins
  check_valkey_auth
  check_external_redis_auth
  check_pod_hardening
  check_database_url_encoding
  check_allowed_hosts_not_widened
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
    # 8b: a scheduled-job CronJob (#1157) names a command that does not exist —
    # every run fails, and nothing else connects the chart's string to the file.
    "8 renamed scheduled-job command|templates/cronjobs.yaml|s/\"command\" \"prune_notifications\"/\"command\" \"prune_notification\"/"
    # 1 (#1180): the demo seed hook stops deleting itself on success, so a
    # completed Job outlives `helm uninstall`.
    "1 demo seed hook kept after success|templates/demo-seed-job.yaml|s/before-hook-creation,hook-succeeded/before-hook-creation/"
    # 9a: a demo object leaks into the default render.
    "9 demo Secret renders with demo off|templates/demo-secret.yaml|s/{{- if include \"visiban.demoEnabled\" . }}/{{- if true }}/"
    # 9b: the fence is not armed on the backend.
    "9 DEMO_MODE not true|templates/_backend-env.tpl|/- name: DEMO_MODE/{n;s/\"true\"/\"false\"/;}"
    # 9b: the countdown and the CronJob drift apart (TruePPM ADR-1197 D9).
    "9 reset schedule not shared with the countdown|templates/demo-reset-cronjob.yaml|s/schedule: {{ \$schedule | quote }}/schedule: \"30 * * * *\"/"
    # 9b: the reset loses the whole-database wipe.
    "9 reset command loses --reset-database|templates/_helpers.tpl|s/, \"--reset-database\"]/]/"
    # 9b + 7: the seed/reset pods fall off the datastore allow-list.
    "9 demo-seed missing from the allow-list|templates/_helpers.tpl|s/ demo-seed{{ end }}/{{ end }}/"
    # 9b: the egress policy opens the internet.
    "9 egress policy opened to the internet|templates/networkpolicy.yaml|s|        - namespaceSelector: {}|        - ipBlock: {cidr: 0.0.0.0/0}|"
    # 9b: the helm test bypasses the frontend.
    "9 demo helm test skips the frontend|templates/tests/demo-read-only.yaml|s/-frontend:{{ .Values.frontend.service.port }}/-backend:{{ .Values.backend.service.port }}/"
    # 10: the most dangerous guard stops firing.
    "10 loginHint-without-demo guard removed|templates/_validate.tpl|s/{{- if and (or \$user \$pass) (not (include \"visiban.demoEnabled\" .)) -}}/{{- if false -}}/"
    # 11 (#1200): the bundled Valkey loses its tag — the exact drift this issue
    # was, reintroduced in the template rather than in values.
    "11 valkey image loses its tag|templates/valkey.yaml|s/image: \"{{ .Values.valkey.image.repository }}:{{ .Values.valkey.image.tag }}\"/image: \"{{ .Values.valkey.image.repository }}\"/"
    # 11: a floating `latest` through values, on the one datastore image whose
    # schema entry is a free string.
    "11 postgresql image floats on latest|values.yaml|s/image: \"postgres:17\"/image: \"postgres:latest\"/"
    # 11 (#1211): the no-password-source guard stops firing, so auth.enabled
    # with no password renders a Valkey that refuses to start.
    "11 valkey auth no-source guard removed|templates/_validate.tpl|s/{{- if and (eq \$pw \"\") (eq \$es \"\") -}}/{{- if false -}}/"
    # 11b (#1211): the password leaks into the Valkey ConfigMap.
    "11b valkey password written into the ConfigMap|templates/valkey.yaml|s/^    # (#1211), never written here: this file is a ConfigMap. Protected mode/    requirepass {{ .Values.valkey.auth.password }}/"
    # 11b: the backend loses the password env (a rename settings.py never reads).
    "11b backend loses REDIS_URL_PASSWORD|templates/_backend-env.tpl|s/- name: REDIS_URL_PASSWORD/- name: REDIS_PASSWORD/"
    # 11b: a crackable hash of the password comes back as a pod annotation.
    "11b password sha256 in a pod annotation|templates/valkey.yaml|s/checksum\/config: {{ .Values.valkey.commonConfiguration | toString | sha256sum }}/checksum\/config: {{ printf \"%v\" .Values.valkey.auth.password | sha256sum }}/"
    # 11b: the server starts without --requirepass while clients present one.
    "11b valkey server started without requirepass|templates/valkey.yaml|s/ --requirepass \"\$REDISCLI_AUTH\"'/'/"
    # 11c (#1361): one backend container loses the external password env.
    "11c external REDIS_URL_PASSWORD not wired|templates/_backend-env.tpl|s/key: {{ include \"visiban.externalRedisAuthSecretKey\" \$ctx }}/key: wrong-key/"
    # 11c: the external password is emitted even without existingSecret,
    # which breaks every install that keeps its password in the URL.
    "11c REDIS_URL_PASSWORD emitted without existingSecret|templates/_helpers.tpl|s/(dig \"existingSecret\" \"\" (.Values.externalRedis | default dict))/true/"
    # 11c: the two-password-sources guard stops firing.
    "11c URL-password-plus-existingSecret guard removed|templates/_validate.tpl|s/{{- if contains \":\" \$userinfo -}}/{{- if false -}}/"
    # 11c: the bundled-Valkey-plus-existingSecret guard stops firing.
    "11c existingSecret-with-bundled-Valkey guard removed|templates/_validate.tpl|/externalRedis.existingSecret is set, but valkey.enabled is true/d"
    "10 SMTP guard removed|templates/_validate.tpl|s/{{- if or (eq (toString .Values.backend.email.backend) \"smtp\") .Values.backend.email.host -}}/{{- if false -}}/"
    # 12 (#1210, #1224): every overridable hardened workload (backend,
    # postgresql, frontend) loses its capability drop through their shared
    # values.yaml default at once.
    "12 capabilities.drop ALL removed from values|values.yaml|s/drop: \[\"ALL\"\]/drop: []/"
    # 13: the credential helper stops encoding — the pre-fix behavior.
    "13 database credentials spliced raw|templates/_helpers.tpl|s/{{- . | urlquery | replace \"+\" \"%20\" }}/{{- . }}/"
    # 13: the space rewrite is dropped, so a space decodes as a literal "+".
    "13 space left as + in database-url|templates/_helpers.tpl|s/ | replace \"+\" \"%20\" }}/ }}/"
    # 14 (#1230): the localhost/127.0.0.1 widening comes back.
    "14 ALLOWED_HOSTS widened with localhost|templates/_backend-env.tpl|s/value: {{ \$ctx.Values.backend.settings.allowedHosts | quote }}/value: {{ printf \"%s,127.0.0.1,localhost\" \$ctx.Values.backend.settings.allowedHosts | quote }}/"
    # 14: the probes send a Host ALLOWED_HOSTS does not accept.
    "14 probe Host not in ALLOWED_HOSTS|templates/backend-deployment.yaml|s/value: {{ include \"visiban.probeHost\" . | quote }}/value: localhost/"
    # 14: the empty-allowedHosts render guard stops firing.
    "14 empty allowedHosts guard removed|templates/_validate.tpl|s/{{- if eq (trim (toString .Values.backend.settings.allowedHosts)) \"\" }}/{{- if false }}/"
    # 14 (#1360): the catch-all/loopback guard stops firing.
    "14 unsafe allowedHosts guard removed|templates/_validate.tpl|s/{{- if and \$unsafeHosts (not .Values.backend.settings.allowUnsafeHosts) }}/{{- if false }}/"
    # 14: the guard degrades to a substring match ("localhost.example.com" refused).
    "14 unsafe allowedHosts matched as substrings|templates/_helpers.tpl|s/{{- if and (or (has \$bare \$unsafe)/{{- if and (or (contains \"localhost\" \$bare) (has \$bare \$unsafe)/"
    # 14: leading dots no longer stripped, so ".127.0.0.1" (Django: matches 127.0.0.1) slips through.
    "14 leading-dot form not normalized|templates/_helpers.tpl|s/regexReplaceAll \"^[^\"]*\" \$e \"\"/\$e/"
    # 14: the opt-in defaults to on, so the guard never fires on a default install.
    "14 allowUnsafeHosts defaults to true|values.yaml|s/allowUnsafeHosts: false/allowUnsafeHosts: true/"
    # 14 (#1360): the NOTES.txt opt-in warning disappears, so the opt-in is silent.
    "14 NOTES opt-in warning removed|templates/NOTES.txt|s/{{- if and \$unsafeHosts .Values.backend.settings.allowUnsafeHosts }}/{{- if false }}/"
    # 10 (#1360): the demo stops refusing the unsafe-hosts opt-in.
    "10 demo unsafe-hosts opt-in guard removed|templates/_validate.tpl|s/{{- if .Values.backend.settings.allowUnsafeHosts -}}/{{- if false -}}/"
  )

  for fixture in "${fixtures[@]}"; do
    local name file prog broken
    name="${fixture%%|*}"
    file="$(cut -d'|' -f2 <<< "$fixture")"
    prog="$(cut -d'|' -f3- <<< "$fixture")"

    broken="$tmp/$(echo "$name" | tr ' #()' '____')"
    rm -rf "$broken"
    # Copied WHOLE, subchart tarballs included: Chart.yaml declares postgresql
    # as a dependency, so a copy without charts/ fails to render at
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
  local control="$tmp/control" control_log="$tmp/control-run.log"
  cp -R "$CHART_DIR" "$control"
  if ( RENDERED="$tmp/control.yaml"; render "$control" "$RENDERED"; FAILURES=0; run_all_checks > "$control_log" 2>&1; [ "$FAILURES" -eq 0 ] ); then
    echo "  ✓ control: the undamaged chart passes"
    passes=$((passes + 1))
  else
    # Unlike every fixture above, a control failure has no injected damage to
    # name — it means the undamaged chart itself trips one of the checks, so
    # the failing check's own output is the only lead. Printed here rather
    # than left in $control_log, which this function deletes on return.
    echo "  ✗ SELF-TEST FAIL: the undamaged chart does not pass — every fixture result above is meaningless" >&2
    sed 's/^/      /' "$control_log" >&2
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
