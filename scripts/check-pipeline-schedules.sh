#!/usr/bin/env bash
# scripts/check-pipeline-schedules.sh — fail when a `.gitlab-ci.yml` job that
# only runs `if: $CI_PIPELINE_SOURCE == "schedule" && $SOME_VAR == "true"`
# has no active GitLab pipeline schedule actually setting `SOME_VAR=true`
# (#1213).
#
# #1213: `nightly-load-test` (#1082) required a manual, one-time GitLab UI
# step — CI/CD → Schedules → New schedule — that was never done. The job's
# `rules:` line, its own header comment, and docs/development/nightly-load-test.md
# all described the schedule; nothing asserted it actually existed. The gap
# left a real ~40% p95 regression on `GET /boards/{id}/full/` undetected for
# as long as the schedule was missing, which is the entire reason this class
# of job exists. Same failure shape as `check-release-images.sh` (#1074): a
# GitLab-side configuration that lives outside this repo, that no commit
# touches and no job asserts, so the only way to notice it silently drifting
# is to go and look, on a schedule.
#
# This is that look. It derives the set of variables a schedule-only job
# actually needs from `.gitlab-ci.yml` ITSELF (every non-comment
# `$CI_PIPELINE_SOURCE == "schedule" && $VAR == "true"` rule) — never a
# hardcoded list, same reasoning as `check-gate-selftest-parity.sh` — then
# calls the GitLab API for the project's configured pipeline schedules and
# fails, naming the variable, if no *active* schedule actually sets it.
#
# Deliberately NOT allow_failure for a genuine finding, same as
# `check-release-images.sh`: a schedule-gated gate that never runs is
# indistinguishable from a codebase with nothing to catch, and that is
# exactly the silence #1213 was filed over. It DOES fail open (warn, exit 0)
# when the API lookup itself is inconclusive (no token configured, network
# error) — reporting a confident MISSING from a lookup that never actually
# succeeded would point the operator at the wrong problem.
#
# ## Overrides
#
# SCHEDULE_AUDIT_ACCEPTED_GAPS  space-separated variable names to report as
#                        SKIP instead of MISSING. Empty by default — silence
#                        is opt-in only, set per-entry in the CI job with a
#                        comment naming the tracking issue, never defaulted
#                        here. Same shape as check-release-images.sh's
#                        ACCEPTED_GAPS: a documented, temporary exception,
#                        not a way to quiet the gate permanently.
# SCHEDULE_PROBE         command that prints, to stdout, a JSON array of this
#                        project's pipeline schedules, each with at least
#                        `active` (bool) and `variables` (array of
#                        {key, value}) — the shape
#                        `GET .../pipeline_schedules/:id` returns. A non-zero
#                        exit or invalid JSON is treated as inconclusive
#                        (fail open). Overridable so the detection logic can
#                        be unit tested (see --self-test) without a token or
#                        network access. Defaults to the real GitLab API
#                        lookup below.
#
# Usage:
#   scripts/check-pipeline-schedules.sh [--ci-file <path>]
#   scripts/check-pipeline-schedules.sh --self-test
#
# Exit codes:
#   0  every schedule-gated variable is covered by an active schedule, an
#      accepted gap, or the lookup was inconclusive (fail open)
#   1  at least one variable has no active schedule setting it true
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_FILE="$REPO_ROOT/.gitlab-ci.yml"
SCHEDULE_AUDIT_ACCEPTED_GAPS="${SCHEDULE_AUDIT_ACCEPTED_GAPS:-}"
SCHEDULE_PROBE="${SCHEDULE_PROBE:-}"
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) SELF_TEST=1; shift ;;
    --ci-file) CI_FILE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# extract_required_vars <ci-file> — every distinct $VAR named in a
# non-comment `$CI_PIPELINE_SOURCE == "schedule" && $VAR == "true"` rule.
# Anchored on the literal `CI_PIPELINE_SOURCE == "schedule"` prefix so this
# never picks up an unrelated `$SOME_VAR == "true"` comparison elsewhere in
# the file (e.g. a merge_request_event rule).
extract_required_vars() {
  local ci_file="$1"
  grep -vE '^[[:space:]]*#' "$ci_file" \
    | grep -oE 'CI_PIPELINE_SOURCE == "schedule" && \$[A-Za-z_][A-Za-z0-9_]* == "true"' \
    | grep -oE '\$[A-Za-z_][A-Za-z0-9_]* == "true"' \
    | sed -E 's/^\$([A-Za-z_][A-Za-z0-9_]*) == "true"$/\1/' \
    | sort -u
}

# default_schedule_probe — the real GitLab API lookup: list this project's
# pipeline schedules, then fetch each one individually (the list endpoint
# omits `variables`; only the single-schedule endpoint includes it), and
# print the merged array. Tries CI_JOB_TOKEN first, then GITLAB_API_TOKEN
# (same fallback chain as check-suppression-issues.sh / kaizen_yield_watch.py)
# — pipeline-schedule read access is not guaranteed for a job token, so
# GITLAB_API_TOKEN (a stored project access token) is the token most
# deployments will actually rely on. Prints nothing and exits non-zero on any
# failure — the caller treats that as inconclusive, not as "no schedules".
default_schedule_probe() {
  local api_base project auth_header url list ids id detail merged
  api_base="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
  project="${CI_PROJECT_ID:-}"
  [ -n "$project" ] || return 1

  if [ -n "${CI_JOB_TOKEN:-}" ]; then
    auth_header="JOB-TOKEN: ${CI_JOB_TOKEN}"
  elif [ -n "${GITLAB_API_TOKEN:-}" ]; then
    auth_header="PRIVATE-TOKEN: ${GITLAB_API_TOKEN}"
  else
    return 1
  fi

  url="${api_base}/projects/${project}/pipeline_schedules?per_page=100"
  list="$(curl -sf -H "$auth_header" "$url")" || return 1
  ids="$(printf '%s' "$list" | jq -r '.[].id')" || return 1

  merged="[]"
  for id in $ids; do
    detail="$(curl -sf -H "$auth_header" "${api_base}/projects/${project}/pipeline_schedules/${id}")" || return 1
    merged="$(printf '%s' "$merged" | jq --argjson d "$detail" '. + [$d]')" || return 1
  done
  printf '%s' "$merged"
}

# active_true_vars <schedules-json> — every variable key set to the literal
# string "true" on an active:true schedule. A schedule that exists but is
# paused (active:false) never fires, so it does not count as covering a var
# — the same "not just present, actually wired to run" distinction
# check-gate-selftest-parity draws between "has --self-test" and "is invoked
# with --self-test".
active_true_vars() {
  printf '%s' "$1" | jq -r '.[] | select(.active == true) | .variables[]? | select(.value == "true") | .key'
}

# check_schedules <ci-file> — prints a report and returns 0 (covered/accepted/
# inconclusive) or 1 (at least one uncovered, unaccepted variable).
check_schedules() {
  local ci_file="$1"
  local required covered var gap_list rc probe_out
  local violations=0 skipped=0 ok=0

  required="$(extract_required_vars "$ci_file")"
  if [ -z "$required" ]; then
    echo "check-pipeline-schedules: no schedule-gated (\$CI_PIPELINE_SOURCE == \"schedule\" && \$VAR == \"true\") rules found in $ci_file."
    return 0
  fi

  rc=0
  if [ -n "$SCHEDULE_PROBE" ]; then
    probe_out="$(eval "$SCHEDULE_PROBE")" || rc=$?
  else
    probe_out="$(default_schedule_probe)" || rc=$?
  fi

  if [ "$rc" -ne 0 ] || [ -z "$probe_out" ]; then
    echo "check-pipeline-schedules: WARNING — could not fetch pipeline schedules (no token, or the API call failed); not blocking on an inconclusive lookup. Set GITLAB_API_TOKEN to enable this check." >&2
    return 0
  fi

  covered="$(active_true_vars "$probe_out")" || {
    echo "check-pipeline-schedules: WARNING — pipeline-schedule response could not be parsed; not blocking on an inconclusive lookup." >&2
    return 0
  }

  gap_list=" ${SCHEDULE_AUDIT_ACCEPTED_GAPS} "

  while IFS= read -r var; do
    [ -n "$var" ] || continue
    if printf '%s\n' "$covered" | grep -qxF "$var"; then
      ok=$((ok + 1))
      continue
    fi
    case "$gap_list" in
      *" ${var} "*)
        skipped=$((skipped + 1))
        echo "SKIP    $var (accepted gap, see SCHEDULE_AUDIT_ACCEPTED_GAPS)"
        ;;
      *)
        violations=$((violations + 1))
        echo "check-pipeline-schedules: MISSING — no active GitLab pipeline schedule sets \$${var}=true. A job in $(basename "$ci_file") only runs when this is set; configure one under CI/CD → Schedules." >&2
        ;;
    esac
  done <<< "$required"

  echo ""
  echo "check-pipeline-schedules: ${ok} covered, ${skipped} accepted gap(s), ${violations} missing."
  [ "$violations" -eq 0 ]
}

# self_test — builds a synthetic CI file and stubs SCHEDULE_PROBE to a fixed
# JSON blob (no network, no token), covering: a covered var, a var missing
# entirely, a var only on an INACTIVE schedule, a var set to "false" (present
# but not enabled), an accepted gap, a probe failure (inconclusive → fail
# open), and the no-schedule-gated-jobs case.
self_test() {
  local tmp ok=1
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  cat > "$tmp/ci.yml" <<'EOS'
covered-job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $COVERED_VAR == "true"'

missing-job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $MISSING_VAR == "true"'

inactive-job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $INACTIVE_VAR == "true"'

disabled-job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $DISABLED_VAR == "true"'

accepted-gap-job:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $ACCEPTED_VAR == "true"'

# a commented-out rule must never count:
# - if: '$CI_PIPELINE_SOURCE == "schedule" && $COMMENTED_VAR == "true"'
EOS

  cat > "$tmp/schedules.json" <<'EOS'
[
  {"active": true, "variables": [{"key": "COVERED_VAR", "value": "true"}]},
  {"active": false, "variables": [{"key": "INACTIVE_VAR", "value": "true"}]},
  {"active": true, "variables": [{"key": "DISABLED_VAR", "value": "false"}]}
]
EOS

  local out rc
  rc=0
  out=$(SCHEDULE_PROBE="cat '$tmp/schedules.json'" SCHEDULE_AUDIT_ACCEPTED_GAPS="ACCEPTED_VAR" \
        check_schedules "$tmp/ci.yml" 2>&1) || rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "self-test FAILED: expected a non-zero exit (MISSING_VAR, INACTIVE_VAR, DISABLED_VAR are uncovered)." >&2
    echo "$out" >&2; exit 1
  fi
  if echo "$out" | grep -q "MISSING.*COVERED_VAR"; then
    echo "self-test FAILED: COVERED_VAR (active schedule, value true) was wrongly flagged MISSING." >&2
    echo "$out" >&2; exit 1
  fi
  if ! echo "$out" | grep -q "MISSING.*MISSING_VAR"; then
    echo "self-test FAILED: MISSING_VAR (no schedule at all) was not flagged." >&2
    echo "$out" >&2; exit 1
  fi
  if ! echo "$out" | grep -q "MISSING.*INACTIVE_VAR"; then
    echo "self-test FAILED: INACTIVE_VAR (schedule exists but active:false) was not flagged." >&2
    echo "$out" >&2; exit 1
  fi
  if ! echo "$out" | grep -q "MISSING.*DISABLED_VAR"; then
    echo "self-test FAILED: DISABLED_VAR (schedule exists but value:false) was not flagged." >&2
    echo "$out" >&2; exit 1
  fi
  if ! echo "$out" | grep -q "SKIP    ACCEPTED_VAR"; then
    echo "self-test FAILED: ACCEPTED_VAR (in SCHEDULE_AUDIT_ACCEPTED_GAPS) was not reported as an accepted SKIP." >&2
    echo "$out" >&2; exit 1
  fi
  if echo "$out" | grep -q "COMMENTED_VAR"; then
    echo "self-test FAILED: a commented-out schedule rule must never be extracted as required." >&2
    echo "$out" >&2; exit 1
  fi
  echo "Case 1 OK: covered/missing/inactive/disabled/accepted-gap/commented all classified correctly."

  rc=0
  out=$(SCHEDULE_PROBE="false" check_schedules "$tmp/ci.yml" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "self-test FAILED: a probe failure must fail OPEN (exit 0), not report a confident MISSING." >&2
    echo "$out" >&2; exit 1
  fi
  echo "Case 2 OK: a probe failure fails open instead of reporting a false MISSING."

  cat > "$tmp/no-schedule-jobs.yml" <<'EOS'
plain-job:
  script:
    - echo hi
EOS
  rc=0
  out=$(SCHEDULE_PROBE="cat '$tmp/schedules.json'" check_schedules "$tmp/no-schedule-jobs.yml" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "self-test FAILED: a CI file with no schedule-gated rules at all must pass clean." >&2
    echo "$out" >&2; exit 1
  fi
  echo "Case 3 OK: a CI file with no schedule-gated jobs passes clean without ever calling the probe."

  rm -rf "$tmp"
  trap - EXIT
  echo "check-pipeline-schedules --self-test: OK"
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

check_schedules "$CI_FILE"
