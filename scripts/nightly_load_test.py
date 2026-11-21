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
  - aged_*                  the summary, analytics and eight metrics/* reads on the AGED board (#2430)
  - analytics_overview, aged_analytics_overview   the overview's eight reads fired at once (#2430)

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
    def from_pid_file(cls, path):
        if not path:
            return cls(None)
        with open(resolve_within(cli_roots(), path), encoding="utf-8") as fh:
            pid = int(fh.read().strip())
        mem = cls(pid)
        mem.read()  # fail now, not after twenty minutes, if the PID is wrong
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
    "flow_dwell", "flow_blocked", "flow_attention", "flow_swimlanes",
)
_AGED_SCENARIOS = (
    "aged_board_summary", "aged_board_analytics", "aged_board_analytics_365",
    "aged_flow_cycle_time", "aged_flow_throughput", "aged_flow_cumulative_flow",
    "aged_flow_wip_age", "aged_flow_dwell", "aged_flow_blocked", "aged_flow_attention",
    "aged_flow_swimlanes",
)
_LINKED_SCENARIOS = ("linked_board_full", "linked_card_list")
_FANOUT_SCENARIOS = ("analytics_overview", "aged_analytics_overview")
_MEMORY_GATED = (
    ("board_summary", "board_analytics") + _FLOW_SCENARIOS + _AGED_SCENARIOS + _FANOUT_SCENARIOS
)

# The overview opens with these eight reads at once, into one server process (#2426).
_OVERVIEW_PATHS = (
    "summary/", "analytics/", "metrics/cycle-time/", "metrics/throughput/",
    "metrics/cumulative-flow/", "metrics/wip-age/", "metrics/dwell/", "metrics/blocked/",
)


def _aged_endpoints(base_url, board_id):
    """The scenarios measured on the aged board (#2430), name -> URL."""
    root = f"{base_url}/api/v1/boards/{board_id}"
    return {
        "aged_board_summary": f"{root}/summary/",
        "aged_board_analytics": f"{root}/analytics/",
        # The widest range: 691 MB at 12k active cards in the stress run (#2427).
        "aged_board_analytics_365": f"{root}/analytics/?days=365",
        "aged_flow_cycle_time": f"{root}/metrics/cycle-time/",
        "aged_flow_throughput": f"{root}/metrics/throughput/",
        # #2444: cumulative flow still reads the whole history for any range.
        "aged_flow_cumulative_flow": f"{root}/metrics/cumulative-flow/",
        "aged_flow_wip_age": f"{root}/metrics/wip-age/",
        "aged_flow_dwell": f"{root}/metrics/dwell/",
        "aged_flow_blocked": f"{root}/metrics/blocked/",
        "aged_flow_attention": f"{root}/metrics/attention/",
        "aged_flow_swimlanes": f"{root}/metrics/swimlanes/",
    }


def _linked_endpoints(base_url, board_id):
    """The scenarios measured on the linked child board (#2424), name -> URL."""
    root = f"{base_url}/api/v1/boards/{board_id}"
    return {"linked_board_full": f"{root}/full/", "linked_card_list": f"{root}/cards/"}


def _overview_urls(base_url, board_id):
    return [f"{base_url}/api/v1/boards/{board_id}/{path}" for path in _OVERVIEW_PATHS]


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
            sess.get(url, timeout=120).raise_for_status()

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
        if _sm.read()["hwm_mb"] != 512.0 or _ServerMemory(None).enabled:
            failures.append("_ServerMemory misreads the status, or a None pid is not disabled")
    aged = _aged_endpoints("http://x", 7)
    if set(aged) != set(_AGED_SCENARIOS) or not aged["aged_board_analytics_365"].endswith("/boards/7/analytics/?days=365"):
        failures.append("_aged_endpoints and _AGED_SCENARIOS disagree, or the 365-day scenario lost its range")
    if set(_linked_endpoints("http://x", 8)) != set(_LINKED_SCENARIOS):
        failures.append("_linked_endpoints and _LINKED_SCENARIOS disagree")
    if len(_overview_urls("http://x", 1)) != 8 or len(set(_overview_urls("http://x", 1))) != 8:
        failures.append("the overview fan-out must be eight distinct reads")
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
    for name in _AGED_SCENARIOS + _LINKED_SCENARIOS + _FANOUT_SCENARIOS:
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
    # A card roughly in the middle of the fetched set, not the first or last —
    # avoids accidentally always hitting whichever card the seed command
    # happens to create first (which may have unusually little history).
    sample_card_id = cards[len(cards) // 2]["id"]
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
        print("NOTE: no --server-pid-file; peak memory is NOT measured or gated (#2430).")

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

    # The overview, as a plain member: eight reads at once on the active-only board.
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
        fixture["aged_board_id"] = aged_board["id"]
        fixture["aged_archived_cards"] = archived_count
        fixture["linked_board_id"] = linked_board["id"]
        fixture["linked_cards"] = len(linked_cards)
        print(f"Fixture (aged/linked): {{'aged_archived_cards': {archived_count}, "
              f"'linked_cards': {len(linked_cards)}}}")

        for name, url in _linked_endpoints(base_url, linked_board["id"]).items():
            measure(name, lambda url=url: _time_requests(analytics_session, url, args.iterations, args.warmup),
                    args.iterations, args.warmup)
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
        "--measure-only",
        action="store_true",
        help="Print/record p50/p95/p99 without loading or evaluating a budget file. "
             "Used to (re-)derive the committed baseline, never in the gating nightly job.",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Prove the percentile/budget-comparison detection logic still fires on a "
             "known-bad and known-good input, then exit. Touches no network or database; reads only the committed baseline.",
    )
    args = parser.parse_args()

    if args.self_test:
        sys.exit(_self_test())

    if not args.token_file:
        print("FAIL: --token-file is required (unless --self-test).", file=sys.stderr)
        sys.exit(1)

    try:
        sys.exit(run(args))
    except (RuntimeError, requests.exceptions.RequestException, OSError, PathEscapeError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
