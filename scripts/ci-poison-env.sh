# shellcheck shell=sh disable=SC2034  # sourced file; CI_POISON_EXEMPT is read by check-ci-poison-list.sh
# gate-selftest-exempt: sourced env file, not a gate; covered by scripts/tests/ci-poison-env.test.sh
# scripts/ci-poison-env.sh — SOURCE this (`. scripts/ci-poison-env.sh`); do not execute (#2461).
#
# Why: `main` pipelines see protected CI/CD variables (GITLAB_API_TOKEN, ...),
# MR pipelines from unprotected branches do not. A CI-script test that quietly
# depends on either passes on the MR and fails only after merge (#2412:
# resolve-docs-version.test.sh inherited GITLAB_API_TOKEN/CI_API_V4_URL). The
# `script-tests` jobs source this file on BOTH pipelines, so every protected
# token is a sentinel and the API endpoint is dead, identically everywhere. A
# test that needs a variable must set it itself.
#
# This is the ONE place the list lives. scripts/check-ci-poison-list.sh fails
# when .gitlab-ci.yml references a `*_TOKEN` variable that is in neither list.
# POSIX sh only: script-tests runs alpine busybox `sh` (bash is installed later), so
# no arrays and no bashisms; lists are whitespace-separated strings (#2461 audit B1).
# Convention doc: docs/maintainers/known-ci-failures.md ("Hermetic CI-script tests").

# Poisoned: set to a sentinel. Derived by grep over .gitlab-ci.yml and scripts/.
CI_POISON_VARS="
  GITLAB_API_TOKEN
  GHCR_TOKEN
  DOCKERHUB_TOKEN
  DOCS_DEPLOY_TOKEN
  RUNNER_STATUS_TOKEN
  RUNNERS_READ_TOKEN
  SONAR_TOKEN
  GH_TOKEN
  KAIZEN_API_TOKEN
  FUZZ_DEEP_API_TOKEN
  ISSUES_API_TOKEN
  RENOVATE_TOKEN
"

# Not poisoned, each with a reason, one `NAME:reason` per line (never grows silently:
# the check reads this).
CI_POISON_EXEMPT="
CI_JOB_TOKEN:GitLab-issued per job, identical in kind on MR and main
SIGSTORE_ID_TOKEN:per-job OIDC id_token, not a protected variable
"

for _v in $CI_POISON_VARS; do
  export "$_v=poisoned-by-ci-poison-env-2461"
done
unset _v
# Dead local endpoint: an accidental API call fails fast instead of reaching gitlab.com.
export CI_API_V4_URL="http://127.0.0.1:9/api/v4"
