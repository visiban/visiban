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
  - notifications_list      GET  /api/v1/notifications/
  - notifications_unread    GET  /api/v1/notifications/unread-count/

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
board_list scenario: its 55ms budget was derived as the owner, whose access
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
import time
from datetime import datetime, timezone

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


def _endpoints(base_url, board_id, sample_card_id):
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
        "notifications_list": f"{base_url}/api/v1/notifications/",
        "notifications_unread": f"{base_url}/api/v1/notifications/unread-count/",
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

    endpoints = _endpoints(base_url, board_id, sample_card_id)

    budgets = {}
    if args.budget_file and not args.measure_only:
        with open(resolve_within(cli_roots(), args.budget_file), encoding="utf-8") as fh:
            budgets = json.load(fh).get("endpoints", {})

    results = {}
    violations = []
    pending = []
    for name, url in endpoints.items():
        print(f"Measuring {name} ({args.iterations} requests, {args.warmup} warmup)...")
        samples_ms = _time_requests(sessions.get(name, session), url, args.iterations, args.warmup)
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
        results[name] = entry
        print(f"  p50={entry['p50_ms']}ms p95={entry['p95_ms']}ms p99={entry['p99_ms']}ms"
              + (f" (budget {budget_ms}ms)" if budget_ms is not None else " (no budget — measure-only)"))
        if pending_ref:
            print(f"  PENDING BUDGET: {name} is measured but NOT gated until {pending_ref} "
                  "assigns its budget.")

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

    for name, ref, p95_ms in pending:
        print(f"\nWARNING: PENDING BUDGET — {name} p95={p95_ms}ms is not gated; "
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
