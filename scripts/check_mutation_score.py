#!/usr/bin/env python3
"""Export, merge and (optionally) gate the backend mutation score (#1384).

Ported from TruePPM's ``check_mutation_score.py`` (#2282/#3216). Two differences
follow from using mutmut **2.5.1** (see docs/development/mutation-testing.md):

* mutmut 2.x has no ``export-cicd-stats`` command (that is 3.x), so this script
  reads mutmut's ``.mutmut-cache`` SQLite file itself (``--export-cache``).
* the backend-mutation job runs several targets (modules, or one class of a
  module), each as N parallel shards, so the checker accepts many stats files,
  checks each target's shards form one run, and sums the targets into one
  merged score. The floor gates the merged score; each target's score is
  printed beside it so a weak module stays visible.

Usage::

    python scripts/check_mutation_score.py --export-cache backend/.mutmut-cache [--target NAME]
        [--line-range LO:HI] OUT.json
    python scripts/check_mutation_score.py STATS.json [STATS2.json ...]
        [--expect-shards N | --expect-shards NAME=N,NAME=N] [--write-merged OUT.json] [--min 0.90]
    python scripts/check_mutation_score.py --check-pragmas backend
    python scripts/check_mutation_score.py --self-test

``--target`` tags a shard's stats with its target name; the merge groups by it.
``--line-range`` (0-based, inclusive) limits the export to a class's lines: the
mutants outside it belong to no target and are left out of every count.

mutmut 2.5.1 can leave a **phantom** row in ``.mutmut-cache``: it looks up a
mutant's line by its text, so on a file with two identical lines (two closing
``    )`` lines, say) it can file the later line's mutant under the earlier one,
creating a row that is never run and stays ``untested`` for ever. Left in, it
would make every run "unfinished". The export compares the cache with the
mutants mutmut actually generates for the file and drops any row that is not
one of them (``phantom`` in the stats); a generated mutant with no row is
counted ``untested``, so a run that skipped real work still fails closed.

The **adjusted** score (the one ``MUTATION_MIN`` gates, #1503) is
``(killed + timeout) / (killed + timeout + survived + suspicious)``.
``skipped`` mutants (another shard's lines) and ``untested`` ones are excluded.

Proven-equivalent mutants are excluded in source with
``# pragma: no mutate -- <reason>``. mutmut never *generates* a mutant on such a
line, so the cache cannot say how many there were and a score computed from it
alone would silently shrink its own denominator. ``--export-cache`` therefore
also counts them (``excluded``) by asking mutmut to enumerate each source file
once as written and once with its pragmas ignored. The **raw** score keeps them
in the denominator as not detected:
``(killed + timeout) / (killed + timeout + survived + suspicious + excluded)``.
Both are always printed, so an exclusion stays visible. A pragma with no
reason is rejected by ``--check-pragmas``.

Exit codes (same contract as TruePPM, #3216):

====  =============================================================
0     measured and at or above the floor, or no floor requested
1     measured and BELOW the floor, or ``--check-pragmas`` found a
      ``# pragma: no mutate`` without a valid reason
2     could not be measured: stats file missing/unparseable/not an
      object, fewer or more shard files than ``--expect-shards`` (per
      target with the NAME=N form, which also fails on a missing or
      unexpected target), a target's shards that are not one
      consistent run (unequal ``total``, or
      non-skipped mutants that do not add up to it), an unfinished
      run (``untested`` mutants left), or zero scoreable mutants. This
      applies in report-only mode too, so a dead run is a yellow job,
      never a meaningless green. Also a floor outside (0, 1], or a
      stats/cache path outside the allowed roots (repo, cwd, temp dir;
      symlinks followed): reported as ``CONFIG ERROR``, nothing read
      or written
====  =============================================================

``--write-merged`` writes the summed counts on every judged run: each target's
``total`` counts once (not N x total), the top-level counts are the sum over
targets, and ``targets`` holds each target's own counts and scores. A
not-measured run (exit 2) gets a ``not_measured`` key with the reason, so the
artifact is never mistaken for a complete run. An invalid floor is a config
error raised before any stats are read, so it writes no merged file.

A floor is a fraction (``0.90``, not ``90``) and is never set to 0 as a
placeholder: unset or empty means "report-only", and the job says so. ``0`` or
anything outside (0, 1] exits 2. The nightly job sets ``MUTATION_MIN=0.90``
(#1384; the job stays ``allow_failure`` for an observation week first).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import PathEscapeError, cli_roots, resolve_within  # noqa: E402

# mutmut 2.x Mutant.status -> stats key.
STATUS_KEYS = {
    "ok_killed": "killed",
    "bad_timeout": "timeout",
    "bad_survived": "survived",
    "ok_suspicious": "suspicious",
    "skipped": "skipped",
    "untested": "untested",
}


# The reason follows `--`. Long enough that "x" or "n/a" cannot pass as one.
MIN_REASON_CHARS = 10


def find_pragma_problems(source: str) -> list[tuple[int, str]]:
    """Return ``(line_number, problem)`` for every ``# pragma: no mutate`` that is not acceptable.

    mutmut itself accepts a bare pragma, so the reason rule lives here (#1503): an
    exclusion nobody explained is indistinguishable from a survivor someone
    wanted to hide. A reason that blames SQLite must also say a PostgreSQL test
    could kill the mutant, because "SQLite cannot observe it" is a gap in the
    test setup, not a property of the code. (A mutant a PostgreSQL test is
    already planned or filed for is not excluded at all; that is a review
    rule the linter cannot see.)
    """
    problems: list[tuple[int, str]] = []
    lines = source.splitlines()
    # find_pragma_lines is mutmut 2.5.1's own rule, verbatim: `# pragma:` and then `no mutate`
    # anywhere after it. So `# pragma: no cover, no mutate` excludes mutants too and must
    # not slip past the reason check.
    for number in find_pragma_lines(source):
        tail = lines[number - 1].partition("# pragma:")[-1]
        rest = tail.partition("no mutate")[-1].strip()
        reason = rest[2:].strip() if rest.startswith("--") else ""
        if len(reason) < MIN_REASON_CHARS:
            problems.append((number, "needs a reason: `# pragma: no mutate -- <why no test can kill this>`"))
        elif re.search(r"sqlite", reason, re.IGNORECASE) and not re.search(r"postgres", reason, re.IGNORECASE):
            problems.append((number, "a SQLite-only claim must also say a PostgreSQL test could kill it"))
    return problems


def _py_files(paths: list[Path]) -> list[Path]:
    """Expand files and directories to the ``*.py`` files under them, skipping vendored trees."""
    skip = {".venv", "venv", "node_modules", "__pycache__", ".git", "site-packages"}
    found: list[Path] = []
    for root in paths:
        if root.is_file():
            found.append(root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in skip)
            found.extend(Path(dirpath) / f for f in sorted(filenames) if f.endswith(".py"))
    return found


def check_pragmas(paths: list[Path]) -> list[str]:
    """Return one message per unacceptable pragma under ``paths``."""
    messages: list[str] = []
    for path in _py_files(paths):
        try:
            text = path.read_text("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if "no mutate" not in text:
            continue
        messages += [f"{path}:{n}: {why}" for n, why in find_pragma_problems(text)]
    return messages


class PragmaCountError(RuntimeError):
    """The pragma-excluded mutant count cannot be trusted."""


def find_pragma_lines(source: str) -> list[int]:
    """Line numbers mutmut 2.5.1 treats as ``no mutate`` (its own rule, verbatim)."""
    return [n for n, line in enumerate(source.splitlines(), start=1)
            if "# pragma:" in line and "no mutate" in line.partition("# pragma:")[-1]]


LineRange = tuple[int, int]  # 0-based, inclusive, as mutmut numbers lines

# Counts every shard of a target reports for the whole target, not for its own lines.
_PER_TARGET_KEYS = ("total", "excluded", "phantom")


def enumerate_mutants(source: str, filename: str, ignore_pragmas: bool) -> list[tuple[int, int]]:
    """The ``(0-based line, index)`` of every mutant mutmut 2.x generates for ``source``.

    mutmut skips a line carrying ``# pragma: no mutate`` before generating anything,
    so the only way to know how many mutants a pragma removed is to enumerate with
    that skip turned off. Only the pragma set differs between the two calls. The
    pairs are the key mutmut's cache stores (``Line.line_number``, ``Mutant.index``).
    """
    from mutmut import ALL, Context, list_mutations  # imported here: only the mutation job has mutmut

    context = Context(source=source, filename=filename, mutation_id=ALL)
    if ignore_pragmas:
        context._pragma_no_mutate_lines = set()  # mutmut 2.5.1 internals; pinned in the job
    return [(m.line_number, m.index) for m in list_mutations(context)]


def count_mutants(source: str, filename: str, ignore_pragmas: bool) -> int:
    """Number of mutants mutmut 2.x generates for ``source`` (see ``enumerate_mutants``)."""
    return len(enumerate_mutants(source, filename, ignore_pragmas))


def _in_range(line: int, line_range: LineRange | None) -> bool:
    return line_range is None or line_range[0] <= line <= line_range[1]


def _status_counts(rows) -> dict[str, int]:
    stats = {key: 0 for key in STATUS_KEYS.values()}
    for status, count in rows:
        key = STATUS_KEYS.get(status, "other")
        stats[key] = stats.get(key, 0) + count
    return stats


def export_cache(cache: Path, enumerate_fn=enumerate_mutants, line_range: LineRange | None = None,
                 target: str | None = None) -> dict[str, int | str]:
    """Count mutants per verdict from a mutmut 2.x ``.mutmut-cache`` file.

    Only the mutants mutmut generates for the cached source files are counted
    (inside ``line_range`` when given). A cache row that is not one of them is a
    phantom of mutmut 2.5.1's line-by-text lookup (see the module docstring) and
    is reported as ``phantom``, not scored; a generated mutant with no row is
    ``untested``. ``excluded`` is the number of proven-equivalent mutants
    (``# pragma: no mutate``) that are not in the cache at all, per target like
    ``total``.
    """
    # The resolved path, not the raw argument, is what reaches the sink (#1377).
    cache = resolve_within(cli_roots(), cache)
    if not cache.exists():
        raise FileNotFoundError(cache)
    # Read-only URI: never create an empty cache by accident. as_uri() percent-quotes
    # the path, so `?`, `#`, `%` and spaces in it cannot corrupt or extend the URI.
    con = sqlite3.connect(cache.as_uri() + "?mode=ro", uri=True)
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not {"SourceFile", "Line"} <= tables:
            # A bare cache (no source file or line rows) can only be counted as stored, and only whole.
            if line_range is not None:
                raise PragmaCountError(f"{cache} has no Line table, so --line-range cannot be applied.")
            stats: dict[str, int | str] = dict(_status_counts(
                con.execute('SELECT status, COUNT(*) FROM "Mutant" GROUP BY status').fetchall()))
            stats["total"] = sum(v for v in stats.values() if isinstance(v, int))
            stats.update(excluded=0, phantom=0)
            if target:
                stats["target"] = target
            return stats
        files = con.execute('SELECT id, filename FROM "SourceFile"').fetchall()
        rows = con.execute('SELECT l.sourcefile, l.line_number, m."index", m.status FROM "Mutant" m '
                           'JOIN "Line" l ON m.line = l.id').fetchall()
    finally:
        con.close()
    counts: dict[str, int] = {}
    excluded = phantom = missing = 0
    for file_id, name in files:
        # mutmut stores the path as given to --paths-to-mutate, relative to the run directory.
        path = resolve_within(cli_roots(), cache.parent / name)
        source = path.read_text("utf-8")
        generated = {m for m in enumerate_fn(source, str(path), False) if _in_range(m[0], line_range)}
        if "no mutate" in source:
            raw = {m for m in enumerate_fn(source, str(path), True) if _in_range(m[0], line_range)}
            diff = len(raw) - len(generated)
            if diff == 0 and any(_in_range(n - 1, line_range) for n in find_pragma_lines(source)):
                # The pragma-honoring switch is mutmut 2.5.1 internals; if it silently stopped working
                # (or every pragma sits on a line with no mutants) `excluded: 0` would be a false number.
                raise PragmaCountError(f"{path} has `# pragma: no mutate` lines but mutmut generates the same "
                                       "number of mutants with and without them; refusing to report excluded=0.")
            excluded += diff
        seen: set[tuple[int, int]] = set()
        for sourcefile, line, index, status in rows:
            if sourcefile != file_id or not _in_range(line, line_range):
                continue
            if (line, index) not in generated:
                phantom += 1
                continue
            seen.add((line, index))
            counts[status] = counts.get(status, 0) + 1
        missing += len(generated - seen)
    stats = dict(_status_counts(counts.items()))
    stats["untested"] += missing
    stats["total"] = sum(v for v in stats.values() if isinstance(v, int))
    # Counted after `total`: excluded mutants are not in the cache and phantoms are not mutants.
    stats.update(excluded=excluded, phantom=phantom)
    if target:
        stats["target"] = target
    return stats


def _parse_line_range(raw: str) -> LineRange:
    lo, sep, hi = raw.partition(":")
    if not sep or not lo.strip().isdigit() or not hi.strip().isdigit() or int(lo) > int(hi):
        raise ValueError(f"--line-range must be LO:HI with 0 <= LO <= HI (0-based, inclusive); got {raw!r}")
    return int(lo), int(hi)


def compute_score(stats: dict[str, int]) -> float | None:
    """Return the score in [0, 1], or None when nothing was scoreable."""
    detected = stats.get("killed", 0) + stats.get("timeout", 0)
    considered = detected + stats.get("survived", 0) + stats.get("suspicious", 0)
    if considered == 0:
        return None
    return detected / considered


def compute_raw_score(stats: dict[str, int]) -> float | None:
    """Like ``compute_score`` but with proven-equivalent (pragma-excluded) mutants counted as not detected."""
    detected = stats.get("killed", 0) + stats.get("timeout", 0)
    considered = (detected + stats.get("survived", 0) + stats.get("suspicious", 0)
                  + stats.get("excluded", 0))
    if considered == 0:
        return None
    return detected / considered


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1%}"


def _format_target_line(name: str, stats: dict[str, int]) -> str:
    """One line per target, so a weak module is visible next to the merged score."""
    detected = stats.get("killed", 0) + stats.get("timeout", 0)
    considered = detected + stats.get("survived", 0) + stats.get("suspicious", 0)
    return (f"  {name:<16} adjusted {_pct(compute_score(stats)):>6} ({detected}/{considered})  "
            f"raw {_pct(compute_raw_score(stats)):>6}  survived {stats.get('survived', 0)}  "
            f"excluded {stats.get('excluded', 0)}  untested {stats.get('untested', 0)}  "
            f"phantom {stats.get('phantom', 0)}")


def _format_summary(stats: dict[str, int], score: float | None, title: str = "merged over all targets") -> str:
    lines = [f"Mutation testing summary ({title})"]
    for key, note in (
        ("killed", ""),
        ("timeout", "  (counted as killed)"),
        ("survived", ""),
        ("suspicious", "  (counted as not detected)"),
        ("untested", "  (run did not finish)"),
        ("skipped", "  (other shards' lines, excluded)"),
        ("excluded", "  (# pragma: no mutate, proven equivalent; never generated)"),
        ("phantom", "  (mutmut 2.5.1 cache rows that are no mutant; dropped)"),
    ):
        lines.append(f"  {key + ':':<12}{stats.get(key, 0)}{note}")
    raw = compute_raw_score(stats)
    lines.append("  adjusted:   " + ("n/a (no scoreable mutants)" if score is None else f"{score:.1%}")
                 + "  (gated by MUTATION_MIN)")
    lines.append("  raw:        " + ("n/a (no scoreable mutants)" if raw is None else f"{raw:.1%}")
                 + "  (excluded mutants counted as not detected)")
    return "\n".join(lines)


def _load(paths: list[Path]) -> tuple[list[dict], str | None]:
    """Load every readable stats file; return them and the first reason one could not be read.

    A shard keeps its integer counts and, when the export tagged it, its ``target`` name.
    """
    shards: list[dict] = []
    for raw in paths:
        # PathEscapeError propagates: main() reports it as a config error, not a measurement.
        path = resolve_within(cli_roots(), raw)
        if not path.exists():
            return shards, f"stats file not found: {raw}"
        try:
            data = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError as exc:
            return shards, f"{raw} is not valid JSON: {exc}"
        if not isinstance(data, dict):
            return shards, f"{raw} holds {type(data).__name__}, expected an object."
        shard = {k: v for k, v in data.items() if isinstance(v, int) and not isinstance(v, bool)}
        if isinstance(data.get("target"), str):
            shard["target"] = data["target"]
        shards.append(shard)
    return shards, None


def _group(shards: list[dict]) -> dict[str, list[dict[str, int]]]:
    """Shards by target name, in first-seen order; an untagged shard belongs to target ``""``."""
    groups: dict[str, list[dict[str, int]]] = {}
    for shard in shards:
        counts = {k: v for k, v in shard.items() if k != "target"}
        groups.setdefault(shard.get("target", ""), []).append(counts)
    return groups


def _parse_expect(raw: str | None) -> int | dict[str, int] | None:
    """``--expect-shards``: an int (all files, one target) or ``NAME=N,NAME=N`` (per target)."""
    if raw is None:
        return None
    if raw.strip().isdigit():
        return int(raw)
    spec: dict[str, int] = {}
    for part in raw.split(","):
        name, sep, count = part.strip().partition("=")
        if not sep or not name or not count.isdigit() or int(count) < 1 or name in spec:
            raise ValueError(f"--expect-shards must be N or NAME=N,NAME=N with N >= 1 and unique names; got {raw!r}")
        spec[name] = int(count)
    return spec


def _check_expected(groups: dict[str, list[dict[str, int]]], n_files: int,
                    expect: int | dict[str, int] | None) -> str | None:
    """Why the files received are not the shards expected, or None."""
    if expect is None:
        return None
    if isinstance(expect, int):
        if n_files != expect:
            return (f"expected {expect} shard stats files, got {n_files}. "
                    "A shard died or its artifact is missing; summing the rest would read as a complete run.")
        return None
    unexpected = sorted(set(groups) - set(expect))
    if unexpected:
        return (f"stats files for targets that were not expected: {unexpected} "
                f"(expected {sorted(expect)}); a stale or foreign artifact must not be summed in.")
    for name, count in expect.items():
        got = len(groups.get(name, []))
        if got != count:
            return (f"target {name}: expected {count} shard stats files, got {got}. "
                    "A shard died or its artifact is missing; summing the rest would read as a complete run.")
    return None


def _check_shard_consistency(shards: list[dict[str, int]], expect_shards: int | None) -> str | None:
    """Return why the shards are not one complete run, or None when they are.

    Every shard runs mutmut over the same module and skips the lines that belong
    to other shards, so each shard's ``total`` is the module's whole mutant count
    and the shards' non-skipped mutants partition it. A shard that ran against
    different source (a stale artifact, another commit) disagrees on ``total``; a
    broken shard hook leaves lines tested twice or by no shard, so the
    non-skipped sum misses ``total``. Either way the summed score describes no
    real run. Applied whenever there is more than one file or a shard count is
    expected; a single hand-written stats file without ``total`` is still judged.
    """
    if len(shards) < 2 and expect_shards is None:
        return None
    totals = [s.get("total") for s in shards]
    if any(t is None for t in totals):
        return "a shard stats file has no `total`, so the shards cannot be shown to cover one run."
    if len(set(totals)) != 1:
        return (f"the shards disagree on the module's mutant count (totals {totals}); "
                "they did not all mutate the same source.")
    total = totals[0]
    excluded = [s.get("excluded", 0) for s in shards]
    if len(set(excluded)) != 1:
        return (f"the shards disagree on the module's excluded-mutant count ({excluded}); "
                "they did not all read the same source.")
    covered = sum(v for s in shards for k, v in s.items() if k not in _PER_TARGET_KEYS + ("skipped",))
    if covered != total:
        return (f"the shards' non-skipped mutants add up to {covered}, not the module's {total}; "
                "some lines were mutated by two shards or by none.")
    return None


def _merge(shards: list[dict[str, int]]) -> dict[str, int | str | list[int]]:
    """Sum one target's per-verdict counts. ``total``, ``excluded`` and ``phantom`` are the
    target's counts (every shard sees the whole target), never N x."""
    merged: dict[str, int | str | list[int]] = {}
    for shard in shards:
        for key, value in shard.items():
            if key not in _PER_TARGET_KEYS:
                merged[key] = int(merged.get(key, 0)) + value
    if shards:
        merged["excluded"] = max(s.get("excluded", 0) for s in shards)
        merged["phantom"] = max(s.get("phantom", 0) for s in shards)
    totals = sorted({s["total"] for s in shards if "total" in s})
    if len(totals) == 1:
        merged["total"] = totals[0]
    elif totals:
        merged["shard_totals"] = [s.get("total", -1) for s in shards]
    return merged


def _merge_targets(per_target: dict[str, dict]) -> dict[str, int]:
    """Sum the targets' merged counts into the job's merged counts (each target's total once)."""
    merged: dict[str, int] = {}
    for counts in per_target.values():
        for key, value in counts.items():
            if isinstance(value, int):
                merged[key] = merged.get(key, 0) + value
    return merged


def _parse_floor(raw: str | None) -> float | None:
    """Return the floor, None for report-only, or raise ValueError with the reason.

    Unset or empty means report-only. Anything else must be a fraction in (0, 1]:
    ``95`` (a percentage) would make every run fail, and ``0`` would read as a
    floor while gating nothing, which the pilot rules out as a placeholder.
    """
    if raw is None or raw.strip() == "":
        return None
    try:
        value = float(raw)
    except ValueError:
        value = float("nan")
    if not 0 < value <= 1:  # also rejects NaN
        raise ValueError(
            f"the floor must be a fraction in (0, 1], e.g. 0.95 for 95% (not 95); got {raw!r}. "
            "Leave MUTATION_MIN unset for report-only; never set it to 0.")
    return value


def _run_real_script(paths: list[Path], floor: str | None, expect_shards: int | None = None,
                     extra: list[str] | None = None, env_floor: str | None = None) -> int:
    """Return only the exit code of ``_run_real_script_full``."""
    return _run_real_script_full(paths, floor, expect_shards, extra, env_floor)[0]


def _run_real_script_full(paths: list[Path], floor: str | None, expect_shards: int | None = None,
                          extra: list[str] | None = None, env_floor: str | None = None) -> tuple[int, str]:
    """Run this script as a subprocess so the self-test sees the real exit code.

    MUTATION_MIN is removed from the child's environment (or set to env_floor) so
    a floor configured on the project cannot change what the fixtures prove.
    """
    cmd = [sys.executable, str(Path(__file__).resolve()), *map(str, paths)]
    if floor is not None:
        cmd += ["--min", floor]
    if expect_shards is not None:
        cmd += ["--expect-shards", str(expect_shards)]
    cmd += extra or []
    env = {k: v for k, v in os.environ.items() if k != "MUTATION_MIN"}
    if env_floor is not None:
        env["MUTATION_MIN"] = env_floor
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    return proc.returncode, proc.stderr


def _self_test() -> int:
    """Prove the checker still both accepts and rejects, and exports correctly."""
    failures: list[str] = []
    checks = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal checks
        checks += 1
        if not ok:
            failures.append(f"{name}{': ' + detail if detail else ''}")

    def shard(**counts: int) -> str:
        return json.dumps(counts)

    cases: dict[str, tuple[list[str], str | None, int]] = {
        "above the floor": ([shard(killed=95, survived=5)], "0.8", 0),
        "exactly at the floor": ([shard(killed=80, survived=20)], "0.8", 0),
        "one mutant below the floor": ([shard(killed=79, survived=21)], "0.8", 1),
        "far below the floor": ([shard(killed=1, survived=99)], "0.9", 1),
        "a floor of exactly 1 is accepted": ([shard(killed=10)], "1", 0),
        "timeouts count as killed": ([shard(timeout=80, survived=20)], "0.8", 0),
        "suspicious counts as not detected": ([shard(killed=79, suspicious=21)], "0.8", 1),
        "skipped excluded from denominator": ([shard(killed=5, skipped=500)], "0.9", 0),
        # Shards are summed, not averaged: 90/100 and 50/100 is 140/200 = 0.70.
        "two shards summed (pass)": (
            [shard(killed=90, survived=10, skipped=100, total=200),
             shard(killed=50, survived=50, skipped=100, total=200)], "0.7", 0),
        "two shards summed (fail)": (
            [shard(killed=90, survived=10, skipped=100, total=200),
             shard(killed=50, survived=50, skipped=100, total=200)], "0.71", 1),
        "unparseable stats file": (["{ not json"], "0.8", 2),
        "JSON array instead of object": (["[1, 2, 3]"], "0.8", 2),
        "empty run at a real floor": ([shard(skipped=5)], "0.9", 2),
        "unfinished run at a real floor": ([shard(killed=9, survived=1, untested=3)], "0.5", 2),
        # Report-only still fails closed on "never measured": the pilot's whole value
        # is the number, so a dead run must be loud (yellow, allow_failure) rather
        # than a green that means nothing (the TruePPM #3172 shape).
        "empty run, report-only": ([shard(skipped=5)], None, 2),
        "terrible score, report-only": ([shard(killed=1, survived=99)], None, 0),
        "unfinished run, report-only": ([shard(killed=9, survived=1, untested=3)], None, 2),
        # Floor range: a percentage, 0, a negative, >1 or non-number is a config
        # error (exit 2), never a silent always-fail, always-pass or no-op floor.
        "floor given as a percentage (95)": ([shard(killed=95, survived=5)], "95", 2),
        "floor of 0": ([shard(killed=95, survived=5)], "0", 2),
        "negative floor": ([shard(killed=95, survived=5)], "-0.1", 2),
        "floor above 1": ([shard(killed=95, survived=5)], "1.5", 2),
        "floor that is NaN": ([shard(killed=95, survived=5)], "nan", 2),
        "floor that is not a number": ([shard(killed=95, survived=5)], "high", 2),
        # Cross-shard consistency: each shard sees the whole module's `total`, and
        # the non-skipped mutants of all shards partition it exactly.
        "shards disagree on total": (
            [shard(killed=5, skipped=5, total=10), shard(killed=5, skipped=6, total=11)], None, 2),
        "shards leave a mutant uncovered": (
            [shard(killed=4, skipped=6, total=10), shard(killed=5, skipped=5, total=10)], None, 2),
        "shards cover a mutant twice": (
            [shard(killed=6, skipped=4, total=10), shard(killed=5, skipped=5, total=10)], None, 2),
        "consistent shards": (
            [shard(killed=4, skipped=6, total=10), shard(killed=6, skipped=4, total=10)], None, 0),
        # #1503: the floor gates the ADJUSTED score. 80/100 adjusted is 80/110 = 72.7% raw; a
        # floor of 0.8 passes only because the 10 proven-equivalent mutants are excluded.
        "floor applies to the adjusted score": ([shard(killed=80, survived=20, excluded=10)], "0.8", 0),
        "adjusted below the floor still fails": ([shard(killed=79, survived=21, excluded=10)], "0.8", 1),
        "excluded alone is not scoreable": ([shard(excluded=5)], None, 2),
        "shards disagree on excluded": (
            [shard(killed=4, skipped=6, total=10, excluded=2), shard(killed=6, skipped=4, total=10, excluded=3)],
            None, 2),
        "shards agreeing on excluded": (
            [shard(killed=4, skipped=6, total=10, excluded=2), shard(killed=6, skipped=4, total=10, excluded=2)],
            None, 0),
    }
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        def write(name: str, body: str) -> Path:
            path = root / name
            path.write_text(body, "utf-8")
            return path

        for name, (bodies, floor, expected) in cases.items():
            paths = [write(f"s{i}.json", body) for i, body in enumerate(bodies)]
            actual = _run_real_script(paths, floor)
            check(name, actual == expected, f"exited {actual}, expected {expected}")

        # A shard with no `total` must be named as such, not reported as some
        # other mismatch (every other check would also trip on the None).
        code, err = _run_real_script_full([write("t0.json", shard(killed=4, skipped=6, total=10)),
                                           write("t1.json", shard(killed=6, skipped=4))], None)
        check("a shard without total", code == 2 and "no `total`" in err, f"exit {code}, stderr {err!r}")
        check("a missing stats file", _run_real_script([root / "nope.json"], "0.8") == 2)
        # The floor is read from MUTATION_MIN too; the range check must cover it.
        ok_stats = write("ok.json", shard(killed=95, survived=5))
        check("MUTATION_MIN=95 from the environment", _run_real_script([ok_stats], None, env_floor="95") == 2)
        check("MUTATION_MIN=0.9 from the environment", _run_real_script([ok_stats], None, env_floor="0.9") == 0)
        check("empty MUTATION_MIN means report-only",
              _run_real_script([write("low.json", shard(killed=1, survived=99))], None, env_floor="") == 0)

        # --expect-shards: a missing shard must never read as a smaller complete run,
        # in report-only mode too. Three good files with 4 expected is the
        # "shard 3 timed out and never wrote its artifact" case.
        good = [write(f"g{i}.json", shard(killed=10, skipped=30, total=40)) for i in range(4)]
        for name, paths, expect, want in (
            ("3 of 4 shards, report-only", good[:3], 4, 2),
            ("1 of 4 shards, report-only", good[:1], 4, 2),
            ("4 of 4 shards", good, 4, 0),
            ("more files than expected", good[:3], 2, 2),
        ):
            got_rc = _run_real_script(paths, None, expect)
            check(name, got_rc == want, f"exited {got_rc}, expected {want}")

        # --write-merged writes the evidence on every judged run, including the
        # not-measured ones (exit 2), and marks those so the artifact cannot be
        # read as a complete run.
        def merged_run(paths: list[Path], expect: int | None = None) -> tuple[int, dict | None]:
            out = root / "merged.json"
            out.unlink(missing_ok=True)
            code = _run_real_script(paths, None, expect, extra=["--write-merged", str(out)])
            return code, json.loads(out.read_text("utf-8")) if out.exists() else None

        code, merged = merged_run([write("m0.json", shard(killed=2, untested=1, skipped=4, total=7)),
                                   write("m1.json", shard(killed=3, survived=1, skipped=3, total=7))])
        check("--write-merged on an unfinished run",
              code == 2 and merged is not None and "not_measured" in merged
              and {k: merged.get(k) for k in ("killed", "untested", "survived", "skipped", "total")}
              == {"killed": 5, "untested": 1, "survived": 1, "skipped": 7, "total": 7},
              f"exit {code}, wrote {merged}")
        code, merged = merged_run(good, 4)
        check("--write-merged total is the module's count, not N x total",
              code == 0 and merged is not None and merged.get("total") == 40
              and merged.get("killed") == 40 and "not_measured" not in merged,
              f"exit {code}, wrote {merged}")
        code, merged = merged_run(good[:3], 4)
        check("--write-merged still writes when a shard is missing",
              code == 2 and merged is not None and "not_measured" in merged and merged.get("killed") == 30,
              f"exit {code}, wrote {merged}")

        # Raw vs adjusted (#1503): excluded mutants are in the raw denominator only.
        adjusted = compute_score({"killed": 80, "survived": 20, "excluded": 10})
        check("adjusted score ignores excluded", adjusted is not None and abs(adjusted - 0.8) < 1e-9, f"{adjusted}")
        raw = compute_raw_score({"killed": 80, "survived": 20, "excluded": 10})
        check("raw score counts excluded as not detected", raw is not None and abs(raw - 80 / 110) < 1e-9, f"{raw}")
        raw_clean = compute_raw_score({"killed": 3, "survived": 1})
        adj_clean = compute_score({"killed": 3, "survived": 1})
        check("raw equals adjusted with nothing excluded",
              raw_clean is not None and adj_clean is not None and abs(raw_clean - adj_clean) < 1e-9,
              f"{raw_clean} vs {adj_clean}")
        check("raw of an empty run is None", compute_raw_score({"skipped": 4}) is None)
        summary = _format_summary({"killed": 80, "survived": 20, "excluded": 10}, 0.8)
        check("summary prints both numbers",
              "adjusted:   80.0%" in summary and "raw:        72.7%" in summary, summary)
        out = root / "both.json"
        code = _run_real_script([write("both_in.json", shard(killed=80, survived=20, excluded=10))], None,
                                extra=["--write-merged", str(out)])
        both = json.loads(out.read_text("utf-8"))
        check("--write-merged carries both scores and the excluded count",
              code == 0 and both.get("excluded") == 10 and abs(both.get("score_adjusted", 0) - 0.8) < 1e-9
              and abs(both.get("score_raw", 0) - 80 / 110) < 1e-9, f"exit {code}, wrote {both}")
        code, merged = merged_run([write("e0.json", shard(killed=2, skipped=4, total=6, excluded=3)),
                                   write("e1.json", shard(killed=4, skipped=2, total=6, excluded=3))])
        check("--write-merged: excluded is the module's count, not N x",
              code == 0 and merged is not None and merged.get("excluded") == 3 and merged.get("total") == 6,
              f"exit {code}, wrote {merged}")

        # Several targets (#1384): each target's shards are checked and merged on their own, then the
        # targets are summed. The floor gates the MERGED adjusted score, never a single target's.
        def tagged(name: str, **counts: int) -> str:
            return json.dumps({"target": name, **counts})

        # a: 2 shards, 90/100 killed, 4 excluded; b: 1 shard, 40/50 killed. Merged 130/150 = 86.7%.
        multi = [write("a0.json", tagged("a", killed=50, survived=5, skipped=45, total=100, excluded=4, phantom=1)),
                 write("a1.json", tagged("a", killed=40, survived=5, skipped=55, total=100, excluded=4, phantom=1)),
                 write("b0.json", tagged("b", killed=40, survived=10, total=50))]
        spec = "a=2,b=1"
        for name, paths, floor, expect, want in (
            ("two targets merged, below the floor although target a is above it", multi, "0.9", spec, 1),
            ("two targets merged, at a floor the merged score meets", multi, "0.86", spec, 0),
            ("two targets, report-only", multi, None, spec, 0),
            ("two targets, a target missing", multi[:2], None, spec, 2),
            ("two targets, a shard of a target missing", [multi[0], multi[2]], None, spec, 2),
            ("two targets, an unexpected target", multi, None, "a=2", 2),
            ("two targets, wrong per-target count", multi, None, "a=1,b=2", 2),
            ("two targets, legacy total count", multi, None, "3", 0),
            ("--expect-shards that is not N or NAME=N", multi, None, "a=x", 2),
            ("--expect-shards with a repeated name", multi, None, "a=2,a=2", 2),
        ):
            got_rc = _run_real_script(paths, floor, expect)
            check(name, got_rc == want, f"exited {got_rc}, expected {want}")
        bad_a = write("a1bad.json", tagged("a", killed=41, survived=5, skipped=54, total=100, excluded=4))
        code, err = _run_real_script_full([multi[0], bad_a, multi[2]], None, spec)
        check("a target's shards that do not partition its total are named",
              code == 2 and "target a:" in err, f"exit {code}, stderr {err!r}")
        code, err = _run_real_script_full([multi[0], multi[1], write("b0bad.json", tagged("b", killed=40, survived=10,
                                                                                         total=51))], None, spec)
        check("a single-shard target is still checked against its total",
              code == 2 and "target b:" in err, f"exit {code}, stderr {err!r}")
        out = root / "multi.json"
        code, err = _run_real_script_full(multi, "0.9", spec, extra=["--write-merged", str(out)])
        both = json.loads(out.read_text("utf-8")) if out.exists() else {}
        check("--write-merged sums targets and keeps each target's scores",
              code == 1 and both.get("total") == 150 and both.get("killed") == 130 and both.get("excluded") == 4
              and both.get("phantom") == 1 and abs(both.get("score_adjusted", 0) - 130 / 150) < 1e-9
              and abs(both.get("score_raw", 0) - 130 / 154) < 1e-9
              and both.get("targets", {}).get("a", {}).get("total") == 100
              and abs(both.get("targets", {}).get("a", {}).get("score_adjusted", 0) - 0.9) < 1e-9
              and abs(both.get("targets", {}).get("b", {}).get("score_adjusted", 0) - 0.8) < 1e-9,
              f"exit {code}, wrote {both}")
        code, stdout = (lambda p: (p.returncode, p.stdout))(subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), *map(str, multi), "--min", "0.85",
             "--expect-shards", spec], capture_output=True, text=True,
            env={k: v for k, v in os.environ.items() if k != "MUTATION_MIN"}))
        check("per-target lines are printed and a target under the floor is named",
              code == 0 and "  a " in stdout and "  b " in stdout and "below the floor on their own" in stdout
              and "b" in stdout.split("below the floor on their own")[-1], f"exit {code}, stdout {stdout!r}")

        # The pragma reason rule.
        good_reason = "x = 1  # pragma: no mutate -- schema constant, guarded by migration-check\n"
        for name, text, want in (
            ("pragma with a reason", good_reason, 0),
            ("pragma without a reason", "x = 1  # pragma: no mutate\n", 1),
            ("pragma with an empty reason", "x = 1  # pragma: no mutate --\n", 1),
            ("pragma with a too-short reason", "x = 1  # pragma: no mutate -- n/a\n", 1),
            ("pragma with a reason not after --", "x = 1  # pragma: no mutate because it is fine\n", 1),
            ("SQLite-only reason", "x = 1  # pragma: no mutate -- lock is not observable on SQLite\n", 1),
            ("SQLite reason naming PostgreSQL",
             "x = 1  # pragma: no mutate -- lock not observable on SQLite; a PostgreSQL test could kill it\n", 0),
            ("no pragma at all", "x = 1\n", 0),
            ("an unrelated pragma", "x = 1  # pragma: no cover\n", 0),
            ("combined pragma without a reason", "x = 1  # pragma: no cover, no mutate\n", 1),
            ("combined pragma with a reason",
             "x = 1  # pragma: no cover, no mutate -- schema constant (migration-check)\n", 0),
            ("no mutate before the pragma marker", "x = 1  # no mutate # pragma: other\n", 0),
        ):
            found = find_pragma_problems(text)
            check(f"find_pragma_problems: {name}", bool(found) == bool(want), f"returned {found}")
        pdir = root / "pragmas"
        pdir.mkdir()
        (pdir / "ok.py").write_text(good_reason, "utf-8")
        check("--check-pragmas passes a clean tree", _run_real_script([], None, extra=["--check-pragmas", str(pdir)]) == 0)
        (pdir / "bad.py").write_text("a = 1\nb = 2  # pragma: no mutate\n", "utf-8")
        code, err = _run_real_script_full([], None, extra=["--check-pragmas", str(pdir)])
        check("--check-pragmas fails on a bare pragma and names file:line",
              code == 1 and "bad.py:2" in err, f"exit {code}, stderr {err!r}")
        code, err = _run_real_script_full([], None, extra=["--check-pragmas", str(root / "no-such-dir")])
        check("--check-pragmas on a missing path is exit 2, not a pass", code == 2 and "NOT MEASURED" in err,
              f"exit {code}, stderr {err!r}")
        empty = root / "emptydir"
        empty.mkdir()
        check("--check-pragmas on a tree with no .py files is exit 2",
              _run_real_script([], None, extra=["--check-pragmas", str(empty)]) == 2)
        skipped_dir = pdir / ".venv"
        skipped_dir.mkdir()
        (skipped_dir / "vendored.py").write_text("b = 2  # pragma: no mutate\n", "utf-8")
        (pdir / "bad.py").unlink()
        check("--check-pragmas skips .venv", _run_real_script([], None, extra=["--check-pragmas", str(pdir)]) == 0)

        # export_cache on a cache in mutmut 2.5.1's real schema (SourceFile, Line, Mutant), with a
        # stand-in enumerator (mutmut is only installed in the mutation job). The stand-in generates
        # two mutants (index 0 and 1) on every line holding `=`, none on a pragma'd line unless
        # pragmas are ignored: the with/without difference is the excluded count.
        src_dir = root / "srcdir"
        src_dir.mkdir()
        mod_lines = ["a = 1  # pragma: no mutate -- schema constant, migration-check",  # line 0
                     "b = 2",                                                         # line 1
                     "class C:",                                                      # line 2
                     "    c = 3",                                                     # line 3
                     "    d = 4  # pragma: no mutate -- schema constant, migration-check",  # line 4
                     "e = 5"]                                                         # line 5
        (src_dir / "mod.py").write_text("\n".join(mod_lines) + "\n", "utf-8")
        (src_dir / "plain.py").write_text("c = 3\n", "utf-8")
        calls: list[tuple[str, bool]] = []

        def fake_enumerate(source: str, filename: str, ignore_pragmas: bool) -> list[tuple[int, int]]:
            calls.append((Path(filename).name, ignore_pragmas))
            return [(n, i) for n, text in enumerate(source.splitlines()) if "=" in text
                    and (ignore_pragmas or "no mutate" not in text) for i in (0, 1)]

        def make_cache(path: Path, rows: list[tuple[str, int, int, str]]) -> Path:
            """rows: (file, 0-based line, index, mutmut status)."""
            con = sqlite3.connect(path)
            con.execute('CREATE TABLE "SourceFile" (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, hash TEXT)')
            con.execute('CREATE TABLE "Line" (id INTEGER PRIMARY KEY, sourcefile INTEGER NOT NULL, '
                        'line TEXT, line_number INTEGER NOT NULL)')
            con.execute('CREATE TABLE "Mutant" (id INTEGER PRIMARY KEY, line INTEGER NOT NULL, '
                        '"index" INTEGER NOT NULL, tested_against_hash TEXT, status TEXT NOT NULL)')
            file_ids: dict[str, int] = {}
            line_ids: dict[tuple[str, int], int] = {}
            for fname, line, index, status in rows:
                if fname not in file_ids:
                    file_ids[fname] = con.execute('INSERT INTO "SourceFile" (filename) VALUES (?)', (fname,)).lastrowid
                if (fname, line) not in line_ids:
                    line_ids[(fname, line)] = con.execute(
                        'INSERT INTO "Line" (sourcefile, line, line_number) VALUES (?, ?, ?)',
                        (file_ids[fname], "", line)).lastrowid
                con.execute('INSERT INTO "Mutant" (line, "index", status) VALUES (?, ?, ?)',
                            (line_ids[(fname, line)], index, status))
            con.commit()
            con.close()
            return path

        all_killed = [("mod.py", n, i, "ok_killed") for n in (1, 3, 5) for i in (0, 1)]
        ccache = make_cache(src_dir / ".mutmut-cache", all_killed + [("plain.py", 0, 0, "ok_killed"),
                                                                     ("plain.py", 0, 1, "bad_survived")])
        got_stats = export_cache(ccache, fake_enumerate)
        check("export_cache counts excluded as the with/without-pragma difference",
              got_stats.get("excluded") == 4 and got_stats.get("killed") == 7 and got_stats.get("survived") == 1
              and got_stats.get("total") == 8 and got_stats.get("phantom") == 0, f"returned {got_stats}")
        check("export_cache never scans a source file with no pragma",
              ("plain.py", True) not in calls, f"calls {calls}")
        try:
            export_cache(ccache, lambda source, filename, ignore_pragmas: [(1, 0)])  # same list either way
            noop_caught = False
        except PragmaCountError:
            noop_caught = True
        check("export_cache refuses excluded=0 when a pragma file yields equal mutant counts", noop_caught)

        # The mutmut 2.5.1 phantom: a row filed under the wrong line (here line 1, index 5) is no
        # mutant mutmut generates. It must be dropped and reported, not left `untested` (which would
        # make every run "unfinished"). A generated mutant with no row at all is untested.
        pdir_cache = src_dir / "phantom"
        pdir_cache.mkdir()
        (pdir_cache / "mod.py").write_text((src_dir / "mod.py").read_text("utf-8"), "utf-8")
        got_stats = export_cache(make_cache(pdir_cache / ".mutmut-cache", all_killed + [("mod.py", 1, 5, "untested")]),
                                 fake_enumerate)
        check("export_cache drops a phantom row and reports it",
              got_stats.get("phantom") == 1 and got_stats.get("untested") == 0 and got_stats.get("total") == 6,
              f"returned {got_stats}")
        mdir = src_dir / "missing"
        mdir.mkdir()
        (mdir / "mod.py").write_text((src_dir / "mod.py").read_text("utf-8"), "utf-8")
        got_stats = export_cache(make_cache(mdir / ".mutmut-cache", all_killed[:-1]), fake_enumerate)
        check("export_cache counts a generated mutant with no cache row as untested",
              got_stats.get("untested") == 1 and got_stats.get("total") == 6, f"returned {got_stats}")

        # --line-range (a class target): only the lines of the range count, for verdicts and for
        # excluded alike; a pragma outside the range is not an error and not this target's exclusion.
        got_stats = export_cache(ccache, fake_enumerate, line_range=(2, 4), target="klass")
        check("export_cache --line-range counts only the range",
              got_stats.get("killed") == 2 and got_stats.get("excluded") == 2 and got_stats.get("total") == 2
              and got_stats.get("target") == "klass", f"returned {got_stats}")
        got_stats = export_cache(ccache, fake_enumerate, line_range=(5, 5))
        check("export_cache --line-range with no pragma inside the range excludes nothing",
              got_stats.get("excluded") == 0 and got_stats.get("total") == 2, f"returned {got_stats}")
        code, err = _run_real_script_full([root / "lr.json"], None,
                                          extra=["--export-cache", str(ccache), "--line-range", "9:3"])
        check("--line-range with LO > HI is a config error", code == 2 and "CONFIG ERROR" in err,
              f"exit {code}, stderr {err!r}")

        bare = root / "bare-cache"
        con = sqlite3.connect(bare)
        con.execute('CREATE TABLE "Mutant" (id INTEGER PRIMARY KEY, status TEXT NOT NULL)')
        con.commit()
        con.close()
        check("a cache with no SourceFile table has nothing excluded",
              export_cache(bare, fake_enumerate).get("excluded") == 0)
        try:
            export_cache(bare, fake_enumerate, line_range=(0, 3))
            bare_range_caught = False
        except PragmaCountError:
            bare_range_caught = True
        check("a cache with no Line table refuses --line-range", bare_range_caught)
        try:
            from mutmut import ALL as _unused  # noqa: F401
            have_mutmut = True
        except ImportError:
            have_mutmut = False
        if have_mutmut:
            # The real mutmut behavior the policy depends on (#1503): a pragma is per physical line and
            # removes the mutants on that line only, from generation, not just from the verdicts.
            sample = ("def a(x):\n    return x + 1  # pragma: no mutate -- test line\n\n"
                      "def b(x):\n    return x + 2\n\nD = dict(\n    max_length=10,\n    db_index=True,\n)\n")
            honored = count_mutants(sample, "sample.py", False)
            ignored = count_mutants(sample, "sample.py", True)
            check("mutmut: a pragma removes the mutants on its own line", ignored - honored == 2,
                  f"honored {honored}, ignored {ignored}")
            # The linter must flag exactly what mutmut honors, including the combined form.
            for form in ("# pragma: no mutate", "# pragma: no cover, no mutate", "# pragma: no mutate -- why not here",
                         "# pragma:no mutate", "#pragma: no mutate", "# no mutate"):
                line = f"def a(x):\n    return x + 1  {form}\n"
                mutmut_honors = count_mutants(line, "t.py", True) > count_mutants(line, "t.py", False)
                seen = "no mutate" in (form.partition("# pragma:")[-1] if "# pragma:" in form else "")
                check(f"linter and mutmut agree on `{form}`", mutmut_honors == seen,
                      f"mutmut honors {mutmut_honors}, linter sees {seen}")
            multiline = sample.replace("    max_length=10,\n", "    max_length=10,  # pragma: no mutate -- test\n")
            check("mutmut: a pragma does not cover the other lines of a call",
                  count_mutants(multiline, "sample.py", False) < honored
                  and count_mutants(multiline, "sample.py", False) > honored - 4,
                  f"{count_mutants(multiline, 'sample.py', False)} vs {honored}")
        else:
            print("SELF-TEST NOTE: mutmut is not installed here; the real-mutmut pragma checks were skipped.",
                  file=sys.stderr)

        # export_cache against a real SQLite file in mutmut 2.x's schema.
        cache = root / ".mutmut-cache"
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
        check("export_cache", all(got.get(k) == v for k, v in want.items()), f"returned {got}, expected {want}")

        # URI building: a path with `?`, `#`, `%` and spaces must open the same file.
        odd_dir = root / "we?ird #dir 100%"
        odd_dir.mkdir()
        odd = odd_dir / "cache db"
        shutil.copy(cache, odd)
        got_odd = export_cache(odd)
        check("export_cache with ?, #, % and spaces in the path",
              all(got_odd.get(k) == v for k, v in want.items()), f"returned {got_odd}")

        # Containment (#1377 helper): a path outside the repo, cwd and temp dir is a config error
        # (exit 2, CONFIG ERROR), never read or written. The fixtures must be outside every root;
        # when this host's home dir is not (cwd or checkout under it), say so rather than pass vacuously.
        outside_dir = Path.home().resolve()
        outside = outside_dir / "mutscore-1515-outside.json"
        try:
            resolve_within(cli_roots(), outside)
            print("SELF-TEST NOTE: home dir is inside an allowed root here; containment cases skipped.",
                  file=sys.stderr)
        except PathEscapeError:
            outside.unlink(missing_ok=True)
            through = outside_dir / "mutscore-1515-link.json"
            try:
                check("a path under the allowed roots resolves", resolve_within(cli_roots(), ok_stats) == ok_stats.resolve())
                msg = "escapes the allowed directories"
                outside.unlink(missing_ok=True)
                code, err = _run_real_script_full([outside], None)
                check("a stats file outside the roots is rejected",
                      code == 2 and "CONFIG ERROR" in err and msg in err, f"exit {code}, stderr {err!r}")
                outside.unlink(missing_ok=True)
                code, err = _run_real_script_full([ok_stats], None, extra=["--write-merged", str(outside)])
                check("--write-merged outside the roots is rejected and not written",
                      code == 2 and "CONFIG ERROR" in err and not outside.exists(), f"exit {code}, stderr {err!r}")
                outside.unlink(missing_ok=True)
                code, err = _run_real_script_full([outside], None, extra=["--export-cache", str(cache)])
                check("--export-cache output outside the roots is rejected and not written",
                      code == 2 and "CONFIG ERROR" in err and not outside.exists(), f"exit {code}, stderr {err!r}")
                outside.unlink(missing_ok=True)
                code, err = _run_real_script_full([root / "o.json"], None, extra=["--export-cache", str(outside)])
                check("--export-cache input outside the roots is rejected",
                      code == 2 and "CONFIG ERROR" in err, f"exit {code}, stderr {err!r}")
                # A symlink inside an allowed root that points outside is rejected, and nothing is written through it.
                link = root / "escape"
                link.symlink_to(outside_dir, target_is_directory=True)
                through.unlink(missing_ok=True)
                code, err = _run_real_script_full([ok_stats], None, extra=["--write-merged", str(link / through.name)])
                check("--write-merged through an escaping symlink is rejected and not written",
                      code == 2 and "CONFIG ERROR" in err and not through.exists(), f"exit {code}, stderr {err!r}")
                through.unlink(missing_ok=True)
                code, err = _run_real_script_full([link / through.name], None)
                check("a stats file read through an escaping symlink is rejected",
                      code == 2 and "CONFIG ERROR" in err, f"exit {code}, stderr {err!r}")
            finally:
                outside.unlink(missing_ok=True)
                through.unlink(missing_ok=True)

    for failure in failures:
        print(f"SELF-TEST FAILED: {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"SELF-TEST OK: {checks} checks passed (above, at, below, floor range, shards, "
          "shard consistency, absent, malformed, unmeasured, merged output, export).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stats_paths", nargs="*", type=Path, help="one or more stats JSON files (summed)")
    parser.add_argument(
        "--min", default=None, metavar="FRACTION",
        help="floor as a fraction in (0, 1], e.g. 0.95; defaults to $MUTATION_MIN. "
             "Unset or empty means report-only",
    )
    parser.add_argument("--export-cache", type=Path, metavar="CACHE",
                        help="read a .mutmut-cache and write stats JSON to the single positional path")
    parser.add_argument("--expect-shards", metavar="N|NAME=N,...",
                        help="exit 2 (not measured) unless exactly N stats files are given (or, per "
                             "target, exactly the NAME=N files and no other target) and each target's "
                             "shards form one consistent run; a shard that never wrote its file must "
                             "not read as a smaller, complete run")
    parser.add_argument("--target", metavar="NAME",
                        help="with --export-cache: tag the stats with this target name (the merge groups by it)")
    parser.add_argument("--line-range", metavar="LO:HI",
                        help="with --export-cache: count only mutants on these 0-based lines (inclusive), "
                             "for a target that is one class of a module")
    parser.add_argument("--write-merged", type=Path, metavar="OUT",
                        help="also write the summed stats JSON to OUT, with a `not_measured` reason "
                             "when the run cannot be judged")
    parser.add_argument("--check-pragmas", nargs="+", type=Path, metavar="PATH",
                        help="exit 1 if any `# pragma: no mutate` under these files/directories has no "
                             "`-- <reason>` (or a SQLite-only reason that omits PostgreSQL), then exit")
    parser.add_argument("--self-test", action="store_true", help="prove the checker can still fail, then exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    if args.check_pragmas:
        try:
            roots = [resolve_within(cli_roots(), p) for p in args.check_pragmas]
        except PathEscapeError as exc:
            print(f"CONFIG ERROR: {exc}", file=sys.stderr)
            return 2
        missing = [str(r) for r in roots if not r.exists()]
        if missing or not _py_files(roots):
            print(f"NOT MEASURED: --check-pragmas found {'no such path: ' + ', '.join(missing) if missing else 'no .py files'} "
                  "to scan; an empty scan must not read as a pass.", file=sys.stderr)
            return 2
        problems = check_pragmas(roots)
        for problem in problems:
            print(f"PRAGMA: {problem}", file=sys.stderr)
        if problems:
            print(f"FAIL: {len(problems)} `# pragma: no mutate` without an acceptable reason "
                  "(see docs/development/mutation-testing.md, Equivalent mutants).", file=sys.stderr)
            return 1
        print("OK: every `# pragma: no mutate` carries a reason.")
        return 0

    if args.export_cache:
        if len(args.stats_paths) != 1:
            print("--export-cache needs exactly one output path", file=sys.stderr)
            return 2
        try:
            line_range = _parse_line_range(args.line_range) if args.line_range else None
        except ValueError as exc:
            print(f"CONFIG ERROR: {exc}", file=sys.stderr)
            return 2
        try:
            stats = export_cache(args.export_cache, line_range=line_range, target=args.target)
        except PathEscapeError as exc:
            print(f"CONFIG ERROR: {exc}", file=sys.stderr)
            return 2
        except PragmaCountError as exc:
            print(f"NOT MEASURED: {exc}", file=sys.stderr)
            return 2
        except ImportError as exc:
            print(f"NOT MEASURED: cannot count pragma-excluded mutants, mutmut is not importable: {exc}",
                  file=sys.stderr)
            return 2
        except (FileNotFoundError, sqlite3.Error, UnicodeDecodeError) as exc:
            print(f"NOT MEASURED: cannot read mutmut cache {args.export_cache}: {exc}", file=sys.stderr)
            return 2
        try:
            out_path = resolve_within(cli_roots(), args.stats_paths[0])
        except PathEscapeError as exc:
            print(f"CONFIG ERROR: {exc}", file=sys.stderr)
            return 2
        out_path.write_text(json.dumps(stats, indent=2) + "\n", "utf-8")
        print(f"wrote {args.stats_paths[0]}: {stats}")
        return 0

    if not args.stats_paths:
        parser.error("give at least one stats file (or --self-test / --export-cache)")

    try:
        floor = _parse_floor(args.min if args.min is not None else os.environ.get("MUTATION_MIN"))
        expect = _parse_expect(args.expect_shards)
    except ValueError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 2

    # Every reason the run cannot be judged, first one wins. All shards that can
    # be read are still loaded so --write-merged keeps the evidence.
    try:
        shards, load_error = _load(args.stats_paths)
    except PathEscapeError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 2
    groups = _group(shards)
    reason = _check_expected(groups, len(args.stats_paths), expect) or load_error
    for name, group in groups.items():
        if reason is not None:
            break
        # A per-target spec always checks a target's shards, even a single one; the
        # legacy int form keeps its old rule for one untagged target.
        target_expect = expect.get(name) if isinstance(expect, dict) else expect
        problem = _check_shard_consistency(group, target_expect)
        if problem is not None:
            reason = f"target {name}: {problem}" if name else problem
    per_target = {name: _merge(group) for name, group in groups.items()}
    stats = _merge_targets(per_target) if len(per_target) != 1 else dict(next(iter(per_target.values())))
    counts = {k: v for k, v in stats.items() if isinstance(v, int)}
    score = compute_score(counts)
    if any(per_target):  # tagged targets: one line each, so a weak module is visible
        print("Per target (the floor gates the merged score below, not these):")
        for name, target_stats in per_target.items():
            print(_format_target_line(name or "(untagged)", {k: v for k, v in target_stats.items()
                                                             if isinstance(v, int)}))
    print(_format_summary(counts, score))

    if reason is None and counts.get("untested", 0) > 0:
        reason = f"{counts['untested']} mutants were never tested (run cut short)."
    if reason is None and score is None:
        reason = ("no mutant was scoreable.\n"
                  "  Check the job log for a dead pytest run or an unreadable .mutmut-cache.")
    if args.write_merged:
        try:
            merged_path = resolve_within(cli_roots(), args.write_merged)
        except PathEscapeError as exc:
            print(f"CONFIG ERROR: {exc}", file=sys.stderr)
            return 2
        out = dict(stats)
        # Both numbers travel in the artifact so an exclusion stays visible to whoever reads it.
        out["score_adjusted"] = score
        out["score_raw"] = compute_raw_score(counts)
        if any(per_target):
            out["targets"] = {
                name: {**target_stats,
                       "score_adjusted": compute_score({k: v for k, v in target_stats.items() if isinstance(v, int)}),
                       "score_raw": compute_raw_score({k: v for k, v in target_stats.items() if isinstance(v, int)})}
                for name, target_stats in per_target.items()}
        if reason is not None:
            out["not_measured"] = reason
        merged_path.write_text(json.dumps(out, indent=2) + "\n", "utf-8")
    if reason is not None:
        print(f"NOT MEASURED: {reason}", file=sys.stderr)
        return 2

    if floor is None:
        print("floor: MUTATION_MIN is unset - report-only, not gating (it would gate the merged adjusted score). "
              "A floor is a fraction such as 0.90, never 0.")
        return 0
    below = [name for name, target_stats in per_target.items() if name
             and (s := compute_score({k: v for k, v in target_stats.items() if isinstance(v, int)})) is not None
             and s < floor]
    if below:
        print(f"NOTE: below the floor on their own (reported, not gated): {', '.join(below)}")
    if score < floor:
        print(f"FAIL: merged adjusted score {score:.1%} is below the floor {floor:.1%}")
        return 1
    print(f"OK: merged adjusted score {score:.1%} meets the floor {floor:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
