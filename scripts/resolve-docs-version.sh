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
# --require-tag (#1997): when the version came ONLY from the .env.example
# fallback (neither DOCS_VERSION nor CI_COMMIT_TAG set, i.e. a push to main),
# require that the git tag exists on origin (`git ls-remote`, overridable with
# TAG_LOOKUP_CMD for tests). Otherwise exit 3 with nothing on stdout. Why: the
# release merge sets APP_VERSION=<tag> before the tag exists, so without this
# main's docs-deploy published the release's versioned docs ahead of the tag and
# outside the release-main-pipeline-guard (#1154). The tag pipeline deploys them
# once the guard passes; main keeps deploying docs edits to an ALREADY-tagged
# version, so docs fixes between releases still go live.
#
# --require-tag also requires the tag's `release-main-pipeline-guard` job to have
# `success` on the TAG pipeline (#2398). A tag on origin only proves the release
# was pushed, not that the guard passed it: a refused release's tag stays on
# origin, and a published GitLab Release is no signal either (release.sh creates
# it before the guard runs). So the next docs push to main would otherwise run
# `mike deploy <tag> ... latest` for images that were never published. The newest
# pipeline for ref=<tag> is read with GITLAB_API_TOKEN (read_api, the same
# variable the guard uses; CI_JOB_TOKEN cannot list pipelines) and its
# non-retried job of that name must be `success`. Fails closed:
#   exit 5  guard is not `success` (failed, running, pending, canceled, manual,
#           job or pipeline missing): skip, the tag pipeline's own docs-deploy
#           publishes once the guard passes
#   exit 4  the lookup itself failed (no token, API error, unparsable reply):
#           fail the job rather than silently skip
# Test hooks (TAG_LOOKUP_CMD for the tag, GUARD_STATUS_CMD for the guard) are
# honored ONLY inside --self-test, so an exported stray cannot neuter the gate.
#
# Usage:
#   scripts/resolve-docs-version.sh [--require-tag] [--env-file <path>]
#   DOCS_VERSION=<tag> scripts/resolve-docs-version.sh
#   CI_COMMIT_TAG=<tag> scripts/resolve-docs-version.sh
#   scripts/resolve-docs-version.sh --self-test
#
# Portable bash 3.2 / BusyBox: no associative arrays, no grep -P, no mapfile,
# bare `set -eu` (see docs/development/ci-gates.md).

set -eu

ENV_FILE=".env.example"
SELF_TEST=0
REQUIRE_TAG=0
# Assigned here, never inherited: test hooks (TAG_LOOKUP_CMD, GUARD_STATUS_CMD)
# are honored only while self_test has set this to 1.
_RDV_SELFTEST=0
GUARD_JOB="release-main-pipeline-guard"

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    --require-tag) REQUIRE_TAG=1; shift ;;
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

# tag_published <v-prefixed version>: 0 = tag on origin, 1 = origin answered and
# the tag is not there, 2 = the lookup itself failed (network, token). `git
# ls-remote --exit-code` exits 2 for "no matching ref"; the stub contract is the
# same (exit 2 = absent, any other nonzero = failed lookup).
tag_published() {
  local rc=0
  if [ "$_RDV_SELFTEST" -eq 1 ] && [ -n "${TAG_LOOKUP_CMD:-}" ]; then
    $TAG_LOOKUP_CMD "refs/tags/$1" >/dev/null 2>&1 || rc=$?
  else
    git ls-remote --exit-code --tags origin "refs/tags/$1" >/dev/null 2>&1 || rc=$?
  fi
  case "$rc" in 0) return 0 ;; 2) return 1 ;; *) return 2 ;; esac
}

# guard_status <tag>: prints the status of the tag pipeline's guard job
# (`success`, `failed`, `running`, ..., or `none` when the pipeline or the job is
# missing) and returns 0; returns nonzero when the lookup itself failed.
guard_status() {
  if [ "$_RDV_SELFTEST" -eq 1 ] && [ -n "${GUARD_STATUS_CMD:-}" ]; then
    $GUARD_STATUS_CMD "$1"
    return $?
  fi
  [ -n "${GITLAB_API_TOKEN:-}" ] && [ -n "${CI_API_V4_URL:-}" ] && [ -n "${CI_PROJECT_ID:-}" ] || return 1
  python3 -I - "$1" "$GUARD_JOB" <<'PY'
import json, os, sys, urllib.parse, urllib.request

tag, job_name = sys.argv[1], sys.argv[2]
api = os.environ["CI_API_V4_URL"].rstrip("/")
proj = urllib.parse.quote(os.environ["CI_PROJECT_ID"], safe="")
token = os.environ["GITLAB_API_TOKEN"]


def get(path):
    req = urllib.request.Request(api + "/projects/" + proj + path, headers={"PRIVATE-TOKEN": token})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - https GitLab API URL from CI
        return json.load(resp)


try:
    pipes = get("/pipelines?ref=" + urllib.parse.quote(tag, safe="") + "&order_by=id&sort=desc&per_page=1")
    if not isinstance(pipes, list):
        sys.exit(1)
    if not pipes:
        print("none")
        sys.exit(0)
    # Only the newest pipeline counts; include_retried defaults to false, so a
    # retried guard job is represented by its latest run.
    jobs = get("/pipelines/%d/jobs?per_page=100" % int(pipes[0]["id"]))
    if not isinstance(jobs, list):
        sys.exit(1)
    mine = [j for j in jobs if j.get("name") == job_name]
    print(str(max(mine, key=lambda j: j.get("id", 0)).get("status", "none")) if mine else "none")
except SystemExit:
    raise
except Exception:  # any API/parse failure must read as "lookup failed", never as a status
    sys.exit(1)
PY
}

# gate_on_tag <DOCS_VERSION> <CI_COMMIT_TAG> <version>: returns 3 when the version
# came from the .env.example fallback and its tag is not published yet, 5 when the
# tag exists but its guard job is not `success` (#2398), 4 when either lookup
# failed (fail closed: a failed lookup must not look like "skip, green").
gate_on_tag() {
  local rc=0 st
  if [ -n "${1:-}" ] || [ -n "${2:-}" ]; then return 0; fi
  tag_published "$3" || rc=$?
  case "$rc" in 0) : ;; 1) return 3 ;; *) return 4 ;; esac
  st=$(guard_status "$3") || return 4
  [ "$st" = "success" ] || return 5
  return 0
}

self_test() {
  local tmp out rc
  _RDV_SELFTEST=1
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

  # --require-tag gate (#1997)
  published="$tmp/published"; printf '#!/bin/sh\n[ "$1" = "refs/tags/v1.3.0" ] && exit 0\nexit 2\n' > "$published"; chmod +x "$published"
  gstub() { printf '#!/bin/sh\n%s\n' "$1" > "$tmp/gs"; chmod +x "$tmp/gs"; }
  gstub 'echo success'
  export TAG_LOOKUP_CMD="$published"
  rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "" "v1.3.0" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELF-TEST FAILED: tag exists and guard success must deploy (rc=$rc)." >&2; exit 1; }
  echo "OK: tag exists and the guard succeeded: deploys (#2398)"
  for st in failed running pending canceled manual skipped created none; do
    gstub "echo $st"
    rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "" "v1.3.0" || rc=$?
    [ "$rc" -eq 5 ] || { echo "SELF-TEST FAILED: guard status '$st' must skip with 5 (rc=$rc)." >&2; exit 1; }
  done
  echo "OK: a refused, unfinished, or missing guard (failed/running/pending/none/...) skips the deploy (#2398)"
  gstub 'exit 1'
  rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "" "v1.3.0" || rc=$?
  [ "$rc" -eq 4 ] || { echo "SELF-TEST FAILED: a failed guard lookup must fail closed with 4 (rc=$rc)." >&2; exit 1; }
  gstub 'echo'
  rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "" "v1.3.0" || rc=$?
  [ "$rc" -eq 5 ] || { echo "SELF-TEST FAILED: an empty guard status must not read as success (rc=$rc)." >&2; exit 1; }
  echo "OK: an API error fails closed (4); an empty reply is never success"
  gstub 'echo success'
  rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "" "v1.4.0" || rc=$?
  [ "$rc" -eq 3 ] || { echo "SELF-TEST FAILED: no tag must still win over a guard stub (rc=$rc)." >&2; exit 1; }
  rc=0; GUARD_STATUS_CMD="$tmp/gs" gate_on_tag "" "v1.4.0" "v1.4.0" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELF-TEST FAILED: the tag pipeline must not consult the guard lookup (rc=$rc)." >&2; exit 1; }
  echo "OK: no tag still skips; the tag pipeline itself is never gated here"
  _RDV_SELFTEST=0
  rc=0; ( unset GITLAB_API_TOKEN; GUARD_STATUS_CMD="$tmp/gs"; guard_status v1.3.0 >/dev/null ) || rc=$?
  [ "$rc" -ne 0 ] || { echo "SELF-TEST FAILED: GUARD_STATUS_CMD must be inert outside --self-test (#2398)." >&2; exit 1; }
  echo "OK: the guard-status test hook is inert outside --self-test"
  _RDV_SELFTEST=1
  echo "OK: main deploys a version whose tag already exists"
  rc=0; TAG_LOOKUP_CMD="$published" gate_on_tag "" "" "v1.4.0" || rc=$?
  [ "$rc" -eq 3 ] || { echo "SELF-TEST FAILED: fallback version with no tag must be refused with 3 (rc=$rc)." >&2; exit 1; }
  echo "OK: main does not deploy a version whose tag does not exist yet (#1997)"
  failing="$tmp/failing"; printf '#!/bin/sh\nexit 128\n' > "$failing"; chmod +x "$failing"
  rc=0; TAG_LOOKUP_CMD="$failing" gate_on_tag "" "" "v1.4.0" || rc=$?
  [ "$rc" -eq 4 ] || { echo "SELF-TEST FAILED: a failed lookup must fail closed with 4, not look like an absent tag (rc=$rc)." >&2; exit 1; }
  echo "OK: a failed tag lookup fails closed instead of skipping"
  rc=0; TAG_LOOKUP_CMD="$published" gate_on_tag "" "v1.4.0" "v1.4.0" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELF-TEST FAILED: the tag pipeline must always deploy (rc=$rc)." >&2; exit 1; }
  echo "OK: the tag pipeline deploys without a lookup"
  rc=0; TAG_LOOKUP_CMD="$published" gate_on_tag "1.4.0" "" "v1.4.0" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELF-TEST FAILED: an explicit DOCS_VERSION recovery run must deploy (rc=$rc)." >&2; exit 1; }
  echo "OK: manual DOCS_VERSION recovery deploys without a lookup"

  echo "=== resolve-docs-version.sh --self-test: PASSED ==="
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

if ! v=$(resolve "${DOCS_VERSION:-}" "${CI_COMMIT_TAG:-}" "$ENV_FILE"); then
  exit 1
fi
if [ "$REQUIRE_TAG" -eq 1 ]; then
  rc=0; gate_on_tag "${DOCS_VERSION:-}" "${CI_COMMIT_TAG:-}" "$v" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "resolve-docs-version: tag $v is not published yet; not deploying its docs from main (#1997)." >&2
    exit "$rc"
  fi
fi
echo "$v"
