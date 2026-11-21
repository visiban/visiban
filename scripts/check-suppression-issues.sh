#!/usr/bin/env bash
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
# #1694: the previous version sent `JOB-TOKEN: $CI_JOB_TOKEN` to
# `GET /projects/:id/issues/:iid` — which answers 401 to ANY job token on
# this public project, while the identical request with no auth header at
# all answers 200. `curl -sf` swallowed that 401 into an empty body, every
# lookup read "unknown", and the gate's own documented fail-open policy for
# an unreachable tracker silently absorbed what should have been a hard
# "closed" finding: this gate had never actually blocked a closed-issue
# citation in CI, because `frontend/src`/`backend` held zero markers to
# notice it with. It also made one request per marker site with no retry
# (429 risk against GitLab's per-IP anonymous budget) and used `sed | head`
# behind a pipe. Fixed by porting scripts/lib/gitlab-issues.sh
# (trueppm/trueppm#4452): resolve every *unique* cited issue in one batched
# call, retrying transient failures, with GITLAB_API_TOKEN / ISSUES_API_TOKEN
# only — never JOB-TOKEN. The job now runs this script with `bash` (was
# `sh`) to use that library; see docs/development/suppressions.md.
#
# #1812: the same job also scans backend/nightly-load-test-baseline.json for
# `pending_budget: "#NNNN"` markers (see run_pending_scan) and fails when the
# cited issue is closed or missing.
#
# Usage:
#   bash scripts/check-suppression-issues.sh              # real run
#   bash scripts/check-suppression-issues.sh --self-test   # gate self-test
#
# Self-test (issue #1093's meta-gate requires every bespoke CI gate to carry
# one): builds a small fixture tree, points the issue-state lookup at a mock
# (no network), and asserts the detection logic actually fires on a marker
# citing a "closed" issue, passes one citing an "open" issue, and leaves a
# plain `-- reason` suppression alone. Exits non-zero if any of that does not
# hold — i.e. if the gate itself is broken. The real-fetch path (batching,
# the JOB-TOKEN-never-sent guarantee, and the new "tracker didn't return
# this issue" state) is covered separately, with a fake `curl` on PATH, by
# scripts/tests/check-suppression-issues.test.sh and
# scripts/tests/gitlab-issues.test.sh — this inline self-test only exercises
# CHECK_SUPPRESSION_MOCK_CLOSED, which never touches the network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/gitlab-issues.sh
source "${REPO_ROOT}/scripts/lib/gitlab-issues.sh"

# Paths this gate scans for the marker. Kept in sync with the areas #1092
# audited: frontend eslint-disable sites and backend pytest skip/xfail sites,
# plus frontend/e2e, where each axe BASELINE entry in a11y.spec.ts carries the
# marker for its tracking issue (#1423).
# (Coverage `omit` entries in backend/.coveragerc are plain path globs with no
# room for an inline comment/reason, so they are out of scope for this
# marker — see docs/development/suppressions.md.)
SCAN_PATHS="frontend/src frontend/e2e backend"

# The marker pattern, as a POSIX basic regular expression (no -E needed):
# parentheses are literal in BRE, so no escaping is required either. Still
# matched with plain `grep -rn` (no GNU-only flags) even though this job now
# runs under bash — the pattern itself is unchanged from #1092.
MARKER_PATTERN='SUPPRESSED-UNTIL(#[0-9]*)'

# resolve_issue_state <issue_iid> <states_blob>
#
# <states_blob> is the "<iid><TAB><state>" lines already resolved for this
# run (see run_scan). Prints "opened", "closed", or "missing" — "missing"
# covers both a nonexistent issue number and one that exists but is
# confidential/invisible to the token in use; the API makes no distinction,
# and this gate must not treat either as a free pass (#1694).
resolve_issue_state() {
  local issue_iid="$1" states="$2" iid state
  while IFS=$'\t' read -r iid state; do
    [ -n "${iid:-}" ] || continue
    if [ "$iid" = "$issue_iid" ]; then
      printf '%s' "$state"
      return 0
    fi
  done <<< "$states"
  printf '%s' "missing"
}

# run_scan <path...> — scans the given paths for the marker and prints one
# finding line per citation whose issue is closed, or whose issue the
# tracker did not return at all. Returns 1 if any citation is closed or
# missing, 0 otherwise (including when the paths contain no markers at all,
# or when the tracker lookup itself is inconclusive — this is a hygiene
# gate, not a security gate, and fails open on a lookup failure rather than
# blocking the pipeline on an inconclusive one; see
# docs/development/suppressions.md).
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

  local tmp_matches
  tmp_matches="$(mktemp)"
  # grep -rn: recursive + line numbers, supported by both GNU and BusyBox
  # grep. No -E: the marker pattern above is plain BRE.
  grep -rn "$MARKER_PATTERN" "$@" > "$tmp_matches" 2>/dev/null || true

  # Pass 1: collect every *unique* issue number cited across all marker
  # sites, so the lookup (real or CHECK_SUPPRESSION_MOCK_CLOSED) runs once
  # per run, not once per marker (#1694). Read from a file, not a pipe: a
  # `... | while read` pipeline runs the loop in a subshell under POSIX
  # sh/dash, and even under bash it would leave `ids`/`seen` edits trapped in
  # the pipeline's subshell — redirection keeps the loop in this shell.
  local issue ids=() seen=","
  while IFS=: read -r file lineno rest; do
    [ -n "${file:-}" ] || continue
    issue="$(printf '%s' "$rest" | sed -n 's/.*SUPPRESSED-UNTIL(#\([0-9][0-9]*\)).*/\1/p')"
    [ -n "$issue" ] || continue
    case "$seen" in
      *",${issue},"*) ;;
      *)
        ids+=("$issue")
        seen="${seen}${issue},"
        ;;
    esac
  done < "$tmp_matches"

  local states="" lookup_rc=0
  if [ "${#ids[@]}" -gt 0 ]; then
    if [ -n "${CHECK_SUPPRESSION_MOCK_CLOSED:-}" ]; then
      # Test-only short-circuit (--self-test and
      # scripts/tests/check-suppression-issues.test.sh): never touches the
      # network. Comma-separated issue numbers in CHECK_SUPPRESSION_MOCK_CLOSED
      # are "closed"; everything else cited is "opened" — this mock never
      # produces "missing", by design (the real-fetch "missing" path is
      # covered separately with a fake curl on PATH).
      local lines=""
      for issue in "${ids[@]}"; do
        case ",${CHECK_SUPPRESSION_MOCK_CLOSED}," in
          *",${issue},"*) lines="${lines}${issue}$(printf '\t')closed"$'\n' ;;
          *) lines="${lines}${issue}$(printf '\t')opened"$'\n' ;;
        esac
      done
      states="$lines"
    else
      states="$(gitlab_issue_states "${ids[@]}")" || lookup_rc=1
    fi
  fi

  if [ "$lookup_rc" -ne 0 ]; then
    echo "check-suppression-issues: WARNING — could not resolve the cited issues' state (tracker unreachable, or no usable token/anonymous access); not blocking on an inconclusive lookup." >&2
  fi

  # Pass 2: evaluate every marker site against the states resolved above.
  while IFS=: read -r file lineno rest; do
    [ -n "${file:-}" ] || continue
    issue="$(printf '%s' "$rest" | sed -n 's/.*SUPPRESSED-UNTIL(#\([0-9][0-9]*\)).*/\1/p')"
    [ -n "$issue" ] || continue

    if [ "$lookup_rc" -ne 0 ]; then
      # Already warned once above; every citation is equally inconclusive
      # when the batch lookup itself failed.
      continue
    fi

    local state
    state="$(resolve_issue_state "$issue" "$states")"
    case "$state" in
      closed)
        scan_fail=1
        echo "check-suppression-issues: ${file}:${lineno}: SUPPRESSED-UNTIL(#${issue}) cites issue #${issue}, which is CLOSED — remove the suppression or re-scope the marker to a new tracked issue." >&2
        ;;
      missing)
        scan_fail=1
        echo "check-suppression-issues: ${file}:${lineno}: SUPPRESSED-UNTIL(#${issue}) cites issue #${issue}, which the tracker did not return (it does not exist, or is confidential to the token/anonymous access used) — re-scope the marker to a real, visible issue." >&2
        ;;
    esac
  done < "$tmp_matches"

  rm -f "$tmp_matches"
  return "$scan_fail"
}

# --- Pending budgets in the nightly load-test baseline (#1812) ---------------
#
# A baseline entry with `budget_p95_ms: null` and `pending_budget: "#NNNN"` is
# measured but not gated (docs/development/nightly-load-test.md, "Pending
# budgets"). Nothing else notices when the cited issue closes while the entry
# is still pending, so the scenario could stay ungated indefinitely. This is
# the same "waiting on tracked work" shape as SUPPRESSED-UNTIL, so it is
# checked here, with the same lookup, the same closed/missing findings and the
# same fail-open policy.
#
# The marker shape matches scripts/nightly_load_test.py `_pending_budget()`:
# a pending entry has a null budget AND a "#NNNN" string. An entry that
# carries a `pending_budget` but also a non-null `budget_p95_ms` is gated
# normally, so it is not pending and is ignored here (a stale marker on a
# gated entry blocks nothing, and the issue closing is expected).
# CHECK_SUPPRESSION_BASELINE is a test seam: the end-to-end test points main() at a
# fixture with a pending entry, because the real baseline carries none once every
# budget is derived (#1808).
BASELINE_FILE="${CHECK_SUPPRESSION_BASELINE:-backend/nightly-load-test-baseline.json}"

# pending_budget_entries <baseline_file> — prints "<name><TAB><iid>" per
# pending entry. Returns non-zero if the file is not parseable JSON.
pending_budget_entries() {
  # Two pending shapes: a null p95 budget with pending_budget, and a null peak-RSS
  # budget with pending_memory_budget (#2430). Each is checked independently, so an
  # entry gated on p95 but pending on memory is still tracked.
  jq -r '(.endpoints // {}) | to_entries[]
    | select(.value | type == "object")
    | .key as $k | .value as $v
    | ( ( $v | select(.budget_p95_ms == null)
          | select((.pending_budget | type) == "string" and (.pending_budget | test("^#[0-9]+$")))
          | "\($k)\t\(.pending_budget[1:])" ),
        ( $v | select(.budget_peak_rss_mb == null)
          | select((.pending_memory_budget | type) == "string" and (.pending_memory_budget | test("^#[0-9]+$")))
          | "\($k)\t\(.pending_memory_budget[1:])" ) )' "$1"
}

# run_pending_scan <baseline_file> — returns 1 if any pending entry cites a
# closed or tracker-missing issue (or the file is missing/unparseable); 0
# otherwise, including when the lookup is inconclusive (fail open, like
# run_scan).
run_pending_scan() {
  local file="$1" entries name iid
  if [ ! -f "$file" ]; then
    echo "check-suppression-issues: ERROR — baseline '$file' does not exist; refusing to report a clean pending_budget scan without having scanned it." >&2
    return 1
  fi
  if ! entries="$(pending_budget_entries "$file" 2>/dev/null)"; then
    echo "check-suppression-issues: ERROR — could not parse '$file' as JSON; refusing to report a clean pending_budget scan." >&2
    return 1
  fi
  [ -n "$entries" ] || return 0

  local ids=() seen=","
  while IFS=$'\t' read -r name iid; do
    [ -n "${iid:-}" ] || continue
    case "$seen" in
      *",${iid},"*) ;;
      *) ids+=("$iid"); seen="${seen}${iid}," ;;
    esac
  done <<< "$entries"

  local states="" lookup_rc=0 lines="" i
  if [ -n "${CHECK_SUPPRESSION_MOCK_CLOSED:-}" ]; then
    # Same test-only short-circuit as run_scan: never touches the network.
    for i in "${ids[@]}"; do
      case ",${CHECK_SUPPRESSION_MOCK_CLOSED}," in
        *",${i},"*) lines="${lines}${i}$(printf '\t')closed"$'\n' ;;
        *) lines="${lines}${i}$(printf '\t')opened"$'\n' ;;
      esac
    done
    states="$lines"
  else
    states="$(gitlab_issue_states "${ids[@]}")" || lookup_rc=1
  fi

  if [ "$lookup_rc" -ne 0 ]; then
    echo "check-suppression-issues: WARNING — could not resolve the pending_budget issues' state (tracker unreachable, or no usable token/anonymous access); not blocking on an inconclusive lookup." >&2
    return 0
  fi

  local pending_fail=0 state
  while IFS=$'\t' read -r name iid; do
    [ -n "${iid:-}" ] || continue
    state="$(resolve_issue_state "$iid" "$states")"
    case "$state" in
      closed)
        pending_fail=1
        echo "check-suppression-issues: ${file}: endpoint '${name}' has a pending budget (pending_budget or pending_memory_budget) #${iid}, which is CLOSED — assign its budget_p95_ms or budget_peak_rss_mb and delete the pending key (whole-file NUC re-derivation), or re-point pending_budget at a new tracked issue." >&2
        ;;
      missing)
        pending_fail=1
        echo "check-suppression-issues: ${file}: endpoint '${name}' has pending_budget #${iid}, which the tracker did not return (it does not exist, or is confidential to the token/anonymous access used) — re-point pending_budget at a real, visible issue." >&2
        ;;
    esac
  done <<< "$entries"
  return "$pending_fail"
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

  mkdir -p "$fixture_dir/mixed-dedup"
  cat > "$fixture_dir/mixed-dedup/a.ts" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#7777): self-test fixture, not a real issue
EOF
  cat > "$fixture_dir/mixed-dedup/b.ts" <<'EOF'
// eslint-disable-next-line react-hooks/exhaustive-deps -- SUPPRESSED-UNTIL(#7777): self-test fixture, not a real issue
EOF
  if ! CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_scan "$fixture_dir/mixed-dedup"; then
    echo "check-suppression-issues --self-test: FAIL — two markers citing the SAME open issue were incorrectly blocked (dedup regression)." >&2
    ok=0
  fi

  # An axe BASELINE entry in frontend/e2e/a11y.spec.ts (#1423): the marker is a
  # trailing comment on an object-literal line, not an eslint-disable.
  mkdir -p "$fixture_dir/a11y-baseline"
  cat > "$fixture_dir/a11y-baseline/a11y.spec.ts" <<'EOF'
    'color-contrast': { maxNodes: 4 }, // SUPPRESSED-UNTIL(#9999)
EOF
  if CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_scan "$fixture_dir/a11y-baseline" 2>/dev/null; then
    echo "check-suppression-issues --self-test: FAIL — an a11y BASELINE entry citing a closed issue did not block." >&2
    ok=0
  fi

  mkdir -p "$fixture_dir/pending"
  cat > "$fixture_dir/pending/baseline.json" <<'EOF'
{"endpoints": {"a": {"budget_p95_ms": null, "pending_budget": "#9999"}, "b": {"budget_p95_ms": 50}}}
EOF
  if CHECK_SUPPRESSION_MOCK_CLOSED="9999" run_pending_scan "$fixture_dir/pending/baseline.json" 2>/dev/null; then
    echo "check-suppression-issues --self-test: FAIL — a pending_budget citing a closed issue did not block." >&2
    ok=0
  fi
  if ! CHECK_SUPPRESSION_MOCK_CLOSED="1" run_pending_scan "$fixture_dir/pending/baseline.json"; then
    echo "check-suppression-issues --self-test: FAIL — a pending_budget citing an open issue was incorrectly blocked." >&2
    ok=0
  fi

  rm -rf "$fixture_dir"
  trap - EXIT

  if [ "$ok" -eq 1 ]; then
    echo "check-suppression-issues --self-test: OK — fires on a closed-issue marker, passes an open-issue marker, ignores a plain reason, dedupes repeated citations, blocks an a11y BASELINE entry, gates pending_budget on its issue's state."
    return 0
  fi
  return 1
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi

  # Run both scans before deciding, so one run reports every finding.
  local rc=0
  # shellcheck disable=SC2086  # SCAN_PATHS is intentionally word-split (bare paths, no globs/spaces).
  if run_scan $SCAN_PATHS; then
    echo "check-suppression-issues: OK — no SUPPRESSED-UNTIL(#N) marker cites a closed or unresolvable issue."
  else
    echo "" >&2
    echo "check-suppression-issues: FAIL — one or more SUPPRESSED-UNTIL(#N) markers cite a closed issue, or an issue the tracker could not confirm exists and is open." >&2
    rc=1
  fi
  if run_pending_scan "$BASELINE_FILE"; then
    echo "check-suppression-issues: OK — no pending_budget in ${BASELINE_FILE} cites a closed or unresolvable issue."
  else
    echo "" >&2
    echo "check-suppression-issues: FAIL — one or more pending_budget entries in ${BASELINE_FILE} cite a closed issue, or an issue the tracker could not confirm exists and is open." >&2
    rc=1
  fi
  exit "$rc"
}

main "$@"
