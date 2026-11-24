#!/usr/bin/env python3
"""Nightly load test — measures p50/p95/p99 latency for Visiban's most
volume-sensitive read endpoints and fails if any exceeds its committed budget.

Background (#1082): `perf-check` (static N+1 review) and `perf-bench` (query
counts on demand) both measure query *count*, which is correlated with but not
equivalent to latency — a regression from a missing index or a data-volume
change can leave the query count and query text identical while making the
same queries slower. This script measures wall-clock latency directly,
against a large seeded fixture, so that class of regression has somewhere to
show up before a customer notices it.

Covers the read endpoints most sensitive to data volume. card_timeline is the
one boards/migrations 0045 (activity/comment composite indexes) exists to keep
fast. card_search filters with ci_contains (ILIKE on PostgreSQL, #1809), which
migration 0030's trigram GIN indexes can serve for selective terms; its broad
'the' term still scans. Its budget was measured before that change and is to be
re-derived (#2063). It measures the access filter and one
cursor page, as a one-board user (#1805).
  - board_list              GET  /api/v1/boards/                    (#1723, budget: #1767)
  - board_full              GET  /api/v1/boards/{id}/full/
  - card_search             GET  /api/v1/cards/?search=...          (#1805)
  - card_search_multi_board GET  /api/v1/cards/?search=...          (#1810, as demo3, 200 boards)
  - card_timeline           GET  /api/v1/boards/{id}/cards/{id}/timeline/  (0045)
  - card_timeline_counts    GET  .../timeline/?include_counts=true   (#2195, what the card sheet requests)
  - board_movements         GET  /api/v1/boards/{id}/movements/      (#2237, first page, budget: #2237)
  - board_movements_deep    GET  .../movements/?offset=<3/4 deep>    (#2237, budget: #2237)
  - board_movements_dated   GET  .../movements/?moved_after=<30d ago> (#2237, budget: #2237)
  - card_list               GET  /api/v1/boards/{id}/cards/         (#2239, budget: #2237)
  - cards_archived          GET  /api/v1/boards/{id}/cards/archived/ (#2239, budget: #2237)
  - notifications_list      GET  /api/v1/notifications/
  - notifications_unread    GET  /api/v1/notifications/unread-count/
  - linked_board_full       GET  .../{linked board}/full/            (#2424, 500 cards each with a parent)
  - linked_card_list        GET  .../{linked board}/cards/           (#2424)
  - children_view           GET  .../{parent board}/children-view/   (#2538, 500 parents x ~100 children)
  - aged_*                  the summary, analytics and the metrics/* reads (single and overview) on the AGED board (#2430)
  - analytics_overview, aged_analytics_overview   the overview's two reads fired together by this script (#2430); the web app sends them one after the other

Peak memory (#2430): with --server-pid-file the script also records the server
process's peak RSS (VmHWM, reset before each scenario) per scenario. Linux only.

Usage (CI — nightly-load-test job in .gitlab-ci.yml):
    python scripts/nightly_load_test.py \\
        --base-url http://localhost:8000 \\
        --token-file /tmp/visiban_load_test_token \\
        --owner-token-file /tmp/visiban_load_test_owner_token \\
        --multi-board-token-file /tmp/visiban_load_test_multi_board_token \\
        --budget-file backend/nightly-load-test-baseline.json \\
        --output nightly-load-test-results.json

Usage (deriving/re-deriving the committed baseline — see
docs/development/nightly-load-test.md):
    python scripts/nightly_load_test.py --measure-only \\
        --base-url http://localhost:8000 \\
        --token-file /tmp/visiban_load_test_token \\
        --owner-token-file /tmp/visiban_load_test_owner_token \\
        --multi-board-token-file /tmp/visiban_load_test_multi_board_token \\
        --output nightly-load-test-results.json
    # Then recompute the WHOLE baseline from that artifact with the documented
    # formula budget_p95_ms = ceil(p95_ms * 1.4 / 5) * 5 (see the "Budget
    # derivation" section of docs/development/nightly-load-test.md) — never a
    # round number, and take the artifact from a NUC-runner job.

--owner-token-file (the board owner, demo1) is REQUIRED for a meaningful
board_list scenario: its 60ms budget was derived as the owner, whose access
query spans all 20 board memberships. Without it the scenario would run as the
plain member demo2 and silently measure a cheaper path. Likewise
--multi-board-token-file (demo3, who owns the --extra-boards fixture) is
REQUIRED for card_search_multi_board: as demo2 it would measure the one-board
plan again (#1810).

Pending budgets (#1810): a scenario whose baseline entry has
"budget_p95_ms": null AND a "pending_budget" issue reference ("#NNNN") is
measured and recorded but not gated, and the run prints a loud PENDING BUDGET
line for it (and a summary at the end) every time. This exists because a
budget may only come from a NUC run (see the doc), so a new scenario can land
before its budget can. The self-test rejects a null budget with no issue
reference, so "pending" can never be a silent default.
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

import requests

from _paths import PathEscapeError, cli_roots, resolve_within


def _wait_for_url(url: str, timeout: int = 60) -> None:
    """Poll *url* until it returns a non-5xx status or *timeout* seconds elapse."""
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code < 500:
                return
        except requests.exceptions.RequestException:
            pass
        attempt += 1
        print(f"  Waiting for {url} … ({attempt})", flush=True)
        time.sleep(2)
    raise RuntimeError(f"Service at {url} did not become ready within {timeout}s")


def _percentile(samples_ms, pct):
    """Nearest-rank percentile — no interpolation, so the reported number is
    always a value that was actually observed, never a synthetic average of two."""
    ordered = sorted(samples_ms)
    idx = max(0, min(len(ordered) - 1, int(round(pct / 100 * len(ordered))) - 1))
    return ordered[idx]


def _check_budget(p95_ms, budget_ms):
    """Return True if p95_ms is within budget_ms, False otherwise.

    Isolated from run() so --self-test can exercise the exact detection logic
    the nightly job's pass/fail verdict depends on, without needing a live
    server (#1093's house rule — see docs/development/ci-gates.md).
    """
    return p95_ms <= budget_ms


_PENDING_REF = re.compile(r"^#\d+$")


def _pending_budget(name, budgets):
    """Return the issue reference when *name* has an explicit pending budget.

    Pending means the baseline entry exists, has ``budget_p95_ms: null`` and a
    ``pending_budget`` of the form "#NNNN". Anything else returns None, which
    callers treat as a normal scenario (a missing/None budget with no valid
    reference is caught by the self-test, not tolerated here).
    """
    entry = budgets.get(name)
    if not isinstance(entry, dict) or entry.get("budget_p95_ms") is not None:
        return None
    ref = entry.get("pending_budget")
    return ref if isinstance(ref, str) and _PENDING_REF.match(ref) else None


# ── Peak memory (#2430) ────────────────────────────────────────────────────────
#
# The analytics endpoints break on memory before they break on latency: 186-691 MB
# for one request against a 512Mi pod. Python's RSS is a high-water mark of the
# heap, so the measure is the server process's VmHWM, reset immediately before a
# scenario (Linux: writing "5" to /proc/<pid>/clear_refs), read straight after.
# It is an absolute peak, so it includes the server's baseline and whatever the
# earlier scenarios left allocated; the scenario order is fixed, which keeps it
# comparable run to run. It needs the server's PID, so CI starts runserver with
# --noreload (no reloader parent) and writes `$!` to a file.

_STATUS_KB = re.compile(r"^(VmRSS|VmHWM):\s+(\d+)\s+kB\s*$", re.MULTILINE)


def _parse_proc_status(text):
    """Return {"rss_mb", "hwm_mb"} from the text of /proc/<pid>/status."""
    found = {key: int(kb) for key, kb in _STATUS_KB.findall(text)}
    if "VmRSS" not in found or "VmHWM" not in found:
        raise RuntimeError("no VmRSS/VmHWM in /proc status (not Linux, or not a live process)")
    return {"rss_mb": found["VmRSS"] / 1024.0, "hwm_mb": found["VmHWM"] / 1024.0}


class _ServerMemory:
    """Reads and resets the server process's peak RSS. ``pid=None`` disables it."""

    def __init__(self, pid, proc_root="/proc"):
        self.pid = pid
        self.proc_root = proc_root

    @classmethod
    def from_pid_file(cls, path, proc_root="/proc"):
        if not path:
            return cls(None)
        with open(resolve_within(cli_roots(), path), encoding="utf-8") as fh:
            pid = int(fh.read().strip())
        if not sys.platform.startswith("linux") and proc_root == "/proc":
            print("NOTE: --server-pid-file needs Linux /proc; peak memory is NOT measured.")
            return cls(None)
        mem = cls(pid, proc_root=proc_root)
        mem.read()  # fail now, not after twenty minutes, if the PID is wrong
        try:
            # Probe the write reset_peak will do, so an unprivileged or read-only /proc
            # is found now rather than on the first scenario after seeding.
            mem.reset_peak()
        except OSError as exc:
            print(f"NOTE: cannot write /proc/{pid}/clear_refs ({exc}); peak memory is NOT measured.")
            return cls(None)
        return mem

    @property
    def enabled(self):
        return self.pid is not None

    def read(self):
        with open(f"{self.proc_root}/{self.pid}/status", encoding="utf-8") as fh:
            return _parse_proc_status(fh.read())

    def reset_peak(self):
        """Make VmHWM start again from the current RSS."""
        with open(f"{self.proc_root}/{self.pid}/clear_refs", "w", encoding="utf-8") as fh:
            fh.write("5")


def _evaluate_memory_budget(name, peak_mb, budgets):
    """Return (budget_mb, within_budget, violation_msg) for one scenario's peak RSS.

    No ``budget_peak_rss_mb`` (or null) is measure-only, exactly as for latency.
    """
    budget_mb = budgets.get(name, {}).get("budget_peak_rss_mb")
    if budget_mb is None:
        return None, None, None
    within = peak_mb <= budget_mb
    msg = None if within else f"{name}: peak RSS {peak_mb:.0f}MB exceeds budget {budget_mb}MB"
    return budget_mb, within, msg


def _pending_memory_budget(name, budgets):
    """The issue reference when *name* has an explicit pending memory budget, else None."""
    entry = budgets.get(name)
    if not isinstance(entry, dict) or entry.get("budget_peak_rss_mb") is not None:
        return None
    ref = entry.get("pending_memory_budget")
    return ref if isinstance(ref, str) and _PENDING_REF.match(ref) else None


# Scenarios whose peak memory is gated (or pending): every scenario that replays
# movement history, on the active-only board and on the aged one.
_FLOW_SCENARIOS = (
    "flow_cycle_time", "flow_throughput", "flow_cumulative_flow", "flow_wip_age",
    "flow_dwell", "flow_blocked", "flow_attention", "flow_swimlanes", "flow_overview",
)
_AGED_SCENARIOS = (
    "aged_board_summary", "aged_board_analytics", "aged_board_analytics_365",
    "aged_flow_cycle_time", "aged_flow_throughput", "aged_flow_cumulative_flow",
    "aged_flow_wip_age", "aged_flow_dwell", "aged_flow_blocked", "aged_flow_attention",
    "aged_flow_swimlanes", "aged_flow_overview", "aged_flow_cumulative_flow_day",
)
_LINKED_SCENARIOS = ("linked_board_full", "linked_card_list")
_CHILDREN_VIEW_SCENARIOS = ("children_view",)
_FANOUT_SCENARIOS = ("analytics_overview", "aged_analytics_overview")
_MEMORY_GATED = (
    ("board_summary", "board_analytics") + _FLOW_SCENARIOS + _AGED_SCENARIOS + _FANOUT_SCENARIOS
    + _CHILDREN_VIEW_SCENARIOS
)

# The overview's two reads, which this script fires together into one server process (the web
# app itself sends them one after the other since #2428, so this is a stricter shape): since #2426 the
# seven flow charts come from one metrics/overview request (getFlowOverview in
# frontend/src/api/flowMetrics.ts:101) and the heatmap from analytics/ (getBoardAnalytics in
# frontend/src/api/boards.ts:188), both fired by useAnalyticsOverviewData.ts.
_OVERVIEW_PATHS = ("metrics/overview/", "analytics/")


def _committed(name, budgets, key):
    """True when *name* has a real (non-null) value for budget *key* in the baseline."""
    entry = budgets.get(name)
    return isinstance(entry, dict) and entry.get(key) is not None


def _check_measured(names, budgets, key, why):
    """Refuse to run when a scenario that is not being measured has a COMMITTED budget.

    A skipped scenario (no --analytics-token-file) or an off memory measurement is a NOTE
    while its budget is pending, but once the budget is committed the gate would pass with
    nothing measured: the same fail-open the refuse-to-run precedent in run() closes (#1767),
    and the absent-input rule in CLAUDE.md. *budgets* is empty under --measure-only.
    """
    unmeasured = [n for n in names if _committed(n, budgets, key)]
    if unmeasured:
        raise RuntimeError(
            f"{why}, but these scenarios have a committed {key} and would pass unmeasured: "
            + ", ".join(unmeasured) + " (#2430)."
        )


_ANALYTICS_USER_SCENARIOS = (
    _LINKED_SCENARIOS + _CHILDREN_VIEW_SCENARIOS + _AGED_SCENARIOS + ("aged_analytics_overview",)
)


def _check_analytics_measured(analytics_session, budgets):
    """The 17 loadtest_analytics scenarios must be measured once any has a committed budget."""
    if analytics_session is not None:
        return
    for key in ("budget_p95_ms", "budget_peak_rss_mb"):
        _check_measured(_ANALYTICS_USER_SCENARIOS, budgets, key,
                        "no --analytics-token-file, so the aged and linked scenarios are skipped")


def _check_memory_measured(server_mem, budgets):
    """Peak memory must be measured once any scenario has a committed memory budget."""
    if not server_mem.enabled:
        _check_measured(_MEMORY_GATED, budgets, "budget_peak_rss_mb",
                        "peak memory is not being measured (no usable --server-pid-file)")


# The overview's default range (useAnalyticsFilters.ts DEFAULT_DAYS), sent on every one of its
# two reads, as getFlowOverview (flowParams) and getBoardAnalytics do. analytics/ defaults to 30
# server side, so omitting it would measure a window the overview never asks for.
_OVERVIEW_DAYS = 90
# The overview's cap on each per-card list (#2429), mirroring OVERVIEW_LIST_LIMIT in
# frontend/src/api/analyticsLimits.ts, which getFlowOverview and getBoardAnalytics both send.
# The self-test fails if the two drift. Without it the scenario measures the uncapped response.
_OVERVIEW_LIST_LIMIT = 300
_OVERVIEW_QUERY = f"days={_OVERVIEW_DAYS}&limit={_OVERVIEW_LIST_LIMIT}"


def _aged_drill_down_day(today=None):
    """A UTC day about 18 months back, mid-history on the 3-year aged fixture (#2444)."""
    today = today or datetime.now(timezone.utc).date()
    return (today - timedelta(days=540)).isoformat()


def _aged_endpoints(base_url, board_id):
    """The scenarios measured on the aged board (#2430), name -> URL."""
    root = f"{base_url}/api/v1/boards/{board_id}"
    return {
        "aged_board_summary": f"{root}/summary/",
        # ?days=90&limit=300: what the Analytics overview sends (DEFAULT_DAYS, #2430; the cap,
        # #2429); the server's own default range is 30.
        "aged_board_analytics": f"{root}/analytics/?{_OVERVIEW_QUERY}",
        # The widest range: 691 MB at 12k active cards in the stress run (#2427).
        "aged_board_analytics_365": f"{root}/analytics/?days=365",
        "aged_flow_cycle_time": f"{root}/metrics/cycle-time/",
        "aged_flow_throughput": f"{root}/metrics/throughput/",
        # #2444: each card's placement is read from its few deciding rows, not its whole history.
        "aged_flow_cumulative_flow": f"{root}/metrics/cumulative-flow/",
        # The day drill-down, mid-history (#2444): every filtered card, finished work from any
        # year included, each from at most four rows.
        "aged_flow_cumulative_flow_day": f"{root}/metrics/cumulative-flow/?date={_aged_drill_down_day()}",
        "aged_flow_wip_age": f"{root}/metrics/wip-age/",
        "aged_flow_dwell": f"{root}/metrics/dwell/",
        "aged_flow_blocked": f"{root}/metrics/blocked/",
        "aged_flow_attention": f"{root}/metrics/attention/",
        "aged_flow_swimlanes": f"{root}/metrics/swimlanes/",
        # The single request the overview makes for its seven flow charts (#2426).
        "aged_flow_overview": f"{root}/metrics/overview/?{_OVERVIEW_QUERY}",
    }


def _linked_endpoints(base_url, board_id):
    """The scenarios measured on the linked child board (#2424), name -> URL."""
    root = f"{base_url}/api/v1/boards/{board_id}"
    return {"linked_board_full": f"{root}/full/", "linked_card_list": f"{root}/cards/"}


def _children_view_endpoints(base_url, board_id):
    """The scenario measured on the children-view parent board (#2538), name -> URL.

    The first page: the endpoint recomputes every live link on the board per page, so each page
    costs the same and scrolling a board is that cost times the page count.
    """
    return {"children_view": f"{base_url}/api/v1/boards/{board_id}/children-view/"}


def _gated_sample_card(cards):
    """The card the timeline scenarios read: roughly mid-set among cards that passed 2+ gates.

    #2405: the gate query runs for every card, gated or not, but it returns only gate rows with
    no linked movement. A card that passed exactly one gate has only the row linked to its move
    into the stage, so its timeline has no gate entries; every card with ``gates_passed >= 2``
    has an unlinked second-gate row. Picking any gated card would time the no-gate path under
    a name that says otherwise. Raises when the fixture has none, rather than falling back to a card that measures nothing.
    """
    gated = [c for c in cards if (c.get("gates_passed") or 0) >= 2]
    if not gated:
        raise RuntimeError(
            "No card on the load-test board has passed a gate, so card_timeline would not "
            "measure gate work. Re-seed with `manage.py seed_demo_data --force --scale N` (#2405)."
        )
    return gated[len(gated) // 2]


def _overview_urls(base_url, board_id):
    return [f"{base_url}/api/v1/boards/{board_id}/{path}?{_OVERVIEW_QUERY}" for path in _OVERVIEW_PATHS]


# The documented busy refusal of the analytics concurrency limit: 503 with this code.
ANALYTICS_BUSY_CODE = "analytics_busy"


class AnalyticsBusyRefusal(RuntimeError):
    """A measured analytics request was refused by the server's concurrency limit."""


def _raise_for_status(response):
    """``raise_for_status``, naming an ``analytics_busy`` refusal on its own.

    A refusal has no meaningful latency, so it fails the run either way, but
    as itself: the fix is the job's ``ANALYTICS_MAX_CONCURRENT`` (at least the
    fan-out width), not a performance regression to chase.
    """
    if response.status_code == 503:
        try:
            code = response.json().get("code")
        except (ValueError, AttributeError):
            code = None
        if code == ANALYTICS_BUSY_CODE:
            raise AnalyticsBusyRefusal(
                f"{response.url}: 503 {ANALYTICS_BUSY_CODE}. The server's analytics concurrency limit refused a "
                "measured request; set ANALYTICS_MAX_CONCURRENT for this job to at least the overview fan-out width "
                f"({len(_OVERVIEW_PATHS)})."
            )
    response.raise_for_status()


def _fan_out(fetch, urls):
    """Run ``fetch(url)`` for every URL at once; return wall time to the LAST one, in ms.

    Raises the first error: a failed request has no meaningful latency.
    """
    errors = []

    def worker(url):
        try:
            fetch(url)
        except Exception as exc:  # noqa: BLE001 -- re-raised on the calling thread below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(u,)) for u in urls]
    start = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed_ms = (time.perf_counter() - start) * 1000
    if errors:
        raise errors[0]
    return elapsed_ms


def _fan_out_samples(headers, urls, iterations, warmup):
    """Wall time of ``iterations`` overview-style fan-outs, after ``warmup`` discarded ones."""

    def fetch(url):
        # One Session per request: a Session is not documented as thread-safe.
        with requests.Session() as sess:
            sess.headers.update(headers)
            _raise_for_status(sess.get(url, timeout=120))

    for _ in range(warmup):
        _fan_out(fetch, urls)
    return [_fan_out(fetch, urls) for _ in range(iterations)]


def _count_of(body):
    """``count`` of a paginated body, the list length of a bare list, else None."""
    if isinstance(body, dict):
        return body.get("count") if "count" in body else len(body.get("results", []))
    return len(body) if isinstance(body, list) else None


def _self_test():
    """Build known-bad and known-good latency samples and prove the detection
    logic (percentile calculation + budget comparison) still fires correctly.

    Touches no network and no database — pure function checks, same shape as
    check-migration-numbering.sh's synthetic-repo self-test. It reads exactly one
    file, the committed baseline, to prove every scenario has a budget (#1767).
    """
    failures = []

    # --- _percentile: nearest-rank, deterministic on a known distribution ---
    samples = list(range(1, 101))  # 1..100 ms, one sample per integer
    p50 = _percentile(samples, 50)
    p95 = _percentile(samples, 95)
    p99 = _percentile(samples, 99)
    if p50 != 50:
        failures.append(f"_percentile(1..100, 50) = {p50}, expected 50")
    if p95 != 95:
        failures.append(f"_percentile(1..100, 95) = {p95}, expected 95")
    if p99 != 99:
        failures.append(f"_percentile(1..100, 99) = {p99}, expected 99")

    # --- KNOWN-BAD: p95 clearly over budget must be flagged as a violation ---
    # 40 samples, top 5 (indices 35-39 once sorted) are 2000ms — nearest-rank
    # p95 (idx = round(0.95*40)-1 = 37) lands inside that top block.
    bad_p95 = _percentile([500] * 35 + [2000] * 5, 95)  # p95 lands on 2000
    if _check_budget(bad_p95, 1000):
        failures.append(
            f"KNOWN-BAD case not flagged: p95={bad_p95}ms passed a 1000ms budget"
        )

    # --- KNOWN-GOOD: p95 clearly under budget must NOT be flagged ---
    good_p95 = _percentile([50] * 40, 95)
    if not _check_budget(good_p95, 1000):
        failures.append(
            f"KNOWN-GOOD case incorrectly flagged: p95={good_p95}ms failed a 1000ms budget"
        )

    # --- Boundary: p95 exactly at budget must pass (<=, not <) ---
    if not _check_budget(1000, 1000):
        failures.append("boundary case failed: p95 == budget must be within budget (<=)")

    # --- board_list (#1723) is measured; a scenario with no baseline entry is
    # measure-only (budgets.get(name, {}).get("budget_p95_ms") is None) ---
    eps = _endpoints("http://x", 1, 2)
    if eps.get("board_list") != "http://x/api/v1/boards/":
        failures.append("board_list scenario missing from _endpoints()")
    if eps.get("card_search_multi_board") != eps.get("card_search") or not eps.get("card_search"):
        failures.append("card_search_multi_board must hit the same URL as card_search (#1810)")
    # #2195: the counts scenario must request include_counts on the same card as the
    # plain timeline, or it would not measure the extra queries.
    if eps.get("card_timeline_counts") != eps.get("card_timeline", "") + "?include_counts=true":
        failures.append("card_timeline_counts must be card_timeline plus ?include_counts=true (#2195)")
    # #2237: the deep offset is page-aligned, inside the history, and 0 when there is no depth.
    for total, want in ((30000, 22500), (1001, 750), (50, 0), (None, 0), ("x", 0)):
        if _movements_deep_offset(total) != want:
            failures.append(f"_movements_deep_offset({total!r}) = {_movements_deep_offset(total)}, expected {want}")
    deps = _endpoints("http://x", 1, 2, 22500, "2026-01-01")
    if not deps["board_movements_deep"].endswith("/movements/?offset=22500"):
        failures.append("board_movements_deep must carry the derived offset (#2237)")
    if not deps["board_movements_dated"].endswith("/movements/?moved_after=2026-01-01"):
        failures.append("board_movements_dated must carry the moved_after date (#2237)")
    # Guard (#1767): every measured scenario must have a committed budget, so a
    # new scenario cannot silently stay measure-only (it could never fail the job).
    # Resolved from this file, not the cwd, so it works wherever the self-test runs.
    baseline_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "backend", "nightly-load-test-baseline.json"
    )
    try:
        with open(baseline_path, encoding="utf-8") as fh:
            committed = json.load(fh).get("endpoints", {})
    except (OSError, ValueError, AttributeError) as exc:
        failures.append(f"could not read committed baseline {baseline_path}: {exc}")
        committed = {}
    if not isinstance(committed, dict) or not committed:
        failures.append("committed baseline has no (or an empty) 'endpoints' mapping")
        committed = {}
    for name in eps:
        if not isinstance(committed.get(name), dict):
            failures.append(f"scenario {name!r} has no entry in nightly-load-test-baseline.json")
        elif committed[name].get("budget_p95_ms") is None and _pending_budget(name, committed) is None:
            failures.append(
                f"scenario {name!r} has no budget_p95_ms in nightly-load-test-baseline.json "
                "and no explicit pending_budget issue reference (#1810)"
            )
    # run()'s budget branch: no baseline entry => measure-only, never a violation,
    # even at an absurd p95; an entry over budget is still flagged.
    if _evaluate_budget("board_list", 10**9, {"board_full": {"budget_p95_ms": 1}}) != (None, None, None):
        failures.append("a scenario without a baseline entry must be measure-only")
    # Pending budgets (#1810): explicit, never a violation, and only valid with an
    # issue reference. A bare null budget, a malformed reference and a budgeted
    # scenario must NOT count as pending.
    _pend = {"s": {"budget_p95_ms": None, "pending_budget": "#1808"}}
    if _pending_budget("s", _pend) != "#1808":
        failures.append("a null budget with a '#NNNN' pending_budget must be pending")
    if _evaluate_budget("s", 10**9, _pend) != (None, None, None):
        failures.append("a pending-budget scenario must never produce a violation")
    for bad in (
        {"s": {"budget_p95_ms": None}},
        {"s": {"budget_p95_ms": None, "pending_budget": "soon"}},
        {"s": {"budget_p95_ms": 50, "pending_budget": "#1808"}},
        {},
    ):
        if _pending_budget("s", bad) is not None:
            failures.append(f"{bad!r} must not count as a pending budget")
    # Multi-board guards (#1810): a missing token and a shrunken fixture must both raise.
    for label, fn, ok_args, bad_args in (
        ("missing multi-board token", _require_multi_board_session,
         ({"card_search_multi_board": object()},), ({"board_list": object()},)),
        ("too few multi-board boards", _check_multi_board_count, (200, 200), (199, 200)),
    ):
        try:
            fn(*ok_args)
        except RuntimeError:
            failures.append(f"{label}: guard raised on a valid input")
        try:
            fn(*bad_args)
            failures.append(f"{label}: guard did not raise on a bad input")
        except RuntimeError:
            pass
    # Board counting (#1810): the OffsetCountPagination envelope has no `next`, so the
    # first page's 50 results must not be mistaken for the user's total.
    for body, want in (
        ({"count": 200, "offset": 0, "page_size": 50, "results": [{}] * 50}, 200),
        ({"results": [{}] * 3}, 3),
        ([{}] * 4, 4),
    ):
        if _boards_in_page(body) != want:
            failures.append(f"_boards_in_page({str(body)[:40]}...) != {want}")
    _b, _w, _msg = _evaluate_budget("board_full", 2000, {"board_full": {"budget_p95_ms": 1000}})
    if _w is not False or not _msg:
        failures.append("_evaluate_budget did not flag an over-budget scenario")

    # #2430 / #2424: peak memory, the aged and linked boards and the overview fan-out.
    sample_status = "Name:\tpython\nVmHWM:\t  524288 kB\nVmRSS:\t  262144 kB\n"
    if _parse_proc_status(sample_status) != {"rss_mb": 256.0, "hwm_mb": 512.0}:
        failures.append("_parse_proc_status did not read VmRSS/VmHWM in MB")
    try:
        _parse_proc_status("Name:\tpython\n")
        failures.append("_parse_proc_status accepted a status with no VmRSS/VmHWM")
    except RuntimeError:
        pass
    _mem = {"m": {"budget_peak_rss_mb": 400}, "p": {"budget_peak_rss_mb": None, "pending_memory_budget": "#2430"}}
    if _evaluate_memory_budget("m", 401.0, _mem)[1] is not False or _evaluate_memory_budget("m", 400.0, _mem)[1] is not True:
        failures.append("_evaluate_memory_budget must flag > budget and pass == budget")
    if _evaluate_memory_budget("p", 10**6, _mem) != (None, None, None) or _evaluate_memory_budget("x", 1, _mem) != (None, None, None):
        failures.append("a pending or missing memory budget must be measure-only")
    if _pending_memory_budget("p", _mem) != "#2430" or _pending_memory_budget("m", _mem) is not None:
        failures.append("_pending_memory_budget must need a null budget and a '#NNNN' reference")
    for bad in ({"s": {"budget_peak_rss_mb": None}}, {"s": {"budget_peak_rss_mb": None, "pending_memory_budget": "x"}}):
        if _pending_memory_budget("s", bad) is not None:
            failures.append(f"{bad!r} must not count as a pending memory budget")
    # _ServerMemory against a fake /proc: reads the status, writes "5" to clear_refs.
    import tempfile
    with tempfile.TemporaryDirectory() as fake_proc:
        os.makedirs(os.path.join(fake_proc, "123"))
        with open(os.path.join(fake_proc, "123", "status"), "w", encoding="utf-8") as fh:
            fh.write(sample_status)
        _sm = _ServerMemory(123, proc_root=fake_proc)
        _sm.reset_peak()
        with open(os.path.join(fake_proc, "123", "clear_refs"), encoding="utf-8") as fh:
            if fh.read() != "5":
                failures.append("_ServerMemory.reset_peak must write 5 to clear_refs")
        if not math.isclose(_sm.read()["hwm_mb"], 512.0) or _ServerMemory(None).enabled:
            failures.append("_ServerMemory misreads the status, or a None pid is not disabled")
    # from_pid_file (#2430): non-Linux and an unwritable clear_refs disable measurement with
    # a NOTE; a wrong PID on Linux still fails now, not after the seeding.
    import contextlib
    import io
    with tempfile.TemporaryDirectory() as work:
        pid_file = os.path.join(work, "server.pid")
        with open(pid_file, "w", encoding="utf-8") as fh:
            fh.write("123")
        fake = os.path.join(work, "proc")
        os.makedirs(os.path.join(fake, "123"))
        with open(os.path.join(fake, "123", "status"), "w", encoding="utf-8") as fh:
            fh.write(sample_status)
        real_platform = sys.platform

        def _from_pid(platform, proc_root):
            sys.platform = platform
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    return _ServerMemory.from_pid_file(pid_file, proc_root=proc_root), out.getvalue()
            finally:
                sys.platform = real_platform

        _m, _out = _from_pid("darwin", "/proc")
        if _m.enabled or "NOTE" not in _out:
            failures.append("from_pid_file on non-Linux must print a NOTE and disable measurement")
        _m, _out = _from_pid("linux", fake)
        if not _m.enabled or _out:
            failures.append("from_pid_file with a readable status and writable clear_refs must enable")
        os.remove(os.path.join(fake, "123", "clear_refs"))
        os.mkdir(os.path.join(fake, "123", "clear_refs"))  # opening a directory for write -> OSError
        _m, _out = _from_pid("linux", fake)
        if _m.enabled or "NOTE" not in _out:
            failures.append("from_pid_file with an unwritable clear_refs must print a NOTE and disable")
        try:
            _from_pid("linux", os.path.join(work, "no-such-proc"))
            failures.append("from_pid_file on Linux with an unreadable PID must fail at startup")
        except OSError:
            pass
    # _check_* (#2430): an unmeasured scenario with a committed budget refuses to run; a
    # pending one stays a NOTE. Skipped analytics scenarios, memory off.
    _b_pending = {n: {"budget_p95_ms": None, "pending_budget": "#2430", "budget_peak_rss_mb": None,
                      "pending_memory_budget": "#2430"} for n in _ANALYTICS_USER_SCENARIOS}
    _b_p95 = {**_b_pending, "aged_flow_dwell": {"budget_p95_ms": 900}}
    _b_rss = {**_b_pending, "linked_card_list": {"budget_peak_rss_mb": 400}}
    _mem_pending = {n: {"budget_peak_rss_mb": None, "pending_memory_budget": "#2430"} for n in _MEMORY_GATED}
    _mem_committed = {**_mem_pending, "flow_dwell": {"budget_peak_rss_mb": 400}}

    def _raises(fn, *a):
        try:
            fn(*a)
        except RuntimeError as exc:
            return str(exc)
        return None

    if _raises(_check_analytics_measured, None, _b_pending) or _raises(_check_analytics_measured, None, {}):
        failures.append("skipped analytics scenarios with only pending budgets must stay a NOTE")
    if "aged_flow_dwell" not in (_raises(_check_analytics_measured, None, _b_p95) or ""):
        failures.append("skipped analytics scenarios with a committed p95 budget must fail the run")
    if "linked_card_list" not in (_raises(_check_analytics_measured, None, _b_rss) or ""):
        failures.append("skipped analytics scenarios with a committed memory budget must fail the run")
    if _raises(_check_analytics_measured, object(), _b_p95):
        failures.append("a present analytics session must never trip the skip guard")
    _off, _on = _ServerMemory(None), _ServerMemory(1)
    if _raises(_check_memory_measured, _off, _mem_pending) or _raises(_check_memory_measured, _off, {}):
        failures.append("memory off with only pending memory budgets must stay a NOTE")
    if "flow_dwell" not in (_raises(_check_memory_measured, _off, _mem_committed) or ""):
        failures.append("memory off with a committed memory budget must fail the run")
    if _raises(_check_memory_measured, _on, _mem_committed):
        failures.append("memory on must never trip the memory guard")
    aged = _aged_endpoints("http://x", 7)
    if set(aged) != set(_AGED_SCENARIOS) or not aged["aged_board_analytics_365"].endswith("/boards/7/analytics/?days=365"):
        failures.append("_aged_endpoints and _AGED_SCENARIOS disagree, or the 365-day scenario lost its range")
    if aged["aged_board_analytics"] != "http://x/api/v1/boards/7/analytics/?days=90&limit=300":
        failures.append("aged_board_analytics must send exactly ?days=90&limit=300, as the overview does")
    if _children_view_endpoints("http://x", 9) != {"children_view": "http://x/api/v1/boards/9/children-view/"}:
        failures.append("_children_view_endpoints must name the children-view first page")
    if set(_children_view_endpoints("http://x", 9)) != set(_CHILDREN_VIEW_SCENARIOS):
        failures.append("_children_view_endpoints and _CHILDREN_VIEW_SCENARIOS disagree")
    _cards = [{"id": i, "gates_passed": 0} for i in range(4)] + [{"id": 10 + i, "gates_passed": 2} for i in range(5)]
    _cards += [{"id": 20 + i, "gates_passed": 1} for i in range(9)]
    if _gated_sample_card(_cards)["id"] != 12:
        failures.append("_gated_sample_card must pick the middle of the cards that passed 2+ gates, never a 1-gate card")
    if "gate" not in (_raises(_gated_sample_card, [{"id": 1, "gates_passed": 1}, {"id": 2}]) or ""):
        failures.append("_gated_sample_card must refuse a fixture with no gated card")
    if set(_linked_endpoints("http://x", 8)) != set(_LINKED_SCENARIOS):
        failures.append("_linked_endpoints and _LINKED_SCENARIOS disagree")
    # Exactly what useAnalyticsOverviewData.ts fires since #2426 (two requests; it never calls
    # summary/ or the single-chart endpoints); drift here means the fan-out stops measuring what
    # the overview does. Query strings included: days=90&limit=300 on both (no swimlane or label
    # filter, no grouping, no period, by default).
    _want_overview = {
        "http://x/api/v1/boards/1/metrics/overview/?days=90&limit=300",
        "http://x/api/v1/boards/1/analytics/?days=90&limit=300",
    }
    _got_overview = _overview_urls("http://x", 1)
    if len(_got_overview) != 2 or set(_got_overview) != _want_overview:
        failures.append("the overview fan-out must be exactly the two reads useAnalyticsOverviewData fires")
    if _aged_endpoints("http://x", 7)["aged_flow_overview"] != "http://x/api/v1/boards/7/metrics/overview/?days=90&limit=300":
        failures.append("aged_flow_overview must send exactly the overview's ?days=90&limit=300")
    # The cap must be the frontend's (#2429): a drift would time a response the page never asks for.
    limits_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "src", "api", "analyticsLimits.ts"
    )
    try:
        with open(limits_path, encoding="utf-8") as fh:
            _limit_match = re.search(r"OVERVIEW_LIST_LIMIT\s*=\s*(\d+)", fh.read())
    except OSError as exc:
        _limit_match = None
        failures.append(f"could not read {limits_path}: {exc}")
    if _limit_match is None or int(_limit_match.group(1)) != _OVERVIEW_LIST_LIMIT:
        failures.append("_OVERVIEW_LIST_LIMIT must equal OVERVIEW_LIST_LIMIT in frontend/src/api/analyticsLimits.ts")
    # The fan-out measures the LAST response, not the sum: four 50ms requests at once
    # must take about 50ms, never 200.
    _wall = _fan_out(lambda _u: time.sleep(0.05), ["a", "b", "c", "d"])
    if not 40 <= _wall < 150:
        failures.append(f"_fan_out wall time {_wall:.0f}ms is not the longest request (expected ~50ms)")
    try:
        _fan_out(lambda _u: (_ for _ in ()).throw(RuntimeError("boom")), ["a"])
        failures.append("_fan_out swallowed a failed request")
    except RuntimeError:
        pass
    if (_count_of({"count": 7, "results": []}), _count_of([1, 2]), _count_of({"results": [1]}), _count_of("x")) != (7, 2, 1, None):
        failures.append("_count_of misreads a page body")
    for name in _AGED_SCENARIOS + _LINKED_SCENARIOS + _CHILDREN_VIEW_SCENARIOS + _FANOUT_SCENARIOS:
        if not isinstance(committed.get(name), dict):
            failures.append(f"scenario {name!r} has no entry in nightly-load-test-baseline.json (#2430)")
        elif committed[name].get("budget_p95_ms") is None and _pending_budget(name, committed) is None:
            failures.append(f"scenario {name!r} has no budget_p95_ms and no pending_budget issue reference (#2430)")
    for name in _MEMORY_GATED:
        entry = committed.get(name) if isinstance(committed.get(name), dict) else {}
        if entry.get("budget_peak_rss_mb") is None and _pending_memory_budget(name, committed) is None:
            failures.append(
                f"scenario {name!r} has no budget_peak_rss_mb and no pending_memory_budget issue reference (#2430)"
            )

    # A busy refusal is reported as itself, never as a generic HTTP error or a latency.
    class _Busy:
        status_code, url = 503, "https://x/metrics/overview/"

        def json(self):
            return {"code": ANALYTICS_BUSY_CODE, "detail": "x"}

        def raise_for_status(self):
            raise AssertionError("raise_for_status reached for a busy refusal")

    try:
        _raise_for_status(_Busy())
        failures.append("an analytics_busy 503 was not refused")
    except AnalyticsBusyRefusal:
        pass
    except AssertionError as exc:
        failures.append(str(exc))

    # Exit run (#2588): the absolute-bar logic fires on a known-bad and a known-good input.
    stress = {"active_cards": EXIT_MIN_ACTIVE_CARDS, "archived_cards": EXIT_MIN_ACTIVE_CARDS * EXIT_MIN_AGED_GENERATIONS}
    good = {"fixture": dict(stress),
            "cumulative_flow_p95_ms": 2999, "drill_down_peak_rss_mb": 400, "overview_peak_rss_mb": 400,
            "analytics_365_rss_growth_mb": 149, "analytics_365_ms": 2999, "overview_payload_bytes": 1000,
            "unread_count_p95_ms": 99, "unread_samples": EXIT_MIN_UNREAD_SAMPLES, "concurrent_peak_rss_mb": 400,
            "over_cap": (True, "ok")}
    if not all(r["passed"] for r in _evaluate_exit_run(good)):
        failures.append("exit run: an all-inside-the-bars input did not pass")
    for key, bad in (("cumulative_flow_p95_ms", 3000), ("drill_down_peak_rss_mb", CONTAINER_MEMORY_LIMIT_MB),
                     ("overview_peak_rss_mb", 513), ("analytics_365_rss_growth_mb", 150), ("analytics_365_ms", 3000),
                     ("overview_payload_bytes", EXIT_OVERVIEW_PAYLOAD_BYTES), ("unread_count_p95_ms", 100),
                     ("concurrent_peak_rss_mb", 600), ("unread_count_p95_ms", None), ("fixture", None)):
        if all(r["passed"] for r in _evaluate_exit_run({**good, key: bad})):
            failures.append(f"exit run: {key}={bad} did not fail its bar")
    if all(r["passed"] for r in _evaluate_exit_run({**good, "over_cap": (False, "x")})):
        failures.append("exit run: a failed over-cap check did not fail the run")
    if CONTAINER_MEMORY_LIMIT_MB != 512:
        failures.append("exit run: the container memory limit constant is not 512 MB")

    # The fixture guard: the default nightly fixture (scale 20, 4 generations) and anything below the
    # stress fixture fails; the stress fixture's floor passes.
    for label, fx, want in (
        ("at both floors", stress, True),
        ("the scheduled nightly's fixture", {"active_cards": 2400, "archived_cards": 2400 * 4}, False),
        ("one card short", {"active_cards": EXIT_MIN_ACTIVE_CARDS - 1,
                            "archived_cards": (EXIT_MIN_ACTIVE_CARDS - 1) * EXIT_MIN_AGED_GENERATIONS}, False),
        ("one generation short", {"active_cards": EXIT_MIN_ACTIVE_CARDS,
                                  "archived_cards": EXIT_MIN_ACTIVE_CARDS * EXIT_MIN_AGED_GENERATIONS - 1}, False),
        ("no active cards", {"active_cards": 0, "archived_cards": 0}, False),
        ("unreadable count", {"active_cards": EXIT_MIN_ACTIVE_CARDS, "archived_cards": None}, False),
    ):
        fx = dict(fx)
        if _evaluate_exit_fixture(fx)["passed"] != want:
            failures.append(f"exit run fixture check ({label}): expected passed={want}")
        if want and fx.get("observed_generations") != EXIT_MIN_AGED_GENERATIONS:
            failures.append(f"exit run fixture check ({label}): observed_generations = {fx.get('observed_generations')}")
        bad_run = {**good, "fixture": fx}
        if not want and all(r["passed"] for r in _evaluate_exit_run(bad_run)):
            failures.append(f"exit run: a run on a fixture {label} still said every bar was met")

    # The mirrored admission limits still match the server's.
    try:
        with open(_ADMISSION_SOURCE, encoding="utf-8") as fh:
            admission_src = fh.read()
        for const, mine in (("PER_USER_MAX_IN_FLIGHT", EXIT_SERVER_PER_USER_MAX_IN_FLIGHT),
                            ("MAX_WAITERS", EXIT_SERVER_MAX_WAITERS)):
            found = re.search(rf"^{const} = (\d+)\b", admission_src, re.MULTILINE)
            if not found or int(found.group(1)) != mine:
                failures.append(f"exit run: analytics_admission.{const} is "
                                f"{found.group(1) if found else 'missing'}, the script mirrors {mine}")
    except OSError as exc:
        failures.append(f"exit run: could not read {_ADMISSION_SOURCE}: {exc}")
    if EXIT_DEFAULT_CONCURRENT_OPENS <= 1 + EXIT_SERVER_MAX_WAITERS:
        failures.append("exit run: the default burst does not exceed the shipped cap (1) plus the waiting room")

    for args_, want in (((200, None, None), "ok"), ((503, ANALYTICS_BUSY_CODE, "10"), "busy"),
                        ((503, ANALYTICS_BUSY_CODE, None), "unexpected"), ((503, None, "10"), "unexpected"),
                        ((422, TOO_LARGE_CODE, None), "too_large"), ((422, "other", None), "unexpected"),
                        ((500, None, None), "unexpected")):
        if _classify_analytics_response(*args_) != want:
            failures.append(f"exit run: _classify_analytics_response{args_} != {want}")

    # The over-cap check. N = 8 opens, cap 1 + 4 waiters = 5 admissible: what the global cap
    # produces, one open per user, is at most 5 admitted per round and the rest refused.
    n_opens, cap1, room = 8, 1, 1 + EXIT_SERVER_MAX_WAITERS

    def burst(rounds=2, ok=room, refused="busy"):
        return [(("ok", 1.0, r) if i < ok else (refused, 0.1, r)) for r in range(rounds) for i in range(n_opens)]

    for label, got, want in (
        ("global cap refusing, one user per open", _evaluate_over_cap(burst(), n_opens, cap1, True, n_opens)[0], True),
        ("refused as too_large", _evaluate_over_cap(burst(refused="too_large"), n_opens, cap1, True, n_opens)[0], True),
        ("stall", _evaluate_over_cap(burst() + [("stall", None, 0)], n_opens, cap1, True, n_opens)[0], False),
        ("unexpected status", _evaluate_over_cap(burst() + [("unexpected", 0.1, 0)], n_opens, cap1, True, n_opens)[0], False),
        ("server gone", _evaluate_over_cap(burst(), n_opens, cap1, False, n_opens)[0], False),
        ("slow request", _evaluate_over_cap(burst() + [("ok", EXIT_STALL_SECONDS + 1, 5)], n_opens, cap1, True, n_opens)[0], False),
        # Every open admitted: the cap was never exercised.
        ("nothing refused", _evaluate_over_cap(burst(ok=n_opens), n_opens, cap1, True, n_opens)[0], False),
        # More admitted in a round than the cap plus the waiting room can hold: the cap was ignored,
        # even though some opens were refused.
        ("cap ignored", _evaluate_over_cap(burst(ok=room + 1), n_opens, cap1, True, n_opens)[0], False),
        # The pre-fix run: every open as ONE user. The per-user limit refuses opens 3..N whatever the
        # global cap is, so these refusals are not accepted as proof of ANALYTICS_MAX_CONCURRENT.
        ("one user (per-user limit refusing)", _evaluate_over_cap(burst(ok=2), n_opens, cap1, True, 1)[0], False),
        ("fewer users than opens", _evaluate_over_cap(burst(), n_opens, cap1, True, n_opens - 1)[0], False),
        # A burst every open of which can be admitted (cap + waiters) forces no refusal: one it did
        # refuse (a waiter timing out) is left to timing, so it proves nothing about the cap.
        ("burst within cap + waiters",
         _evaluate_over_cap([("ok", 1.0, 0)] * (room - 1) + [("busy", 8.0, 0)], room, cap1, True, room)[0], False),
        ("burst within cap", _evaluate_over_cap(burst(), 1, cap1, True, 1)[0], False),
    ):
        if got != want:
            failures.append(f"exit run over-cap check ({label}): got {got}, expected {want}")

    # Exit run wiring (#2588): stubs stand in for the server, so no network is touched.
    class _Resp:
        status_code, reason, url = 422, "Unprocessable", "https://x/analytics/?days=365"

        def json(self):
            return {"code": TOO_LARGE_CODE}

    class _TooLarge(requests.exceptions.HTTPError):
        def __init__(self):
            super().__init__("422")
            self.response = _Resp()

    wired_burst = burst()

    class _StubOps:
        raises = ()

        def _go(self, name, value):
            if name in self.raises:
                raise _TooLarge()
            return value

        def fixture(self):
            return self._go("fx", dict(stress))

        def cumulative_flow(self):
            return self._go("cf", [1000.0] * 10)

        def drill_down(self):
            return self._go("dd", 111.0)

        def overview_open(self):
            return self._go("ov", (222.0, 5000))

        def analytics_365(self):
            return self._go("a365", ([2000.0] * 3, 77.0))

        def concurrent(self):
            return self._go("conc", (wired_burst, [10.0] * 30, [], 9000, 333.0))

        def alive(self):
            return True

    wired = _collect_exit_measurements(_StubOps(), n_opens, cap1, n_opens)
    for key, want in (("cumulative_flow_p95_ms", 1000.0), ("drill_down_peak_rss_mb", 111.0),
                      ("overview_peak_rss_mb", 222.0), ("analytics_365_ms", 2000.0),
                      ("analytics_365_rss_growth_mb", 77.0), ("overview_payload_bytes", 9000),
                      ("unread_count_p95_ms", 10.0), ("concurrent_peak_rss_mb", 333.0)):
        if wired.get(key) != want:
            failures.append(f"exit run wiring: {key} = {wired.get(key)}, expected {want}")
    wired_records = _evaluate_exit_run(wired)
    if not all(r["passed"] for r in wired_records):
        failures.append("exit run wiring: stub measurements inside every bar did not all pass")
    wired_out = _exit_output(wired, wired_records, n_opens, 2, cap1, n_opens)
    if not wired_out["passed"]:
        failures.append("exit run: a clean run's artifact did not say passed")
    if (wired_out.get("fixture") or {}).get("observed_generations") != EXIT_MIN_AGED_GENERATIONS \
            or wired_out.get("burst_users") != n_opens:
        failures.append("exit run: the artifact does not record the fixture and the burst's user count")
    # The same burst run as one user: the wiring passes the user count through and the run fails.
    if _evaluate_exit_run(_collect_exit_measurements(_StubOps(), n_opens, cap1, 1))[-1]["passed"]:
        failures.append("exit run wiring: a burst run as one user passed the over-cap check")
    # One measurement refused (analytics_too_large): recorded as that check's failure, the rest still run.
    broken = _StubOps()
    broken.raises = ("a365",)
    partial = _collect_exit_measurements(broken, n_opens, cap1, n_opens)
    partial_records = {r["check"]: r for r in _evaluate_exit_run(partial)}
    if partial_records["analytics_365_ms"]["passed"] or TOO_LARGE_CODE not in partial_records["analytics_365_ms"].get("detail", ""):
        failures.append("exit run: a refused analytics/?days=365 was not recorded as that check's failure with its reason")
    if not partial_records["cumulative_flow_p95_ms"]["passed"] or not partial_records["over_cap_refused_cleanly"]["passed"]:
        failures.append("exit run: one failed measurement stopped the other checks")
    if _exit_output(partial, list(partial_records.values()), n_opens, 2, cap1, n_opens)["passed"]:
        failures.append("exit run: an artifact with a failed check said passed")
    broken.raises = ("conc",)
    if _evaluate_exit_run(_collect_exit_measurements(broken, n_opens, cap1, n_opens))[-1]["passed"]:
        failures.append("exit run: a failed concurrent scenario still passed the over-cap check")
    broken.raises = ("fx",)
    fx_failed = {r["check"]: r for r in _evaluate_exit_run(_collect_exit_measurements(broken, n_opens, cap1, n_opens))}
    if fx_failed["fixture_is_stress_fixture"]["passed"] or not fx_failed["cumulative_flow_p95_ms"]["passed"]:
        failures.append("exit run: an unreadable fixture did not fail its check alone")
    # Minimum sample guard on unread-count.
    few = {**good, "unread_samples": EXIT_MIN_UNREAD_SAMPLES - 1}
    few_unread = [r for r in _evaluate_exit_run(few) if r["check"] == "unread_count_p95_ms_under_load"][0]
    if few_unread["passed"]:
        failures.append("exit run: too few unread-count samples did not fail the bar")
    enough = {**good, "unread_samples": EXIT_MIN_UNREAD_SAMPLES}
    if not all(r["passed"] for r in _evaluate_exit_run(enough)):
        failures.append("exit run: the minimum number of unread-count samples did not pass")

    # _ExitOps, the real ops: which endpoint each measurement requests, and which element of
    # peak_of's (result, peak RSS, RSS growth) it returns. Recording stubs, no network.
    requested = []

    class _RecResp:
        def __init__(self, url):
            self.url, self.content = url, b"x" * 4321

        def raise_for_status(self):
            pass

        def json(self):
            if self.url.endswith("/cards/archived/"):
                return {"count": 120, "results": []}
            return {"cards": [{}] * 10}

    class _RecSession:
        def get(self, url, timeout=None):
            requested.append(url)
            return _RecResp(url)

    def _rec_time(_session, url, iterations, warmup):
        requested.append(url)
        return [float(iterations)]

    hwm_mb, growth_mb = 444.0, 7.0

    def _rec_peak(fn):
        return fn(), hwm_mb, growth_mb

    rec_ops = _ExitOps(_RecSession(), "https://x", 9, _rec_peak,
                       concurrent=lambda: (wired_burst, [1.0], [], 55),
                       alive=lambda: True, iterations=3, warmup=1,
                       declared={"declared_scale": 100}, time_requests=_rec_time)
    root9 = "https://x/api/v1/boards/9"

    def _one_call(label, fn, check_url):
        del requested[:]
        result = fn()
        if len(requested) != 1 or not check_url(requested[0]):
            failures.append(f"exit run ops: {label} requested {requested}")
        return result

    _one_call("cumulative_flow", rec_ops.cumulative_flow,
              lambda u: u == f"{root9}/metrics/cumulative-flow/")
    dd = _one_call("drill_down", rec_ops.drill_down,
                   lambda u: u.startswith(f"{root9}/metrics/cumulative-flow/?date=")
                   and re.search(r"date=\d{4}-\d{2}-\d{2}$", u))
    if dd != hwm_mb:
        failures.append(f"exit run ops: drill_down returned {dd}, not the peak RSS (high-water mark)")
    ov = _one_call("overview_open", rec_ops.overview_open,
                   lambda u: u.startswith(f"{root9}/metrics/overview/?"))
    if ov != (hwm_mb, 4321):
        failures.append(f"exit run ops: overview_open returned {ov}, not (peak RSS, payload bytes)")
    a365 = _one_call("analytics_365", rec_ops.analytics_365,
                     lambda u: u == f"{root9}/analytics/?days=365")
    if a365 != ([3.0], growth_mb):
        failures.append(f"exit run ops: analytics_365 returned {a365}, not (samples, RSS growth)")
    conc = rec_ops.concurrent()
    if conc[4] != hwm_mb or conc[3] != 55:
        failures.append(f"exit run ops: concurrent returned peak {conc[4]}, payload {conc[3]}")
    del requested[:]
    fx = rec_ops.fixture()
    if sorted(requested) != sorted([f"{root9}/cards/archived/", f"{root9}/full/"]) \
            or (fx["active_cards"], fx["archived_cards"], fx.get("declared_scale")) != (10, 120, 100):
        failures.append(f"exit run ops: fixture() read {requested} -> {fx}")

    if failures:
        print("SELF-TEST FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("SELF-TEST OK: percentile calculation and budget comparison both fire correctly.")
    return 0


def _evaluate_budget(name, p95, budgets):
    """Return (budget_ms, within_budget, violation_msg) for one scenario.

    A scenario with no baseline entry, or a null budget (see _pending_budget), is
    measure-only: budget_ms is None and it can never produce a violation. The
    self-test requires every scenario to have a budget or an explicit pending
    reference, so measure-only is never silent.
    """
    budget_ms = budgets.get(name, {}).get("budget_p95_ms")
    if budget_ms is None:
        return None, None, None
    within = _check_budget(p95, budget_ms)
    msg = None if within else f"{name}: p95={p95:.1f}ms exceeds budget {budget_ms}ms"
    return budget_ms, within, msg


def _movements_deep_offset(total_count, page_size=50):
    """A page-aligned offset about three quarters into the board's history (#2237).

    A fixed offset would drift from "deep" as the fixture changes, or run past the
    end and measure an empty page, so it is derived from the count the first page
    reports.
    """
    if not isinstance(total_count, int) or total_count <= page_size:
        return 0
    return (total_count * 3 // 4) // page_size * page_size


def _endpoints(base_url, board_id, sample_card_id, movements_deep_offset=0, moved_after=None):
    """The measured scenarios, name -> URL.

    ``board_list`` (#1723) is budgeted in the baseline file (#1767). run() treats
    a scenario with no budget as measure-only (recorded, never a violation); the
    self-test requires every scenario here to have a budget or an explicit
    pending_budget issue reference (#1810).
    """
    return {
        "board_list": f"{base_url}/api/v1/boards/",
        "board_full": f"{base_url}/api/v1/boards/{board_id}/full/",
        "card_search": f"{base_url}/api/v1/cards/?search=the",
        # Same URL, different viewer: run as demo3 (see run()), who can access
        # ~200 boards, so the card SELECT gets the scan-and-sort plan (#1810).
        "card_search_multi_board": f"{base_url}/api/v1/cards/?search=the",
        "card_timeline": f"{base_url}/api/v1/boards/{board_id}/cards/{sample_card_id}/timeline/",
        # The card sheet requests the timeline with counts on every open and on every
        # card.version change (#967), so the extra COUNT queries need their own budget.
        "card_timeline_counts": (
            f"{base_url}/api/v1/boards/{board_id}/cards/{sample_card_id}/timeline/?include_counts=true"
        ),
        # Board History: first page, a deep offset, and a date-filtered page. #1961
        # removed the window count and turned the date filter into a datetime range;
        # query counts stay at 2 either way, so only latency can see a regression.
        "board_movements": f"{base_url}/api/v1/boards/{board_id}/movements/",
        "board_movements_deep": (
            f"{base_url}/api/v1/boards/{board_id}/movements/?offset={movements_deep_offset}"
        ),
        "board_movements_dated": (
            f"{base_url}/api/v1/boards/{board_id}/movements/?moved_after={moved_after or '1970-01-01'}"
        ),
        # Page queries that dropped their Window(Count) total for a plain page
        # plus a bare COUNT when the page is full (#2239).
        "card_list": f"{base_url}/api/v1/boards/{board_id}/cards/",
        "cards_archived": f"{base_url}/api/v1/boards/{board_id}/cards/archived/",
        "notifications_list": f"{base_url}/api/v1/notifications/",
        "notifications_unread": f"{base_url}/api/v1/notifications/unread-count/",
        # Both replay movement history since #448: summary for the cards completed
        # in 30 days, analytics for the cards relevant to its window.
        "board_summary": f"{base_url}/api/v1/boards/{board_id}/summary/",
        "board_analytics": f"{base_url}/api/v1/boards/{board_id}/analytics/",
        # The flow metrics replay the whole board's movement history (#448).
        "flow_cycle_time": f"{base_url}/api/v1/boards/{board_id}/metrics/cycle-time/",
        "flow_throughput": f"{base_url}/api/v1/boards/{board_id}/metrics/throughput/",
        "flow_cumulative_flow": f"{base_url}/api/v1/boards/{board_id}/metrics/cumulative-flow/",
        "flow_wip_age": f"{base_url}/api/v1/boards/{board_id}/metrics/wip-age/",
        "flow_dwell": f"{base_url}/api/v1/boards/{board_id}/metrics/dwell/",
        "flow_blocked": f"{base_url}/api/v1/boards/{board_id}/metrics/blocked/",
        "flow_attention": f"{base_url}/api/v1/boards/{board_id}/metrics/attention/",
        "flow_swimlanes": f"{base_url}/api/v1/boards/{board_id}/metrics/swimlanes/",
        # The one request the overview makes for its seven flow charts (#2426), as it sends it.
        "flow_overview": f"{base_url}/api/v1/boards/{board_id}/metrics/overview/?{_OVERVIEW_QUERY}",
    }


def _find_board(session, base_url, board_name):
    r = session.get(f"{base_url}/api/v1/boards/", timeout=15)
    r.raise_for_status()
    body = r.json()
    boards = body["results"] if isinstance(body, dict) and "results" in body else body
    for board in boards:
        if board.get("name") == board_name:
            return board
    raise RuntimeError(
        f"No board named '{board_name}' is visible to this token. "
        "Run `manage.py seed_demo_data --force --scale N` first."
    )


def _require_multi_board_session(sessions):
    """Raise unless the multi-board viewer's session is configured (#1810).

    Pure so --self-test can prove the guard fires without a server.
    """
    if "card_search_multi_board" not in sessions:
        raise RuntimeError(
            "--multi-board-token-file is required: card_search_multi_board must be "
            "measured as the multi-board user demo3 (#1810)"
        )


def _check_multi_board_count(count, minimum):
    """Raise if the multi-board user can access fewer than *minimum* boards.

    A seed that silently shrinks (or omits --extra-boards) would otherwise
    produce a valid-looking one-board number for the many-board scenario.
    """
    if count < minimum:
        raise RuntimeError(
            f"The multi-board user can access {count} boards, fewer than "
            f"--min-multi-boards={minimum}. Seed with "
            "`manage.py seed_demo_data --force --scale N --extra-boards M` (#1810)."
        )


def _boards_in_page(body):
    """Total boards a /boards/ response says exist for the user.

    The list uses OffsetCountPagination: {count, offset, page_size, results}, with
    no ``next`` link, so walking ``next`` stops after page 1 (50 boards) however
    many the user can access. ``count`` is the whole-queryset total. A bare list
    (unpaginated) is its own total.
    """
    if isinstance(body, dict) and "count" in body:
        return body["count"]
    if isinstance(body, dict):
        return len(body["results"])
    return len(body)


def _count_accessible_boards(session, base_url):
    """Number of boards visible to *session*'s user."""
    r = session.get(f"{base_url}/api/v1/boards/", timeout=30)
    r.raise_for_status()
    return _boards_in_page(r.json())


def _time_requests(session, url, iterations, warmup):
    """GET *url* `warmup` times (discarded) then `iterations` times, timed.

    Returns a list of elapsed times in milliseconds. Raises on any non-2xx
    response — a failed request has no meaningful latency and must not be
    silently averaged in with the successful ones.
    """
    for _ in range(warmup):
        r = session.get(url, timeout=30)
        r.raise_for_status()

    samples_ms = []
    for _ in range(iterations):
        start = time.perf_counter()
        r = session.get(url, timeout=30)
        elapsed_ms = (time.perf_counter() - start) * 1000
        r.raise_for_status()
        samples_ms.append(elapsed_ms)
    return samples_ms


# ─── Exit run (#2588) ─────────────────────────────────────────────────────────
# A one-off, manual stress run for the Analytics beta exit. It checks ABSOLUTE bars, not the
# ratio-to-baseline budgets above (decision on #2559: no stored placements; the 1.5x ratio is
# replaced by absolute bars). The bars live here, never in the baseline JSON, and use no
# pending_budget. Run it against daphne with DEBUG=False (see the "Exit run" section of
# docs/development/nightly-load-test.md): DEBUG=True keeps a query log in memory and inflates RSS.

# The container memory limit the exit run measures against (MB): the memory limit of the
# production backend container. One named constant, so the bar is changed in one place.
CONTAINER_MEMORY_LIMIT_MB = 512
EXIT_CUMULATIVE_FLOW_P95_MS = 3000          # metrics/cumulative-flow on the aged board (#2425, #2444)
EXIT_OVERVIEW_PEAK_RSS_MB = CONTAINER_MEMORY_LIMIT_MB   # one metrics/overview/ open (#2426)
EXIT_ANALYTICS_365_GROWTH_MB = 150          # analytics/?days=365 RSS growth (#2451)
EXIT_ANALYTICS_365_MS = 3000                # analytics/?days=365 latency (#2451)
EXIT_OVERVIEW_PAYLOAD_BYTES = 1024 * 1024   # one overview response body
EXIT_UNREAD_COUNT_P95_MS = 100              # notifications/unread-count/ under concurrent opens (#2428)
EXIT_STALL_SECONDS = 60                     # an over-cap request slower than this is a stall
EXIT_MIN_UNREAD_SAMPLES = 20                # fewer unread-count samples than this say nothing about p95
# The server's two other admission limits (backend/boards/services/analytics_admission.py), mirrored
# because this script imports no Django; --self-test reads that file and fails if either drifts.
# Each user may have PER_USER_MAX_IN_FLIGHT analytics requests running or waiting, and it is checked
# BEFORE the global cap, so a burst from one user is refused by the per-user limit whatever
# ANALYTICS_MAX_CONCURRENT is. The burst therefore runs one open per distinct user, and must be wider
# than the cap plus the waiting room, or every open can legitimately be admitted and nothing is refused.
EXIT_SERVER_PER_USER_MAX_IN_FLIGHT = 2      # analytics_admission.PER_USER_MAX_IN_FLIGHT
EXIT_SERVER_MAX_WAITERS = 4                 # analytics_admission.MAX_WAITERS
EXIT_DEFAULT_CONCURRENT_OPENS = 8           # > ANALYTICS_MAX_CONCURRENT (1) + EXIT_SERVER_MAX_WAITERS (4)
_ADMISSION_SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir,
                                 "backend", "boards", "services", "analytics_admission.py")
# The fixture the bars are about: #2588 names the 3-year board (LOAD_TEST_AGED_GENERATIONS=12) and
# #2451's 12k-card fixture (LOAD_TEST_SCALE=100). The generation count is read off the board as
# archived // active (each generation copies every active card once). The card floor is NOT 12,000:
# seed_demo_data gives each of scale x 10 swimlanes random.randint(11, 13) cards, so scale 100 is
# 11,000-13,000 active cards, about 12,000 on average, and a 12,000 floor could fail the very
# fixture #2451 names. 11,000 is what scale 100 guarantees; the scheduled nightly's ~2,400 fails it.
EXIT_MIN_AGED_GENERATIONS = 12
EXIT_MIN_ACTIVE_CARDS = 11_000
TOO_LARGE_CODE = "analytics_too_large"
_EXIT_UNREAD_URL = "/api/v1/notifications/unread-count/"
_EXIT_CURRENT_USER_URL = "/api/v1/auth/user/"


def _bar(name, value, limit, unit, lower_is_better=True):
    """One pass/fail record against an absolute bar. ``value`` None (not measured) fails."""
    passed = value is not None and (value < limit if lower_is_better else value >= limit)
    return {"check": name, "value": None if value is None else round(value, 1), "bar": limit,
            "unit": unit, "passed": bool(passed)}


def _classify_analytics_response(status, code, retry_after):
    """Name an analytics response: ok, busy, too_large or unexpected.

    ``busy`` is the documented 503 ``analytics_busy`` with its ``Retry-After`` (#2428);
    ``too_large`` is the documented 422 ``analytics_too_large``. A 503 without the code or the
    header, or any other status, is ``unexpected``.
    """
    if status == 200:
        return "ok"
    if status == 503 and code == ANALYTICS_BUSY_CODE and retry_after:
        return "busy"
    if status == 422 and code == TOO_LARGE_CODE:
        return "too_large"
    return "unexpected"


def _evaluate_over_cap(outcomes, concurrency, cap, server_alive, users):
    """The over-cap bar: returns (passed, detail).

    ``outcomes`` is a list of (classification, elapsed_s, round) per request, elapsed_s None for
    a stall. ``users`` is how many distinct users the burst's opens ran as.

    The bar is about the GLOBAL cap, ANALYTICS_MAX_CONCURRENT, so it accepts a refusal as proof
    only when nothing else could have refused: each open is a different user (so the per-user
    limit, checked first on the server, never trips), and the burst is wider than the cap plus
    the waiting room (so a refusal is forced, not left to timing). It then passes only when every
    request was ok, busy or too_large (no stall, no unexpected status), at least one was refused,
    no round admitted more opens than the cap plus the waiting room can hold (else the cap was not
    applied), and the server still answers (no OOM).
    """
    kinds = [o[0] for o in outcomes]
    room = cap + EXIT_SERVER_MAX_WAITERS
    if concurrency <= room:
        return False, (f"{concurrency} concurrent opens do not exceed ANALYTICS_MAX_CONCURRENT={cap} plus "
                       f"{EXIT_SERVER_MAX_WAITERS} waiters: every open can be admitted, so no refusal is forced")
    if users < concurrency:
        return False, (f"the {concurrency} opens ran as {users} distinct user(s): with more than one open per "
                       f"user the per-user limit ({EXIT_SERVER_PER_USER_MAX_IN_FLIGHT}) can do the refusing, so a "
                       "refusal does not prove the global cap")
    if "stall" in kinds or any(o[1] is not None and o[1] > EXIT_STALL_SECONDS for o in outcomes):
        return False, "a request stalled"
    if "unexpected" in kinds:
        return False, f"{kinds.count('unexpected')} request(s) had an unexpected status"
    if not (kinds.count("busy") + kinds.count("too_large")):
        return False, "no request was refused, so the cap was never exercised"
    admitted = {}
    for kind, _, rnd in outcomes:
        admitted[rnd] = admitted.get(rnd, 0) + (kind == "ok")
    most = max(admitted.values(), default=0)
    if most > room:
        return False, (f"one round admitted {most} opens, more than ANALYTICS_MAX_CONCURRENT={cap} plus "
                       f"{EXIT_SERVER_MAX_WAITERS} waiters can hold: the cap was not applied")
    if not server_alive:
        return False, "the server stopped answering after the burst (OOM?)"
    return True, (f"{kinds.count('ok')} ok, {kinds.count('busy')} busy, {kinds.count('too_large')} too_large "
                  f"over {users} distinct users; at most {most} admitted in one round (bound {room})")


def _evaluate_exit_fixture(fixture):
    """The fixture record: passes only on the 3-year, 12k-card stress board (pure; self-tested).

    ``fixture`` has ``active_cards`` and ``archived_cards`` as read off the aged board (plus the
    declared seed values, recorded only). Sets ``observed_generations`` on it.
    """
    active, archived = fixture.get("active_cards"), fixture.get("archived_cards")
    ok_counts = isinstance(active, int) and isinstance(archived, int) and active > 0
    gens = archived // active if ok_counts else None
    fixture["observed_generations"] = gens
    passed = ok_counts and active >= EXIT_MIN_ACTIVE_CARDS and gens >= EXIT_MIN_AGED_GENERATIONS
    detail = (f"{active} active and {archived} archived cards ({gens} generations); declared scale "
              f"{fixture.get('declared_scale')}, aged generations {fixture.get('declared_aged_generations')}")
    if not passed:
        detail += (". Not the stress fixture: seed with LOAD_TEST_SCALE=100 and LOAD_TEST_AGED_GENERATIONS=12, "
                   "or no bar below says anything about it")
    return {"check": "fixture_is_stress_fixture", "value": active,
            "bar": f">= {EXIT_MIN_ACTIVE_CARDS} active cards and >= {EXIT_MIN_AGED_GENERATIONS} generations",
            "unit": "cards", "passed": bool(passed), "detail": detail}


def _failure_reason(exc):
    """A one-line reason a measurement could not run; names a documented refusal as itself."""
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            code = resp.json().get("code")
        except (ValueError, AttributeError):
            code = None
        return f"{resp.status_code} {code or resp.reason} from {resp.url} (the request was refused, not measured)"
    return f"{type(exc).__name__}: {exc}"


def _evaluate_exit_run(m):
    """Turn the measured figures *m* into the list of absolute-bar records (pure; self-tested).

    ``m["failures"]`` maps a check name to the reason its measurement could not run (a refused
    or failed request). Such a check is recorded as failed with that reason; the others are still
    evaluated, so one failure never hides the rest.
    """
    failures = m.get("failures", {})
    over_ok, over_detail = m.get("over_cap", (False, "not measured"))
    unread = m.get("unread_count_p95_ms")
    unread_detail = None
    if unread is not None and m.get("unread_samples", 0) < EXIT_MIN_UNREAD_SAMPLES:
        unread_detail = (f"only {m.get('unread_samples', 0)} unread-count samples, fewer than "
                         f"{EXIT_MIN_UNREAD_SAMPLES}: p95 not trustworthy")
        unread = None
    fixture = m.get("fixture")
    records = [
        _evaluate_exit_fixture(fixture) if fixture else
        {"check": "fixture_is_stress_fixture", "value": None, "unit": "cards", "passed": False,
         "bar": f">= {EXIT_MIN_ACTIVE_CARDS} active cards and >= {EXIT_MIN_AGED_GENERATIONS} generations",
         "detail": "the fixture was not read"},
        _bar("cumulative_flow_p95_ms", m.get("cumulative_flow_p95_ms"), EXIT_CUMULATIVE_FLOW_P95_MS, "ms"),
        _bar("drill_down_peak_rss_mb", m.get("drill_down_peak_rss_mb"), CONTAINER_MEMORY_LIMIT_MB, "MB"),
        _bar("overview_peak_rss_mb", m.get("overview_peak_rss_mb"), EXIT_OVERVIEW_PEAK_RSS_MB, "MB"),
        _bar("analytics_365_rss_growth_mb", m.get("analytics_365_rss_growth_mb"), EXIT_ANALYTICS_365_GROWTH_MB, "MB"),
        _bar("analytics_365_ms", m.get("analytics_365_ms"), EXIT_ANALYTICS_365_MS, "ms"),
        _bar("overview_payload_bytes", m.get("overview_payload_bytes"), EXIT_OVERVIEW_PAYLOAD_BYTES, "bytes"),
        _bar("unread_count_p95_ms_under_load", unread, EXIT_UNREAD_COUNT_P95_MS, "ms"),
        _bar("concurrent_peak_rss_mb", m.get("concurrent_peak_rss_mb"), CONTAINER_MEMORY_LIMIT_MB, "MB"),
    ]
    over = {"check": "over_cap_refused_cleanly", "value": None, "bar": "503 analytics_busy / 422 analytics_too_large, no stall, no OOM",
            "unit": "", "passed": bool(over_ok), "detail": over_detail}
    records.append(over)
    for r in records:
        if r["check"] in failures:
            r["passed"], r["detail"] = False, failures[r["check"]]
        elif not r["passed"] and r["check"] == "unread_count_p95_ms_under_load" and unread_detail:
            r["detail"] = unread_detail
    return records


def _collect_exit_measurements(ops, concurrency, cap, users):
    """Run every exit-run measurement through *ops*, never letting one abort the rest.

    *ops* has: fixture() -> {active_cards, archived_cards, ...}, cumulative_flow() -> [ms],
    drill_down() -> peak_mb, overview_open() -> (peak_mb, payload_bytes), analytics_365() ->
    ([ms], growth_mb), concurrent() -> (outcomes, unread_ms, unread_errors, largest_payload,
    peak_mb), alive() -> bool. A measurement that raises (a refused request,
    ``analytics_too_large``, a timeout) is recorded under ``m["failures"]`` for the checks it
    feeds. Kept apart from ``run_exit`` so --self-test can feed it stubs; ``_ExitOps`` is the real
    *ops*. ``users`` is how many distinct users the burst ran as.
    """
    m = {"failures": {}}

    def attempt(checks, fn):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 -- recorded as the checks' failure reason
            for c in checks:
                m["failures"][c] = _failure_reason(exc)
            return None

    fx = attempt(("fixture_is_stress_fixture",), ops.fixture)
    if fx:
        m["fixture"] = dict(fx)
    cf = attempt(("cumulative_flow_p95_ms",), ops.cumulative_flow)
    if cf:
        m["cumulative_flow_p95_ms"] = _percentile(cf, 95)
    dd = attempt(("drill_down_peak_rss_mb",), ops.drill_down)
    if dd is not None:
        m["drill_down_peak_rss_mb"] = dd
    ov = attempt(("overview_peak_rss_mb", "overview_payload_bytes"), ops.overview_open)
    payload = 0
    if ov:
        m["overview_peak_rss_mb"], payload = ov
        m["overview_payload_bytes"] = payload
    a365 = attempt(("analytics_365_ms", "analytics_365_rss_growth_mb"), ops.analytics_365)
    if a365:
        m["analytics_365_ms"], m["analytics_365_rss_growth_mb"] = _percentile(a365[0], 95), a365[1]
    conc = attempt(("unread_count_p95_ms_under_load", "concurrent_peak_rss_mb", "over_cap_refused_cleanly"),
                   ops.concurrent)
    if conc:
        outcomes, unread, unread_errors, big, peak = conc
        m["concurrent_peak_rss_mb"] = peak
        m["overview_payload_bytes"] = max(payload, big)
        m["unread_samples"] = len(unread)
        if unread_errors:
            m["failures"]["unread_count_p95_ms_under_load"] = (
                f"unread-count failed during the concurrent opens: {unread_errors[0]}")
        elif unread:
            m["unread_count_p95_ms"] = _percentile(unread, 95)
        m["over_cap"] = _evaluate_over_cap(outcomes, concurrency, cap, ops.alive(), users)
        m["responses"] = {k: [o[0] for o in outcomes].count(k) for k in ("ok", "busy", "too_large", "unexpected", "stall")}
    return m


def _unread_poller(base_url, headers, stop, samples, errors):
    """Time notifications/unread-count/ (as demo2, who has notifications) about every 250 ms until *stop* is set.

    Slower than the 50 ms first tried: under DEBUG=False the `user` throttle is 5000/hour, not
    9999. A non-200 (a 429 included) is appended to *errors*, which fails the unread-count check
    with that reason; the other checks still run and the artifact is still written."""
    with requests.Session() as sess:
        sess.headers.update(headers)
        while not stop.is_set():
            start = time.perf_counter()
            try:
                r = sess.get(base_url + _EXIT_UNREAD_URL, timeout=30)
                elapsed = (time.perf_counter() - start) * 1000
                if r.status_code == 200:
                    samples.append(elapsed)
                else:
                    errors.append(f"unread-count returned {r.status_code}")
            except requests.exceptions.RequestException as exc:
                errors.append(f"unread-count: {exc}")
            stop.wait(0.25)


def _concurrent_overview(base_url, burst_headers, poll_headers, board_id, rounds):
    """Open the overview once per entry of *burst_headers*, all at once, *rounds* times, timing unread-count meanwhile.

    Each open runs with its own headers, one distinct user each, so the server's per-user limit
    never refuses and any refusal is the global cap's (see ``_evaluate_over_cap``). A 503
    ``analytics_busy`` or 422 ``analytics_too_large`` is an EXPECTED response here (admission
    refusing the opens beyond ANALYTICS_MAX_CONCURRENT and its waiting room), recorded, never an
    error. Returns (outcomes, unread_samples, unread_errors, payload_bytes_of_largest_ok); each
    outcome is (classification, elapsed_s or None for a stall, round).
    """
    url = _overview_urls(base_url, board_id)[0]  # metrics/overview/
    outcomes, lock = [], threading.Lock()
    largest = [0]

    def open_overview(headers, rnd):
        start = time.perf_counter()
        try:
            with requests.Session() as sess:
                sess.headers.update(headers)
                r = sess.get(url, timeout=EXIT_STALL_SECONDS)
            try:
                code = r.json().get("code") if r.status_code != 200 else None
            except (ValueError, AttributeError):
                code = None
            kind = _classify_analytics_response(r.status_code, code, r.headers.get("Retry-After"))
            with lock:
                outcomes.append((kind, time.perf_counter() - start, rnd))
                if kind == "ok":
                    largest[0] = max(largest[0], len(r.content))
        except requests.exceptions.RequestException:
            with lock:
                outcomes.append(("stall", None, rnd))

    samples, errors, stop = [], [], threading.Event()
    poller = threading.Thread(target=_unread_poller, args=(base_url, poll_headers, stop, samples, errors))
    poller.start()
    try:
        for rnd in range(rounds):
            threads = [threading.Thread(target=open_overview, args=(h, rnd)) for h in burst_headers]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
    finally:
        stop.set()
        poller.join()
    return outcomes, samples, errors, largest[0]


def _server_alive(base_url):
    try:
        return requests.get(f"{base_url}/api/health/liveness/", timeout=10).status_code == 200
    except requests.exceptions.RequestException:
        return False


def _burst_users(base_url, burst_headers):
    """How many distinct users the burst's tokens belong to, read from auth/user/ (raises on a failure)."""
    ids = set()
    for headers in burst_headers:
        r = requests.get(base_url + _EXIT_CURRENT_USER_URL, headers=headers, timeout=30)
        r.raise_for_status()
        body = r.json()
        ids.add(body.get("pk", body.get("id", body.get("username"))))
    return len(ids - {None})


def _exit_output(m, records, concurrency, rounds, cap, users):
    """The artifact body. Always built, whatever failed: a check that could not run is a failed record."""
    return {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "mode": "exit-run",
        "container_memory_limit_mb": CONTAINER_MEMORY_LIMIT_MB,
        "fixture": m.get("fixture"),
        "concurrent_opens": concurrency, "rounds": rounds, "burst_users": users,
        "analytics_max_concurrent": cap,
        "responses": m.get("responses", {}),
        "checks": records,
        "passed": all(r["passed"] for r in records),
    }


class _ExitOps:
    """The exit run's real measurements: the *ops* ``_collect_exit_measurements`` runs.

    Everything that touches the server is injected (the session, the timing function, the RSS
    sampler ``peak_of``, the concurrent burst and the liveness probe), so --self-test runs it
    against recording stubs and proves which endpoint each measurement requests and which
    element of ``peak_of``'s (result, peak RSS MB, RSS growth MB) each one returns.
    """

    def __init__(self, session, base_url, board_id, peak_of, concurrent, alive, iterations, warmup,
                 declared=None, time_requests=_time_requests):
        self.session, self.peak_of, self._concurrent, self._alive = session, peak_of, concurrent, alive
        self.iterations, self.warmup, self.time_requests = iterations, warmup, time_requests
        self.declared = dict(declared or {})
        self.root = f"{base_url}/api/v1/boards/{board_id}"
        self.endpoints = _aged_endpoints(base_url, board_id)

    def fixture(self):
        # The same reads the budget run's aged-board guard uses: the archived page's count, and
        # the active cards /full/ returns.
        archived = self.session.get(f"{self.root}/cards/archived/", timeout=60)
        archived.raise_for_status()
        full = self.session.get(f"{self.root}/full/", timeout=120)
        full.raise_for_status()
        return {**self.declared, "active_cards": len(full.json().get("cards", [])),
                "archived_cards": _count_of(archived.json())}

    def cumulative_flow(self):
        return self.time_requests(self.session, self.endpoints["aged_flow_cumulative_flow"],
                                  self.iterations, self.warmup)

    def drill_down(self):
        # Peak RSS (the high-water mark) during the ?date= drill-down.
        return self.peak_of(lambda: self.time_requests(
            self.session, self.endpoints["aged_flow_cumulative_flow_day"], self.iterations, 0))[1]

    def overview_open(self):
        one, peak, _ = self.peak_of(lambda: self.session.get(self.endpoints["aged_flow_overview"], timeout=120))
        one.raise_for_status()
        return peak, len(one.content)

    def analytics_365(self):
        # RSS GROWTH, not the peak: #2451's bar is how much one request adds.
        t365, _, growth = self.peak_of(lambda: self.time_requests(
            self.session, self.endpoints["aged_board_analytics_365"], self.iterations, 0))
        return t365, growth

    def concurrent(self):
        (outcomes, unread, errors, big), peak, _ = self.peak_of(self._concurrent)
        return outcomes, unread, errors, big, peak

    def alive(self):
        return self._alive()


def _read_token(path):
    with open(resolve_within(cli_roots(), path), encoding="utf-8") as fh:
        return fh.read().strip()


def run_exit(args):
    """The exit run: absolute bars on the aged board. Returns the process exit code."""
    if not args.analytics_token_file:
        raise RuntimeError("--exit-run needs --analytics-token-file (loadtest_analytics, the aged board's owner).")
    if not args.server_pid_file:
        raise RuntimeError("--exit-run needs --server-pid-file: its RSS bars are measured on the server process.")
    if not args.token_file:
        raise RuntimeError("--exit-run needs --token-file (demo2, who has the seeded notifications): "
                           "unread-count is timed as that user, as loadtest_analytics has none.")
    if not args.exit_burst_token_dir:
        raise RuntimeError("--exit-run needs --exit-burst-token-dir: one token file per distinct member of "
                           "the aged board, one per concurrent overview open.")
    session = requests.Session()
    session.headers["Authorization"] = f"Token {_read_token(args.analytics_token_file)}"
    poll_headers = {"Authorization": f"Token {_read_token(args.token_file)}"}
    burst_dir = resolve_within(cli_roots(), args.exit_burst_token_dir)
    burst_tokens = [_read_token(os.path.join(burst_dir, name)) for name in sorted(os.listdir(burst_dir))]
    concurrency = args.exit_concurrent_opens
    if not burst_tokens:
        raise RuntimeError(f"--exit-burst-token-dir {args.exit_burst_token_dir} holds no token files.")
    # Fewer tokens than opens: reuse them, so the run still happens and the over-cap check fails
    # on the user count, recorded, rather than the run stopping here.
    burst_headers = [{"Authorization": f"Token {burst_tokens[i % len(burst_tokens)]}"} for i in range(concurrency)]
    base_url = args.base_url.rstrip("/")
    _wait_for_url(f"{base_url}/api/health/liveness/", timeout=args.startup_timeout)
    mem = _ServerMemory.from_pid_file(args.server_pid_file)
    if not mem.enabled:
        raise RuntimeError("--exit-run cannot read the server's RSS (needs Linux /proc, same host).")
    board = _find_board(session, base_url, args.aged_board_name)
    users_error = None
    try:
        users = _burst_users(base_url, burst_headers)
    except (requests.exceptions.RequestException, ValueError) as exc:
        users, users_error = 0, f"could not confirm the burst tokens' users from auth/user/: {_failure_reason(exc)}"
    print(f"Exit run on board {board['id']} ({args.aged_board_name}); container limit {CONTAINER_MEMORY_LIMIT_MB} MB; "
          f"burst of {concurrency} opens as {users} distinct users.")

    def peak_of(fn):
        """Run fn(); return (its result, peak RSS MB during it, RSS growth MB)."""
        mem.reset_peak()
        before = mem.read()["rss_mb"]
        result = fn()
        hwm = mem.read()["hwm_mb"]
        return result, hwm, hwm - before

    ops = _ExitOps(
        session, base_url, board["id"], peak_of,
        concurrent=lambda: _concurrent_overview(base_url, burst_headers, poll_headers, board["id"], args.exit_rounds),
        alive=lambda: _server_alive(base_url),
        iterations=args.aged_iterations, warmup=args.aged_warmup,
        declared={"declared_scale": args.fixture_scale, "declared_aged_generations": args.fixture_aged_generations},
    )
    m = _collect_exit_measurements(ops, concurrency, args.exit_max_concurrent, users)
    if users_error:
        m["failures"]["over_cap_refused_cleanly"] = users_error
    records = _evaluate_exit_run(m)
    print("\nEXIT RUN RESULTS (absolute bars, #2588)")
    for r in records:
        print(f"  {'PASS' if r['passed'] else 'FAIL'}  {r['check']}: {r['value']} {r['unit']} (bar {r['bar']})"
              + (f" - {r['detail']}" if r.get("detail") else ""))
    output = _exit_output(m, records, concurrency, args.exit_rounds, args.exit_max_concurrent, users)
    out_path = resolve_within(cli_roots(), args.exit_output)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2)
    print(f"Wrote exit-run results to {out_path}")
    if not output["passed"]:
        print("\nFAIL - exit-run bar(s) not met: " + ", ".join(r["check"] for r in records if not r["passed"]), file=sys.stderr)
        return 1
    print("\nAll exit-run bars met.")
    return 0


def run(args):
    with open(resolve_within(cli_roots(), args.token_file), encoding="utf-8") as fh:
        token = fh.read().strip()

    session = requests.Session()
    session.headers["Authorization"] = f"Token {token}"
    # board_list measures the member-heavy path, which needs a viewer whose
    # access query spans the board's many memberships. The default user is a
    # plain member (only their own membership row is visible to the access
    # filter), so an optional owner token is used for that scenario alone.
    sessions = {}
    if args.owner_token_file:
        with open(resolve_within(cli_roots(), args.owner_token_file), encoding="utf-8") as fh:
            owner_session = requests.Session()
            owner_session.headers["Authorization"] = f"Token {fh.read().strip()}"
        sessions["board_list"] = owner_session
    if args.multi_board_token_file:
        with open(resolve_within(cli_roots(), args.multi_board_token_file), encoding="utf-8") as fh:
            multi_session = requests.Session()
            multi_session.headers["Authorization"] = f"Token {fh.read().strip()}"
        sessions["card_search_multi_board"] = multi_session

    analytics_session = None
    if args.analytics_token_file:
        with open(resolve_within(cli_roots(), args.analytics_token_file), encoding="utf-8") as fh:
            analytics_session = requests.Session()
            analytics_session.headers["Authorization"] = f"Token {fh.read().strip()}"

    # Fail loudly rather than silently measure board_list as demo2: the committed
    # board_list budget was derived as the owner, so a plain-member run would
    # compare a cheaper path against it and hide a regression (#1767). Measure-only
    # runs (re-deriving) are exempt only in that they never gate; they still need
    # the owner path to produce a valid number, so the requirement is unconditional.
    if "board_list" not in sessions:
        raise RuntimeError(
            "--owner-token-file is required: board_list must be measured as the board owner (#1767)"
        )

    # Same reason for card_search_multi_board (#1810): as demo2 it would time the
    # one-board index walk and report a number that says nothing about the
    # many-board plan.
    _require_multi_board_session(sessions)

    base_url = args.base_url.rstrip("/")
    _wait_for_url(f"{base_url}/api/health/liveness/", timeout=args.startup_timeout)

    board = _find_board(session, base_url, args.board_name)
    board_id = board["id"]

    full = session.get(f"{base_url}/api/v1/boards/{board_id}/full/", timeout=30)
    full.raise_for_status()
    full_data = full.json()
    cards = full_data.get("cards", [])
    if not cards:
        raise RuntimeError(
            f"Board '{args.board_name}' (id={board_id}) has no cards — "
            "cannot exercise the card-timeline endpoint. Re-seed with a "
            "non-trivial --scale."
        )
    # A card roughly in the middle of the cards that passed a gate, not the first or last —
    # avoids accidentally always hitting whichever card the seed command happens to create
    # first (which may have unusually little history), and makes the timeline read gate rows (#2405).
    sample_card_id = _gated_sample_card(cards)["id"]
    fixture = {
        "board_name": args.board_name,
        "board_id": board_id,
        "card_count": len(cards),
        "swimlane_count": len(full_data.get("swimlanes", [])),
    }
    # Prove the multi-board user really is multi-board before timing anything;
    # a seed without --extra-boards would otherwise produce a valid-looking
    # one-board number (#1810).
    multi_board_count = _count_accessible_boards(sessions["card_search_multi_board"], base_url)
    _check_multi_board_count(multi_board_count, args.min_multi_boards)
    fixture["multi_board_accessible_boards"] = multi_board_count
    print(f"Fixture: {fixture}")

    # The movements scenarios need the board's history size (deep offset) and a
    # date inside it; both are read from the live fixture, not hard-coded (#2237).
    first_page = session.get(f"{base_url}/api/v1/boards/{board_id}/movements/", timeout=30)
    first_page.raise_for_status()
    movements_count = first_page.json().get("count")
    deep_offset = _movements_deep_offset(movements_count)
    if deep_offset == 0:
        raise RuntimeError(
            f"Board '{args.board_name}' has {movements_count} movements — too few for the "
            "deep-offset scenario. Re-seed with --scale > 1 (deep movement history)."
        )
    fixture["movement_count"] = movements_count
    moved_after = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    endpoints = _endpoints(base_url, board_id, sample_card_id, deep_offset, moved_after)

    budgets = {}
    if args.budget_file and not args.measure_only:
        with open(resolve_within(cli_roots(), args.budget_file), encoding="utf-8") as fh:
            budgets = json.load(fh).get("endpoints", {})

    results = {}
    violations = []
    pending = []
    server_mem = _ServerMemory.from_pid_file(args.server_pid_file)
    if not server_mem.enabled:
        if not args.server_pid_file:  # from_pid_file already said why when one was given
            print("NOTE: no --server-pid-file; peak memory is NOT measured or gated (#2430).")
        _check_memory_measured(server_mem, budgets)
    _check_analytics_measured(analytics_session, budgets)

    def measure(name, sample, iterations, warmup, extra=None):
        """Run ``sample()`` (a list of ms), then record, print and gate its p95 and peak RSS."""
        print(f"Measuring {name} ({iterations} timed, {warmup} warmup)...")
        if server_mem.enabled:
            server_mem.reset_peak()
            rss_before = server_mem.read()["rss_mb"]
        samples_ms = sample()
        p50 = _percentile(samples_ms, 50)
        p95 = _percentile(samples_ms, 95)
        p99 = _percentile(samples_ms, 99)
        entry = {
            "n": len(samples_ms),
            "p50_ms": round(p50, 1),
            "p95_ms": round(p95, 1),
            "p99_ms": round(p99, 1),
            "mean_ms": round(statistics.mean(samples_ms), 1),
            "max_ms": round(max(samples_ms), 1),
        }
        entry.update(extra or {})
        budget_ms, within_budget, violation = _evaluate_budget(name, p95, budgets)
        pending_ref = _pending_budget(name, budgets)
        if pending_ref:
            entry["budget_pending"] = pending_ref
            pending.append((name, pending_ref, entry["p95_ms"]))
        if budget_ms is not None:
            entry["budget_p95_ms"] = budget_ms
            entry["within_budget"] = within_budget
            if violation:
                violations.append(violation)
        mem_line = ""
        if server_mem.enabled:
            after = server_mem.read()
            entry["peak_rss_mb"] = round(after["hwm_mb"], 1)
            entry["rss_growth_mb"] = round(after["hwm_mb"] - rss_before, 1)
            mem_budget, mem_within, mem_violation = _evaluate_memory_budget(
                name, entry["peak_rss_mb"], budgets
            )
            mem_pending = _pending_memory_budget(name, budgets)
            if mem_budget is not None:
                entry["budget_peak_rss_mb"] = mem_budget
                entry["within_memory_budget"] = mem_within
                if mem_violation:
                    violations.append(mem_violation)
            if mem_pending:
                entry["memory_budget_pending"] = mem_pending
                pending.append((f"{name} (peak RSS)", mem_pending, entry["peak_rss_mb"]))
            mem_line = f" peak_rss={entry['peak_rss_mb']}MB (+{entry['rss_growth_mb']}MB)"
        results[name] = entry
        print(f"  p50={entry['p50_ms']}ms p95={entry['p95_ms']}ms p99={entry['p99_ms']}ms{mem_line}"
              + (f" (budget {budget_ms}ms)" if budget_ms is not None else " (no budget — measure-only)"))
        if pending_ref:
            print(f"  PENDING BUDGET: {name} is measured but NOT gated until {pending_ref} "
                  "assigns its budget.")
        if server_mem.enabled and entry.get("memory_budget_pending"):
            print(f"  PENDING MEMORY BUDGET: {name} peak RSS is measured but NOT gated until "
                  f"{entry['memory_budget_pending']} assigns its budget.")

    for name, url in endpoints.items():
        sess = sessions.get(name, session)
        measure(name, lambda sess=sess, url=url: _time_requests(sess, url, args.iterations, args.warmup),
                args.iterations, args.warmup)

    # The overview, as a plain member: its two reads fired together on the active-only board (the web app sends them in sequence).
    measure(
        "analytics_overview",
        lambda: _fan_out_samples(dict(session.headers), _overview_urls(base_url, board_id),
                                 args.fanout_iterations, args.fanout_warmup),
        args.fanout_iterations, args.fanout_warmup, {"requests_per_sample": len(_OVERVIEW_PATHS)},
    )

    # Aged and linked boards (#2430, #2424): owned by their own user so no existing
    # scenario's data changes; skipped, loudly, when that user has no token.
    if analytics_session is None:
        print("NOTE: no --analytics-token-file; the aged-board and linked-board scenarios "
              "(#2430, #2424) are NOT measured.")
    else:
        aged_board = _find_board(analytics_session, base_url, args.aged_board_name)
        linked_board = _find_board(analytics_session, base_url, args.linked_board_name)
        archived_page = analytics_session.get(
            f"{base_url}/api/v1/boards/{aged_board['id']}/cards/archived/", timeout=60)
        archived_page.raise_for_status()
        archived_count = _count_of(archived_page.json())
        if not isinstance(archived_count, int) or archived_count < args.min_aged_archived:
            raise RuntimeError(
                f"The aged board has {archived_count} archived cards, fewer than "
                f"--min-aged-archived={args.min_aged_archived}. Seed with "
                "`manage.py seed_demo_data --force --scale N --aged-generations G` (#2430)."
            )
        linked_full = analytics_session.get(f"{base_url}/api/v1/boards/{linked_board['id']}/full/", timeout=60)
        linked_full.raise_for_status()
        linked_cards = linked_full.json().get("cards", [])
        if len(linked_cards) < args.min_linked_cards or not all(c.get("parent") for c in linked_cards):
            raise RuntimeError(
                f"The linked board has {len(linked_cards)} cards (need >= {args.min_linked_cards}, "
                "all with a parent). Seed with `manage.py seed_demo_data --force --scale N "
                "--linked-boards` (#2424)."
            )
        cv_board = _find_board(analytics_session, base_url, args.children_view_board_name)
        cv_page = analytics_session.get(_children_view_endpoints(base_url, cv_board["id"])["children_view"], timeout=120)
        cv_page.raise_for_status()
        cv_body = cv_page.json()
        cv_rows = cv_body.get("rows", cv_body.get("results"))
        if not isinstance(cv_rows, list) or len(cv_rows) == 0:
            raise RuntimeError(
                "children-view on the children-view board returned no parent rows. Seed with "
                "`manage.py seed_demo_data --force --scale N --linked-boards` (#2538)."
            )
        fixture["children_view_board_id"] = cv_board["id"]
        fixture["aged_board_id"] = aged_board["id"]
        fixture["aged_archived_cards"] = archived_count
        fixture["linked_board_id"] = linked_board["id"]
        fixture["linked_cards"] = len(linked_cards)
        print(f"Fixture (aged/linked): {{'aged_archived_cards': {archived_count}, "
              f"'linked_cards': {len(linked_cards)}}}")

        for name, url in _linked_endpoints(base_url, linked_board["id"]).items():
            measure(name, lambda url=url: _time_requests(analytics_session, url, args.iterations, args.warmup),
                    args.iterations, args.warmup)
        # Each request is a full recompute of 500 parents x ~100 children: the aged iteration
        # count, not the default 40.
        for name, url in _children_view_endpoints(base_url, cv_board["id"]).items():
            measure(name, lambda url=url: _time_requests(analytics_session, url, args.aged_iterations, args.aged_warmup),
                    args.aged_iterations, args.aged_warmup)
        # Few iterations: each aged request costs seconds, and p95 over ten samples is
        # the slowest one, which is what a "does it still fit" gate wants anyway.
        for name, url in _aged_endpoints(base_url, aged_board["id"]).items():
            measure(name, lambda url=url: _time_requests(analytics_session, url, args.aged_iterations, args.aged_warmup),
                    args.aged_iterations, args.aged_warmup)
        measure(
            "aged_analytics_overview",
            lambda: _fan_out_samples(dict(analytics_session.headers), _overview_urls(base_url, aged_board["id"]),
                                     args.fanout_iterations, args.fanout_warmup),
            args.fanout_iterations, args.fanout_warmup, {"requests_per_sample": len(_OVERVIEW_PATHS)},
        )

    output = {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "fixture": fixture,
        "iterations": args.iterations,
        "warmup": args.warmup,
        "results": results,
    }
    if args.output:
        out_path = resolve_within(cli_roots(), args.output)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(output, fh, indent=2)
        print(f"Wrote results to {out_path}")

    if args.measure_only:
        print("\n--measure-only: not evaluating budgets. Use these p95 numbers "
              "(x1.3-1.5) to (re-)derive backend/nightly-load-test-baseline.json.")
        return 0

    for name, ref, value in pending:
        what = f"{value}MB" if name.endswith("(peak RSS)") else f"p95={value}ms"
        print(f"\nWARNING: PENDING BUDGET — {name} {what} is not gated; "
              f"{ref} assigns the budget.", file=sys.stderr)

    if violations:
        print("\nFAIL — budget exceeded:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    if pending:
        print(f"\nAll budgeted endpoints within budget ({len(pending)} pending, NOT gated: "
              + ", ".join(n for n, _, _ in pending) + ").")
    else:
        print("\nAll endpoints within budget.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:8000")
    # Not required=True at the argparse level so --self-test (#1093's house
    # rule — see docs/development/ci-gates.md) can run standalone, with no
    # live server or token file. Presence is validated in run() instead.
    parser.add_argument("--token-file", default=None, help="Path to a raw PAT (see manage.py provision_fuzz_token).")
    parser.add_argument(
        "--owner-token-file", default=None,
        help="Optional PAT for the board OWNER, used only for the board_list scenario (#1723).",
    )
    parser.add_argument(
        "--multi-board-token-file", default=None,
        help="PAT for demo3 (owner of the --extra-boards fixture), used only for the "
             "card_search_multi_board scenario (#1810). Required.",
    )
    parser.add_argument(
        "--min-multi-boards", type=int, default=50,
        help="Fail if the multi-board user can access fewer boards than this (default: 50).",
    )
    parser.add_argument(
        "--analytics-token-file", default=None,
        help="PAT for loadtest_analytics, the sole member of the aged and linked boards "
             "(#2430, #2424). Without it those scenarios are skipped, loudly.",
    )
    parser.add_argument("--aged-board-name", default="Visiban Load Test Aged Board")
    parser.add_argument("--linked-board-name", default="Visiban Load Test Linked Board")
    parser.add_argument("--children-view-board-name", default="Visiban Load Test Children View Board")
    parser.add_argument(
        "--min-aged-archived", type=int, default=1000,
        help="Fail if the aged board has fewer archived cards than this (default: 1000).",
    )
    parser.add_argument(
        "--min-linked-cards", type=int, default=500,
        help="Fail if the linked board has fewer cards than this, or any lacks a parent (default: 500).",
    )
    parser.add_argument("--aged-iterations", type=int, default=10,
                        help="Timed requests per aged-board scenario (default: 10; each costs seconds).")
    parser.add_argument("--aged-warmup", type=int, default=2)
    parser.add_argument("--fanout-iterations", type=int, default=10,
                        help="Timed overview fan-outs per board (default: 10).")
    parser.add_argument("--fanout-warmup", type=int, default=2)
    parser.add_argument(
        "--server-pid-file", default=None,
        help="File holding the server's PID. Enables peak-RSS measurement (Linux, same host) (#2430).",
    )
    parser.add_argument("--board-name", default="Visiban Load Test Board")
    parser.add_argument("--budget-file", default="backend/nightly-load-test-baseline.json")
    parser.add_argument("--output", default="nightly-load-test-results.json")
    parser.add_argument("--iterations", type=int, default=40, help="Timed requests per endpoint (default: 40).")
    parser.add_argument("--warmup", type=int, default=5, help="Untimed requests per endpoint before measuring (default: 5).")
    parser.add_argument("--startup-timeout", type=int, default=60)
    parser.add_argument(
        "--exit-run", action="store_true",
        help="The Analytics beta-exit stress run (#2588): absolute pass/fail bars on the aged board, "
             "not the baseline budgets. Needs --analytics-token-file and --server-pid-file.",
    )
    parser.add_argument("--exit-output", default="nightly-load-test-exit-run.json")
    parser.add_argument("--exit-concurrent-opens", type=int, default=EXIT_DEFAULT_CONCURRENT_OPENS,
                        help="Overview opens fired together for the concurrent scenario, one per distinct user "
                             f"(default: {EXIT_DEFAULT_CONCURRENT_OPENS}); must exceed the cap plus "
                             f"{EXIT_SERVER_MAX_WAITERS} waiters.")
    parser.add_argument("--exit-burst-token-dir", default=None,
                        help="Directory of token files, one per distinct member of the aged board; the "
                             "concurrent opens run one per token, so the per-user limit never refuses.")
    parser.add_argument("--fixture-scale", type=int, default=None,
                        help="The seed's --scale, recorded in the exit-run artifact (the check reads the board).")
    parser.add_argument("--fixture-aged-generations", type=int, default=None,
                        help="The seed's --aged-generations, recorded in the exit-run artifact.")
    parser.add_argument("--exit-rounds", type=int, default=3,
                        help="How many times that burst is repeated (default: 3).")
    parser.add_argument("--exit-max-concurrent", type=int, default=1,
                        help="The server's ANALYTICS_MAX_CONCURRENT (default 1, the shipped value); the burst must exceed it.")
    parser.add_argument(
        "--measure-only",
        action="store_true",
        help="Print/record p50/p95/p99 without loading or evaluating a budget file. "
             "Used to (re-)derive the committed baseline, never in the gating nightly job.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Prove the percentile/budget-comparison detection logic still fires on a "
             "known-bad and known-good input, then exit. Touches no network or database; reads only the committed "
             "baseline and the two admission limits in backend/boards/services/analytics_admission.py.",
    )
    args = parser.parse_args()

    if args.self_test:
        sys.exit(_self_test())

    if not args.token_file and not args.exit_run:
        print("FAIL: --token-file is required (unless --self-test or --exit-run).", file=sys.stderr)
        sys.exit(1)

    try:
        sys.exit(run_exit(args) if args.exit_run else run(args))
    except (RuntimeError, requests.exceptions.RequestException, OSError, PathEscapeError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
