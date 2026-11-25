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

Two foreign-key shapes do the same damage without naming an index anywhere
(#1798):

6. ``AddField`` of a ``ForeignKey`` that leaves ``db_index`` at its default, or of
   any ``OneToOneField`` (its unique index cannot be turned off), on an existing
   table. Django builds the column's index inline. An ``AlterField`` that turns a
   ``db_index=False`` foreign key's index back on is the same build.
7. ``AlterField`` that changes ``null`` on a ``ForeignKey`` / ``OneToOneField``.
   Django drops and re-adds the constraint, which revalidates every row.

An ``AlterField`` only states the field's new definition, so rule 7 replays each
app's earlier migrations, in filename order, to learn the old one. When the old
definition cannot be found the operation is flagged: unknown is not "unchanged".

The rule, the exemption, and the grandfathered sets are all documented in
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

FOREIGN_KEY_FIELDS = frozenset({"ForeignKey", "OneToOneField"})

# Migrations that predate the two foreign-key rules (#1798). Unlike GRANDFATHERED,
# an entry here is skipped by those two rules only; every older rule still applies.
GRANDFATHERED_FOREIGN_KEY = frozenset(
    {
        # AddField(ForeignKey) with the implicit index, all applied history
        "accounts/migrations/0011_user_default_board.py",
        "boards/migrations/0009_board_group.py",
        "boards/migrations/0017_notification_actor_action_type.py",
        "boards/migrations/0044_cardchecklist_created_by.py",
    }
)

FOREIGN_KEY_KEYS = frozenset({"fk-index", "o2o-index", "fk-null"})

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
    "fk-index": (
        f"Django builds the foreign key's index inline, holding its lock for the "
        f"whole build. Set db_index=False on the field, declare the index in the "
        f"model's Meta.indexes, and add it with "
        f"visiban.db_operations.AddIndexConcurrently in its own migration "
        f"{_ATOMIC_HINT}"
    ),
    "o2o-index": (
        f"a OneToOneField always builds a unique index inline, and db_index=False "
        f"does not stop it. Add a ForeignKey with db_index=False and build the "
        f"unique index separately with SeparateDatabaseAndState plus a "
        f"vendor-guarded CREATE UNIQUE INDEX CONCURRENTLY {_ATOMIC_HINT}"
    ),
    "fk-null": (
        "changing null on a foreign key makes Django drop and re-add the constraint, "
        "revalidating every row under ACCESS EXCLUSIVE on this table and SHARE ROW "
        "EXCLUSIVE on the referenced one. Change only the column's nullability, as "
        "boards/0079_cardmovement_card_nullable does"
    ),
}


@dataclass(frozen=True)
class FieldState:
    """The parts of a field definition the foreign-key rules compare.

    ``None`` for a boolean means the source does not spell it as a literal.
    """

    kind: str
    null: bool | None
    db_index: bool | None
    db_constraint: bool | None


# (model_name, field_name) -> the field's definition so far, for one app.
FieldHistory = dict[tuple[str, str], FieldState]


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    operation: str
    guidance_key: str

    def render(self) -> str:
        if self.guidance_key == "atomic":
            return f"{self.path}:{self.line}: {GUIDANCE['atomic']}."
        if self.guidance_key in FOREIGN_KEY_KEYS:
            return (
                f"{self.path}:{self.line}: {self.operation}: "
                f"{GUIDANCE[self.guidance_key]}. If the lock is genuinely harmless, add "
                f"an inline `# {EXEMPT_MARKER} <reason>` comment."
            )
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


def _argument(node: ast.Call, name: str, position: int) -> str | None:
    """A literal string argument given by keyword or position, lowercased."""
    value = _keyword(node, name)
    if value is None and len(node.args) > position:
        value = node.args[position]
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return value.value.lower()
    return None


def _bool_kwarg(field: ast.Call, name: str, default: bool) -> bool | None:
    value = _keyword(field, name)
    if value is None:
        return default
    if isinstance(value, ast.Constant) and isinstance(value.value, bool):
        return value.value
    return None


def _field_state(field: ast.expr | None) -> FieldState | None:
    if not isinstance(field, ast.Call):
        return None
    return FieldState(
        kind=_callable_name(field) or "",
        null=_bool_kwarg(field, "null", False),
        db_index=_bool_kwarg(field, "db_index", True),
        db_constraint=_bool_kwarg(field, "db_constraint", True),
    )


def _ordered_operations(tree: ast.AST) -> list[ast.Call]:
    """The migration's operation calls in the order they apply.

    ``SeparateDatabaseAndState`` is unpacked with ``database_operations`` first,
    whatever order the keywords are written in: they run against the old state, so
    they must be compared before ``state_operations`` records the new one.
    """
    ordered: list[ast.Call] = []

    def visit(node: ast.expr) -> None:
        if not isinstance(node, ast.Call):
            return
        if _callable_name(node) == "SeparateDatabaseAndState":
            for name in ("database_operations", "state_operations"):
                value = _keyword(node, name)
                if isinstance(value, (ast.List, ast.Tuple)):
                    for child in value.elts:
                        visit(child)
            return
        ordered.append(node)

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "operations" for t in node.targets
        ):
            if isinstance(node.value, (ast.List, ast.Tuple)):
                for element in node.value.elts:
                    visit(element)

    # An operations list assembled some other way must not hide a field change.
    seen = {id(node) for node in ordered}
    ordered.extend(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and id(node) not in seen
        and _callable_name(node) in FIELD_OPERATIONS
    )
    return ordered


def _record(node: ast.Call, history: FieldHistory) -> None:
    """Apply one operation to ``history``."""
    name = _callable_name(node)

    if name == "CreateModel":
        model = _argument(node, "name", 0)
        fields = _keyword(node, "fields")
        if fields is None and len(node.args) > 1:
            fields = node.args[1]
        if model and isinstance(fields, (ast.List, ast.Tuple)):
            for pair in fields.elts:
                if isinstance(pair, ast.Tuple) and len(pair.elts) == 2:
                    key, field = pair.elts
                    state = _field_state(field)
                    if isinstance(key, ast.Constant) and state:
                        history[(model, str(key.value).lower())] = state
    elif name == "RenameModel":
        old = _argument(node, "old_name", 0)
        new = _argument(node, "new_name", 1)
        for model, field_name in list(history):
            if model == old and new:
                history[(new, field_name)] = history.pop((model, field_name))
    elif name == "RenameField":
        model = _argument(node, "model_name", 0)
        old = _argument(node, "old_name", 1)
        new = _argument(node, "new_name", 2)
        if model and old and new and (model, old) in history:
            history[(model, new)] = history.pop((model, old))
    else:
        # AddField, AlterField, and subclasses of them such as 0079's
        # DropNotNullKeepingForeignKey, which share the same keywords.
        model = _argument(node, "model_name", 0)
        field_name = _argument(node, "name", 1)
        state = _field_state(_keyword(node, "field"))
        if model and field_name and state:
            history[(model, field_name)] = state


def record_fields(source: str, history: FieldHistory) -> None:
    """Replay one migration's field definitions into ``history``."""
    for node in _ordered_operations(ast.parse(source)):
        _record(node, history)


def _foreign_key_risks(
    node: ast.Call, history: FieldHistory
) -> list[tuple[str, str]]:
    """``(operation, guidance_key)`` for each foreign-key rule ``node`` breaks."""
    name = _callable_name(node)
    new = _field_state(_keyword(node, "field"))
    if name not in FIELD_OPERATIONS or new is None or new.kind not in FOREIGN_KEY_FIELDS:
        return []
    # An explicit db_index=True / unique=True is already reported by the older rule.
    explicit_index = _indexing_kwarg(node) is not None

    if name == "AddField":
        if explicit_index:
            return []
        if new.kind == "OneToOneField":
            return [("AddField(OneToOneField)", "o2o-index")]
        if new.db_index is not False:
            return [("AddField(ForeignKey) without db_index=False", "fk-index")]
        return []

    model = _argument(node, "model_name", 0)
    field_name = _argument(node, "name", 1)
    old = history.get((model, field_name)) if model and field_name else None
    if old is None:
        return [(f"AlterField({new.kind}) with no known earlier definition", "fk-null")]
    if old.kind not in FOREIGN_KEY_FIELDS:
        return []

    risks = []
    # With no database constraint on either side there is nothing to re-validate.
    constrained = old.db_constraint is not False and new.db_constraint is not False
    if constrained and (old.null is None or new.null is None or old.null != new.null):
        risks.append((f"AlterField({new.kind}) changing null", "fk-null"))
    if (
        not explicit_index
        and new.kind == "ForeignKey"
        and old.kind == "ForeignKey"
        and old.db_index is False
        and new.db_index is not False
    ):
        risks.append(("AlterField(ForeignKey) turning the index on", "fk-index"))
    return risks


def _scan_foreign_keys(
    tree: ast.AST, rel_path: str, prior_fields: FieldHistory | None
) -> list[Violation]:
    state_only = _state_only_nodes(tree)
    history = dict(prior_fields or {})
    created: set[str] = set()
    violations: list[Violation] = []

    for node in _ordered_operations(tree):
        if id(node) not in state_only:
            if _callable_name(node) == "CreateModel":
                model = _argument(node, "name", 0)
                if model:
                    created.add(model)
            # A table created in this migration has no rows and no readers.
            elif _argument(node, "model_name", 0) not in created:
                violations.extend(
                    Violation(rel_path, node.lineno, operation, key)
                    for operation, key in _foreign_key_risks(node, history)
                )
        _record(node, history)

    return violations


def scan_source(
    source: str, rel_path: str, prior_fields: FieldHistory | None = None
) -> list[Violation]:
    """Return every non-concurrent index/constraint operation in one migration.

    ``prior_fields`` is the app's field history before this migration. Without it,
    a foreign-key ``AlterField`` on a field this file does not define is flagged.
    """
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

    if rel_path not in GRANDFATHERED_FOREIGN_KEY:
        violations.extend(_scan_foreign_keys(tree, rel_path, prior_fields))

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
        "CONCURRENTLY / NOT VALID pattern (#1081), or builds a foreign-key index "
        "or re-validates a foreign key inline (#1798)."
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

        stale = sorted(
            entry
            for entry in GRANDFATHERED | GRANDFATHERED_FOREIGN_KEY
            if not (root / entry).exists()
        )
        for entry in stale:
            # A squash or a deletion removed a grandfathered migration. That is not a
            # failure — but the list must be pruned or it rots into a set of names
            # nobody can check.
            self.stderr.write(
                self.style.WARNING(
                    f"grandfathered migration no longer exists, prune it from "
                    f"its grandfathered set: {entry}"
                )
            )

        violations: list[Violation] = []
        checked = 0
        histories: dict[str, FieldHistory] = {}
        for path in iter_migration_files(root):
            rel_path = path.relative_to(root).as_posix()
            source = path.read_text(encoding="utf-8")
            history = histories.setdefault(rel_path.split("/", 1)[0], {})
            if rel_path not in GRANDFATHERED:
                checked += 1
                violations.extend(scan_source(source, rel_path, history))
            # Grandfathered files are not linted but still define fields.
            record_fields(source, history)

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
                f"({len(GRANDFATHERED - set(stale))} grandfathered, skipped): "
                f"no non-concurrent index or constraint operations."
            )
        )
