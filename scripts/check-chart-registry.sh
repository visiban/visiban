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
#       It then asserts the resolved chart is cosign-signed (#2373): helm-publish
#       signs every chart keyless from a release tag pipeline, so a chart at that
#       path with no signature from that identity was published outside the job.
#
#   check-chart-registry.sh --candidate <version>
#       PUBLISH guard (helm-publish, before `helm push`). Refuses, in order:
#       - a STABLE chart version cut from a pre-release tag (CI_COMMIT_TAG
#         contains `-`, e.g. v1.3.0-beta.1). That is the #1155 root cause itself:
#         a plain `0.8.0` carrying beta images outranks every `0.8.0-*` and
#         becomes what a bare `helm install` resolves to. Unset CI_COMMIT_TAG
#         (a dry run) skips this one rule.
#       - a version that is ALREADY published. `helm push` overwrites the tag, so
#         a re-push silently changes what `--version <v>` installs for everyone
#         who pinned it, and leaves the old cosign signature pointing at a digest
#         the tag no longer names.
#       - a pre-release `X.Y.Z-*` when a stable `X.Y.Z` is already published:
#         the new chart could never outrank it. Publishing a pre-release AFTER
#         its stable is shadowing by definition, whereas the reverse order
#         (betas, then the stable) is the ordinary release path.
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
#                      (replaces image_exists entirely)
# CHART_MANIFEST_STATUS_OF  command: prints the registry's HTTP status for the
#                      image manifest in $1 (replaces only the network read, so
#                      the status-to-verdict mapping in image_exists is tested)
# CHART_DIGEST_OF      command: prints the manifest digest of the chart version in $1
#                      (replaces the registry HEAD read)
# CHART_COSIGN         the cosign binary or stub                       (cosign)
# CHART_SIGN_IDENTITY_REGEXP / CHART_SIGN_ISSUER
#                      the signer constraints; default to the identity helm-publish
#                      signs with (docs/administration/image-verification.md)
# CI_COMMIT_TAG        the release tag (GitLab sets it); --candidate refuses a
#                      stable chart version when this is a pre-release tag
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
# Keyless identity helm-publish signs the chart with: the tag pipeline of
# visiban/visiban only (no heads/main alternative, unlike the images). Must match
# docs/administration/image-verification.md and IDENTITY_TAG in
# scripts/check-release-attestations.sh.
CHART_SIGN_IDENTITY_REGEXP="${CHART_SIGN_IDENTITY_REGEXP:-^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*\$}"
CHART_SIGN_ISSUER="${CHART_SIGN_ISSUER:-https://gitlab.com}"
CHART_COSIGN="${CHART_COSIGN:-cosign}"

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
  if [ "${2:-}" = image-missing ]; then
    cat <<EOF

First confirm the image really is gone, not just unreadable from this job:
  docker manifest inspect ${IMAGE_REGISTRY}/<image>:v<appVersion>
If it can be republished (re-run the release tag's image jobs), do that; the chart
is then healthy again and nothing needs deleting. Only if the image cannot come
back, remove the chart version so a bare \`helm install\` stops resolving to it.
EOF
  else
    echo
    echo "Remove the offending version from the registry."
  fi
  cat <<EOF

Deleting a chart version from the registry: a pipeline cannot do it: it needs
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
  local cand="$1" base="" versions stable tag="${CI_COMMIT_TAG:-}"
  if [[ "$cand" =~ $PRE_RE ]]; then
    base="${BASH_REMATCH[1]}"
  elif ! [[ "$cand" =~ $STABLE_RE ]]; then
    die "candidate '$cand' is not a valid chart version"
  fi
  # A pre-release tag must never publish a plain stable chart: that chart would
  # outrank the whole X.Y.Z-* line and carry pre-release images (#1155). Checked
  # before any registry read, so it holds even when the registry is unreadable.
  if [ -z "$base" ] && [[ "$tag" == *-* ]]; then
    echo "check-chart-registry: FAIL  refusing to publish stable chart $cand from pre-release tag $tag." >&2
    echo "A plain $cand outranks every $cand-* under semver and Helm skips pre-releases, so a bare" >&2
    echo "\`helm install oci://${GHCR_HOST}/${CHART_REPO}\` would resolve to this pre-release build." >&2
    echo "Publish it as $cand-${tag#*-} instead (helm package --version)." >&2
    return 1
  fi
  # Plain assignment, not `local x=$(…)` and not `list_versions | grep … || true`:
  # either would swallow list_versions' exit 2, and an unreadable registry would
  # read as "no stable version to shadow" — the gate failing open.
  versions="$(list_versions)"
  if printf '%s\n' "$versions" | grep -Fxq -- "$cand"; then
    echo "check-chart-registry: FAIL  refusing to publish $cand: it is already in ${GHCR_HOST}/${CHART_REPO}." >&2
    echo "\`helm push\` would overwrite it, silently changing what \`--version $cand\` installs for" >&2
    echo "everyone who pinned it. Bump \`version:\` in helm/visiban/Chart.yaml and re-run the job." >&2
    return 1
  fi
  if [ -z "$base" ]; then
    echo "check-chart-registry: OK  $cand is a stable version not yet published; nothing can shadow it."
    return 0
  fi
  stable="$(printf '%s\n' "$versions" | grep -Fx "$base" || true)"
  if [ -n "$stable" ]; then
    echo "check-chart-registry: FAIL  refusing to publish $cand: stable $base is already in ${GHCR_HOST}/${CHART_REPO}." >&2
    echo "Semver ranks $base above $cand, and Helm skips pre-releases unless --version is given, so an" >&2
    echo "operator running \`helm install oci://${GHCR_HOST}/${CHART_REPO}\` — with or without --devel —" >&2
    echo "would keep getting $base and never this chart." >&2
    remediation "$base" >&2
    return 1
  fi
  echo "check-chart-registry: OK  $cand is not yet published and no stable $base in the registry shadows it."
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
  # Only a 404 means "not there". A 401/403 (token), 429 (rate limit), 5xx or
  # 000 (no connection) means the job could not see, and must not be reported
  # as a missing image with "delete the chart" remediation: exit 2, fail closed.
  local code
  code="$(manifest_status "$1")" || return 2
  case "$code" in
    200) return 0 ;;
    404) return 1 ;;
    *)   echo "check-chart-registry: registry answered HTTP ${code:-none} for $1" >&2; return 2 ;;
  esac
}

manifest_status() {
  if [ -n "${CHART_MANIFEST_STATUS_OF:-}" ]; then
    $CHART_MANIFEST_STATUS_OF "$1"
    return
  fi
  local repo="${1#${IMAGE_REGISTRY}/}" tag token
  tag="${repo##*:}"
  repo="${repo%:*}"
  token="$(curl -fsS --max-time 30 --retry 3 \
    "https://${IMAGE_REGISTRY}/token?scope=repository:${repo}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || return 2
  [ -n "$token" ] || return 2
  # curl prints 000 itself when it cannot connect; image_exists maps that to 2.
  curl -s -o /dev/null -w '%{http_code}' -I --max-time 30 --retry 3 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://${IMAGE_REGISTRY}/v2/${repo}/manifests/${tag}" || true
}

# The by-digest reference is what helm-publish signed (a tag can move, a digest
# cannot), so resolve the tag to its digest first and verify that.
chart_digest() {
  if [ -n "${CHART_DIGEST_OF:-}" ]; then
    $CHART_DIGEST_OF "$1"
    return
  fi
  local token
  token="$(curl -fsS --max-time 30 --retry 3 \
    "https://${GHCR_HOST}/token?scope=repository:${CHART_REPO}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || return 2
  [ -n "$token" ] || return 2
  curl -fsSI --max-time 30 --retry 3 -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://${GHCR_HOST}/v2/${CHART_REPO}/manifests/$1" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}'
}

# 0 = signed by the helm-publish identity, 1 = no valid signature, 2 = could not run.
chart_signed() {
  local ver="$1" digest ref out rc=0
  command -v "$CHART_COSIGN" >/dev/null 2>&1 || [ -x "$CHART_COSIGN" ] \
    || die "cosign ($CHART_COSIGN) is not installed; cannot verify the signature of chart $ver"
  digest="$(chart_digest "$ver")" || die "could not resolve the digest of chart $ver"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "could not resolve the digest of chart $ver (got '${digest}')"
  ref="${GHCR_HOST}/${CHART_REPO}@${digest}"
  out="$("$CHART_COSIGN" verify "$ref" \
    --certificate-identity-regexp "$CHART_SIGN_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$CHART_SIGN_ISSUER" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  printf '%s\n' "$out" | sed 's/^/  cosign: /' >&2
  return 1
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
    remediation "$default" image-missing >&2
    return 1
  fi
  if ! chart_signed "$default"; then
    echo "check-chart-registry: FAIL  chart $default, which a bare \`helm install oci://${GHCR_HOST}/${CHART_REPO}\` resolves to," \
         "has no valid cosign signature from the helm-publish identity ($CHART_SIGN_IDENTITY_REGEXP, issuer $CHART_SIGN_ISSUER)." >&2
    echo "helm-publish signs every chart it pushes, so an unsigned or differently-signed artifact at this path was" >&2
    echo "published outside that job. Investigate who pushed it before deleting anything; the version in the" >&2
    echo "registry may be the only evidence. Charts at or before v1.2.0-alpha.2 are unsigned (#1284)." >&2
    return 1
  fi
  echo "check-chart-registry: OK  bare \`helm install\` resolves to chart $default; its default images ($tag) exist and the chart is signed by the helm-publish identity."
}

# --- self-test --------------------------------------------------------------
self_test() {
  local fails=0 self
  self="${BASH_SOURCE[0]}"
  run() { # <env assignments…> -- <args…>; sets OUT and RC
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    # Default stubs: a signed chart, so cases about other properties never reach
    # the network for the digest or need a real cosign. Later assignments win.
    set +e; OUT="$(env CHART_DIGEST_OF="${DIGEST_STUB:-}" CHART_COSIGN="${COSIGN_STUB:-}" \
      SELFTEST_SIGNER="https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/tags/v1.3.0" \
      "${envs[@]}" bash "$self" "$@" 2>&1)"; RC=$?; set -e
  }
  expect() { # <desc> <expected rc> [fragment]
    local ok=1
    [ "$RC" -eq "$2" ] || ok=0
    if [ -n "${3:-}" ] && ! grep -qF -- "$3" <<<"$OUT"; then ok=0; fi
    if [ "$ok" -eq 1 ]; then echo "  ok    $1"; else echo "  FAIL  $1 (rc=$RC, wanted $2${3:+, output containing '$3'})"; echo "$OUT" | sed 's/^/        /'; fails=$((fails+1)); fi
  }
  local probe_ok="true" probe_beta_only
  probe_beta_only="$(mktemp)"
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

  # Signing stub: models a chart signed by $SELFTEST_SIGNER (empty = unsigned) and
  # applies the REAL identity regexp / issuer the script passes, so a loosened or
  # mistyped constraint fails here rather than only against Sigstore.
  local cosign_stub digest_cmd; cosign_stub="$(mktemp)"; digest_cmd="$(mktemp)"; DIGEST_STUB="$digest_cmd"; COSIGN_STUB="$cosign_stub"
  cat > "$cosign_stub" <<'COSIGN'
#!/usr/bin/env bash
re=""; iss=""
while [ $# -gt 0 ]; do
  case "$1" in
    --certificate-identity-regexp) re="$2"; shift 2 ;;
    --certificate-oidc-issuer) iss="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "${SELFTEST_SIGNER:-}" ] || { echo "Error: no signatures found" >&2; exit 1; }
[ "$iss" = "https://gitlab.com" ] || { echo "Error: issuer mismatch ($iss)" >&2; exit 1; }
[[ "$SELFTEST_SIGNER" =~ $re ]] || { echo "Error: none of the expected identities matched" >&2; exit 1; }
COSIGN
  printf '#!/usr/bin/env bash\necho sha256:%s\n' "$(printf 'a%.0s' $(seq 64))" > "$digest_cmd"
  chmod +x "$cosign_stub" "$digest_cmd"
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
  run CHART_TAGS="0.3.0" CI_COMMIT_TAG=v1.3.0-beta.1 -- --candidate 0.4.0
  expect "the #1155 root cause: a stable chart from a pre-release tag is refused" 1 "refusing to publish stable chart 0.4.0 from pre-release tag v1.3.0-beta.1"
  expect "  …and it names the suffixed version to publish instead" 1 "0.4.0-beta.1 instead"
  run GHCR_HOST=127.0.0.1:9 CI_COMMIT_TAG=v1.3.0-rc.1 -- --candidate 0.4.0
  expect "  …refused before any registry read (holds when GHCR is down)" 1 "from pre-release tag"
  run CHART_TAGS="0.3.0 0.4.0-beta.1" CI_COMMIT_TAG=v1.3.0-beta.2 -- --candidate 0.4.0-beta.2
  expect "a suffixed chart from a pre-release tag is accepted" 0
  run CHART_TAGS="0.3.0 0.4.0-beta.1" CI_COMMIT_TAG=v1.3.0 -- --candidate 0.4.0
  expect "a stable chart from a stable tag is accepted" 0
  run CHART_TAGS="0.3.0 0.4.0" CI_COMMIT_TAG=v1.3.1 -- --candidate 0.4.0
  expect "an already-published stable version is refused (no overwrite)" 1 "already in"
  run CHART_TAGS="0.4.0-beta.1 0.4.0-beta.2" -- --candidate 0.4.0-beta.2
  expect "an already-published pre-release version is refused (no overwrite)" 1 "already in"

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
  local status_cmd; status_cmd="$(mktemp)"
  printf '#!/usr/bin/env bash\necho "${SELFTEST_HTTP_CODE}"\n' > "$status_cmd"
  chmod +x "$status_cmd"
  run CHART_TAGS="0.4.0" CHART_APPVERSION_OF="$appv_cmd" CHART_MANIFEST_STATUS_OF="$status_cmd" SELFTEST_HTTP_CODE=200 --
  expect "manifest HTTP 200 is an existing image" 0 "resolves to chart 0.4.0"
  run CHART_TAGS="0.4.0" CHART_APPVERSION_OF="$appv_cmd" CHART_MANIFEST_STATUS_OF="$status_cmd" SELFTEST_HTTP_CODE=404 --
  expect "manifest HTTP 404 is a missing image (exit 1)" 1 "MISSING ghcr.io/visiban/visiban/backend:v0.4.0"
  expect "  …and the remediation says to confirm and republish before deleting" 1 "First confirm the image really is gone"
  local code
  for code in 401 429 503 000; do
    run CHART_TAGS="0.4.0" CHART_APPVERSION_OF="$appv_cmd" CHART_MANIFEST_STATUS_OF="$status_cmd" SELFTEST_HTTP_CODE=$code --
    expect "manifest HTTP $code is 'could not ask' (exit 2), never MISSING" 2 "could not query"
  done
  rm -f "$status_cmd"

  local signed_env=(CHART_TAGS="0.4.0" CHART_APPVERSION_OF="$appv_cmd" CHART_IMAGE_PROBE="$probe_ok")
  echo "chart signature (#2373):"
  run "${signed_env[@]}" SELFTEST_SIGNER="https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/tags/v1.3.0" --
  expect "signed by the helm-publish tag identity: pass" 0 "signed by the helm-publish identity"
  run "${signed_env[@]}" SELFTEST_SIGNER="" --
  expect "unsigned chart: fail" 1 "no valid cosign signature"
  expect "  …and the message names the identity constraint" 1 "refs/tags/v"
  run "${signed_env[@]}" SELFTEST_SIGNER="https://gitlab.com/someone-else/fork//.gitlab-ci.yml@refs/tags/v1.3.0" --
  expect "signed by another identity: fail" 1 "no valid cosign signature"
  run "${signed_env[@]}" SELFTEST_SIGNER="https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/heads/main" --
  expect "signed from main, not a tag pipeline: fail" 1 "no valid cosign signature"
  run "${signed_env[@]}" CHART_COSIGN=/nonexistent/cosign --
  expect "cosign missing: exit 2, never a pass" 2 "not installed"
  rm -f "$cosign_stub" "$digest_cmd"

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
