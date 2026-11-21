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
# The pick is the newest GA tag whose release images are published on GHCR; if
# the newest is not published yet (the tag pipeline publishes them) it falls
# back to the previous GA with a warning. --no-image-check skips that (offline).
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

# Is the release's backend image published? Release images are pushed by the
# tag pipeline, so a tag can exist minutes before its images do; a drill that
# started in that window would fail at the pull. Anonymous registry manifest
# HEAD, following the token handshake GHCR requires even for public pulls.
# TAG_IMAGE_CHECK_CMD (a command taking the tag; exit 0 = published) replaces
# the network call, and is honored ONLY under --self-test (SELF_TEST=1).
tag_image_available() {
  local tag="$1"
  if [ "${SELF_TEST:-0}" = "1" ] && [ -n "${TAG_IMAGE_CHECK_CMD:-}" ]; then
    ${TAG_IMAGE_CHECK_CMD} "${tag}"
    return
  fi
  local repo="visiban/visiban/backend" token code
  token="$(curl -fsS --max-time 20 "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
  [ -n "${token}" ] || return 1
  code="$(curl -sS -o /dev/null -I --max-time 20 -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${repo}/manifests/${tag}" 2>/dev/null)" || return 1
  [ "${code}" = "200" ]
}

# Reads tag names on stdin; prints the newest GA tag whose images are published.
# Falls back to an older GA, loudly, when the newest is not yet published.
# Exit 1 = no GA tag at all, or none with published images.
pick_available_ga() {
  local tags tag first="" any=0
  tags="$(list_ga_desc)"
  [ -n "${tags}" ] || return 1
  while IFS= read -r tag; do
    [ -n "${first}" ] || first="${tag}"
    if tag_image_available "${tag}"; then
      if [ "${tag}" != "${first}" ]; then
        echo "WARNING: newest GA ${first} has no published images yet (its tag pipeline may still be running); upgrading from ${tag} instead" >&2
      fi
      printf '%s\n' "${tag}"
      any=1
      break
    fi
  done <<<"${tags}"
  if [ "${any}" -eq 0 ]; then
    echo "no GA tag has published release images (checked ghcr.io/visiban/visiban/backend)" >&2
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
  # Image availability: the stub is honored only because SELF_TEST=1 is set here.
  export SELF_TEST=1
  local tags=$'v1.1.0\nv1.2.0\nv1.3.0-beta.1'
  TAG_IMAGE_CHECK_CMD="true"
  export TAG_IMAGE_CHECK_CMD
  got="$(printf '%s\n' "${tags}" | pick_available_ga 2>/dev/null || true)"
  if [ "${got}" = "v1.2.0" ]; then echo "  ok   newest GA with images is picked"
  else echo "  FAIL newest available: got '${got}'" >&2; fails=$((fails + 1)); fi
  TAG_IMAGE_CHECK_CMD="test_stub_not_v120"
  test_stub_not_v120() { [ "$1" != "v1.2.0" ]; }
  got="$(printf '%s\n' "${tags}" | pick_available_ga 2>/dev/null || true)"
  if [ "${got}" = "v1.1.0" ]; then echo "  ok   falls back to the previous GA when the newest is unpublished"
  else echo "  FAIL fallback: got '${got}'" >&2; fails=$((fails + 1)); fi
  if printf '%s\n' "${tags}" | pick_available_ga 2>&1 >/dev/null | grep -q 'WARNING'; then
    echo "  ok   fallback warns loudly"
  else echo "  FAIL fallback must warn" >&2; fails=$((fails + 1)); fi
  TAG_IMAGE_CHECK_CMD="false"
  if printf '%s\n' "${tags}" | pick_available_ga >/dev/null 2>&1; then
    echo "  FAIL no published images must fail" >&2; fails=$((fails + 1))
  else echo "  ok   no GA with images fails"; fi
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
  local remote="origin" mode="remote" fetch=1 check=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --self-test) self_test; return ;;
      --filter) mode="filter" ;;
      --local) mode="local" ;;
      --remote) remote="${2:?--remote needs a name}"; shift ;;
      --no-fetch) fetch=0 ;;
      --no-image-check) check=0 ;;
      -h|--help) sed -n '2,32p' "$0"; return 0 ;;
      *) echo "unknown argument: $1" >&2; return 2 ;;
    esac
    shift
  done

  local tag
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
