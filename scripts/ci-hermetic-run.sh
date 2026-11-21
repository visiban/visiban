#!/bin/sh
# shellcheck shell=sh
# gate-selftest-exempt: a wrapper, not a gate; covered by scripts/tests/ci-hermetic-run.test.sh
# scripts/ci-hermetic-run.sh — run ONE CI-script test command hermetically (#2461).
#
#   sh scripts/ci-hermetic-run.sh bash scripts/tests/<name>.test.sh [args...]
#
# In a child shell it sources scripts/ci-poison-env.sh (every protected token
# becomes a sentinel), starts scripts/ci-api-canary.py (CI_API_V4_URL points at
# a loopback listener that logs any request), runs the command, then verifies
# the canary log. It exits with the command's status, or 1 when the command
# passed but reached the API with inherited variables (the #2412 class).
#
# Why a wrapper and not a job-wide `. ci-poison-env.sh`: jobs such as
# suppressions-check run their tests next to a REAL step that needs the real
# token. The poison lives only in this process, so the job's own shell, and so
# every later step, keeps its real variables.
#
# POSIX sh (alpine busybox in CI); needs python3 for the canary.
set -u
[ $# -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # resolved at run time from this script's directory
. "$here/ci-poison-env.sh"
log="$(mktemp "${TMPDIR:-/tmp}/canary-2461.XXXXXX")" || { echo "ERROR: mktemp failed" >&2; exit 2; }
started="$(python3 "$here/ci-api-canary.py" start --log "$log")" || { echo "ERROR: API canary did not start" >&2; exit 2; }
eval "$started"
"$@"
rc=$?
python3 "$here/ci-api-canary.py" verify --log "$log" --pid "$CANARY_PID" >&2
vrc=$?
rm -f "$log"
[ "$rc" -ne 0 ] && exit "$rc"
exit "$vrc"
