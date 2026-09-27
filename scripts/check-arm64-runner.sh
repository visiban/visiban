#!/usr/bin/env bash
# scripts/check-arm64-runner.sh — fail fast, with an actionable message, when
# the arm64 group runner is not online, instead of letting a `tags: [arm64]`
# job queue forever (#1084).
#
# Why this exists: a job selected by `tags:` with no online matching runner
# does not fail — it sits `pending` indefinitely. GitLab's per-job
# `timeout:` cannot catch this: it only bounds RUNNING time, never
# PENDING/queued time. This project already learned the underlying lesson
# once — `saas-linux-medium-arm64` silently resolved to `no_matching_runner`
# on a throwaway probe rather than an outright pipeline failure (see #1084's
# history in docs/maintainers/ci-runners.md). This script is the "fail
# loudly" half of that lesson: it runs as its own fast job, on ANY runner,
# BEFORE the real arm64 build job would ever be scheduled.
#
# Requires the GitLab Runners API (`GET /runners/:id`). GitLab Free supports
# neither group nor project access tokens (verified 2026-09-27 against the
# actual GitLab.com UI — see the "GitLab tier" project memory), so this
# reads a PERSONAL access token's fine-grained "Runner: Read" permission,
# scoped to the visiban group, stored as the CI/CD variable named by
# RUNNER_STATUS_TOKEN (masked + protected — see
# docs/maintainers/tokens-and-rotation.md).
#
# Usage:
#   scripts/check-arm64-runner.sh <runner-id>
#   scripts/check-arm64-runner.sh --self-test
#
# Overrides (env):
#   RUNNER_STATUS_TOKEN   the read_api-scoped PAT (required, unless stubbed
#                         via RUNNER_STATUS_PROBE for --self-test)
#   GITLAB_API_BASE       API root (default https://gitlab.com/api/v4)
#   RUNNER_STATUS_PROBE   command receiving <runner-id>, printing the
#                         runner's JSON to stdout — overridable so the
#                         decision logic can be unit-tested with a stub, no
#                         token or network required. Same convention as
#                         check-release-images.sh's RELEASE_IMAGE_PROBE.
#
# Exit codes:
#   0  runner is online
#   1  runner is registered but not online (paused/offline/stale)
#   2  invocation error (no token, no runner id, malformed API response, or
#      the API call itself failed)

set -euo pipefail

GITLAB_API_BASE="${GITLAB_API_BASE:-https://gitlab.com/api/v4}"
RUNNER_STATUS_PROBE="${RUNNER_STATUS_PROBE:-}"

# fetch_runner <runner-id> — prints the runner's JSON to stdout, or returns 2.
fetch_runner() {
  local runner_id="$1"
  if [ -n "$RUNNER_STATUS_PROBE" ]; then
    "$RUNNER_STATUS_PROBE" "$runner_id"
    return
  fi
  if [ -z "${RUNNER_STATUS_TOKEN:-}" ]; then
    echo "ERROR: RUNNER_STATUS_TOKEN is not set — cannot query the GitLab Runners API." >&2
    echo "       Configure it under Settings -> CI/CD -> Variables (masked + protected)." >&2
    return 2
  fi
  curl -sSf --header "PRIVATE-TOKEN: ${RUNNER_STATUS_TOKEN}" \
    "${GITLAB_API_BASE}/runners/${runner_id}"
}

# check_runner_online <runner-id> — the real decision logic, factored out of
# main() so --self-test can call it in-process against a stub.
check_runner_online() {
  local runner_id="$1" body status
  body="$(fetch_runner "$runner_id")" || return 2
  status="$(printf '%s' "$body" | jq -r '.status // empty' 2>/dev/null || true)"
  if [ -z "$status" ]; then
    echo "ERROR: could not read a status field from the runner API response for id ${runner_id}." >&2
    echo "       Response was: ${body}" >&2
    return 2
  fi
  echo "runner ${runner_id} status: ${status}"
  if [ "$status" = "online" ]; then
    return 0
  fi
  echo "ERROR: arm64 runner ${runner_id} is not online (status: ${status})." >&2
  echo "       The real arm64 build job would otherwise queue forever waiting for it." >&2
  echo "       Bring the runner online (it's a persistent Mac host — check that both" >&2
  echo "       Docker Desktop and the gitlab-runner service are running) and retry" >&2
  echo "       this pipeline, or wait for the next scheduled release attempt." >&2
  return 1
}

# --self-test: proves the decision logic above actually fires for each
# status, using a stub RUNNER_STATUS_PROBE — no token, no network. Weighted
# toward the offline/malformed paths per the TruePPM/#1084 incident: a check
# only ever observed passing against a healthy runner would reproduce
# exactly the failure it exists to catch.
self_test() {
  local tmp fail=0 pass=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  check() { # check "<description>" <0-if-ok>
    if [ "$2" -eq 0 ]; then
      pass=$((pass + 1))
    else
      echo "  SELF-TEST FAIL: $1" >&2
      fail=$((fail + 1))
    fi
  }

  cat > "$tmp/probe.sh" <<'SH'
#!/usr/bin/env bash
cat "$STUB_RESPONSE_FILE"
SH
  chmod +x "$tmp/probe.sh"
  export RUNNER_STATUS_PROBE="$tmp/probe.sh"
  export STUB_RESPONSE_FILE="$tmp/response"

  echo "=== check-arm64-runner.sh --self-test ==="

  echo "case: runner online"
  printf '{"id":56802474,"status":"online"}' > "$tmp/response"
  local rc=0
  check_runner_online 56802474 >/dev/null 2>&1 || rc=$?
  check "exits 0 when status is online" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"

  echo "case: runner offline"
  printf '{"id":56802474,"status":"offline"}' > "$tmp/response"
  rc=0
  check_runner_online 56802474 >/dev/null 2>&1 || rc=$?
  check "exits 1 (not 0, not 2) when status is offline" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"

  echo "case: runner paused"
  printf '{"id":56802474,"status":"paused"}' > "$tmp/response"
  rc=0
  check_runner_online 56802474 >/dev/null 2>&1 || rc=$?
  check "exits 1 when status is paused" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"

  echo "case: malformed API response (no status field)"
  printf '{"id":56802474}' > "$tmp/response"
  rc=0
  check_runner_online 56802474 >/dev/null 2>&1 || rc=$?
  check "exits 2 (invocation error), not 1, on a malformed response" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

  echo "case: no token and no stub probe configured"
  unset RUNNER_STATUS_PROBE
  rc=0
  ( unset RUNNER_STATUS_TOKEN
    check_runner_online 56802474 >/dev/null 2>&1
  ) || rc=$?
  check "exits 2 when RUNNER_STATUS_TOKEN is unset" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

  echo
  if [ "$fail" -gt 0 ]; then
    echo "check-arm64-runner.sh --self-test: $pass passed, $fail FAILED" >&2
    return 1
  fi
  echo "check-arm64-runner.sh --self-test: $pass passed"
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi
  local runner_id="${1:-}"
  if [ -z "$runner_id" ]; then
    echo "ERROR: usage: $0 <runner-id>  (or --self-test)" >&2
    exit 2
  fi
  check_runner_online "$runner_id"
  exit $?
}

main "$@"
