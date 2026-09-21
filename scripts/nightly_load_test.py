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

Covers the endpoints boards/migrations 0030 (trigram GIN search indexes) and
0045 (activity/comment composite indexes) exist to keep fast as data volume
grows:
  - board_full              GET  /api/v1/boards/{id}/full/
  - card_search             GET  /api/v1/cards/?search=...          (0030)
  - card_timeline           GET  /api/v1/boards/{id}/cards/{id}/timeline/  (0045)
  - notifications_list      GET  /api/v1/notifications/
  - notifications_unread    GET  /api/v1/notifications/unread-count/

Usage (CI — nightly-load-test job in .gitlab-ci.yml):
    python scripts/nightly_load_test.py \\
        --base-url http://localhost:8000 \\
        --token-file /tmp/visiban_load_test_token \\
        --budget-file backend/nightly-load-test-baseline.json \\
        --output nightly-load-test-results.json

Usage (deriving/re-deriving the committed baseline — see
docs/development/nightly-load-test.md):
    python scripts/nightly_load_test.py --measure-only \\
        --base-url http://localhost:8000 \\
        --token-file /tmp/visiban_load_test_token \\
        --output nightly-load-test-results.json
    # Then hand-update backend/nightly-load-test-baseline.json's "budget_ms"
    # values to roughly 1.3-1.5x the "p95_ms" this run measured — never a
    # round number, and never looser than the ratio the issue specifies.
"""

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone

import requests


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


def _self_test():
    """Build known-bad and known-good latency samples and prove the detection
    logic (percentile calculation + budget comparison) still fires correctly.

    Touches no network, no database, no files — pure function checks, same
    shape as check-migration-numbering.sh's synthetic-repo self-test.
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

    if failures:
        print("SELF-TEST FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("SELF-TEST OK: percentile calculation and budget comparison both fire correctly.")
    return 0


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
    with open(args.token_file, encoding="utf-8") as fh:
        token = fh.read().strip()

    session = requests.Session()
    session.headers["Authorization"] = f"Token {token}"

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
    print(f"Fixture: {fixture}")

    endpoints = {
        "board_full": f"{base_url}/api/v1/boards/{board_id}/full/",
        "card_search": f"{base_url}/api/v1/cards/?search=the",
        "card_timeline": f"{base_url}/api/v1/boards/{board_id}/cards/{sample_card_id}/timeline/",
        "notifications_list": f"{base_url}/api/v1/notifications/",
        "notifications_unread": f"{base_url}/api/v1/notifications/unread-count/",
    }

    budgets = {}
    if args.budget_file and not args.measure_only:
        with open(args.budget_file, encoding="utf-8") as fh:
            budgets = json.load(fh).get("endpoints", {})

    results = {}
    violations = []
    for name, url in endpoints.items():
        print(f"Measuring {name} ({args.iterations} requests, {args.warmup} warmup)...")
        samples_ms = _time_requests(session, url, args.iterations, args.warmup)
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
        budget_ms = budgets.get(name, {}).get("budget_p95_ms")
        if budget_ms is not None:
            within_budget = _check_budget(p95, budget_ms)
            entry["budget_p95_ms"] = budget_ms
            entry["within_budget"] = within_budget
            if not within_budget:
                violations.append(f"{name}: p95={p95:.1f}ms exceeds budget {budget_ms}ms")
        results[name] = entry
        print(f"  p50={entry['p50_ms']}ms p95={entry['p95_ms']}ms p99={entry['p99_ms']}ms"
              + (f" (budget {budget_ms}ms)" if budget_ms is not None else " (no budget — measure-only)"))

    output = {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "fixture": fixture,
        "iterations": args.iterations,
        "warmup": args.warmup,
        "results": results,
    }
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(output, fh, indent=2)
        print(f"Wrote results to {args.output}")

    if args.measure_only:
        print("\n--measure-only: not evaluating budgets. Use these p95 numbers "
              "(x1.3-1.5) to (re-)derive backend/nightly-load-test-baseline.json.")
        return 0

    if violations:
        print("\nFAIL — budget exceeded:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print("\nAll endpoints within budget.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://localhost:8000")
    # Not required=True at the argparse level so --self-test (#1093's house
    # rule — see docs/development/ci-gates.md) can run standalone, with no
    # live server or token file. Presence is validated in run() instead.
    parser.add_argument("--token-file", default=None, help="Path to a raw PAT (see manage.py provision_fuzz_token).")
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
             "known-bad and known-good input, then exit. Touches no network or files.",
    )
    args = parser.parse_args()

    if args.self_test:
        sys.exit(_self_test())

    if not args.token_file:
        print("FAIL: --token-file is required (unless --self-test).", file=sys.stderr)
        sys.exit(1)

    try:
        sys.exit(run(args))
    except (RuntimeError, requests.exceptions.RequestException, OSError) as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
