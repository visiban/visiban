#!/usr/bin/env python3
"""Export, merge and (optionally) gate the backend mutation score (#1384).

Ported from TruePPM's ``check_mutation_score.py`` (#2282/#3216). Two differences
follow from using mutmut **2.5.1** (see docs/development/mutation-testing.md):

* mutmut 2.x has no ``export-cicd-stats`` command (that is 3.x), so this script
  reads mutmut's ``.mutmut-cache`` SQLite file itself (``--export-cache``).
* the backend-mutation job runs as N parallel shards, so the checker accepts
  several stats files and sums them.

Usage::

    python scripts/check_mutation_score.py --export-cache backend/.mutmut-cache OUT.json
    python scripts/check_mutation_score.py STATS.json [STATS2.json ...] [--write-merged OUT.json]
    python scripts/check_mutation_score.py --self-test

The score is ``(killed + timeout) / (killed + timeout + survived + suspicious)``.
``skipped`` mutants (another shard's lines) and ``untested`` ones are excluded.

Exit codes (same contract as TruePPM, #3216):

====  =============================================================
0     measured and at or above the floor, or no floor requested
1     measured and BELOW the floor
2     could not be measured: stats file missing/unparseable/not an
      object, an unfinished run (``untested`` mutants left), or zero
      scoreable mutants. This applies in report-only mode too, so a
      dead run is a yellow job, never a meaningless green
====  =============================================================

``MUTATION_MIN`` is deliberately unset in CI during the pilot (report-only). A
floor is read off a week of observed nightlies, never chosen up front, and is
never set to 0 as a placeholder: unset means "report-only", and the job says so.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

# mutmut 2.x Mutant.status -> stats key.
STATUS_KEYS = {
    "ok_killed": "killed",
    "bad_timeout": "timeout",
    "bad_survived": "survived",
    "ok_suspicious": "suspicious",
    "skipped": "skipped",
    "untested": "untested",
}


def export_cache(cache: Path) -> dict[str, int]:
    """Count mutants per verdict from a mutmut 2.x ``.mutmut-cache`` file."""
    if not cache.exists():
        raise FileNotFoundError(cache)
    # Read-only URI: never create an empty cache by accident.
    con = sqlite3.connect(f"file:{cache}?mode=ro", uri=True)
    try:
        rows = con.execute('SELECT status, COUNT(*) FROM "Mutant" GROUP BY status').fetchall()
    finally:
        con.close()
    stats = {key: 0 for key in STATUS_KEYS.values()}
    for status, count in rows:
        stats[STATUS_KEYS.get(status, "other")] = stats.get(STATUS_KEYS.get(status, "other"), 0) + count
    stats["total"] = sum(stats.values())
    return stats


def compute_score(stats: dict[str, int]) -> float | None:
    """Return the score in [0, 1], or None when nothing was scoreable."""
    detected = stats.get("killed", 0) + stats.get("timeout", 0)
    considered = detected + stats.get("survived", 0) + stats.get("suspicious", 0)
    if considered == 0:
        return None
    return detected / considered


def _format_summary(stats: dict[str, int], score: float | None) -> str:
    lines = ["Mutation testing summary (backend beachhead: boards/permissions.py)"]
    for key, note in (
        ("killed", ""),
        ("timeout", "  (counted as killed)"),
        ("survived", ""),
        ("suspicious", "  (counted as not detected)"),
        ("untested", "  (run did not finish)"),
        ("skipped", "  (other shards' lines, excluded)"),
    ):
        lines.append(f"  {key + ':':<12}{stats.get(key, 0)}{note}")
    lines.append("  score:      " + ("n/a (no scoreable mutants)" if score is None else f"{score:.1%}"))
    return "\n".join(lines)


def _load(paths: list[Path]) -> dict[str, int] | int:
    """Load and sum stats files, or return exit code 2 after printing why."""
    total: dict[str, int] = {}
    for path in paths:
        if not path.exists():
            print(f"NOT MEASURED: stats file not found: {path}", file=sys.stderr)
            return 2
        try:
            data = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError as exc:
            print(f"NOT MEASURED: {path} is not valid JSON: {exc}", file=sys.stderr)
            return 2
        if not isinstance(data, dict):
            print(f"NOT MEASURED: {path} holds {type(data).__name__}, expected an object.", file=sys.stderr)
            return 2
        for key, value in data.items():
            if isinstance(value, int):
                total[key] = total.get(key, 0) + value
    return total


def _run_real_script(paths: list[Path], floor: str) -> int:
    """Run this script as a subprocess so the self-test sees the real exit code."""
    cmd = [sys.executable, str(Path(__file__).resolve()), *map(str, paths), "--min", floor]
    return subprocess.run(cmd, capture_output=True, text=True).returncode


def _self_test() -> int:
    """Prove the checker still both accepts and rejects, and exports correctly."""
    cases: dict[str, tuple[list[str], str, int]] = {
        "above the floor": ([json.dumps({"killed": 95, "survived": 5})], "0.8", 0),
        "exactly at the floor": ([json.dumps({"killed": 80, "survived": 20})], "0.8", 0),
        "one mutant below the floor": ([json.dumps({"killed": 79, "survived": 21})], "0.8", 1),
        "far below the floor": ([json.dumps({"killed": 1, "survived": 99})], "0.9", 1),
        "timeouts count as killed": ([json.dumps({"timeout": 80, "survived": 20})], "0.8", 0),
        "suspicious counts as not detected": ([json.dumps({"killed": 79, "suspicious": 21})], "0.8", 1),
        "skipped excluded from denominator": (
            [json.dumps({"killed": 5, "skipped": 500})], "0.9", 0),
        # Shards are summed, not averaged: 90/100 and 50/100 is 140/200 = 0.70.
        "two shards summed (pass)": (
            [json.dumps({"killed": 90, "survived": 10}), json.dumps({"killed": 50, "survived": 50})],
            "0.7", 0),
        "two shards summed (fail)": (
            [json.dumps({"killed": 90, "survived": 10}), json.dumps({"killed": 50, "survived": 50})],
            "0.71", 1),
        "unparseable stats file": (["{ not json"], "0.8", 2),
        "JSON array instead of object": (["[1, 2, 3]"], "0.8", 2),
        "empty run at a real floor": ([json.dumps({"skipped": 5})], "0.9", 2),
        "unfinished run at a real floor": ([json.dumps({"killed": 9, "survived": 1, "untested": 3})], "0.5", 2),
        # Report-only still fails closed on "never measured": the pilot's whole value
        # is the number, so a dead run must be loud (yellow, allow_failure) rather
        # than a green that means nothing (the TruePPM #3172 shape).
        "empty run, report-only": ([json.dumps({"skipped": 5})], "0", 2),
        "terrible score, report-only": ([json.dumps({"killed": 1, "survived": 99})], "0", 0),
        "unfinished run, report-only": ([json.dumps({"killed": 9, "survived": 1, "untested": 3})], "0", 2),
    }
    rc = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, (bodies, floor, expected) in cases.items():
            paths = []
            for i, body in enumerate(bodies):
                p = Path(tmp) / f"s{i}.json"
                p.write_text(body, "utf-8")
                paths.append(p)
            actual = _run_real_script(paths, floor)
            if actual != expected:
                print(f"SELF-TEST FAILED: {name} exited {actual}, expected {expected}", file=sys.stderr)
                rc = 1
        if _run_real_script([Path(tmp) / "nope.json"], "0.8") != 2:
            print("SELF-TEST FAILED: a missing stats file must exit 2", file=sys.stderr)
            rc = 1

        # --write-merged must write the summed file even when the run is then
        # judged "not measured" (exit 2): the artifact is the evidence.
        merged = Path(tmp) / "merged.json"
        a, b = Path(tmp) / "m0.json", Path(tmp) / "m1.json"
        a.write_text(json.dumps({"killed": 2, "untested": 1}), "utf-8")
        b.write_text(json.dumps({"killed": 3, "survived": 1}), "utf-8")
        code = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(a), str(b),
                               "--write-merged", str(merged)], capture_output=True).returncode
        if code != 2 or not merged.exists() or json.loads(merged.read_text()) != {
                "killed": 5, "untested": 1, "survived": 1}:
            print("SELF-TEST FAILED: --write-merged must write the sum and still exit 2", file=sys.stderr)
            rc = 1

        # export_cache against a real SQLite file in mutmut 2.x's schema.
        cache = Path(tmp) / ".mutmut-cache"
        con = sqlite3.connect(cache)
        con.execute('CREATE TABLE "Mutant" (id INTEGER PRIMARY KEY, status TEXT NOT NULL)')
        con.executemany(
            'INSERT INTO "Mutant" (status) VALUES (?)',
            [("ok_killed",)] * 3 + [("bad_survived",), ("bad_timeout",), ("ok_suspicious",),
                                    ("skipped",), ("untested",)],
        )
        con.commit()
        con.close()
        got = export_cache(cache)
        want = {"killed": 3, "survived": 1, "timeout": 1, "suspicious": 1, "skipped": 1,
                "untested": 1, "total": 8}
        if any(got.get(k) != v for k, v in want.items()):
            print(f"SELF-TEST FAILED: export_cache returned {got}, expected {want}", file=sys.stderr)
            rc = 1

    if rc == 0:
        print(f"SELF-TEST OK: {len(cases) + 3} checks passed "
              "(above, at, below, shards, absent, malformed, unmeasured, export).")
    return rc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stats_paths", nargs="*", type=Path, help="one or more stats JSON files (summed)")
    parser.add_argument(
        "--min", type=float,
        default=float(os.environ.get("MUTATION_MIN", "0") or "0"),
        help="floor in [0, 1]; defaults to $MUTATION_MIN, unset/0 means report-only",
    )
    parser.add_argument("--export-cache", type=Path, metavar="CACHE",
                        help="read a .mutmut-cache and write stats JSON to the single positional path")
    parser.add_argument("--write-merged", type=Path, metavar="OUT",
                        help="also write the summed stats JSON to OUT before judging the run")
    parser.add_argument("--self-test", action="store_true", help="prove the checker can still fail, then exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    if args.export_cache:
        if len(args.stats_paths) != 1:
            print("--export-cache needs exactly one output path", file=sys.stderr)
            return 2
        try:
            stats = export_cache(args.export_cache)
        except (FileNotFoundError, sqlite3.Error) as exc:
            print(f"NOT MEASURED: cannot read mutmut cache {args.export_cache}: {exc}", file=sys.stderr)
            return 2
        args.stats_paths[0].write_text(json.dumps(stats, indent=2) + "\n", "utf-8")
        print(f"wrote {args.stats_paths[0]}: {stats}")
        return 0

    if not args.stats_paths:
        parser.error("give at least one stats file (or --self-test / --export-cache)")

    loaded = _load(args.stats_paths)
    if isinstance(loaded, int):
        return loaded
    stats = loaded
    if args.write_merged:
        args.write_merged.write_text(json.dumps(stats, indent=2) + "\n", "utf-8")
    score = compute_score(stats)
    print(_format_summary(stats, score))

    if stats.get("untested", 0) > 0:
        print(f"NOT MEASURED: {stats['untested']} mutants were never tested (run cut short).", file=sys.stderr)
        return 2
    if score is None:
        print("NOT MEASURED: no mutant was scoreable.\n"
              "  Check the job log for a dead pytest run or an unreadable .mutmut-cache.", file=sys.stderr)
        return 2
    if args.min <= 0:
        print("floor: MUTATION_MIN is unset - report-only, not gating. "
              "Set it from the observed nightly scores (one point under the low end), never to 0.")
        return 0
    if score < args.min:
        print(f"FAIL: score {score:.1%} is below the floor {args.min:.1%}")
        return 1
    print(f"OK: score {score:.1%} meets the floor {args.min:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
