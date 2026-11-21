# shellcheck shell=bash
# gate-selftest-exempt: a sourced library, not a gate; covered by scripts/tests/drill-image.test.sh
# Sourced (not executed) by the drills that boot the product images:
# helm-install-drill.sh, helm-netpol-drill.sh, prod-compose-drill.sh,
# helm-upgrade-drill.sh and compose-upgrade-drill.sh (#2492; the upgrade
# drills' HEAD images only — their last-GA FROM images are pulled as published).
#
# In CI the drill must test the image built from ITS OWN commit, and must not
# rebuild it: the per-commit kaniko jobs (backend-docker-build,
# frontend-docker-build and their -prod siblings in .gitlab-ci.yml) push it to
# $CI_REGISTRY_IMAGE/ci/<name> and hand the digest-pinned reference to the drill through a dotenv report (DRILL_*_IMAGE). The drill
# pulls that exact digest, checks the image's revision label against the
# commit under test and its architecture against the daemon's, and re-tags it
# under the local name the drill already uses. Rebuilding in dind cost the
# slowest drill ~170 s with no layer cache (#2492).
#
# Why the revision check matters: a drill run against some OTHER commit's image
# (a stale dotenv, a copy-pasted digest) reports a deploy regression that is
# really version skew, or misses one — the reason .helm-drill-base never pulls
# a released image.
#
# Locally (no GITLAB_CI) with the variable unset, the drill builds the image
# from the working tree exactly as it did before, so the scripts still run on a
# laptop. In CI an unset variable is a FAILURE, not a silent rebuild: it means
# the needs:/dotenv wiring broke, and a quiet fallback would put the 170 s back
# without anyone noticing (absent-input rule, #1075). DRILL_ALLOW_LOCAL_BUILD=1
# is the explicit opt-out for running a drill script by hand inside a CI job.
#
# The one in-CI exception: a project with NO container registry (e.g. a fork
# with the registry disabled), where GitLab leaves CI_REGISTRY_IMAGE undefined.
# There the kaniko jobs build with --no-push and hand over no image (see
# .kaniko-ci-image), so there is nothing to pull, and the drill falls back to
# the local dind build with a loud log line. Where the registry exists, the
# unset variable still fails.

# drill_image <var-name> <local-tag> <dockerfile> <context> [docker build args...]
drill_image() {
  local var="$1" tag="$2" dockerfile="$3" context="$4"
  shift 4
  local ref="${!var:-}"

  if [ -n "$ref" ]; then
    case "$ref" in
      *@sha256:*) ;;
      *) echo "drill-image: $var='$ref' is not pinned by digest (expected <repo>@sha256:<digest>)" >&2; return 1 ;;
    esac
    local expect="${DRILL_IMAGE_REVISION:-${CI_COMMIT_SHA:-}}"
    if [ -z "$expect" ]; then
      echo "drill-image: $var is set but neither DRILL_IMAGE_REVISION nor CI_COMMIT_SHA is, so the image cannot be checked against the commit under test" >&2
      return 1
    fi
    docker pull -q "$ref" >/dev/null || { echo "drill-image: could not pull $ref" >&2; return 1; }
    local rev arch want_arch
    rev="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref")" || return 1
    if [ "$rev" != "$expect" ]; then
      echo "drill-image: $ref was built from revision '$rev', but this drill is testing '$expect'" >&2
      return 1
    fi
    arch="$(docker image inspect --format '{{ .Architecture }}' "$ref")" || return 1
    want_arch="$(docker version --format '{{ .Server.Arch }}')" || return 1
    if [ "$arch" != "$want_arch" ]; then
      echo "drill-image: $ref is $arch but the drill's Docker daemon is $want_arch" >&2
      return 1
    fi
    docker tag "$ref" "$tag" || return 1
    echo "  ✓ $tag <- $ref (revision $rev, $arch)"
    return 0
  fi

  if [ -n "${GITLAB_CI:-}" ] && [ -z "${CI_REGISTRY_IMAGE:-}" ]; then
    echo "drill-image: WARNING: $var is unset and CI_REGISTRY_IMAGE is empty: this project has no container registry, so the kaniko job pushed no per-commit image. Falling back to a LOCAL dind build of $tag from $dockerfile (slow, uncached; #2492)." >&2
  elif [ -n "${GITLAB_CI:-}" ] && [ "${DRILL_ALLOW_LOCAL_BUILD:-}" != "1" ]; then
    echo "drill-image: $var is unset in CI. The per-commit kaniko build job (#2492) did not hand this drill its image; check the drill's needs: and the build job's dotenv report. Refusing to rebuild in dind." >&2
    return 1
  fi
  echo "  ↳ $var unset: building $tag from $dockerfile (local fallback)"
  docker build -q "$@" -t "$tag" -f "$dockerfile" "$context" >/dev/null
}
