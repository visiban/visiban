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
#   scripts/resolve-last-ga-tag.sh [--remote <name>] [--no-fetch]
#   scripts/resolve-last-ga-tag.sh --local        # list local tags instead (offline)
#   scripts/resolve-last-ga-tag.sh --filter       # read tag names on stdin, print the pick
#   scripts/resolve-last-ga-tag.sh --self-test
#
# Prints the tag on stdout; diagnostics go to stderr.
# Exit: 0 = tag printed, 1 = no GA tag found, 2 = usage / git error.

set -euo pipefail

# Reads tag names (or `git ls-remote` lines) on stdin, prints the latest GA tag.
pick_latest_ga() {
  local picked
  picked="$(
    sed -E 's#^.*refs/tags/##; s#\^\{\}$##' \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
      | sed 's/^v//' \
      | sort -u -t. -k1,1n -k2,2n -k3,3n \
      | tail -n 1
  )" || true
  [ -n "${picked}" ] || return 1
  printf 'v%s\n' "${picked}"
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
  if [ "${fails}" -ne 0 ]; then
    echo "resolve-last-ga-tag.sh --self-test: ${fails} failure(s)" >&2
    return 1
  fi
  echo "resolve-last-ga-tag.sh --self-test: all passed"
}

main() {
  local remote="origin" mode="remote" fetch=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --self-test) self_test; return ;;
      --filter) mode="filter" ;;
      --local) mode="local" ;;
      --remote) remote="${2:?--remote needs a name}"; shift ;;
      --no-fetch) fetch=0 ;;
      -h|--help) sed -n '2,27p' "$0"; return 0 ;;
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
      tag="$(git tag -l 'v*' | pick_latest_ga)" \
        || { echo "no local GA tag (vX.Y.Z)" >&2; return 1; } ;;
    remote)
      local listing
      listing="$(git ls-remote --tags --refs "${remote}" 'v*')" \
        || { echo "git ls-remote ${remote} failed" >&2; return 2; }
      tag="$(printf '%s\n' "${listing}" | pick_latest_ga)" \
        || { echo "no GA tag (vX.Y.Z) on ${remote}" >&2; return 1; } ;;
  esac

  if [ "${fetch}" -eq 1 ] && ! git rev-parse -q --verify "refs/tags/${tag}^{commit}" >/dev/null; then
    echo "fetching ${tag} from ${remote} (depth 1)" >&2
    git fetch -q --no-tags --depth=1 "${remote}" "refs/tags/${tag}:refs/tags/${tag}" >&2 \
      || { echo "could not fetch ${tag}" >&2; return 2; }
  fi
  printf '%s\n' "${tag}"
}

main "$@"
