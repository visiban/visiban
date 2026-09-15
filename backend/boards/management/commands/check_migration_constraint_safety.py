"""Fail the build when a migration adds a constraint pre-existing rows can violate.

Why this exists
----------------
``AddConstraint``, an ``AlterField``/``AddField`` that makes a column ``NOT NULL``, and
``AlterUniqueTogether``/``AlterIndexTogether`` all validate every existing row as part of
applying them. On a table that already has rows, a row that violates the new rule does not
produce a graceful failure: the migration partially applies, the deploying pod's migrate
step errors out, health checks fail, and the deploy is stuck in a crash-loop until someone
manually intervenes — worse than a migration that simply refuses to run (#1098).

This is a different failure mode from #1081 (``check_migration_concurrency``), even though
the two checks watch overlapping operation classes. #1081 is about how long the
``ACCESS EXCLUSIVE`` lock is held. This check is about whether the operation can succeed at
all against the data that is already there. A migration can pass one and fail the other —
``AddConstraintNotValid`` is concurrency-safe on its own, but the paired
``ValidateConstraint`` still scans every row and fails exactly the same way a plain
``AddConstraint`` would.

The two are kept as sibling commands rather than one command with a mode flag: the rules,
the exemption text, and the failure messages are all independent, and a reader auditing "is
this migration lock-safe" has no reason to also load "is this migration data-safe" into the
same mental model. Keeping the AST-walking helpers duplicated between the two files (rather
than importing one from the other) is a deliberate trade for the same reason — each gate
stays readable and breakable on its own.

The scan is deliberately syntactic (``ast`` + ``tokenize``), matching #1081: it parses the
migration's ``operations`` list rather than importing the module or touching a database, so
it can flag a migration that would not even import on the current backend.

What is flagged
----------------
1. ``AddConstraint`` — validates every row when applied.
2. ``ValidateConstraint`` — the deferred half of the ``AddConstraintNotValid`` /
   ``ValidateConstraint`` pair from #1081. ``AddConstraintNotValid`` itself never fails
   against existing data (that is the point of ``NOT VALID``), so it is not flagged, but the
   ``ValidateConstraint`` that follows it still scans the table and can fail.
3. ``AlterUniqueTogether`` / ``AlterIndexTogether`` — rebuilds the table's unique index and
   fails on any duplicate.
4. ``AddField`` that is not nullable and carries no ``default`` — Django cannot add such a
   column to a table with existing rows at all; there is no value to give them.
5. ``AlterField`` that explicitly sets ``null=False`` — making an existing column NOT NULL
   fails if any row is still NULL.
6. ``AddField`` / ``AlterField`` with ``unique=True`` on an existing table — Django builds a
   unique index for it and fails on any pre-existing duplicate. (Not ``db_index=True``: a
   plain index never rejects a row, so it carries no data-safety risk — that case is #1081's
   territory, not this one.)

What is not flagged
--------------------
- Any of the above on a model created earlier in the *same* migration (via ``CreateModel``):
  a table with no rows yet cannot have a row that violates anything. Not an escape-hatch
  case — correct behavior, so it is never reported at all.
- Any of the above preceded, in the same migration's operations list, by a ``RunPython`` or
  ``RunSQL`` step. The scan does not verify the step actually repairs the right rows — the
  same coarseness #1081's checker accepts for its own "is this actually concurrent" scan —
  but requiring *some* explicit repair step in the right place is the entire point.
- Any of the above where the migration's own *dependencies* list points at another migration,
  in the same app, that is itself a repair migration (i.e. its operations are RunPython /
  RunSQL). This is the "adjacent migration in the same MR" case the issue describes —
  ``accounts/0021_unique_username_ci`` depends directly on
  ``accounts/0020_resolve_ci_username_collisions``, a dedicated RunPython migration that
  repairs exactly the rows the constraint would otherwise reject.
- Operations nested under ``SeparateDatabaseAndState(state_operations=...)`` — state-only,
  emits no DDL, cannot fail against real data.
- A squashed migration (``replaces`` present) — reproduces operations from before this rule
  existed under a new filename; see ``docs/development/database-migrations.md``.
- An operation carrying an inline ``# constraint-safe: <reason>`` comment, on the operation's
  own line or within the four lines above it. The reason after the colon is mandatory.

Migrations from before this rule are listed in ``GRANDFATHERED`` by filename, the same
convention #1081 uses, and for the same reason: re-checking applied history buys nothing and
editing it is worse than leaving it alone.
"""

from __future__ import annotations

import ast
import tokenize
from dataclasses import dataclass
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

# Operations that validate every existing row when applied.
CONSTRAINT_OPERATIONS = frozenset({"AddConstraint"})
DEFERRED_VALIDATION_OPERATIONS = frozenset({"ValidateConstraint"})
TOGETHER_OPERATIONS = frozenset({"AlterUniqueTogether", "AlterIndexTogether"})
FIELD_OPERATIONS = frozenset({"AddField", "AlterField"})

# A RunPython / RunSQL step is treated as a data-repair step. The scan does not (cannot,
# staying purely syntactic) confirm it repairs the specific rows a later operation cares
# about — it only confirms one exists in the right place. See module docstring.
REPAIR_OPERATIONS = frozenset({"RunPython", "RunSQL"})

# Never fails against existing data — NOT VALID defers the scan to a later ValidateConstraint.
NEVER_VALIDATES_IMMEDIATELY = frozenset({"AddConstraintNotValid"})

EXEMPT_MARKER = "constraint-safe:"
EXEMPT_LOOKBACK = 4

# Migrations that predate #1098. Listed by filename, not filtered by number, so the set can
# only shrink — see docs/development/database-migrations.md for the reasoning on each entry.
GRANDFATHERED = frozenset(
    {
        # AddConstraint (CheckConstraint), no repair step anywhere in the chain: existing
        # rows are safe by construction, not by a repair migration. `single_use` and
        # `used_at` were both added by the immediately preceding migration
        # (groups/0013) with defaults of False/NULL, so every pre-existing row already
        # satisfies `Q(single_use=True) | Q(used_at__isnull=True)` — there is no row for
        # the constraint to reject. A purely syntactic scan cannot see that a field's
        # *default value* makes a repair step unnecessary, only that no repair step is
        # present.
        "groups/migrations/0014_group_invite_link_used_at_constraint.py",
        # AddField(display_name), not nullable and no default. Genuinely unsafe against a
        # populated `users` table — but this is migration 0002 of the `accounts` app,
        # bundled with 0001_initial from Visiban's earliest pre-1.0 history. Every install
        # that has ever run it applied 0001 and 0002 together against an empty database, the
        # same way every fresh install still does; there has never been a deploy where users
        # existed between 0001 and 0002 landing. Re-issuing it as a new migration would be
        # pure churn for that reason, and editing it in place means the file no longer
        # matches what every existing install already has applied — the same tradeoff #1081
        # rejected for its own fourteen.
        "accounts/migrations/0002_user_display_name.py",
    }
)

GUIDANCE = {
    "AddConstraint": (
        "add a `RunPython` step earlier in this migration (or in the migration this one "
        "depends on) that repairs or removes any rows that would violate it before adding it"
    ),
    "ValidateConstraint": (
        "the constraint was added NOT VALID, but validating it still scans every existing "
        "row and fails the same way AddConstraint would — add the repair step before this "
        "operation runs"
    ),
    "together": (
        "AlterUniqueTogether/AlterIndexTogether rebuilds the table's unique index and fails "
        "if any duplicate rows already exist — deduplicate them in a RunPython step first"
    ),
    "AddField-not-null": (
        "Django cannot add a NOT NULL column with no default to a table that already has "
        "rows — add `null=True` (and tighten it in a later migration once backfilled) or "
        "give the field a `default=`"
    ),
    "AlterField-null-false": (
        "making an existing column NOT NULL fails if any row is still NULL — backfill the "
        "column in a RunPython step first"
    ),
    "unique=True": (
        "Django builds a unique index for this and fails if any duplicate values already "
        "exist — deduplicate them in a RunPython step first"
    ),
}


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    operation: str
    guidance_key: str

    def render(self) -> str:
        return (
            f"{self.path}:{self.line}: {self.operation} can fail against pre-existing rows "
            f"that violate it — {GUIDANCE[self.guidance_key]}. If existing rows cannot "
            f"violate it (a table created in this same migration, for example, or already "
            f"repaired by a prior migration), add an inline `# {EXEMPT_MARKER} <reason>` "
            f"comment."
        )


def _callable_name(node: ast.Call) -> str | None:
    """Return the bare callable name of a call node, if it has one."""
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _keyword(node: ast.Call, name: str) -> ast.expr | None:
    for keyword in node.keywords:
        if keyword.arg == name:
            return keyword.value
    return None


def _is_true(value: ast.expr | None) -> bool:
    return isinstance(value, ast.Constant) and value.value is True


def _is_false(value: ast.expr | None) -> bool:
    return isinstance(value, ast.Constant) and value.value is False


def _model_name(node: ast.Call, kwarg: str = "model_name") -> str | None:
    value = _keyword(node, kwarg)
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return value.value.lower()
    return None


def _constraint_kind(node: ast.Call) -> str:
    """AddConstraint and ValidateConstraint share one message key each; no split by
    CheckConstraint/UniqueConstraint is needed here (unlike #1081) because the guidance —
    "add a repair step first" — is identical for both constraint kinds.
    """
    name = _callable_name(node)
    return "ValidateConstraint" if name in DEFERRED_VALIDATION_OPERATIONS else "AddConstraint"


def _field_risk(node: ast.Call, op_name: str) -> str | None:
    """Return the guidance key for a risky AddField/AlterField, or None if it is safe.

    Field kwargs Django autodetector omits when they equal the field's own default (``null``
    defaults to False, so a bare AlterField that never mentions ``null`` is just as likely to
    be an unrelated change as a nullable->NOT NULL transition — the autodetector's output is
    genuinely ambiguous there). To keep the false-positive rate near zero on real history,
    AlterField is only flagged when it *explicitly* writes ``null=False``: Django never
    autogenerates that (False already being the default), so seeing it written out is a
    deliberate statement that this field is losing its nullability.

    ``unique=True`` is treated differently for ``AddField`` than for ``AlterField``.
    PostgreSQL does not consider NULL equal to NULL, so a unique index over a nullable
    *brand-new* column never rejects any pre-existing row — every one of them gets NULL
    (``boards/0034_board_share_token``, ``groups/0010_hash_group_invite_token``: both add a
    unique column that is also nullable, and both are safe by this exact reasoning). An
    ``AlterField`` adding ``unique=True`` gets no such exemption: the column already holds
    real values from before, and nullability going forward says nothing about whether two of
    those existing values already collide.
    """
    field = _keyword(node, "field")
    if not isinstance(field, ast.Call):
        return None

    null_kw = _keyword(field, "null")
    is_unique = _is_true(_keyword(field, "unique"))

    if op_name == "AddField":
        has_default = _keyword(field, "default") is not None
        if is_unique and not _is_true(null_kw):
            return "unique=True"
        if not _is_true(null_kw) and not has_default:
            return "AddField-not-null"
    elif op_name == "AlterField":
        if is_unique:
            return "unique=True"
        if _is_false(null_kw):
            return "AlterField-null-false"

    return None


def _is_squashed(tree: ast.AST) -> bool:
    """True if the module defines ``replaces``, i.e. it is a squashed migration.

    Mirrors #1081's ``check_migration_concurrency._is_squashed``: a squash reproduces
    operations written long before this rule, under a filename that was never individually
    reviewed against it.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "replaces" for t in node.targets
        ):
            return True
    return False


def _operations_elts(tree: ast.AST) -> list[ast.expr]:
    """The elements of the migration's ``operations = [...]`` list, in source order."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "operations" for t in node.targets):
            continue
        if isinstance(node.value, ast.List):
            return list(node.value.elts)
    return []


def _dependencies(tree: ast.AST) -> list[tuple[str, str]]:
    """The migration's ``(app_label, migration_name)`` dependency pairs.

    Only literal two-string tuples/lists are resolved — ``migrations.swappable_dependency(...)``
    depends on a setting rather than a literal name and is silently skipped, which is
    harmless here: it always points at the user model app, never at the app being scanned.
    """
    deps: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "dependencies" for t in node.targets):
            continue
        value = node.value
        if not isinstance(value, ast.List):
            continue
        for elt in value.elts:
            if isinstance(elt, (ast.Tuple, ast.List)) and len(elt.elts) == 2:
                a, b = elt.elts
                if (
                    isinstance(a, ast.Constant)
                    and isinstance(a.value, str)
                    and isinstance(b, ast.Constant)
                    and isinstance(b.value, str)
                ):
                    deps.append((a.value, b.value))
    return deps


def _state_only_nodes(tree: ast.AST) -> set[int]:
    """Node ids nested under a ``state_operations=`` keyword — see #1081's identical helper.

    ``SeparateDatabaseAndState(state_operations=[AddConstraint(...)])`` only updates Django's
    in-memory state; it emits no DDL and cannot fail against real rows.
    """
    state_only: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg != "state_operations":
                continue
            for descendant in ast.walk(keyword.value):
                state_only.add(id(descendant))
    return state_only


def _exemption_lines(source: str) -> list[int]:
    """Line numbers of inline ``constraint-safe:`` comments carrying a reason."""
    try:
        readline = iter(source.splitlines(keepends=True)).__next__
        comments = [
            (token.start[0], token.string)
            for token in tokenize.generate_tokens(readline)
            if token.type == tokenize.COMMENT
        ]
    except tokenize.TokenError:
        return []

    lines = []
    for lineno, text in comments:
        marker, _, reason = text.partition(EXEMPT_MARKER)
        if marker == text or not reason.strip():
            continue
        lines.append(lineno)
    return sorted(lines)


def _apply_exemptions(
    violations: list[Violation], exemption_lines: list[int]
) -> list[Violation]:
    """Suppress at most ONE violation per exemption comment — see #1081's identical rule.

    Each comment consumes the first violation at or below it (within ``EXEMPT_LOOKBACK``
    lines) and no more, so two adjacent risky operations need two comments.
    """
    remaining = sorted(violations, key=lambda v: v.line)
    for comment_line in exemption_lines:
        for violation in remaining:
            if comment_line <= violation.line <= comment_line + EXEMPT_LOOKBACK:
                remaining.remove(violation)
                break
    return remaining


def has_top_level_repair(tree: ast.AST) -> bool:
    """True if any element of the operations list is itself a RunPython/RunSQL step.

    Used only for the cross-migration ("adjacent migration in the same MR") exemption: a
    migration that depends on one made entirely (or partly) of repair steps is assumed to
    have already fixed whatever the dependent migration is about to enforce.
    """
    state_only = _state_only_nodes(tree)
    for elt in _operations_elts(tree):
        if not isinstance(elt, ast.Call) or id(elt) in state_only:
            continue
        if _callable_name(elt) in REPAIR_OPERATIONS:
            return True
    return False


def scan_source(
    source: str, rel_path: str, adjacent_has_repair: bool = False
) -> list[Violation]:
    """Return every constraint-adding operation in one migration that lacks a repair step.

    ``adjacent_has_repair`` is precomputed by the caller from the migration's own
    ``dependencies`` — see module docstring, "adjacent migration in the same MR".
    """
    tree = ast.parse(source, filename=rel_path)
    if _is_squashed(tree):
        return []

    state_only = _state_only_nodes(tree)
    created_models: set[str] = set()
    repair_seen = adjacent_has_repair
    violations: list[Violation] = []

    def report(line: int, operation: str, guidance_key: str) -> None:
        violations.append(Violation(rel_path, line, operation, guidance_key))

    for elt in _operations_elts(tree):
        if not isinstance(elt, ast.Call) or id(elt) in state_only:
            continue

        name = _callable_name(elt)

        if name == "CreateModel":
            value = _keyword(elt, "name")
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                created_models.add(value.value.lower())
            continue

        if name in REPAIR_OPERATIONS:
            repair_seen = True
            continue

        if name in NEVER_VALIDATES_IMMEDIATELY:
            continue

        if name in CONSTRAINT_OPERATIONS or name in DEFERRED_VALIDATION_OPERATIONS:
            model = _model_name(elt)
            if (model and model in created_models) or repair_seen:
                continue
            report(elt.lineno, name, _constraint_kind(elt))
            continue

        if name in TOGETHER_OPERATIONS:
            model = _model_name(elt, kwarg="name")
            if (model and model in created_models) or repair_seen:
                continue
            report(elt.lineno, name, "together")
            continue

        if name in FIELD_OPERATIONS:
            model = _model_name(elt)
            if (model and model in created_models) or repair_seen:
                continue
            guidance_key = _field_risk(elt, name)
            if guidance_key is not None:
                report(elt.lineno, f"{name}({guidance_key.split('-', 1)[-1]})", guidance_key)

    return _apply_exemptions(violations, _exemption_lines(source))


def iter_migration_files(backend_root: Path) -> list[Path]:
    return sorted(
        path
        for path in backend_root.glob("*/migrations/*.py")
        if path.name != "__init__.py"
    )


class Command(BaseCommand):
    help = (
        "Fail if any migration adds a constraint (or equivalent) that could fail against "
        "pre-existing rows, without a preceding data-repair step (#1098)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--backend-root",
            default=None,
            help="Directory containing the Django apps (defaults to the repo's backend/).",
        )
        parser.add_argument(
            "--self-test",
            action="store_true",
            help=(
                "Run the scanner against known-bad and known-good fixture migrations and "
                "report whether it still catches the bad ones and clears the good ones "
                "(#1093). Touches no files and does not scan the real migration tree."
            ),
        )

    def handle(self, *args, **options):
        if options["self_test"]:
            failures = _run_self_test(self.stdout, self.stderr, self.style)
            if failures:
                raise CommandError(f"{failures} self-test assertion(s) failed.")
            return

        root = (
            Path(options["backend_root"]).resolve()
            if options["backend_root"]
            else Path(__file__).resolve().parents[3]
        )

        stale = sorted(entry for entry in GRANDFATHERED if not (root / entry).exists())
        for entry in stale:
            self.stderr.write(
                self.style.WARNING(
                    f"grandfathered migration no longer exists, prune it from "
                    f"GRANDFATHERED: {entry}"
                )
            )

        files = iter_migration_files(root)
        parsed: dict[str, tuple[ast.AST, str]] = {}
        for path in files:
            rel_path = path.relative_to(root).as_posix()
            source = path.read_text(encoding="utf-8")
            try:
                parsed[rel_path] = (ast.parse(source, filename=rel_path), source)
            except SyntaxError as exc:
                raise CommandError(f"{rel_path}: could not parse — {exc}") from None

        # Precompute, for every migration, whether ITS OWN operations are a repair step —
        # needed before the second pass so a migration can consult what its dependency
        # looks like, regardless of scan order across apps/files.
        repair_by_key: dict[tuple[str, str], bool] = {}
        for rel_path, (tree, _source) in parsed.items():
            app_label = rel_path.split("/", 1)[0]
            migration_name = Path(rel_path).stem
            repair_by_key[(app_label, migration_name)] = has_top_level_repair(tree)

        violations: list[Violation] = []
        checked = 0
        for rel_path, (tree, source) in parsed.items():
            if rel_path in GRANDFATHERED:
                continue
            checked += 1
            app_label = rel_path.split("/", 1)[0]
            adjacent_has_repair = any(
                repair_by_key.get((dep_app, dep_name), False)
                for dep_app, dep_name in _dependencies(tree)
                if dep_app == app_label
            )
            violations.extend(scan_source(source, rel_path, adjacent_has_repair))

        if violations:
            for violation in sorted(violations, key=lambda v: (v.path, v.line)):
                self.stderr.write(self.style.ERROR(violation.render()))
            raise CommandError(
                f"{len(violations)} constraint-safety violation(s) found. "
                f"See docs/development/database-migrations.md."
            )

        self.stdout.write(
            self.style.SUCCESS(
                f"Checked {checked} migration(s) "
                f"({len(GRANDFATHERED) - len(stale)} grandfathered, skipped): "
                f"no unsafe constraint operations found."
            )
        )


# ---------------------------------------------------------------------------
# --self-test (#1093): prove the gate still fires on known-bad fixtures and
# clears known-good ones. No files touched, no database, no real migration tree.
# ---------------------------------------------------------------------------

_BAD_FIXTURES = {
    "AddConstraint with no repair step": (
        """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AddConstraint(
                    model_name="card",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
            ]
        """,
        ["AddConstraint"],
    ),
    "ValidateConstraint with no repair step": (
        """
        from django.db import migrations, models

        from visiban.db_operations import AddConstraintNotValid, ValidateConstraint

        class Migration(migrations.Migration):
            atomic = False
            dependencies = [("boards", "0001_initial")]
            operations = [
                AddConstraintNotValid(
                    model_name="card",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
                ValidateConstraint(model_name="card", name="x_chk"),
            ]
        """,
        ["ValidateConstraint"],
    ),
    "AlterField null=False with no repair step": (
        """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AlterField(
                    model_name="card",
                    name="uid",
                    field=models.CharField(max_length=16, null=False),
                ),
            ]
        """,
        ["AlterField(null-false)"],
    ),
    "AddField not-null no default": (
        """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AddField(
                    model_name="card",
                    name="priority",
                    field=models.IntegerField(),
                ),
            ]
        """,
        ["AddField(not-null)"],
    ),
    "AlterUniqueTogether with no repair step": (
        """
        from django.db import migrations

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AlterUniqueTogether(
                    name="column",
                    unique_together={("board", "name")},
                ),
            ]
        """,
        ["AlterUniqueTogether"],
    ),
}

_GOOD_FIXTURES = {
    "AddConstraint preceded by RunPython in the same migration": """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.RunPython(
                    migrations.RunPython.noop, migrations.RunPython.noop
                ),
                migrations.AddConstraint(
                    model_name="card",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
            ]
        """,
    "AddConstraint on a table created in the same migration": """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.CreateModel(name="Widget", fields=[]),
                migrations.AddConstraint(
                    model_name="widget",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
            ]
        """,
    "AddConstraint with an inline constraint-safe comment": f"""
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                # {EXEMPT_MARKER} verified no existing row violates this in prod
                migrations.AddConstraint(
                    model_name="card",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
            ]
        """,
    "AddField(null=True) is never risky": """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AddField(
                    model_name="card",
                    name="archived_at",
                    field=models.DateTimeField(null=True),
                ),
            ]
        """,
    "AlterField that never mentions null is not flagged (ambiguous, not a known transition)": """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0001_initial")]
            operations = [
                migrations.AlterField(
                    model_name="card",
                    name="title",
                    field=models.CharField(max_length=200),
                ),
            ]
        """,
}


def _run_self_test(stdout, stderr, style) -> int:
    """Run every fixture through ``scan_source``; return the number of failed assertions."""
    import textwrap

    failures = 0
    stdout.write("check_migration_constraint_safety --self-test")
    stdout.write("=" * 47)

    stdout.write("\n-- known-bad fixtures (must be flagged) --")
    for description, (source, expected_operations) in _BAD_FIXTURES.items():
        findings = scan_source(textwrap.dedent(source), "boards/migrations/0099_x.py")
        found_ops = sorted(f.operation for f in findings)
        if found_ops == sorted(expected_operations):
            stdout.write(style.SUCCESS(f"  ok: {description}"))
        else:
            stderr.write(
                style.ERROR(
                    f"  FAIL: {description} — expected {expected_operations}, got {found_ops}"
                )
            )
            failures += 1

    stdout.write("\n-- known-good fixtures (must NOT be flagged) --")
    for description, source in _GOOD_FIXTURES.items():
        findings = scan_source(textwrap.dedent(source), "boards/migrations/0099_x.py")
        if findings == []:
            stdout.write(style.SUCCESS(f"  ok: {description}"))
        else:
            stderr.write(
                style.ERROR(
                    f"  FAIL: {description} — expected no findings, got "
                    f"{[f.operation for f in findings]}"
                )
            )
            failures += 1

    stdout.write("\n-- adjacent-migration repair exemption --")
    adjacent_source = textwrap.dedent(
        """
        from django.db import migrations, models

        class Migration(migrations.Migration):
            dependencies = [("boards", "0020_repair")]
            operations = [
                migrations.AddConstraint(
                    model_name="card",
                    constraint=models.CheckConstraint(
                        condition=models.Q(position__gte=0), name="x_chk"
                    ),
                ),
            ]
        """
    )
    without = scan_source(adjacent_source, "boards/migrations/0021_x.py")
    with_repair = scan_source(
        adjacent_source, "boards/migrations/0021_x.py", adjacent_has_repair=True
    )
    if without and not with_repair:
        stdout.write(
            style.SUCCESS(
                "  ok: flagged without adjacent_has_repair, cleared when the dependency "
                "is a repair migration"
            )
        )
    else:
        stderr.write(
            style.ERROR(
                f"  FAIL: adjacent-repair exemption — without={without}, with={with_repair}"
            )
        )
        failures += 1

    stdout.write("")
    if failures:
        stderr.write(style.ERROR(f"{failures} assertion(s) failed."))
    else:
        stdout.write(style.SUCCESS("All self-test assertions passed."))
    return failures
