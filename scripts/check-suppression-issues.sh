#!/usr/bin/env sh
# scripts/check-suppression-issues.sh — SUPPRESSED-UNTIL(#NNNN) marker gate.
#
# Problem (#1092): a suppression (`pytest.mark.skip`, `eslint-disable`, a
# coverage `omit`, an excluded a11y rule) is added for a reason that is true
# *today*. Nothing ever revisits it, so the suppression outlives its reason
# silently and the gate it disables stays green while hiding real failures.
#
# Convention: a suppression that is waiting on tracked work (as opposed to
# being permanently intentional) carries a marker naming the issue that would
# remove it:
#
#   @pytest.mark.skip(reason="SUPPRESSED-UNTIL(#1084): arm64 images unavailable")
#   // eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#1057): deps churn until the token migration lands
#
# This script greps the tree for `SUPPRESSED-UNTIL(#N)`, looks up each cited
# issue's state via the GitLab REST API, and fails — naming file, line, and
# issue — if any cited issue is already CLOSED. A suppression with a plain
# `-- reason` and no marker is never touched; this convention is for
# *temporary* suppressions only (see docs/development/suppressions.md).
#
# Documented convention: docs/development/suppressions.md, CLAUDE.md.
#
# Why this must run on `main` and on schedule, not only on MRs: the
# triggering event is "an issue closed", not "a commit landed" — an MR-only
# job would never fire once the suppression's branch has already merged.
#
# Portability: this runs in the `changelog-check` job's `alpine:3.19` image
# elsewhere in this pipeline family, which ships BusyBox grep/sed — no
# --exclude-dir, no -P, no GNU-only flags, no interval expressions ({1,}).
# Every pattern below is plain POSIX basic-regex-safe (parens and `*` only).
#
# Usage:
#   sh scripts/check-suppression-issues.sh              # real run
#   sh scripts/check-suppression-issues.sh --self-test   # gate self-test
#
# Self-test (issue #1093's meta-gate requires every bespoke CI gate to carry
# one): builds a small fixture tree, points the issue-state lookup at a mock
# (no network), and asserts the detection logic actually fires on a marker
# citing a "closed" issue, passes one citing an "open" issue, and leaves a
# plain `-- reason` suppression alone. Exits non-zero if any of that does not
# hold — i.e. if the gate itself is broken.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Paths this gate scans for the marker. Kept in sync with the areas #1092
# audited: frontend eslint-disable sites and backend pytest skip/xfail sites.
# (Coverage `omit` entries in backend/.coveragerc are plain path globs with no
# room for an inline comment/reason, so they are out of scope for this
# marker — see docs/development/suppressions.md.)
SCAN_PATHS="frontend/src backend"

# The marker pattern, as a POSIX basic regular expression (no -E needed):
# parentheses are literal in BRE, so no escaping is required either.
MARKER_PATTERN='SUPPRESSED-UNTIL(#[0-9]*)'

# gitlab_issue_state <issue_iid> — prints "closed", "opened", or "unknown"
# (API/network failure — fail OPEN/non-blocking, this is a hygiene gate, not
# a security gate; see script header) for the given issue IID in this
# project.
#
# CHECK_SUPPRESSION_MOCK_CLOSED, if set, is a comma-separated list of issue
# numbers to treat as closed and short-circuits the real API call entirely —
# used only by --self-test so the gate's own test needs no network access
# and no real issue to exist.
gitlab_issue_state() {
  issue_iid="$1"

  if [ -n "${CHECK_SUPPRESSION_MOCK_CLOSED:-}" ]; then
    case ",${CHECK_SUPPRESSION_MOCK_CLOSED}," in
      *",${issue_iid},"*) echo "closed" ;;
      *) echo "opened" ;;
    esac
    return 0
  fi

  api_base="${CI_API_V4_URL:-https://gitlab.com/api/v4}"
  project="${CI_PROJECT_ID:-visiban%2Fvisiban}"
  url="${api_base}/projects/${project}/issues/${issue_iid}"

  response=""
  if [ -n "${CI_JOB_TOKEN:-}" ]; then
    response="$(curl -sf -H "JOB-TOKEN: ${CI_JOB_TOKEN}" "$url" 2>/dev/null)" || true
  elif [ -n "${GITLAB_API_TOKEN:-}" ]; then
    response="$(curl -sf -H "PRIVATE-TOKEN: ${GITLAB_API_TOKEN}" "$url" 2>/dev/null)" || true
  else
    response="$(curl -sf "$url" 2>/dev/null)" || true
  fi

  if [ -z "$response" ]; then
    echo "unknown"
    return 0
  fi

  state="$(printf '%s' "$response" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' | head -n 1)"
  case "$state" in
    closed) echo "closed" ;;
    opened) echo "opened" ;;
    *) echo "unknown" ;;
  esac
}

# run_scan <path...> — scans the given paths for the marker and prints one
# finding line per closed-issue citation. Returns 1 if any citation is
# closed, 0 otherwise (including when the paths contain no markers at all).
#
# A missing scan path is itself a failure, not a clean scan: `grep -r` on a
# nonexistent path errors on stderr (which we otherwise discard) and `|| true`
# would silently swallow that, letting a future rename of frontend/src or
# backend turn this gate into a silent no-op that always reports OK without
# scanning anything — exactly the "the number stopped meaning anything"
# failure mode #1092/#1090 exists to catch, applied to the gate itself.
run_scan() {
  scan_fail=0
  for p in "$@"; do
    if [ ! -e "$p" ]; then
      echo "check-suppression-issues: ERROR — scan path '$p' does not exist; refusing to report a clean scan without having scanned it." >&2
      scan_fail=1
    fi
  done

  tmp_matches="$(mktemp)"
  # grep -rn: recursive + line numbers, supported by both GNU and BusyBox
  # grep. No -E: the marker pattern above is plain BRE.
  grep -rn "$MARKER_PATTERN" "$@" > "$tmp_matches" 2>/dev/null || true

  # Read from a file, not a pipe: a `... | while read` pipeline runs the loop
  # in a subshell under POSIX sh (dash/ash), so `scan_fail` set inside it
  # would be lost. Redirection keeps the loop in the current shell.
  while IFS=: read -r file lineno rest; do
    [ -n "${file:-}" ] || continue
    issue="$(printf '%s' "$rest" | sed -n 's/.*SUPPRESSED-UNTIL(#\([0-9][0-9]*\)).*/\1/p')"
    [ -n "$issue" ] || continue

    state="$(gitlab_issue_state "$issue")"
    case "$state" in
      closed)
        scan_fail=1
        echo "check-suppression-issues: ${file}:${lineno}: SUPPRESSED-UNTIL(#${issue}) cites issue #${issue}, which is CLOSED — remove the suppression or re-scope the marker to a new tracked issue." >&2
        ;;
      unknown)
        echo "check-suppression-issues: WARNING — could not determine the state of #${issue} (${file}:${lineno}); not blocking on an inconclusive lookup." >&2
        ;;
    esac
  done < "$tmp_matches"

  rm -f "$tmp_matches"
  return "$scan_fail"
}

# self_test — see script header. Never touches the network.
self_test() {
  fixture_dir="$(mktemp -d)"
  trap 'rm -rf "$fixture_dir"' EXIT

  ok=1

  mkdir -p "$fixture_dir/closed"
  cat > "$fixture_dir/closed/bad.ts" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#9999): self-test fixture, not a real issue
EOF
  if CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_scan "$fixture_dir/closed"; then
    echo "check-suppression-issues --self-test: FAIL — a marker citing a closed issue did not block." >&2
    ok=0
  fi

  mkdir -p "$fixture_dir/open"
  cat > "$fixture_dir/open/good.ts" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#8888): self-test fixture, not a real issue
EOF
  if ! CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_scan "$fixture_dir/open"; then
    echo "check-suppression-issues --self-test: FAIL — a marker citing an open issue was incorrectly blocked." >&2
    ok=0
  fi

  mkdir -p "$fixture_dir/plain"
  cat > "$fixture_dir/plain/fine.ts" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- deps intentionally narrowed, permanent
EOF
  if ! CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_scan "$fixture_dir/plain"; then
    echo "check-suppression-issues --self-test: FAIL — a plain '-- reason' suppression with no marker was incorrectly flagged." >&2
    ok=0
  fi

  rm -rf "$fixture_dir"
  trap - EXIT

  if [ "$ok" -eq 1 ]; then
    echo "check-suppression-issues --self-test: OK — fires on a closed-issue marker, passes an open-issue marker, ignores a plain reason."
    return 0
  fi
  return 1
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi

  # shellcheck disable=SC2086  # SCAN_PATHS is intentionally word-split (two bare paths, no globs/spaces).
  if run_scan $SCAN_PATHS; then
    echo "check-suppression-issues: OK — no SUPPRESSED-UNTIL(#N) marker cites a closed issue."
    exit 0
  else
    echo "" >&2
    echo "check-suppression-issues: FAIL — one or more SUPPRESSED-UNTIL(#N) markers cite a closed issue." >&2
    exit 1
  fi
}

main "$@"
