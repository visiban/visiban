"""Fail the build when a migration builds an index or constraint non-concurrently.

Why this exists
---------------
``migrations.AddIndex`` and ``migrations.AddConstraint`` compile to a plain
``CREATE INDEX`` / ``ALTER TABLE ... ADD CONSTRAINT``, both of which hold an
``ACCESS EXCLUSIVE`` lock on the table for the entire build. On ``cards`` — the
table every board read and write goes through — that is a full outage for as
long as the index takes to build, which for the trigram GIN indexes is the worst
case. This check is what stops the pattern coming back after #1081, and it is
what lets the upgrade guide promise a genuinely zero-downtime ``migrate``.

There are five ways to build an index or a uniqueness constraint in a Django
migration, and all five are checked here. Catching only the first would leave the
rule trivially evadable — and this is not hypothetical: three of the other four
are already used in this repo's history, by migrations that never mention
``AddIndex`` at all.

1. ``AddIndex`` / ``AddConstraint`` operations.
2. ``db_index=True`` on a field in ``AddField`` / ``AlterField``
   (``0036_cardmovement_type_and_index``).
3. ``unique=True`` on a field in ``AddField`` / ``AlterField`` — Django builds a
   unique index for it (``0018_add_stable_uids``, five times, including on
   ``cards``).
4. ``AlterUniqueTogether`` / ``AlterIndexTogether``
   (``0043_column_unique_name_per_board``).
5. Raw ``CREATE INDEX`` SQL inside ``RunSQL`` / ``RunPython``
   (``0030_card_trigram_search_indexes``).

The rule, the exemption, and the grandfathered set are all documented in
``docs/development/database-migrations.md``. Keep the three in sync.

The scan is deliberately syntactic (``ast`` + ``tokenize``) rather than importing
the migration modules: it must be able to flag a migration that would not even
import on the current backend, and it must not need a database.
"""

from __future__ import annotations

import ast
import re
import tokenize
from dataclasses import dataclass
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

# Operations that take ACCESS EXCLUSIVE for the whole build. Matched on the
# attribute/name as written in the migration, so ``AddIndexConcurrently`` and
# ``AddConstraintNotValid`` do not match and are never flagged.
LOCKING_OPERATIONS = frozenset({"AddIndex", "AddConstraint"})

FIELD_OPERATIONS = frozenset({"AddField", "AlterField"})

# Both rebuild the table's unique/index sets under ACCESS EXCLUSIVE.
TOGETHER_OPERATIONS = frozenset({"AlterUniqueTogether", "AlterIndexTogether"})

# Field kwargs that make Django build an index for the column.
INDEXING_FIELD_KWARGS = ("db_index", "unique")

# Operations that require `atomic = False` on the Migration class. Without it
# Django wraps the migration in a transaction and the operation raises
# NotSupportedError at migrate time — loud, but only once it reaches an
# environment that runs migrations.
CONCURRENT_OPERATIONS = frozenset(
    {
        "AddIndexConcurrently",
        "RemoveIndexConcurrently",
        "AddConstraintNotValid",
        "ValidateConstraint",
    }
)

# A CREATE INDEX in hand-written SQL. `CONCURRENTLY` must appear between the
# CREATE and the index name, so a simple lookahead on the same statement is enough.
RAW_CREATE_INDEX = re.compile(
    r"create\s+(?:unique\s+)?index\s+(?!concurrently\b)", re.IGNORECASE
)

# Inline escape hatch. A comment on the operation's own line, or on any of the
# `EXEMPT_LOOKBACK` lines directly above it, suppresses the finding. The reason
# text after the colon is mandatory — a bare marker is still a violation, because
# the whole point is that the next reader can see *why* the lock was acceptable.
EXEMPT_MARKER = "concurrency-exempt:"
EXEMPT_LOOKBACK = 4

# Migrations that predate #1081. The decision recorded in
# docs/development/database-migrations.md is to leave applied history alone: every
# install that has these applied already paid the lock, and re-issuing them would
# buy a fresh install nothing it does not already get from an empty table. They
# are listed explicitly rather than filtered by migration number so that the
# grandfathered set can only shrink, never silently grow.
GRANDFATHERED = frozenset(
    {
        # AddIndex / AddConstraint
        "accounts/migrations/0021_unique_username_ci.py",
        "accounts/migrations/0022_add_can_access_all_content_index.py",
        "boards/migrations/0024_enforce_wip_limits_and_card_index.py",
        "boards/migrations/0038_add_notification_cardmovement_indexes.py",
        "boards/migrations/0045_add_activity_comment_composite_indexes.py",
        "boards/migrations/0047_add_cardchecklist_card_pos_index.py",
        "groups/migrations/0014_group_invite_link_used_at_constraint.py",
        # Raw CREATE INDEX in RunPython (the trigram GIN indexes)
        "boards/migrations/0030_card_trigram_search_indexes.py",
        # db_index=True on a field of an existing table. (db_index=True or
        # unique=True inside a CreateModel is not listed and is not flagged: the
        # table is new, has no rows and no readers, so the lock is uncontended by
        # construction.)
        "boards/migrations/0019_add_card_archived_at.py",
        "boards/migrations/0036_cardmovement_type_and_index.py",
        "groups/migrations/0010_hash_group_invite_token.py",
        # unique=True on a field of an existing table — Django builds a unique index
        "boards/migrations/0018_add_stable_uids.py",
        "boards/migrations/0034_board_share_token.py",
        # AlterUniqueTogether on an existing table
        "boards/migrations/0043_column_unique_name_per_board.py",
    }
)

_ATOMIC_HINT = "and set `atomic = False` on the Migration class"

GUIDANCE = {
    "AddIndex": f"use visiban.db_operations.AddIndexConcurrently {_ATOMIC_HINT}",
    "CheckConstraint": (
        f"use visiban.db_operations.AddConstraintNotValid followed by "
        f"ValidateConstraint {_ATOMIC_HINT}"
    ),
    "UniqueConstraint": (
        f"NOT VALID is not accepted for unique constraints — use "
        f"SeparateDatabaseAndState with a vendor-guarded CREATE UNIQUE INDEX "
        f"CONCURRENTLY plus ADD CONSTRAINT ... USING INDEX {_ATOMIC_HINT}"
    ),
    "AddConstraint": (
        f"for a CheckConstraint use visiban.db_operations.AddConstraintNotValid "
        f"followed by ValidateConstraint; for a UniqueConstraint use "
        f"SeparateDatabaseAndState with a vendor-guarded CREATE UNIQUE INDEX "
        f"CONCURRENTLY {_ATOMIC_HINT}"
    ),
    "db_index=True": (
        f"drop db_index=True from the field and declare the index in the model's "
        f"Meta.indexes, then add it with visiban.db_operations.AddIndexConcurrently "
        f"in its own migration {_ATOMIC_HINT}"
    ),
    "unique=True": (
        f"unique=True makes Django build a unique index. Drop it from the field and "
        f"declare a UniqueConstraint in the model's Meta.constraints, then add it with "
        f"SeparateDatabaseAndState plus a vendor-guarded CREATE UNIQUE INDEX "
        f"CONCURRENTLY {_ATOMIC_HINT}"
    ),
    "together": (
        f"AlterUniqueTogether/AlterIndexTogether rebuild the table's constraint set "
        f"in place. Declare a UniqueConstraint or Index in the model's Meta instead "
        f"and add it concurrently {_ATOMIC_HINT}"
    ),
    "atomic": (
        "this migration uses a concurrent operation but does not set `atomic = False` "
        "on the Migration class, so Django will wrap it in a transaction and the "
        "operation will raise NotSupportedError at migrate time"
    ),
    "CREATE INDEX": (
        f"add CONCURRENTLY to the statement {_ATOMIC_HINT}; keep the "
        f"schema_editor.connection.vendor guard so the migration still runs on SQLite"
    ),
}


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    operation: str
    guidance_key: str

    def render(self) -> str:
        if self.guidance_key == "atomic":
            return f"{self.path}:{self.line}: {GUIDANCE['atomic']}."
        return (
            f"{self.path}:{self.line}: {self.operation} takes ACCESS EXCLUSIVE on the "
            f"table for the whole build — {GUIDANCE[self.guidance_key]}. If the lock is "
            f"genuinely harmless (a table created in this same migration, for example), "
            f"add an inline `# {EXEMPT_MARKER} <reason>` comment."
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


def _constraint_kind(node: ast.Call) -> str:
    """Classify an AddConstraint by its constraint argument.

    The recipes differ: a CheckConstraint can be added NOT VALID and validated
    separately, a UniqueConstraint cannot. Giving one blanket instruction for both
    would ship guidance that is wrong for whichever half the author happens to have.
    """
    constraint = _keyword(node, "constraint")
    if isinstance(constraint, ast.Call):
        name = _callable_name(constraint)
        if name in ("CheckConstraint", "UniqueConstraint"):
            return name
    return "AddConstraint"


def _indexing_kwarg(node: ast.Call) -> str | None:
    """Return the field kwarg that makes Django build an index, if any.

    ``db_index=True`` and ``unique=True`` both do it — ``unique`` builds a unique
    index — and both are invisible to a checker that only looks at operation names.
    ``0018_add_stable_uids`` used ``unique=True`` five times, once on ``cards``.
    """
    field = _keyword(node, "field")
    if not isinstance(field, ast.Call):
        return None
    for kwarg in INDEXING_FIELD_KWARGS:
        value = _keyword(field, kwarg)
        if isinstance(value, ast.Constant) and value.value is True:
            return f"{kwarg}=True"
    return None


def _sets_atomic_false(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "atomic" for t in node.targets):
            continue
        if isinstance(node.value, ast.Constant) and node.value.value is False:
            return True
    return False


def _is_squashed(tree: ast.AST) -> bool:
    """True if the module defines ``replaces``, i.e. it is a squashed migration.

    A squash reproduces operations that were written long before this rule and
    already grandfathered under their original filenames — which no longer exist on
    disk. Linting the squashed file as new would flag history as a fresh violation.
    See the squash procedure in docs/development/database-migrations.md.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "replaces" for t in node.targets
        ):
            return True
    return False


def _state_only_nodes(tree: ast.AST) -> set[int]:
    """Node ids of calls nested under a ``state_operations=`` keyword.

    ``SeparateDatabaseAndState(state_operations=[AddIndex(...)])`` only updates
    Django's in-memory migration state; it emits no DDL and takes no lock. Migration
    0030 relies on exactly this to keep ``makemigrations`` quiet while the real index
    is built by a vendor-guarded ``RunPython``. Flagging those would be a false
    positive that pushes authors toward the escape hatch for no reason.
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
    """Line numbers of inline ``concurrency-exempt:`` comments carrying a reason."""
    try:
        readline = iter(source.splitlines(keepends=True)).__next__
        comments = [
            (token.start[0], token.string)
            for token in tokenize.generate_tokens(readline)
            if token.type == tokenize.COMMENT
        ]
    except tokenize.TokenError:
        # A file that does not tokenize will not parse either; ast.parse reports it.
        return []

    lines = []
    for lineno, text in comments:
        marker, _, reason = text.partition(EXEMPT_MARKER)
        if marker == text or not reason.strip():
            # Marker absent, or present with no reason after the colon.
            continue
        lines.append(lineno)
    return sorted(lines)


def _apply_exemptions(
    violations: list[Violation], exemption_lines: list[int]
) -> list[Violation]:
    """Suppress at most ONE violation per exemption comment.

    A raw line window would silently cover whatever else happened to fall inside it.
    With operations written compactly — one ``AddIndex(...)`` per line, which is
    common — a comment exempting a new table's index would also wave through the
    next operation on a live table, which is precisely the case the reason text
    claims not to cover. Each comment therefore consumes the first violation at or
    below it and no more; two adjacent operations need two comments.
    """
    remaining = sorted(violations, key=lambda v: v.line)
    for comment_line in exemption_lines:
        for violation in remaining:
            if comment_line <= violation.line <= comment_line + EXEMPT_LOOKBACK:
                remaining.remove(violation)
                break
    return remaining


def scan_source(source: str, rel_path: str) -> list[Violation]:
    """Return every non-concurrent index/constraint operation in one migration."""
    tree = ast.parse(source, filename=rel_path)
    if _is_squashed(tree):
        return []

    state_only = _state_only_nodes(tree)
    violations: list[Violation] = []
    uses_concurrent_op = False

    def report(line: int, operation: str, guidance_key: str) -> None:
        violations.append(Violation(rel_path, line, operation, guidance_key))

    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if RAW_CREATE_INDEX.search(node.value):
                report(node.lineno, "raw CREATE INDEX", "CREATE INDEX")
            continue

        if not isinstance(node, ast.Call):
            continue

        name = _callable_name(node)
        if name in CONCURRENT_OPERATIONS:
            uses_concurrent_op = True
            continue
        if id(node) in state_only:
            continue

        if name == "AddIndex":
            report(node.lineno, "AddIndex", "AddIndex")
        elif name == "AddConstraint":
            report(node.lineno, "AddConstraint", _constraint_kind(node))
        elif name in TOGETHER_OPERATIONS:
            report(node.lineno, name, "together")
        elif name in FIELD_OPERATIONS:
            kwarg = _indexing_kwarg(node)
            if kwarg is not None:
                report(node.lineno, f"{name}({kwarg})", kwarg)

    violations = _apply_exemptions(violations, _exemption_lines(source))

    if uses_concurrent_op and not _sets_atomic_false(tree):
        # Not exemptable: there is no situation where a concurrent operation works
        # inside a transaction, so an exemption comment could only hide a crash.
        violations.append(Violation(rel_path, 1, "Migration", "atomic"))

    return sorted(violations, key=lambda v: (v.path, v.line))


def iter_migration_files(backend_root: Path) -> list[Path]:
    return sorted(
        path
        for path in backend_root.glob("*/migrations/*.py")
        if path.name != "__init__.py"
    )


class Command(BaseCommand):
    help = (
        "Fail if any migration adds an index or constraint without the "
        "CONCURRENTLY / NOT VALID pattern (#1081)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--backend-root",
            default=None,
            help="Directory containing the Django apps (defaults to the repo's backend/).",
        )

    def handle(self, *args, **options):
        root = (
            Path(options["backend_root"]).resolve()
            if options["backend_root"]
            else Path(__file__).resolve().parents[3]
        )

        stale = sorted(entry for entry in GRANDFATHERED if not (root / entry).exists())
        for entry in stale:
            # A squash or a deletion removed a grandfathered migration. That is not a
            # failure — but the list must be pruned or it rots into a set of names
            # nobody can check.
            self.stderr.write(
                self.style.WARNING(
                    f"grandfathered migration no longer exists, prune it from "
                    f"GRANDFATHERED: {entry}"
                )
            )

        violations: list[Violation] = []
        checked = 0
        for path in iter_migration_files(root):
            rel_path = path.relative_to(root).as_posix()
            if rel_path in GRANDFATHERED:
                continue
            checked += 1
            violations.extend(scan_source(path.read_text(encoding="utf-8"), rel_path))

        if violations:
            for violation in violations:
                self.stderr.write(self.style.ERROR(violation.render()))
            raise CommandError(
                f"{len(violations)} non-concurrent index/constraint operation(s) found. "
                f"See docs/development/database-migrations.md."
            )

        self.stdout.write(
            self.style.SUCCESS(
                f"Checked {checked} migration(s) "
                f"({len(GRANDFATHERED) - len(stale)} grandfathered, skipped): "
                f"no non-concurrent index or constraint operations."
            )
        )
