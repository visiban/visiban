#!/usr/bin/env bash
# scripts/resolve-docs-version.sh — resolves and normalizes the docs-deploy
# VERSION for CI's docs-deploy job (see .gitlab-ci.yml, docs-deploy).
#
# Extracted out of the inline CI script so the normalization logic — and the
# regression it fixes (#1270) — is unit-testable outside a live pipeline run.
#
# Resolution order: $DOCS_VERSION > $CI_COMMIT_TAG > the APP_VERSION= line in
# .env.example (or --env-file <path>). Whatever is resolved is normalized to
# carry a leading "v" before being printed.
#
# Why normalization is unconditional: mike (the docs versioning tool)
# compares version identifiers as plain strings, so "1.1.0-rc.1" and
# "v1.1.0-rc.1" are two distinct, unrelated entries — and mike/verspec's
# loose-version sort ranks any unprefixed identifier above every prefixed
# one, regardless of actual semver order. A single manually-typed
# DOCS_VERSION without the "v" (via the docs-deploy job's documented manual
# recovery trigger) silently created exactly that duplicate and pinned it to
# the top of the docs version dropdown for months, undetected, because only
# one of the three VERSION sources normalized before this fix.
#
# Prints the normalized version to stdout and exits 0, or exits 1 with
# nothing on stdout when no version could be resolved from any source (the
# caller should treat this as "nothing to deploy," not a failure — see
# .gitlab-ci.yml).
#
# Usage:
#   scripts/resolve-docs-version.sh [--env-file <path>]
#   DOCS_VERSION=<tag> scripts/resolve-docs-version.sh
#   CI_COMMIT_TAG=<tag> scripts/resolve-docs-version.sh
#   scripts/resolve-docs-version.sh --self-test
#
# Portable bash 3.2 / BusyBox: no associative arrays, no grep -P, no mapfile,
# bare `set -eu` (see docs/development/ci-gates.md).

set -eu

ENV_FILE=".env.example"
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

resolve() {
  # $1 = DOCS_VERSION, $2 = CI_COMMIT_TAG, $3 = env file path. Echoes the
  # normalized version and returns 0, or returns 1 with nothing echoed.
  v="${1:-}"
  if [ -z "$v" ]; then
    v="${2:-}"
  fi
  if [ -z "$v" ] && [ -f "$3" ]; then
    v=$(grep '^APP_VERSION=' "$3" | head -1 | cut -d= -f2)
  fi
  if [ -z "$v" ]; then
    return 1
  fi
  case "$v" in
    v*) : ;;
    *) v="v${v}" ;;
  esac
  echo "$v"
}

self_test() {
  local tmp out rc
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  echo "=== resolve-docs-version.sh --self-test ==="

  no_env="$tmp/does-not-exist"

  rc=0; out=$(resolve "1.1.0-rc.1" "" "$no_env") || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v1.1.0-rc.1" ]; then
    echo "SELF-TEST FAILED: unprefixed DOCS_VERSION should be v-prefixed (got '$out', rc=$rc) — this is the exact #1270 repro." >&2
    exit 1
  fi
  echo "OK: unprefixed DOCS_VERSION pre-release gets v-prefixed (#1270 repro)"

  rc=0; out=$(resolve "v1.1.0" "" "$no_env") || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v1.1.0" ]; then
    echo "SELF-TEST FAILED: already-prefixed DOCS_VERSION must pass through unchanged (got '$out', rc=$rc)." >&2
    exit 1
  fi
  echo "OK: already-prefixed DOCS_VERSION passes through unchanged"

  rc=0; out=$(resolve "" "1.2.0" "$no_env") || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v1.2.0" ]; then
    echo "SELF-TEST FAILED: unprefixed CI_COMMIT_TAG should be v-prefixed (got '$out', rc=$rc)." >&2
    exit 1
  fi
  echo "OK: unprefixed CI_COMMIT_TAG gets v-prefixed"

  env_unprefixed="$tmp/env-unprefixed"
  printf 'APP_VERSION=1.1.0\n' > "$env_unprefixed"
  rc=0; out=$(resolve "" "" "$env_unprefixed") || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v1.1.0" ]; then
    echo "SELF-TEST FAILED: unprefixed .env.example fallback should be v-prefixed (got '$out', rc=$rc)." >&2
    exit 1
  fi
  echo "OK: unprefixed .env.example APP_VERSION fallback gets v-prefixed"

  env_prefixed="$tmp/env-prefixed"
  printf 'APP_VERSION=v1.1.0\n' > "$env_prefixed"
  rc=0; out=$(resolve "" "" "$env_prefixed") || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v1.1.0" ]; then
    echo "SELF-TEST FAILED: already-prefixed .env.example fallback must not double-prefix (got '$out', rc=$rc)." >&2
    exit 1
  fi
  echo "OK: already-prefixed .env.example fallback does not double-prefix"

  rc=0; resolve "" "" "$no_env" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "SELF-TEST FAILED: no source resolvable should return 1, not print a version." >&2
    exit 1
  fi
  echo "OK: no resolvable source returns 1 (caller treats as 'nothing to deploy')"

  echo "=== resolve-docs-version.sh --self-test: PASSED ==="
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

if ! resolve "${DOCS_VERSION:-}" "${CI_COMMIT_TAG:-}" "$ENV_FILE"; then
  exit 1
fi
