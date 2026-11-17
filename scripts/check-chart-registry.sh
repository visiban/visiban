#!/usr/bin/env bash
# scripts/check-chart-registry.sh — the published Helm chart must be installable
# by the command we tell operators to run, and a release must never publish a
# chart that hides its own pre-releases (#1155).
#
# Why this exists. The `v0.4.0-beta.1` cut published a chart under the plain
# version `0.4.0`, before scripts/release.sh bumped Chart.yaml (#1155). Semver
# sorts `0.4.0` ABOVE every `0.4.0-beta.N`, and Helm ignores pre-releases unless
# asked, so `helm install oci://…` — with no --version, and even with --devel —
# resolved to that chart forever. It was broken (its default image tag `v0.4.0`
# was never published) and unsigned. #1155 stops the chart being cut with a stale
# version; it does not notice the artifact already sitting in the registry, and
# nothing reads the registry after a tag ships. A version disappearing or going
# wrong there is not a diff event: no commit to review, no job to go red.
#
# Two modes, one script:
#
#   check-chart-registry.sh
#       DEFAULT-RESOLUTION check (nightly). Resolves what a bare `helm install`
#       gets — the highest STABLE version, because Helm skips pre-releases — reads
#       its appVersion, and requires the image tag the chart would pull
#       (`v<appVersion>`, the chart's own default) to exist for every default
#       image. It asserts the property operators depend on rather than a proxy for
#       it: "a stable and its betas coexist" is the NORMAL state once 0.4.0 ships
#       correctly, so that rule would go permanently red the day it is fixed.
#
#   check-chart-registry.sh --candidate <version>
#       PUBLISH guard (helm:publish, before `helm push`). Refuses to push a
#       pre-release `X.Y.Z-*` when a stable `X.Y.Z` is already published: the new
#       chart could never outrank it. Stateless in the right way — publishing a
#       pre-release AFTER its stable is shadowing by definition, whereas the
#       reverse order (betas, then the stable) is the ordinary release path.
#
#   check-chart-registry.sh --self-test
#       Proves both modes can still fail, in the job that runs them (#3194).
#
# ## Overrides (used by --self-test; also handy for a dry run)
#
# CHART_REPO           GHCR repository path            (visiban/charts/visiban)
# GHCR_HOST            registry host                   (ghcr.io)
# CHART_TAGS           whitespace-separated tag list; skips the network read
# CHART_APPVERSION_OF  command: prints the appVersion of the chart version in $1
# CHART_IMAGE_PROBE    command: exits 0 when the image reference in $1 exists
# CHART_DEFAULT_IMAGES space-separated `<repo>` paths under $GHCR_HOST
#                      (must match image.repository / image.webRepository in
#                      helm/visiban/values.yaml)
#
# Exit codes:  0 healthy · 1 the registry state is wrong · 2 could not read the
# registry, or invocation error. A read failure is deliberately NOT exit 0: a
# gate that goes quiet when it cannot see is the failure mode it exists to end.

set -euo pipefail

CHART_REPO="${CHART_REPO:-visiban/charts/visiban}"
GHCR_HOST="${GHCR_HOST:-ghcr.io}"
CHART_DEFAULT_IMAGES="${CHART_DEFAULT_IMAGES:-visiban/visiban/backend visiban/visiban/frontend}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-$GHCR_HOST}"

STABLE_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
PRE_RE='^([0-9]+\.[0-9]+\.[0-9]+)-[0-9A-Za-z.-]+$'

die() { echo "check-chart-registry: $*" >&2; exit 2; }

# The registry's tag list also carries cosign's `sha256-<digest>[.sig|.att]` tags;
# keep only chart versions.
list_versions() {
  local raw
  if [ "${CHART_TAGS+set}" = set ]; then
    raw="$(printf '%s\n' $CHART_TAGS)"
  else
    local token body
    token="$(curl -fsS --max-time 30 --retry 3 \
      "https://${GHCR_HOST}/token?scope=repository:${CHART_REPO}:pull" 2>/dev/null \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
    [ -n "$token" ] || die "could not get an anonymous pull token from ${GHCR_HOST} for ${CHART_REPO}"
    body="$(curl -fsS --max-time 30 --retry 3 -H "Authorization: Bearer ${token}" \
      "https://${GHCR_HOST}/v2/${CHART_REPO}/tags/list?n=1000" 2>/dev/null)" \
      || die "could not read the tag list for ${GHCR_HOST}/${CHART_REPO}"
    raw="$(printf '%s' "$body" | sed -n 's/.*"tags":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d '"')"
  fi
  printf '%s\n' "$raw" | grep -E "${STABLE_RE}|${PRE_RE}" || true
}

remediation() {
  cat <<EOF

Remove the offending version from the registry. A pipeline cannot do it: it needs
someone with admin rights on the package, or a token with read:packages and
delete:packages. ghcr.io is GitHub's registry, so this is a GitHub-side action even
though the repository and CI are on GitLab.

  Web UI (no CLI):
    https://github.com/orgs/visiban/packages  ->  charts/visiban  ->  Package settings
    ->  Manage versions  ->  delete "$1" (and any leftover sha256-... version)

  API (curl; \$GH_TOKEN needs read:packages + delete:packages):
    curl -sH "Authorization: Bearer \$GH_TOKEN" \\
      "https://api.github.com/orgs/visiban/packages/container/charts%2Fvisiban/versions"
    # pick the "id" whose metadata.container.tags contains "$1", then:
    curl -X DELETE -H "Authorization: Bearer \$GH_TOKEN" \\
      "https://api.github.com/orgs/visiban/packages/container/charts%2Fvisiban/versions/<id>"

  (The GitHub CLI works too: gh api -X DELETE on the same paths.)

Then confirm with:  helm show chart oci://${GHCR_HOST}/${CHART_REPO} --devel
EOF
}

# --- publish guard ----------------------------------------------------------
check_candidate() {
  local cand="$1" base versions stable
  if [[ "$cand" =~ $PRE_RE ]]; then
    base="${BASH_REMATCH[1]}"
  elif [[ "$cand" =~ $STABLE_RE ]]; then
    echo "check-chart-registry: OK  $cand is a stable version; nothing can shadow it."
    return 0
  else
    die "candidate '$cand' is not a valid chart version"
  fi
  # Plain assignment, not `local x=$(…)` and not `list_versions | grep … || true`:
  # either would swallow list_versions' exit 2, and an unreadable registry would
  # read as "no stable version to shadow" — the gate failing open.
  versions="$(list_versions)"
  stable="$(printf '%s\n' "$versions" | grep -Fx "$base" || true)"
  if [ -n "$stable" ]; then
    echo "check-chart-registry: FAIL  refusing to publish $cand: stable $base is already in ${GHCR_HOST}/${CHART_REPO}." >&2
    echo "Semver ranks $base above $cand, and Helm skips pre-releases unless --version is given, so an" >&2
    echo "operator running \`helm install oci://${GHCR_HOST}/${CHART_REPO}\` — with or without --devel —" >&2
    echo "would keep getting $base and never this chart." >&2
    remediation "$base" >&2
    return 1
  fi
  echo "check-chart-registry: OK  no stable $base in the registry to shadow $cand."
}

# --- default-resolution check -----------------------------------------------
app_version_of() {
  if [ -n "${CHART_APPVERSION_OF:-}" ]; then
    $CHART_APPVERSION_OF "$1"
    return
  fi
  local token manifest cfg
  token="$(curl -fsS --max-time 30 --retry 3 \
    "https://${GHCR_HOST}/token?scope=repository:${CHART_REPO}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || die "could not get a pull token to read chart $1"
  manifest="$(curl -fsS --max-time 30 --retry 3 -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://${GHCR_HOST}/v2/${CHART_REPO}/manifests/$1" | tr -d '\n ')" \
    || die "could not read the manifest for chart $1"
  cfg="$(printf '%s' "$manifest" | sed -n 's/.*"config":{[^}]*"digest":"\(sha256:[a-f0-9]*\)".*/\1/p')"
  [ -n "$cfg" ] || die "chart $1 manifest has no config digest"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --max-time 30 --retry 3 \
    -H "Authorization: Bearer ${token}" \
    "https://${GHCR_HOST}/v2/${CHART_REPO}/blobs/${cfg}" | tr -d '\n ' \
    | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p'
}

image_exists() {
  if [ -n "${CHART_IMAGE_PROBE:-}" ]; then
    $CHART_IMAGE_PROBE "$1"
    return
  fi
  # 0 = exists, 1 = the registry answered and it is not there, 2 = could not ask.
  local repo="${1#${IMAGE_REGISTRY}/}" tag token code
  tag="${repo##*:}"
  repo="${repo%:*}"
  token="$(curl -fsS --max-time 30 --retry 3 \
    "https://${IMAGE_REGISTRY}/token?scope=repository:${repo}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || return 2
  code="$(curl -s -o /dev/null -w '%{http_code}' -I --max-time 30 --retry 3 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://${IMAGE_REGISTRY}/v2/${repo}/manifests/${tag}")"
  [ "$code" = "200" ]
}

check_default() {
  local versions stables default appv tag ref rc bad=0
  versions="$(list_versions)"
  [ -n "$versions" ] || die "no chart versions found in ${GHCR_HOST}/${CHART_REPO} — is the registry readable?"
  stables="$(printf '%s\n' "$versions" | grep -E "${STABLE_RE}" | sort -V || true)"
  if [ -z "$stables" ]; then
    echo "check-chart-registry: OK  no stable chart version is published, so a bare \`helm install\` fails" \
         "loudly (no version to resolve) rather than installing anything. Pre-release only: $(printf '%s' "$versions" | tr '\n' ' ')"
    return 0
  fi
  default="$(printf '%s\n' "$stables" | tail -n 1)"
  appv="$(app_version_of "$default")"
  [ -n "$appv" ] || die "could not read appVersion of chart $default"
  tag="v${appv}"
  for repo in $CHART_DEFAULT_IMAGES; do
    ref="${IMAGE_REGISTRY}/${repo}:${tag}"
    rc=0; image_exists "$ref" || rc=$?
    case "$rc" in
      0) echo "check-chart-registry: ok    $ref exists" ;;
      1) echo "check-chart-registry: MISSING $ref" >&2; bad=1 ;;
      *) die "could not query ${IMAGE_REGISTRY} for $ref" ;;
    esac
  done
  if [ "$bad" -ne 0 ]; then
    echo "check-chart-registry: FAIL  \`helm install oci://${GHCR_HOST}/${CHART_REPO}\` resolves to chart $default" \
         "(appVersion $appv), whose default image tag $tag does not exist — a stock install cannot pull it." >&2
    remediation "$default" >&2
    return 1
  fi
  echo "check-chart-registry: OK  bare \`helm install\` resolves to chart $default; its default images ($tag) exist."
}

# --- self-test --------------------------------------------------------------
self_test() {
  local fails=0 self
  self="${BASH_SOURCE[0]}"
  run() { # <env assignments…> -- <args…>; sets OUT and RC
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    set +e; OUT="$(env "${envs[@]}" bash "$self" "$@" 2>&1)"; RC=$?; set -e
  }
  expect() { # <desc> <expected rc> [fragment]
    local ok=1
    [ "$RC" -eq "$2" ] || ok=0
    if [ -n "${3:-}" ] && ! grep -qF -- "$3" <<<"$OUT"; then ok=0; fi
    if [ "$ok" -eq 1 ]; then echo "  ok    $1"; else echo "  FAIL  $1 (rc=$RC, wanted $2${3:+, output containing '$3'})"; echo "$OUT" | sed 's/^/        /'; fails=$((fails+1)); fi
  }
  local probe_ok="true" probe_beta_only="$(mktemp)"
  cat > "$probe_beta_only" <<'PROBE'
#!/usr/bin/env bash
case "$1" in *:v0.4.0-beta.3) exit 0 ;; *) exit 1 ;; esac
PROBE
  chmod +x "$probe_beta_only"
  local appv_cmd; appv_cmd="$(mktemp)"
  cat > "$appv_cmd" <<'APPV'
#!/usr/bin/env bash
case "$1" in 0.4.0) echo 0.4.0 ;; 0.4.0-beta.3) echo 0.4.0-beta.3 ;; 0.3.0) echo 0.3.0 ;; esac
APPV
  chmod +x "$appv_cmd"

  echo "publish guard:"
  run CHART_TAGS="0.4.0 0.4.0-beta.2 0.4.0-beta.3 sha256-3aada.sig" -- --candidate 0.4.0-beta.4
  expect "the #1155 case: beta.4 refused while stable 0.4.0 is published" 1 "refusing to publish 0.4.0-beta.4"
  expect "  …and the message names the version to delete and how" 1 "delete:packages"
  run CHART_TAGS="0.4.0-beta.2 0.4.0-beta.3" -- --candidate 0.4.0-beta.4
  expect "beta.4 accepted when no stable 0.4.0 exists" 0
  run CHART_TAGS="0.4.0-beta.2 0.4.0-beta.3" -- --candidate 0.4.0
  expect "the stable release itself is accepted after its betas" 0
  run CHART_TAGS="0.3.0 0.4.0-beta.1" -- --candidate 0.4.0-beta.2
  expect "an older stable line does not block a newer pre-release" 0
  run CHART_TAGS="0.4.0" -- --candidate 0.4.0-rc.1
  expect "an rc after its stable is refused too" 1 "refusing to publish 0.4.0-rc.1"
  run CHART_TAGS="" -- --candidate not-a-version
  expect "a malformed candidate is an invocation error, not a pass" 2
  run GHCR_HOST=127.0.0.1:9 -- --candidate 0.4.0-beta.4
  expect "an unreadable registry fails closed (exit 2), not open" 2 "could not"

  echo "default-resolution check:"
  run CHART_TAGS="0.4.0 0.4.0-beta.2 0.4.0-beta.3" CHART_APPVERSION_OF="$appv_cmd" CHART_IMAGE_PROBE="$probe_beta_only" --
  expect "the #1155 case: bare install resolves to 0.4.0, whose v0.4.0 image is missing" 1 "MISSING ghcr.io/visiban/visiban/backend:v0.4.0"
  expect "  …and it names the chart Helm resolves to" 1 "resolves to chart 0.4.0"
  run CHART_TAGS="0.4.0 0.4.0-beta.2 0.4.0-beta.3" CHART_APPVERSION_OF="$appv_cmd" CHART_IMAGE_PROBE="$probe_ok" --
  expect "healthy: stable 0.4.0 whose default images exist, betas alongside" 0 "resolves to chart 0.4.0"
  run CHART_TAGS="0.4.0-beta.2 0.4.0-beta.3" CHART_APPVERSION_OF="$appv_cmd" CHART_IMAGE_PROBE="$probe_ok" --
  expect "pre-release only: a bare install fails loudly, which is fine" 0 "fails loudly"
  run CHART_TAGS="0.3.0 0.4.0 0.4.0-beta.3" CHART_APPVERSION_OF="$appv_cmd" CHART_IMAGE_PROBE="$probe_beta_only" --
  expect "the HIGHEST stable is the one checked (0.4.0, not 0.3.0)" 1 "resolves to chart 0.4.0"
  run CHART_TAGS="sha256-3aada sha256-be9e.sig" CHART_APPVERSION_OF="$appv_cmd" --
  expect "cosign tags are not chart versions: nothing found is an error" 2
  run GHCR_HOST=127.0.0.1:9 --
  expect "an unreadable registry fails closed (exit 2), not open" 2 "could not"

  rm -f "$probe_beta_only" "$appv_cmd"
  echo
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST FAILED: $fails case(s)."; return 1; fi
  echo "SELF-TEST OK: publish guard and default-resolution check both fail when they should."
}

case "${1:-}" in
  --self-test)  self_test ;;
  --candidate)  [ -n "${2:-}" ] || die "--candidate needs a version"; check_candidate "$2" ;;
  "")           check_default ;;
  *)            die "usage: $0 [--self-test | --candidate <version>]" ;;
esac
