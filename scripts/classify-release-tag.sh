#!/usr/bin/env bash
# scripts/classify-release-tag.sh — single source of truth for whether a
# release tag is "stable" (gets the :latest/:MAJOR.MINOR registry aliases) or
# "pre-release" (gets neither — only its own exact :<tag>).
#
# Extracted after a 2026-10 incident: backend-manifest/frontend-manifest's
# TAGS_ARG defaulted to "latest" unconditionally, with the stable/pre-release
# regex only gating whether :MAJOR.MINOR was ALSO added on top of it — so
# every alpha/beta/rc tag silently re-pointed backend:latest/frontend:latest
# (on both the GitLab registry and GHCR) at that pre-release build, from
# v1.2.0-alpha.1 through v1.2.0-alpha.3 (about three days) before anyone
# noticed. This is the second time this exact bug shape has hit this repo —
# #1270 already fixed it once for docs-deploy's version resolution (see
# resolve-docs-version.sh). Extracting it here means the two real call sites
# (backend-manifest/frontend-manifest, and scripts/release.sh's pre-tag
# intent printout) share one classifier instead of two copies of the same
# regex that can silently drift apart again — and gives it one place to carry
# a --self-test.
#
# A "stable" tag matches ^v[0-9]+\.[0-9]+\.[0-9]+$ exactly (no pre-release
# suffix) — the same classifier docs-deploy (resolve-docs-version.sh) and
# scripts/release.sh's own VERSION handling already use.
#
# Usage:
#   scripts/classify-release-tag.sh <tag>
#   scripts/classify-release-tag.sh --self-test
#
# With a tag, prints two lines to stdout and always exits 0 — classification
# itself never fails; an unparseable or non-release string is simply reported
# non-stable, not errored:
#   STABLE=true|false
#   ALIASES=latest,<MAJOR.MINOR>   (when STABLE=true)
#   ALIASES=                       (when STABLE=false)
#
# --self-test proves the classification against a battery of tags (including
# the exact alpha/beta/rc shapes this repo's release.sh produces) and exits
# 0/1. Touches nothing in this repository.

set -eu

classify() {
  local tag="$1" minor
  if echo "$tag" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    minor="$(echo "$tag" | grep -oE '^v[0-9]+\.[0-9]+' | tr -d 'v')"
    echo "STABLE=true"
    echo "ALIASES=latest,${minor}"
  else
    echo "STABLE=false"
    echo "ALIASES="
  fi
}

self_test() {
  echo "=== classify-release-tag.sh --self-test ==="
  local failures=0

  check() { # check <tag> <want_stable> <want_aliases>
    local tag="$1" want_stable="$2" want_aliases="$3"
    local out stable aliases
    out="$(classify "$tag")"
    stable="$(echo "$out" | sed -n 's/^STABLE=//p')"
    aliases="$(echo "$out" | sed -n 's/^ALIASES=//p')"
    if [ "$stable" = "$want_stable" ] && [ "$aliases" = "$want_aliases" ]; then
      echo "OK: $tag -> STABLE=$stable ALIASES=$aliases"
    else
      echo "FAIL: $tag -> got STABLE=$stable ALIASES=$aliases, want STABLE=$want_stable ALIASES=$want_aliases"
      failures=$((failures + 1))
    fi
  }

  check "v1.1.0" "true" "latest,1.1"
  check "v2.0.0" "true" "latest,2.0"
  check "v10.20.30" "true" "latest,10.20"
  # The exact shapes scripts/release.sh produces (#1270 repro: these used to
  # all incorrectly get "latest" too).
  check "v1.2.0-alpha.1" "false" ""
  check "v1.2.0-alpha.3" "false" ""
  check "v1.2.0-beta.1" "false" ""
  check "v1.2.0-rc.1" "false" ""
  check "v1.2.0-rc.10" "false" ""
  # Malformed/partial — must not be misread as stable.
  check "v1.2" "false" ""
  check "v1.2.0.1" "false" ""
  check "1.2.0" "false" ""
  check "not-a-tag" "false" ""
  check "" "false" ""

  if [ "$failures" -eq 0 ]; then
    echo "=== classify-release-tag.sh --self-test: PASSED ==="
    return 0
  fi
  echo "=== classify-release-tag.sh --self-test: FAILED ($failures) ==="
  return 1
}

case "${1:-}" in
  --self-test) self_test ;;
  "")
    echo "Usage: $0 <tag> | --self-test" >&2
    exit 2
    ;;
  *) classify "$1" ;;
esac
