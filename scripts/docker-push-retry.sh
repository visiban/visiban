#!/usr/bin/env bash
# scripts/docker-push-retry.sh — retry a `docker push` against the transient
# registry failure a persistent shell-executor runner is uniquely exposed to
# (#1205).
#
# Ported from TruePPM's scripts/docker-push-retry.sh, which hit this in
# production on the same runner shape Visiban's arm64 leg uses:
#
#   Mounted from visiban/visiban/backend
#   error from registry: blob unknown to registry - sha256:...
#
# Having just pushed the backend image, the daemon optimizes the frontend
# push by asking the registry to MOUNT a shared blob out of the backend
# repository rather than uploading it. If the registry accepts the mount but
# cannot resolve the blob when the manifest references it, the manifest PUT
# fails and nothing lands (one tag exists, the other 404s).
#
# Why only the arm64 leg is exposed: the amd64 legs (`.kaniko-push-common`)
# run kaniko in a fresh container per job, so there is no other repository to
# mount *from*. `.arm64-docker-push-base` is a shell executor on a
# persistent host whose Docker daemon accumulates cross-repo state between
# jobs. The amd64 legs cannot reach this failure class; the arm64 legs can.
#
# Ported proactively rather than waiting to rediscover it during a live
# release cut — the runner shape that caused it for TruePPM is identical
# here (persistent macOS shell-executor host, shared Docker Desktop daemon).
#
# Usage:
#   source scripts/docker-push-retry.sh
#   push_with_retry "registry.example.com/org/img:tag"
#
# Knobs (env):
#   DOCKER_PUSH_MAX_ATTEMPTS  attempts before giving up (default 4)
#   DOCKER_PUSH_BACKOFF_UNIT  seconds multiplied by attempt number (default 5)
#
# The self-test swaps `docker` for a stub via the shell variable _DPR_PUSH_CMD.
# It is unset whenever this file is sourced, so a CI/pipeline variable of that
# name can never replace the binary that runs next to the logged-in credentials.

unset _DPR_PUSH_CMD

push_with_retry() {
  local ref="$1"
  local max="${DOCKER_PUSH_MAX_ATTEMPTS:-4}"
  local unit="${DOCKER_PUSH_BACKOFF_UNIT:-5}"
  local cmd="${_DPR_PUSH_CMD:-docker}"
  local attempt=1

  while :; do
    if "$cmd" push "$ref"; then
      if [ "$attempt" -gt 1 ]; then
        echo "push of ${ref} succeeded on attempt ${attempt}"
      fi
      return 0
    fi

    if [ "$attempt" -ge "$max" ]; then
      echo "ERROR: push of ${ref} failed after ${max} attempts." >&2
      echo "If the log shows 'blob unknown to registry' after a 'Mounted from'" >&2
      echo "line, the cross-repo blob mount is not clearing on retry — push" >&2
      echo "from a saved tarball with crane/skopeo instead, which does not" >&2
      echo "consult the local daemon's cross-repo state at all." >&2
      return 1
    fi

    local backoff=$(( attempt * unit ))
    echo "push of ${ref} failed (attempt ${attempt}/${max}); retrying in ${backoff}s"
    sleep "$backoff"
    attempt=$(( attempt + 1 ))
  done
}

# --------------------------------------------------------------------------
# Self-test. Proves the retry loop actually retries and actually gives up,
# using a stub in place of `docker` — same --self-test convention
# check-release-images.sh and check-arm64-runner.sh follow.
# --------------------------------------------------------------------------
_self_test() {
  # Deliberately NOT `local`: the EXIT trap fires after this function has
  # returned, so a function-local would be unbound by then and `set -u` would
  # print a spurious error after an otherwise clean run.
  _ST_TMP="$(mktemp -d)"
  trap 'rm -rf "${_ST_TMP:-}"' EXIT
  local tmp="$_ST_TMP"
  local fail=0

  # Stub: fails until a counter file reaches $STUB_SUCCEED_ON, then succeeds.
  cat >"$tmp/stub" <<'STUB'
#!/usr/bin/env bash
count_file="${STUB_COUNT_FILE}"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
if [ -n "${STUB_SUCCEED_ON:-}" ] && [ "$n" -ge "$STUB_SUCCEED_ON" ]; then
  echo "stub: push succeeded on call $n"
  exit 0
fi
echo "stub: Mounted from other/repo"
echo "stub: error from registry: blob unknown to registry - sha256:deadbeef" >&2
exit 1
STUB
  chmod +x "$tmp/stub"

  _DPR_PUSH_CMD="$tmp/stub"
  export DOCKER_PUSH_BACKOFF_UNIT=0

  # Case 1: succeeds on the 3rd attempt — the loop must keep going and win.
  STUB_COUNT_FILE="$tmp/c1" STUB_SUCCEED_ON=3 DOCKER_PUSH_MAX_ATTEMPTS=4 \
    push_with_retry "example/img:tag" >/dev/null 2>&1
  if [ "$(cat "$tmp/c1")" = "3" ]; then
    echo "  ok    retries a failing push and succeeds on attempt 3"
  else
    echo "  FAIL  expected 3 attempts, got $(cat "$tmp/c1")"; fail=1
  fi

  # Case 2: never succeeds — must give up at exactly max attempts, non-zero.
  if STUB_COUNT_FILE="$tmp/c2" STUB_SUCCEED_ON=99 DOCKER_PUSH_MAX_ATTEMPTS=4 \
      push_with_retry "example/img:tag" >/dev/null 2>&1; then
    echo "  FAIL  a permanently failing push returned success"; fail=1
  elif [ "$(cat "$tmp/c2")" = "4" ]; then
    echo "  ok    gives up after exactly 4 attempts and fails non-zero"
  else
    echo "  FAIL  expected 4 attempts, got $(cat "$tmp/c2")"; fail=1
  fi

  # Case 3: first attempt succeeds — must not sleep or retry.
  STUB_COUNT_FILE="$tmp/c3" STUB_SUCCEED_ON=1 DOCKER_PUSH_MAX_ATTEMPTS=4 \
    push_with_retry "example/img:tag" >/dev/null 2>&1
  if [ "$(cat "$tmp/c3")" = "1" ]; then
    echo "  ok    a clean push is pushed exactly once"
  else
    echo "  FAIL  expected 1 attempt, got $(cat "$tmp/c3")"; fail=1
  fi

  if [ "$fail" -eq 0 ]; then
    echo "SELF-TEST OK: retry loop retries, gives up, and does not over-push."
    return 0
  fi
  echo "SELF-TEST FAILED"
  return 1
}

if [ "${1:-}" = "--self-test" ]; then
  set -uo pipefail
  _self_test
  exit $?
fi
