#!/usr/bin/env bash
# scripts/resolve-last-ga-tag.sh — print the latest GA release tag (#2463).
#
# The upgrade drills (scripts/compose-upgrade-drill.sh, scripts/helm-upgrade-drill.sh)
# install "the last release" and upgrade it to HEAD. That tag is resolved here,
# never hardcoded, so the drills move forward on their own when a release ships.
#
# GA means exactly `vMAJOR.MINOR.PATCH`. Pre-releases (`-alpha.N`, `-beta.N`,
# `-rc.N`) are excluded: operators are told to run GA, so GA is the populated
# schema an upgrade actually starts from. Ordering is numeric per component
# (v1.10.0 > v1.9.3), not lexical.
#
# In a fork MR pipeline `origin` is the fork, so CI_MERGE_REQUEST_PROJECT_URL
# (the target project) is used, but only when the source project differs from
# the target; same-project MRs (incl. the private enterprise mirror) use
# `origin`. --remote overrides both.
# Tags are listed from the REMOTE (`git ls-remote`), not the local clone: CI
# clones are shallow and carry no tags, so a local `git tag` lists nothing (or a
# stale subset) and the drill would silently start from the wrong release. The
# chosen tag is then fetched (depth 1) only if it is not already present, so the
# drills can `git archive` its compose file and chart.
#
# Usage:
#   scripts/resolve-last-ga-tag.sh [--remote <name>] [--no-fetch] [--no-image-check]
#   scripts/resolve-last-ga-tag.sh --local        # list local tags instead (offline)
#   scripts/resolve-last-ga-tag.sh --filter       # read tag names on stdin, print the pick
#   scripts/resolve-last-ga-tag.sh --self-test
#
# The pick is the newest GA tag whose backend and frontend images and OCI chart
# are all published; if the newest is not published yet (the tag pipeline
# publishes them) it falls back to the previous GA with a warning. --no-image-check skips that (offline).
#
# Prints the tag on stdout; diagnostics go to stderr.
# Exit: 0 = tag printed, 1 = no GA tag found, 2 = usage / git error.

set -euo pipefail

# Reads tag names (or `git ls-remote` lines) on stdin, prints every GA tag,
# newest first.
list_ga_desc() {
  sed -E 's#^.*refs/tags/##; s#\^\{\}$##' \
    | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
    | sed 's/^v//' \
    | sort -u -t. -k1,1nr -k2,2nr -k3,3nr \
    | sed 's/^/v/'
}

# Reads tag names on stdin, prints the latest GA tag.
pick_latest_ga() {
  local picked
  picked="$(list_ga_desc | head -n 1)" || true
  [ -n "${picked}" ] || return 1
  printf '%s\n' "${picked}"
}

# Anonymous GHCR manifest HEAD for <repo>:<ref>, following the token handshake
# GHCR requires even for public pulls. Exit 0 = the manifest exists.
ghcr_manifest_exists() {
  local repo="$1" ref="$2" token code
  token="$(curl -fsS --max-time 20 "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
  [ -n "${token}" ] || return 1
  code="$(curl -sS -o /dev/null -I --max-time 20 -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${repo}/manifests/${ref}" 2>/dev/null)" || return 1
  [ "${code}" = "200" ]
}

# The chart version a tag shipped, from its helm/visiban/Chart.yaml. Fetches
# the tag (depth 1) when it is not in the clone: CI clones are shallow.
tag_chart_version() {
  local tag="$1" remote
  remote="$(tag_remote)"
  if ! git rev-parse -q --verify "refs/tags/${tag}^{commit}" >/dev/null 2>&1; then
    git fetch -q --no-tags --depth=1 "${remote}" "refs/tags/${tag}:refs/tags/${tag}" >&2 || return 1
  fi
  git show "${tag}:helm/visiban/Chart.yaml" 2>/dev/null \
    | sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}.*/\1/p' | head -n 1
}

# Is one release artifact published? kind = backend | frontend | chart. The
# tag pipeline publishes these in stages (helm-publish runs last), so a tag can
# exist minutes before all of them do, and a drill started in that window fails
# at the pull. TAG_IMAGE_CHECK_CMD (a command taking <kind> <tag>; exit 0 =
# published) replaces the network calls, and is honored ONLY under --self-test
# (SELF_TEST=1).
tag_artifact_available() {
  local kind="$1" tag="$2" version
  if [ "${SELF_TEST:-0}" = "1" ] && [ -n "${TAG_IMAGE_CHECK_CMD:-}" ]; then
    ${TAG_IMAGE_CHECK_CMD} "${kind}" "${tag}"
    return
  fi
  case "${kind}" in
    backend) ghcr_manifest_exists "visiban/visiban/backend" "${tag}" ;;
    frontend) ghcr_manifest_exists "visiban/visiban/frontend" "${tag}" ;;
    chart)
      version="$(tag_chart_version "${tag}")" || return 1
      [ -n "${version}" ] || return 1
      ghcr_manifest_exists "visiban/charts/visiban" "${version}" ;;
    *) return 1 ;;
  esac
}

# Prints the first missing artifact kind for a tag; exit 0 if all are published.
tag_missing_artifact() {
  local kind
  for kind in backend frontend chart; do
    if ! tag_artifact_available "${kind}" "$1"; then
      printf '%s\n' "${kind}"
      return 1
    fi
  done
}

# The remote tags are listed and fetched from. In a fork MR pipeline `origin`
# is the fork, whose tags are stale, so the target project is used instead.
# Same-project MRs keep `origin`: the target URL would be an anonymous HTTPS
# ls-remote, which fails in a private project such as the enterprise mirror.
tag_remote() {
  if [ -n "${REMOTE_OVERRIDE:-}" ]; then
    printf '%s\n' "${REMOTE_OVERRIDE}"
  elif [ -n "${CI_MERGE_REQUEST_PROJECT_URL:-}" ] \
    && [ -n "${CI_MERGE_REQUEST_SOURCE_PROJECT_ID:-}" ] \
    && [ "${CI_MERGE_REQUEST_SOURCE_PROJECT_ID}" != "${CI_MERGE_REQUEST_PROJECT_ID:-}" ]; then
    printf '%s.git\n' "${CI_MERGE_REQUEST_PROJECT_URL}"
  else
    printf 'origin\n'
  fi
}

# Reads tag names on stdin; prints the newest GA tag whose artifacts are all
# published. Falls back to an older GA, loudly, when the newest is not yet.
# Exit 1 = no GA tag at all, or none with every artifact published.
pick_available_ga() {
  local tags tag first="" any=0 missing
  tags="$(list_ga_desc)"
  [ -n "${tags}" ] || return 1
  while IFS= read -r tag; do
    [ -n "${first}" ] || first="${tag}"
    if missing="$(tag_missing_artifact "${tag}")"; then
      if [ "${tag}" != "${first}" ]; then
        echo "WARNING: newest GA ${first} is not fully published yet (its tag pipeline may still be running); upgrading from ${tag} instead" >&2
      fi
      printf '%s\n' "${tag}"
      any=1
      break
    fi
    echo "WARNING: ${tag} is missing its published ${missing} artifact" >&2
  done <<<"${tags}"
  if [ "${any}" -eq 0 ]; then
    echo "no GA tag has all release artifacts published (checked backend and frontend images and the OCI chart on ghcr.io)" >&2
    return 1
  fi
}

self_test() {
  local fails=0 got
  expect() {
    local name="$1" want="$2" input="$3"
    got="$(printf '%s\n' "${input}" | pick_latest_ga || true)"
    if [ "${got}" = "${want}" ]; then
      echo "  ok   ${name}"
    else
      echo "  FAIL ${name}: want '${want}', got '${got}'" >&2
      fails=$((fails + 1))
    fi
  }
  echo "resolve-last-ga-tag.sh --self-test"
  expect "pre-releases newer than the GA are excluded" "v1.2.0" \
    "$(printf '%s\n' v1.1.0 v1.2.0-alpha.1 v1.2.0-rc.1 v1.2.0 v1.3.0-alpha.1 v1.3.0-beta.2 v1.3.0-rc.1)"
  expect "numeric, not lexical, ordering" "v1.10.0" \
    "$(printf '%s\n' v1.9.3 v1.10.0 v1.2.0)"
  expect "patch ordering" "v1.2.10" \
    "$(printf '%s\n' v1.2.9 v1.2.10 v1.2.1)"
  expect "malformed / unprefixed tags are ignored" "v1.0.0" \
    "$(printf '%s\n' v1.0.0 1.4.0 v1.4 v2.0.0rc1 release-1.5.0 v3.0.0.1)"
  expect "git ls-remote lines, peeled refs included" "v1.2.0" \
    "$(printf 'aaa\trefs/tags/v1.1.0\nbbb\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.2.0^{}\nccc\trefs/tags/v1.3.0-beta.1\n')"
  expect "only pre-releases yields nothing" "" \
    "$(printf '%s\n' v1.0.0-alpha.1 v1.0.0-rc.1)"
  expect "empty input yields nothing" "" ""
  if printf '%s\n' v1.0.0-rc.1 | pick_latest_ga >/dev/null; then
    echo "  FAIL no-GA input must return non-zero" >&2
    fails=$((fails + 1))
  else
    echo "  ok   no-GA input returns non-zero"
  fi
  # Artifact availability: the stub is honored only because SELF_TEST=1 is set here.
  # It takes <kind> <tag>.
  export SELF_TEST=1
  local tags=$'v1.1.0\nv1.2.0\nv1.3.0-beta.1'
  TAG_IMAGE_CHECK_CMD="true"
  export TAG_IMAGE_CHECK_CMD
  got="$(printf '%s\n' "${tags}" | pick_available_ga 2>/dev/null || true)"
  if [ "${got}" = "v1.2.0" ]; then echo "  ok   newest GA with artifacts is picked"
  else echo "  FAIL newest available: got '${got}'" >&2; fails=$((fails + 1)); fi
  test_stub_not_v120() { [ "$2" != "v1.2.0" ]; }
  test_stub_no_chart_v120() { ! { [ "$1" = "chart" ] && [ "$2" = "v1.2.0" ]; }; }
  test_stub_no_frontend_v120() { ! { [ "$1" = "frontend" ] && [ "$2" = "v1.2.0" ]; }; }
  local stub label
  for stub in test_stub_not_v120 test_stub_no_chart_v120 test_stub_no_frontend_v120; do
    TAG_IMAGE_CHECK_CMD="${stub}"
    label="${stub#test_stub_}"
    got="$(printf '%s\n' "${tags}" | pick_available_ga 2>/dev/null || true)"
    if [ "${got}" = "v1.1.0" ]; then echo "  ok   falls back to the previous GA (${label})"
    else echo "  FAIL fallback (${label}): got '${got}'" >&2; fails=$((fails + 1)); fi
    if printf '%s\n' "${tags}" | pick_available_ga 2>&1 >/dev/null | grep 'WARNING' >/dev/null; then
      echo "  ok   fallback warns loudly (${label})"
    else echo "  FAIL fallback must warn (${label})" >&2; fails=$((fails + 1)); fi
  done
  TAG_IMAGE_CHECK_CMD="test_stub_no_chart_v120"
  if printf '%s\n' "${tags}" | pick_available_ga 2>&1 >/dev/null | grep 'missing its published chart' >/dev/null; then
    echo "  ok   warning names the missing artifact"
  else echo "  FAIL warning must name the missing chart" >&2; fails=$((fails + 1)); fi
  TAG_IMAGE_CHECK_CMD="false"
  if printf '%s\n' "${tags}" | pick_available_ga >/dev/null 2>&1; then
    echo "  FAIL no published artifacts must fail" >&2; fails=$((fails + 1))
  else echo "  ok   no GA with artifacts fails"; fi
  # Remote selection: a fork MR pipeline must list the target project's tags.
  got="$(unset CI_MERGE_REQUEST_PROJECT_URL CI_MERGE_REQUEST_SOURCE_PROJECT_ID CI_MERGE_REQUEST_PROJECT_ID REMOTE_OVERRIDE; tag_remote)"
  if [ "${got}" = "origin" ]; then echo "  ok   remote defaults to origin"
  else echo "  FAIL remote default: got '${got}'" >&2; fails=$((fails + 1)); fi
  got="$(unset REMOTE_OVERRIDE; CI_MERGE_REQUEST_PROJECT_URL=https://gitlab.com/visiban/visiban CI_MERGE_REQUEST_PROJECT_ID=7 CI_MERGE_REQUEST_SOURCE_PROJECT_ID=7 tag_remote)"
  if [ "${got}" = "origin" ]; then echo "  ok   same-project MR uses origin"
  else echo "  FAIL same-project MR remote: got '${got}'" >&2; fails=$((fails + 1)); fi
  got="$(unset REMOTE_OVERRIDE; CI_MERGE_REQUEST_PROJECT_URL=https://gitlab.com/visiban/visiban CI_MERGE_REQUEST_PROJECT_ID=7 CI_MERGE_REQUEST_SOURCE_PROJECT_ID=9 tag_remote)"
  if [ "${got}" = "https://gitlab.com/visiban/visiban.git" ]; then echo "  ok   fork MR uses the target project"
  else echo "  FAIL fork MR remote: got '${got}'" >&2; fails=$((fails + 1)); fi
  unset TAG_IMAGE_CHECK_CMD SELF_TEST
  if [ "${fails}" -ne 0 ]; then
    echo "resolve-last-ga-tag.sh --self-test: ${fails} failure(s)" >&2
    return 1
  fi
  echo "resolve-last-ga-tag.sh --self-test: all passed"
}

# $1 = 1 to require published images (default), 0 to skip the registry check.
pick_for_mode() {
  if [ "$1" = "1" ]; then pick_available_ga; else pick_latest_ga; fi
}

main() {
  local remote="" mode="remote" fetch=1 check=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --self-test) self_test; return ;;
      --filter) mode="filter" ;;
      --local) mode="local" ;;
      --remote) REMOTE_OVERRIDE="${2:?--remote needs a name}"; shift ;;
      --no-fetch) fetch=0 ;;
      --no-image-check) check=0 ;;
      -h|--help) sed -n '2,32p' "$0"; return 0 ;;
      *) echo "unknown argument: $1" >&2; return 2 ;;
    esac
    shift
  done

  local tag
  remote="$(tag_remote)"
  case "${mode}" in
    filter)
      pick_latest_ga || { echo "no GA tag in input" >&2; return 1; }
      return ;;
    local)
      tag="$(git tag -l 'v*' | pick_for_mode "${check}")" \
        || { echo "no usable local GA tag (vX.Y.Z)" >&2; return 1; } ;;
    remote)
      local listing
      listing="$(git ls-remote --tags --refs "${remote}" 'v*')" \
        || { echo "git ls-remote ${remote} failed" >&2; return 2; }
      tag="$(printf '%s\n' "${listing}" | pick_for_mode "${check}")" \
        || { echo "no usable GA tag (vX.Y.Z) on ${remote}" >&2; return 1; } ;;
  esac

  if [ "${fetch}" -eq 1 ] && ! git rev-parse -q --verify "refs/tags/${tag}^{commit}" >/dev/null; then
    echo "fetching ${tag} from ${remote} (depth 1)" >&2
    git fetch -q --no-tags --depth=1 "${remote}" "refs/tags/${tag}:refs/tags/${tag}" >&2 \
      || { echo "could not fetch ${tag}" >&2; return 2; }
  fi
  printf '%s\n' "${tag}"
}

main "$@"
