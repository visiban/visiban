#!/usr/bin/env python3
"""Rebuild backend/.test_durations from CI-measured test times (#2422).

Why this exists: `backend-test` splits the suite 8 ways with pytest-split's
`least_duration` algorithm, which balances shards using the committed
`backend/.test_durations` file. Shards must not `--store-durations` (each would
write only its own slice), and regenerating the file locally means a full
single-process suite run on SQLite, whose timings do not match CI's Postgres
runners. So the file drifted: 6,314 entries covering 12.7 min, against ~11,800
tests that take ~105 job-minutes on CI, and pytest-split's per-shard estimate
was off ~5x.

Every `backend-test` shard already reports per-test times as JUnit XML, and
GitLab exposes the merged result as the pipeline's test report. This script
turns those times into pytest-split's format: a flat `{nodeid: seconds}` JSON
object, keys sorted so the diff is reviewable.

Node ids are resolved against `pytest --collect-only -q`, because JUnit only
carries a dotted `classname` (`boards.tests.test_x.SomeTests`) and a test
`name` (`test_y[param]`), not the node id pytest-split keys on:

* a collected test with no CI timing is left out (pytest-split gives it the
  average duration);
* a CI timing whose test no longer collects (renamed, deleted) is dropped;
* a `(classname, name)` pair that two collected ids share is dropped rather
  than guessed;
* repeated rows for one test (reruns, subtests reporting under the parent's
  name) are SUMMED: that is the time the shard actually spent on that node id.

JUnit `time`, like pytest-split's `--store-durations`, covers setup, call and
teardown, so the units match.

One-command refresh (from the repo root, with `glab` authenticated):

    python3 scripts/refresh_test_durations.py --pipeline latest --collect \\
        --output backend/.test_durations

`--pipeline latest` takes the newest successful `main` push pipeline. The
shards' JUnit reports expire with their artifacts (1 day), so use a recent one.
Offline inputs: `--test-report report.json` (from
`glab api projects/:id/pipelines/<id>/test_report`) and/or `--junit
junit-*.xml`, with `--collected collected.txt`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET  # nosec B405 - CI's own junit artifacts; ET does not expand external entities
from collections import defaultdict
from pathlib import Path

from _paths import REPO_ROOT, cli_roots, resolve_within

PROJECT = "visiban%2Fvisiban"
SUITE = "backend-test"


def nodeid_key(nodeid: str) -> tuple[str, str] | None:
    """Map `a/b/test_c.py::Cls::test_d[x]` to JUnit's `("a.b.test_c.Cls", "test_d[x]")`."""
    parts = nodeid.split("::")
    if len(parts) < 2 or not parts[0].endswith(".py"):
        return None
    module = parts[0][: -len(".py")].replace("/", ".")
    return ".".join([module, *parts[1:-1]]), parts[-1]


def parse_collected(text: str) -> list[str]:
    """Node ids from `pytest --collect-only -q` (one per line, then a summary)."""
    return [line.strip() for line in text.splitlines() if "::" in line and line.strip().split("::")[0].endswith(".py")]


def rows_from_test_report(report: dict, suite: str) -> list[tuple[str, str, float]]:
    suites = [s for s in report.get("test_suites", []) if s.get("name") == suite]
    if not suites:
        raise SystemExit(f"error: no {suite!r} suite in the test report (JUnit reports expired?)")
    return [
        (c.get("classname") or "", c.get("name") or "", float(c.get("execution_time") or 0.0))
        for s in suites
        for c in s.get("test_cases", [])
    ]


def rows_from_junit(text: str) -> list[tuple[str, str, float]]:
    root = ET.fromstring(text)  # nosec B314 - see import note
    return [
        (tc.get("classname") or "", tc.get("name") or "", float(tc.get("time") or 0.0))
        for tc in root.iter("testcase")
    ]


def build(rows: list[tuple[str, str, float]], collected: list[str]) -> tuple[dict[str, float], dict[str, int]]:
    by_key: dict[tuple[str, str], list[str]] = defaultdict(list)
    for nodeid in collected:
        key = nodeid_key(nodeid)
        if key is not None:
            by_key[key].append(nodeid)
    ambiguous = {k for k, v in by_key.items() if len(v) > 1}
    durations: dict[str, float] = defaultdict(float)
    rows_seen: dict[str, int] = defaultdict(int)
    stats = {"rows": len(rows), "unknown": 0, "ambiguous": 0, "summed": 0}
    for classname, name, seconds in rows:
        key = (classname, name)
        if key in ambiguous:
            stats["ambiguous"] += 1
            continue
        ids = by_key.get(key)
        if not ids:
            stats["unknown"] += 1
            continue
        rows_seen[ids[0]] += 1
        if rows_seen[ids[0]] > 1:
            stats["summed"] += 1
        durations[ids[0]] += seconds
    stats["entries"] = len(durations)
    stats["collected"] = len(collected)
    stats["untimed"] = len(collected) - len(durations)
    return {k: durations[k] for k in sorted(durations)}, stats


def glab_json(path: str) -> object:
    # List-form args with no shell, and the same run(check=True, capture_output=True)
    # shape as collect() below: `path` is built in this file from a pipeline id the
    # user passed, never interpolated into a shell command line.
    out = subprocess.run(["glab", "api", path], check=True, capture_output=True).stdout
    return json.loads(out)


def latest_pipeline() -> int:
    data = glab_json(f"projects/{PROJECT}/pipelines?ref=main&source=push&status=success&per_page=1")
    if not isinstance(data, list) or not data:
        raise SystemExit("error: no successful main push pipeline found")
    return int(data[0]["id"])


def collect(python: str) -> str:
    return subprocess.run(
        [python, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
        cwd=REPO_ROOT / "backend",
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pipeline", help="pipeline id, or `latest` for the newest green main push pipeline")
    ap.add_argument("--test-report", help="GitLab pipeline test_report JSON file")
    ap.add_argument("--junit", nargs="*", default=[], help="JUnit XML files")
    ap.add_argument("--suite", default=SUITE, help=f"test-report suite name (default {SUITE})")
    ap.add_argument("--collected", help="output of `pytest --collect-only -q`, run in backend/")
    ap.add_argument("--collect", action="store_true", help="run the collection here instead of --collected")
    ap.add_argument("--python", default=str(REPO_ROOT / "backend/.venv/bin/python"), help="python for --collect")
    ap.add_argument("--output", help="write here (default: stdout)")
    args = ap.parse_args(argv)
    roots = cli_roots()

    rows: list[tuple[str, str, float]] = []
    if args.pipeline:
        pid = latest_pipeline() if args.pipeline == "latest" else int(args.pipeline)
        print(f"pipeline {pid}", file=sys.stderr)
        report = glab_json(f"projects/{PROJECT}/pipelines/{pid}/test_report")
        rows += rows_from_test_report(report, args.suite)
    if args.test_report:
        report = json.loads(resolve_within(roots, args.test_report).read_text())
        rows += rows_from_test_report(report, args.suite)
    for path in args.junit:
        rows += rows_from_junit(resolve_within(roots, path).read_text())
    if not rows:
        ap.error("no timings: pass --pipeline, --test-report or --junit")

    if args.collect:
        collected_text = collect(args.python)
    elif args.collected:
        collected_text = resolve_within(roots, args.collected).read_text()
    else:
        ap.error("pass --collected FILE or --collect")
    collected = parse_collected(collected_text)
    if not collected:
        raise SystemExit("error: no node ids in the collection output")

    durations, stats = build(rows, collected)
    body = json.dumps(durations, indent=4, sort_keys=True) + "\n"
    if args.output:
        out = resolve_within(roots, args.output)
        with tempfile.NamedTemporaryFile("w", dir=out.parent, delete=False, suffix=".tmp") as fh:
            fh.write(body)
        Path(fh.name).replace(out)
    else:
        sys.stdout.write(body)
    print(
        "{entries} entries ({total:.0f} s) from {rows} rows; {collected} collected, {untimed} untimed; "
        "dropped {unknown} unknown and {ambiguous} ambiguous rows; summed {summed} repeated rows".format(
            total=sum(durations.values()), **stats
        ),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
