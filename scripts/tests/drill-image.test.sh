#!/usr/bin/env bash
# scripts/tests/drill-image.test.sh — unit test for scripts/drill-image.sh
# (#2492). A stub `docker` on PATH records every call and answers inspect/
# version from env, so no daemon is needed. Run: bash scripts/tests/drill-image.test.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/drill-image.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 ${2:-}" in
  "pull "*)  [ "${STUB_PULL_FAIL:-}" = 1 ] && exit 1; exit 0 ;;
  "image inspect")
    case "$*" in
      *Labels*) printf '%s\n' "${STUB_REVISION:-}" ;;
      *Architecture*) printf '%s\n' "${STUB_ARCH:-amd64}" ;;
    esac ;;
  "version "*) printf '%s\n' "${STUB_SERVER_ARCH:-amd64}" ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/docker"
SHA=0123456789abcdef0123456789abcdef01234567
REF="registry.example/p/ci/backend@sha256:$(printf 'a%.0s' $(seq 64))"
fail=0
# run <desc> <want-rc> <want-in-log|-> <refuse-in-log|-> [env assignments...]
run() {
  local desc="$1" want="$2" need="$3" refuse="$4"; shift 4
  : > "$TMP/log"
  local rc=0 out
  LAST_OUT=""
  out="$(env -i PATH="$TMP/bin:/usr/bin:/bin" STUB_LOG="$TMP/log" "$@" \
    bash -c '. "$0"; drill_image DRILL_X_IMAGE local/x:t Dockerfile ctx --build-arg A=B' "$LIB" 2>&1)" || rc=$?
  LAST_OUT="$out"
  local log; log="$(cat "$TMP/log")"
  if [ "$rc" -ne "$want" ] && { [ "$want" -eq 0 ] || [ "$rc" -eq 0 ]; }; then
    echo "  FAIL: $desc (rc=$rc, want $want): $out"; fail=1; return
  fi
  if [ "$need" != - ] && [[ "$log" != *"$need"* ]]; then
    echo "  FAIL: $desc: docker log lacks '$need': $log"; fail=1
  fi
  if [ "$refuse" != - ] && [[ "$log" == *"$refuse"* ]]; then
    echo "  FAIL: $desc: docker log has '$refuse': $log"; fail=1
  fi
}
run "CI image, matching revision: pulled + tagged, never built" 0 "tag $REF local/x:t" "build" \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=$REF STUB_REVISION=$SHA
run "DRILL_IMAGE_REVISION overrides CI_COMMIT_SHA" 0 "tag $REF local/x:t" "build" \
  GITLAB_CI=true CI_COMMIT_SHA=other DRILL_IMAGE_REVISION=$SHA DRILL_X_IMAGE=$REF STUB_REVISION=$SHA
run "image from another commit is refused (version skew)" 1 "pull" "tag " \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=$REF STUB_REVISION=fffffff
run "image with no revision label is refused" 1 "pull" "tag " \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=$REF STUB_REVISION=
run "tag reference (not digest) is refused before any pull" 1 - "pull" \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=registry.example/p/ci/backend:$SHA STUB_REVISION=$SHA
run "no commit to check against is refused" 1 - "pull" \
  GITLAB_CI=true DRILL_X_IMAGE=$REF STUB_REVISION=$SHA
run "architecture mismatch is refused" 1 "pull" "tag " \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=$REF STUB_REVISION=$SHA STUB_ARCH=arm64
run "pull failure fails" 1 "pull" "tag " \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA DRILL_X_IMAGE=$REF STUB_PULL_FAIL=1
run "unset in CI (registry present) fails, never rebuilds in dind" 1 - "build" \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA CI_REGISTRY_IMAGE=registry.example/p
case "$LAST_OUT" in *"is unset in CI"*) ;; *) echo "  FAIL: registry-present refusal not logged: $LAST_OUT"; fail=1 ;; esac
run "unset in CI with explicit opt-out builds" 0 "build -q --build-arg A=B -t local/x:t -f Dockerfile ctx" - \
  GITLAB_CI=true CI_REGISTRY_IMAGE=registry.example/p DRILL_ALLOW_LOCAL_BUILD=1
# A project with no registry (fork with it disabled): CI_REGISTRY_IMAGE is
# undefined or empty, the kaniko job pushed nothing, so the local build is the
# only way to get an image, and it says so loudly.
run "unset in CI, CI_REGISTRY_IMAGE empty: local build, logged" 0 "build -q --build-arg A=B -t local/x:t -f Dockerfile ctx" "pull" \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA CI_REGISTRY_IMAGE=
case "$LAST_OUT" in *"WARNING"*"CI_REGISTRY_IMAGE is empty"*"LOCAL dind build"*) ;; *) echo "  FAIL: no-registry fallback not logged: $LAST_OUT"; fail=1 ;; esac
run "unset in CI, CI_REGISTRY_IMAGE undefined: local build" 0 "build -q --build-arg A=B -t local/x:t -f Dockerfile ctx" "pull" \
  GITLAB_CI=true CI_COMMIT_SHA=$SHA
run "unset locally builds from the working tree" 0 "build -q --build-arg A=B -t local/x:t -f Dockerfile ctx" "pull" \
  HOME=/nonexistent
[ "$fail" -eq 0 ] && echo "drill-image.test: all cases pass"
exit "$fail"
