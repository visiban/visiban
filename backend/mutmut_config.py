"""mutmut hooks and target list for the nightly backend-mutation job (#1384). Not imported by Django.

One table, ``TARGETS``, says what the nightly job mutates: the source file, the
test files each mutant runs against, an optional class to restrict the run to,
and how many parallel CI jobs (shards) the target is split across. Everything
else is derived from it:

* ``python mutmut_config.py run`` is the CI driver. GitLab's ``parallel: N``
  gives each job ``CI_NODE_INDEX`` (1-based) of ``CI_NODE_TOTAL``; ``slot()``
  maps that to one (target, shard) pair, so the CI file never repeats a test
  list. ``CI_NODE_TOTAL`` must equal the sum of the shard counts, or the job
  stops before mutating anything.
* ``python mutmut_config.py expect-shards`` prints the ``name=N,...`` spec the
  report job hands to ``check_mutation_score.py --expect-shards``.
* ``python mutmut_config.py self-test --ci-file ../.gitlab-ci.yml`` (run on MRs
  by ``mutation-score-selftest``) checks every path, test file and class exists
  and that the CI file's ``parallel:`` matches, so a renamed test file or a new
  shard fails on the MR rather than a night later.

``pre_mutation`` is mutmut 2.x's per-mutant hook. mutmut is single-process, so a
target is split across jobs by mutant: the target's mutants, in (line, index)
order, are dealt round-robin, so shard k of N mutates the mutants whose ordinal
is ``k`` modulo N and every shard gets the same count, give or take one. (An
earlier ``line_index % N`` split left some shards twice as full as others,
because mutants cluster on a few lines.) A target with a ``scope`` class only
deals the mutants inside that class and skips the rest; the range is computed
from the code with ``ast`` on every run, never hardcoded, because the class
moves whenever ``models.py`` changes. With ``MUTATION_TARGET`` set but no
``MUTATION_SHARD`` (a hand run), every mutant of the target runs; the CI driver
always sets ``MUTATION_SHARD``. Outside CI with no ``MUTATION_TARGET`` the
hook falls back to a bare ``MUTATION_SHARDS``/``MUTATION_SHARD`` split by line
(one shard and all lines when those are unset too), so a hand run with
``--paths-to-mutate`` behaves as before.
"""

from __future__ import annotations

import ast
import os
import subprocess
from collections import Counter
import sys
from dataclasses import dataclass
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
TESTS_DIR = "boards/tests/"


@dataclass(frozen=True)
class Target:
    name: str
    path: str  # relative to backend/
    tests: tuple[str, ...]  # file names under boards/tests/
    shards: int
    scope: str | None = None  # a top-level class in `path`; None means the whole module


_RBAC_TESTS = (
    "test_rbac.py",
    "test_rbac_boundaries.py",
    "test_explicit_permissions.py",
    "test_permissions_unit_mutation_gaps.py",
)
# The movement-record suites: the six files the CardMovement re-measure used (2026-10-08).
_MOVEMENT_TESTS = (
    "test_card_services.py",
    "test_card_move.py",
    "test_card_archiving.py",
    "test_card_mutation_hooks.py",
    "test_card_edge_cases.py",
    "test_movement_record_mutation_gaps.py",
)
# The list of the 2026-10-09 whole-module re-measure of services/cards.py (96.7%).
_CARD_SERVICE_TESTS = _MOVEMENT_TESTS + (
    "test_views_cards.py",
    "test_notifications.py",
    "test_card_timeline.py",
    "test_views_extra.py",
    "test_board_events.py",
    "test_security_fixes.py",
    "test_card_service_mutation_gaps.py",
)
# The union of the head (#1502) and remainder (#1484) re-measures, plus the
# custom-field CSV suite for the code #1449 added after them (#1546).
_IMPORT_EXPORT_TESTS = (
    "test_import_export_head_gaps.py",
    "test_import_export_mutation_gaps.py",
    "test_import.py",
    "test_import_naming.py",
    "test_import_options.py",
    "test_import_user_scope.py",
    "test_import_custom_fields.py",
    "test_import_csv_custom_fields.py",
    "test_trello_import.py",
    "test_import_json_value_validation.py",
    "test_export.py",
    "test_export_controls.py",
    "test_export_edge_cases.py",
    "test_moderator_export.py",
)

# Shard counts come from the per-mutant cost in docs/development/mutation-testing.md
# (Nightly CI job, "Shard arithmetic"): each shard is sized to finish well inside the job's
# `timeout:`. Changing a count means changing `parallel:` on backend-mutation too;
# `self-test --ci-file` fails the MR until both agree.
# GitLab lets one job `needs:` at most 50 jobs, and backend-mutation-report needs every shard.
MAX_SHARDS = 50

TARGETS: tuple[Target, ...] = (
    Target("permissions", "boards/permissions.py", _RBAC_TESTS, shards=2),
    Target("cards", "boards/services/cards.py", _CARD_SERVICE_TESTS, shards=7),
    Target(
        "card_movement",
        "boards/models.py",
        _MOVEMENT_TESTS,
        shards=2,
        scope="CardMovement",
    ),
    Target(
        "import_export",
        "boards/views/import_export.py",
        _IMPORT_EXPORT_TESTS,
        shards=33,
    ),
)


def total_shards() -> int:
    return sum(t.shards for t in TARGETS)


def get_target(name: str) -> Target:
    for target in TARGETS:
        if target.name == name:
            return target
    raise KeyError(
        f"unknown MUTATION_TARGET {name!r}; known: {', '.join(t.name for t in TARGETS)}"
    )


def slot(node_index: int, node_total: int) -> tuple[Target, int]:
    """Map GitLab's 1-based ``CI_NODE_INDEX`` of ``CI_NODE_TOTAL`` to (target, 0-based shard)."""
    if node_total != total_shards():
        raise ValueError(
            f"CI_NODE_TOTAL is {node_total} but TARGETS in mutmut_config.py add up to "
            f"{total_shards()} shards; keep `parallel:` on backend-mutation in step."
        )
    if not 1 <= node_index <= node_total:
        raise ValueError(f"CI_NODE_INDEX {node_index} is outside 1..{node_total}")
    offset = node_index - 1
    for target in TARGETS:
        if offset < target.shards:
            return target, offset
        offset -= target.shards
    raise AssertionError(
        "unreachable: node_index was range-checked"
    )  # pragma: no cover


def line_range(target: Target) -> tuple[int, int] | None:
    """0-based inclusive line range of ``target.scope`` (decorators included), or None for the whole file."""
    if target.scope is None:
        return None
    tree = ast.parse((BACKEND / target.path).read_text("utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == target.scope:
            first = min([node.lineno] + [d.lineno for d in node.decorator_list])
            return first - 1, node.end_lineno - 1
    raise LookupError(f"class {target.scope} not found in {target.path}")


def runner_command(target: Target) -> str:
    """The pytest command mutmut runs per mutant.

    ``-x`` stops at the first failure, which is what makes a kill cheap. The
    interpreter is named in full because mutmut 2.5.1 starts the runner without
    a shell. ``--reuse-db`` keeps pytest-django from recreating the PostgreSQL
    test database and replaying every migration for each mutant: the schema comes
    from the migration files, which no mutant touches, so reusing it changes no
    verdict.
    """
    files = " ".join(TESTS_DIR + name for name in target.tests)
    return f"{sys.executable} -m pytest -x -q -p no:cacheprovider --reuse-db {files}"


# ── mutmut hook ──────────────────────────────────────────────────────────────

Mutant = tuple[int, int]  # (0-based line, index on that line): mutmut's own key


def assign(target: Target, mutants: list[Mutant]) -> dict[Mutant, int]:
    """Deal the target's mutants (inside its class range, if any) round-robin over its shards."""
    rng = line_range(target)
    inside = sorted(m for m in set(mutants) if rng is None or rng[0] <= m[0] <= rng[1])
    return {m: i % target.shards for i, m in enumerate(inside)}


def target_mutants(target: Target) -> list[Mutant]:
    """Every mutant mutmut 2.5.1 generates for the target's file (pragmas honored)."""
    from mutmut import ALL, Context, list_mutations  # only the mutation job has mutmut

    source = (BACKEND / target.path).read_text("utf-8")
    context = Context(source=source, filename=target.path, mutation_id=ALL)
    return [(m.line_number, m.index) for m in list_mutations(context)]


@dataclass(frozen=True)
class _Active:
    shard: (
        int | None
    )  # None: no MUTATION_SHARD, so a hand run of a target runs all its shards
    shards: int
    assignment: dict[Mutant, int] | None  # None: hand run, split by line only


_ACTIVE: _Active | None = None


def _active() -> _Active:
    """This process's shard, resolved once from the environment."""
    global _ACTIVE
    if _ACTIVE is None:
        shards = int(os.environ.get("MUTATION_SHARDS", "1"))
        shard = int(os.environ.get("MUTATION_SHARD", "0"))
        name = os.environ.get("MUTATION_TARGET")
        if name:
            target = get_target(name)
            _ACTIVE = _Active(
                shard if "MUTATION_SHARD" in os.environ else None,
                target.shards,
                assign(target, target_mutants(target)),
            )
        else:
            _ACTIVE = _Active(shard, shards, None)
    return _ACTIVE


def _skip(active: _Active, line: int, index: int) -> bool:
    if active.assignment is not None and active.shard is None:
        return (line, index) not in active.assignment
    if active.assignment is not None:
        # Outside the class range, or a mutant the enumeration does not know: no shard runs
        # it. The export then counts it untested (fail closed) unless it is a cache phantom.
        return active.assignment.get((line, index)) != active.shard
    return active.shards > 1 and line % active.shards != active.shard


def pre_mutation(context):
    """Skip every mutant that is not this shard's (or is outside the target's class)."""
    if _skip(_active(), context.mutation_id.line_number, context.mutation_id.index):
        context.skip = True


# ── CLI ──────────────────────────────────────────────────────────────────────


def _run(node_index: int, node_total: int) -> int:
    """Run one shard of one target, then export its stats file. Run from backend/."""
    try:
        target, shard = slot(node_index, node_total)
        rng = line_range(target)
    except (ValueError, LookupError) as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 2
    os.environ.update(
        MUTATION_TARGET=target.name,
        MUTATION_SHARD=str(shard),
        MUTATION_SHARDS=str(target.shards),
    )
    scope = f", class {target.scope} (0-based lines {rng[0]}-{rng[1]})" if rng else ""
    print(
        f"backend-mutation job {node_index}/{node_total}: target {target.name} "
        f"({target.path}{scope}), shard {shard + 1} of {target.shards}, {len(target.tests)} test files",
        flush=True,  # before mutmut's own output, which goes straight to the job log
    )
    mutmut = [sys.executable, "-m", "mutmut"]
    # A non-zero exit only means survivors exist. A run that died is caught by the
    # export (missing cache) or the report (untested mutants, no scoreable ones).
    subprocess.run(
        mutmut
        + [
            "run",
            "--paths-to-mutate",
            target.path,
            "--tests-dir",
            TESTS_DIR,
            "--runner",
            runner_command(target),
            "--no-progress",
        ],
        check=False,
    )
    subprocess.run(mutmut + ["results"], check=False)
    export = [
        sys.executable,
        str(BACKEND.parent / "scripts" / "check_mutation_score.py"),
        "--export-cache",
        ".mutmut-cache",
        "--target",
        target.name,
        # Exit 2 if mutmut never registered this file (its baseline test run died):
        # mutmut's own exit code cannot say so, since survivors also make it non-zero.
        "--source",
        target.path,
    ]
    if rng:
        export += ["--line-range", f"{rng[0]}:{rng[1]}"]
    export.append(f"mutmut-stats-{node_index}.json")
    return subprocess.run(export, check=False).returncode


def _confine_cli_path(path: Path) -> Path:
    """Resolve a CLI-supplied path inside the allowed roots, or raise PathEscapeError (#1549).

    ``scripts/_paths.py`` is imported lazily, only on the ``--ci-file`` path: mutmut
    imports this module as a hook, and that import must stay cheap and side-effect-free.
    """
    scripts = str(Path(__file__).resolve().parent.parent / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from _paths import cli_roots, resolve_within

    return resolve_within(cli_roots(), path)


def _ci_file_problems(ci_file: Path) -> list[str]:
    """Check ``parallel:`` in the CI file; raises PathEscapeError if it is outside the roots.

    The real ``--ci-file`` flow and the self-test's escape check both go through here, so
    dropping the confinement call fails the self-test.
    """
    ci_file = _confine_cli_path(ci_file)
    parallel = _ci_parallel(ci_file)
    if parallel == total_shards():
        return []
    return [
        f"{ci_file}: backend-mutation has `parallel: {parallel}`, but TARGETS add up "
        f"to {total_shards()} shards ({expect_spec()})"
    ]


def _self_test(ci_file: Path | None) -> int:
    problems: list[str] = []
    try:
        _ci_file_problems(Path("/etc/passwd"))
        problems.append("--ci-file confinement accepted /etc/passwd")
    except Exception as exc:  # noqa: BLE001 - only PathEscapeError is the expected rejection
        if type(exc).__name__ != "PathEscapeError":
            problems.append(f"--ci-file confinement raised {type(exc).__name__}, not PathEscapeError")
    names = [t.name for t in TARGETS]
    if len(set(names)) != len(names):
        problems.append(f"duplicate target names: {names}")
    for target in TARGETS:
        if target.shards < 1:
            problems.append(f"{target.name}: shards must be at least 1")
        if "=" in target.name or "," in target.name:
            problems.append(
                f"{target.name}: a target name cannot hold `=` or `,` (expect-shards spec)"
            )
        if not (BACKEND / target.path).is_file():
            problems.append(f"{target.name}: {target.path} does not exist")
            continue
        problems += [
            f"{target.name}: test file {TESTS_DIR}{t} does not exist"
            for t in target.tests
            if not (BACKEND / TESTS_DIR / t).is_file()
        ]
        try:
            rng = line_range(target)
        except LookupError as exc:
            problems.append(f"{target.name}: {exc}")
            continue
        if rng is not None and rng[1] <= rng[0]:
            problems.append(f"{target.name}: empty line range {rng}")
        if target.scope is not None and rng != _text_class_span(target):
            problems.append(
                f"{target.name}: line_range() gives {rng}, but class {target.scope} spans "
                f"{_text_class_span(target)} in the source text; the run would mutate part of it"
            )
        problems += _check_partition(target)
    if total_shards() > MAX_SHARDS:
        problems.append(
            f"TARGETS add up to {total_shards()} shards; backend-mutation-report `needs:` every "
            f"shard and GitLab caps `needs:` at {MAX_SHARDS} jobs. Use fewer, longer shards."
        )
    # Every job maps to exactly one (target, shard), and every (target, shard) to one job.
    seen = [
        (t.name, s)
        for t, s in (slot(i, total_shards()) for i in range(1, total_shards() + 1))
    ]
    if seen != [(t.name, s) for t in TARGETS for s in range(t.shards)]:
        problems.append(f"slot() does not enumerate every (target, shard) once: {seen}")
    for bad in (
        (0, total_shards()),
        (total_shards() + 1, total_shards()),
        (1, total_shards() + 1),
    ):
        try:
            slot(*bad)
            problems.append(f"slot{bad} was accepted")
        except ValueError:
            pass
    if ci_file is not None:
        try:
            problems += _ci_file_problems(ci_file)
        except ValueError as exc:  # PathEscapeError is a ValueError
            print(f"MUTMUT CONFIG: {exc}", file=sys.stderr)
            return 2
    for problem in problems:
        print(f"MUTMUT CONFIG: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(
        f"OK: {len(TARGETS)} mutation targets, {total_shards()} shards ({expect_spec()})."
    )
    return 0


def _text_class_span(target: Target) -> tuple[int, int] | None:
    """The class's 0-based line span read from the text, independently of ``ast``.

    From its first decorator (or ``class`` line) to the last line before the next
    top-level statement that is neither blank nor a comment.
    """
    lines = (BACKEND / target.path).read_text("utf-8").splitlines()
    start = next(
        (
            i
            for i, t in enumerate(lines)
            if t.startswith(f"class {target.scope}(")
            or t.startswith(f"class {target.scope}:")
        ),
        None,
    )
    if start is None:
        return None
    first = start
    while first > 0 and lines[first - 1].startswith("@"):
        first -= 1
    end = start
    for i in range(start + 1, len(lines)):
        text = lines[i]
        if text and not text[0].isspace() and not text.startswith("#"):
            break
        if text.strip() and not text.lstrip().startswith("#"):
            end = i
    return first, end


def _check_partition(target: Target) -> list[str]:
    """Run ``pre_mutation``'s decision for every shard over the target's mutants.

    Every mutant inside the class range must be run by exactly one shard, every
    mutant outside it by none, and the shards' counts may differ by at most one.
    With mutmut importable the real mutants are used; otherwise (the lint image)
    two stand-in mutants on every line of the file.
    """
    try:
        mutants = target_mutants(target)
    except ImportError:
        n_lines = len((BACKEND / target.path).read_text("utf-8").splitlines())
        mutants = [(line, i) for line in range(n_lines) for i in (0, 1)]
    assignment = assign(target, mutants)
    rng = line_range(target)
    runs: dict[Mutant, int] = {m: 0 for m in mutants}
    per_shard = [0] * target.shards
    for shard in range(target.shards):
        active = _Active(shard, target.shards, assignment)
        for m in mutants:
            if not _skip(active, *m):
                runs[m] += 1
                per_shard[shard] += 1
    problems = []
    inside = [m for m in mutants if rng is None or rng[0] <= m[0] <= rng[1]]
    if not inside:
        problems.append(f"{target.name}: no mutants to run")
    bad_inside = [m for m in inside if runs[m] != 1]
    bad_outside = [m for m in mutants if m not in set(inside) and runs[m] != 0]
    if bad_inside:
        problems.append(
            f"{target.name}: {len(bad_inside)} mutants are not run by exactly one shard "
            f"(first {bad_inside[0]}, run {runs[bad_inside[0]]} times)"
        )
    if bad_outside:
        problems.append(
            f"{target.name}: {len(bad_outside)} mutants outside class {target.scope} are run"
        )
    hand = _Active(None, target.shards, assignment)
    hand_runs = [m for m in mutants if not _skip(hand, *m)]
    if sorted(hand_runs) != sorted(inside):
        problems.append(
            f"{target.name}: a hand run without MUTATION_SHARD runs {len(hand_runs)} mutants, "
            f"not the {len(inside)} of the whole range"
        )
    if per_shard and max(per_shard) - min(per_shard) > 1:
        problems.append(f"{target.name}: uneven shards {per_shard}")
    return problems


def _ci_parallel(ci_file: Path) -> int | None:
    """The ``parallel:`` of the ``backend-mutation:`` job, read without a YAML parser.

    The lint image has no PyYAML. The job block runs from its top-level key to
    the next line that starts in column 0 with a non-space, non-comment character.
    """
    in_job = False
    for line in ci_file.read_text("utf-8").splitlines():
        if line.startswith("backend-mutation:"):
            in_job = True
            continue
        if in_job and line and not line[0].isspace() and not line.startswith("#"):
            break
        if in_job and line.strip().startswith("parallel:"):
            value = line.split(":", 1)[1].strip()
            return int(value) if value.isdigit() else None
    return None


def expect_spec() -> str:
    return ",".join(f"{t.name}={t.shards}" for t in TARGETS)


def main(argv: list[str]) -> int:
    command = argv[0] if argv else ""
    if command == "run":
        return _run(int(os.environ["CI_NODE_INDEX"]), int(os.environ["CI_NODE_TOTAL"]))
    if command == "expect-shards":
        print(expect_spec())
        return 0
    if command == "self-test":
        ci_file = Path(argv[2]) if len(argv) == 3 and argv[1] == "--ci-file" else None
        return _self_test(ci_file)
    if command == "targets":
        for target in TARGETS:
            rng = line_range(target)
            try:
                sizes = sorted(
                    set(
                        Counter(
                            assign(target, target_mutants(target)).values()
                        ).values()
                    )
                )
                count = f", {sum(1 for _ in assign(target, target_mutants(target)))} mutants, per shard {sizes}"
            except ImportError:
                count = ""
            print(
                f"{target.name:<14} {target.path}{' ' + target.scope if target.scope else ''}"
                f"{f' lines {rng[0]}-{rng[1]} (0-based)' if rng else ''}, {target.shards} shards{count}"
            )
            print(f"{'':<14} {runner_command(target)}")
        return 0
    print(
        "usage: python mutmut_config.py run | expect-shards | targets | self-test [--ci-file PATH]",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
