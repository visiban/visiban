# Build every new index and constraint concurrently

<span class="vb-version" title="Added in 1.2">1.2+</span>

Build every new index and constraint with `visiban.db_operations`, so `migrate` never blocks the product.

**Why it matters:** An index or constraint added the default Django way takes an `ACCESS EXCLUSIVE` lock on its table for the *entire* build. On `cards` — the table every board read and every card move goes through — that's a full outage lasting as long as the build takes, which on a large instance with trigram indexes is minutes, not milliseconds.

**The big picture:** PostgreSQL offers a way out, and Visiban requires it. Everything below follows from the rule that `migrate` must never block the product.

!!! info "Related rules"
    This covers **index and constraint** safety only. The adjacent column rules — every new
    column nullable or defaulted, never drop a column in the migration that removes the ORM
    reference, rename = add + copy + drop across three releases — live in
    [Upgrading Visiban](../administration/upgrade.md#zero-downtime-migration-rules). They
    serve the same zero-downtime goal; only the index and constraint rules on this page are
    machine-enforced.

---

## The rule

**Every new index and every new constraint must be built concurrently.** The CI
`migration-check` job fails the pipeline otherwise.

```bash
cd backend
python manage.py check_migration_concurrency
```

The check is a syntactic scan of `backend/*/migrations/*.py`. It needs no database and will flag a migration that wouldn't even import on the current backend.

There are **five** ways to build an index or a uniqueness constraint in a Django migration, and it checks all five. Catching only the first would leave the rule trivially evadable, and that isn't hypothetical: three of the other four are already used in this repo's history, by migrations that never mention `AddIndex` at all.

| Pattern | Flagged | Example in the tree |
|---|---|---|
| `migrations.AddIndex` / `migrations.AddConstraint` | yes | `boards/0047_add_cardchecklist_card_pos_index` |
| `db_index=True` on a field in `AddField` / `AlterField` | yes | `boards/0036_cardmovement_type_and_index` |
| `unique=True` on a field in `AddField` / `AlterField` | yes | `boards/0018_add_stable_uids` |
| `AlterUniqueTogether` / `AlterIndexTogether` | yes | `boards/0043_column_unique_name_per_board` |
| raw `CREATE INDEX` in `RunSQL` / `RunPython` | yes, unless it says `CONCURRENTLY` | `boards/0030_card_trigram_search_indexes` |
| `db_index=True` / `unique=True` inside `CreateModel` | **no** | the table is new — no rows, no readers |
| `Meta.indexes` / `Meta.constraints` in `CreateModel` `options` | **no** | same reason — built with the new table (e.g. `boards/0061_add_card_external_ref`) |
| `AddIndex` under `SeparateDatabaseAndState(state_operations=...)` | **no** | state only, emits no DDL |

**Watch out:** The field-level patterns are the easiest to reach for and the easiest to miss in review. `makemigrations` generates them silently from a one-word model change, and nothing in the generated file says "index". `unique=True` in particular doesn't look like an index at all, but Django implements it as one, under the same lock. Declare the index in the model's `Meta.indexes` (or the uniqueness in `Meta.constraints`) instead, and add it concurrently.

The check also fails a migration that uses a concurrent operation without setting `atomic = False`. That combination raises `NotSupportedError` at `migrate` time. It's loud, but only once it reaches an environment that runs migrations: usually CI at the earliest and production at the worst.

---

### A NOT NULL column with a default

Use `db_default=` for a `NOT NULL` column, so the database keeps the default.

**Why it matters:** A `NOT NULL` column added with only a Python-level `default=` is safe for the rows that already exist, but not for a rolling deploy. On PostgreSQL, Django adds the column with the default and then **drops the database default** at the end of `AddField`. Old application pods keep running during the rollout, and an `INSERT` from one of them that doesn't name the new column then fails with a `NOT NULL` violation until that pod drains. Any table written on a user-facing path (signup, login, board or card creation, membership changes) is exposed.

```python
migrations.AddField(
    model_name="user",
    name="example_flag",
    field=models.BooleanField(default=False, db_default=False),
)
```

- Put the same `db_default` on the model field so `makemigrations --check` stays clean.
- A migration that has already shipped gets an additive `AlterField` rather than an edit in place.
- The `check_migration_constraint_safety` scan below accepts any `default=` and so doesn't fail on this; `migration-check` enforces it.
- The scan stays advisory by decision (#1680): its fix hint recommends `db_default=` (alongside `default=`), but it never fails a `default=`-only column.

## Adding an index

Use `AddIndexConcurrently` from `visiban.db_operations` and set `atomic = False` on the
`Migration` class.

```python
# backend/boards/migrations/00XX_add_card_due_index.py
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # Required: CREATE INDEX CONCURRENTLY cannot run inside a transaction, and Django
    # wraps every migration in one by default.
    atomic = False

    dependencies = [("boards", "0051_board_card_density")]

    operations = [
        AddIndexConcurrently(
            model_name="card",
            index=models.Index(fields=["board", "due_at"], name="card_board_due_idx"),
        ),
    ]
```

Declare the index on the model's `Meta.indexes` as usual. `makemigrations` will generate a plain `AddIndex`, and you replace it by hand with `AddIndexConcurrently`. Django has no setting that makes the autodetector emit the concurrent form, so hand-editing the generated file is the intended workflow. The CI check catches the times you forget.

---

## The rule that matters more than the syntax

**Never put a concurrent operation in the same migration as any other schema operation.**

**Why it matters:** `atomic = False` means there's no transaction, and therefore no rollback. If a later operation fails, every earlier one stays applied while Django records the migration as *not* applied. The retry re-runs the earlier operations against a database that already has them, and fails again. The migration is now wedged and has to be untangled by hand.

`boards/0024_enforce_wip_limits_and_card_index` is the shape to avoid: it combines `AddField(enforce_wip_limits)` with an `AddIndex` on `cards`. It's safe today precisely *because* it's atomic. Adding `atomic = False` to it to make the index concurrent would trade a guaranteed-atomic migration for one that can leave the column added and the migration unrecorded. Split instead: one migration for the field, and a second one (non-atomic, single operation) for the index.

### Recovering from a failed concurrent build

An interrupted `CREATE INDEX CONCURRENTLY` doesn't roll back. It leaves a real, named index in the catalog marked **`INVALID`**. The index is maintained on every write but used by no query, so the symptom is a slow database with an index that looks present. Check for it and drop it before retrying:

```bash
psql "$DATABASE_URL" -c "SELECT indexrelid::regclass AS name, indisvalid
                         FROM pg_index WHERE NOT indisvalid;"
psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY <name>;"
```

Then re-run `migrate`. A `ValidateConstraint` that fails is the same case: the constraint stays in place as `NOT VALID`, enforced for new rows but unverified for old ones. Clean up the offending rows and re-run.

---

## Adding a check constraint

`ADD CONSTRAINT` validates the whole table under `ACCESS EXCLUSIVE`. Split it: add the
constraint `NOT VALID` (a catalog-only change, so the exclusive lock is held for microseconds),
then validate it in a second step under the much weaker `SHARE UPDATE EXCLUSIVE`, which
readers and writers don't block on.

```python
from django.db import migrations, models

from visiban.db_operations import AddConstraintNotValid, ValidateConstraint


class Migration(migrations.Migration):
    atomic = False  # the two steps must land in separate transactions

    dependencies = [("boards", "0051_board_card_density")]

    operations = [
        AddConstraintNotValid(
            model_name="card",
            constraint=models.CheckConstraint(
                condition=models.Q(position__gte=0), name="card_position_non_negative"
            ),
        ),
        ValidateConstraint(model_name="card", name="card_position_non_negative"),
    ]
```

**Watch out:** `atomic = False` isn't optional here. Run both operations inside one transaction and the brief `ACCESS EXCLUSIVE` from step one is held until commit, across the whole validation scan. That is precisely the outage the split exists to avoid.

A `NOT VALID` constraint is enforced for new and updated rows immediately; only the scan of pre-existing rows is deferred. If the validation step fails, the constraint stays in place as `NOT VALID` and the fix is a data cleanup followed by a re-run.

---

## Adding a unique constraint

`NOT VALID` isn't accepted for unique constraints — PostgreSQL has no way to defer a
uniqueness check. The safe path builds a unique *index* concurrently and then attaches a
constraint to it, which is a catalog-only operation:

```python
from django.db import migrations, models

SQL_FORWARD = """
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS card_board_slug_uniq
    ON cards (board_id, slug);
ALTER TABLE cards
    ADD CONSTRAINT card_board_slug_uniq UNIQUE USING INDEX card_board_slug_uniq;
"""


def forward(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(SQL_FORWARD)


def backward(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("ALTER TABLE cards DROP CONSTRAINT IF EXISTS card_board_slug_uniq;")


class Migration(migrations.Migration):
    atomic = False

    dependencies = [("boards", "0051_board_card_density")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            # State-only: tells the ORM the constraint exists so makemigrations stays
            # quiet. It emits no DDL and takes no lock, which is why the CI check does
            # not flag AddConstraint here.
            state_operations=[
                migrations.AddConstraint(
                    model_name="card",
                    constraint=models.UniqueConstraint(
                        fields=["board", "slug"], name="card_board_slug_uniq"
                    ),
                ),
            ],
        ),
        migrations.RunPython(forward, backward),
    ]
```

Migration `0030_card_trigram_search_indexes` uses this same `SeparateDatabaseAndState` shape
for its GIN indexes; read it for a worked example already in the tree.
When the uniqueness only has to hold for non-null values, a *partial* `UniqueConstraint`
(`condition=Q(col__isnull=False)`) is simpler: Django implements it as a unique index on
every backend, so the `ALTER TABLE ... ADD CONSTRAINT ... USING INDEX` step drops out.
`boards/0089_board_share_token_hash_uniq` is the worked example. It drops a leftover
index of the same name before the build, because a failed `CREATE INDEX CONCURRENTLY` leaves
an `INVALID` index that `IF NOT EXISTS` would skip. On SQLite it calls
`schema_editor.add_constraint` / `remove_constraint`, so test databases there enforce the
constraint and can still migrate backward.

---

## Adding a foreign key

A foreign key is a constraint, and PostgreSQL validates a constraint — scanning the
referencing column against the referenced table — while holding a lock on *both* tables for
the length of the scan. Everything above already covers this for a `CheckConstraint`. A
`ForeignKey` needs its own recipe because `AddConstraintNotValid` explicitly rejects
anything that isn't a `CheckConstraint`:

```pycon
>>> AddConstraintNotValid(model_name="card", constraint=models.UniqueConstraint(...))
TypeError: AddConstraintNotValid.constraint must be a check constraint.
```

`check_migration_concurrency` doesn't look at foreign-key validation either way — see
below — so which recipe applies is a judgment call the check can't make for you. It comes
down to whether the column being constrained already holds data.

### A new, nullable column on an existing table

If the column is brand new, every row gets `NULL` the instant it's added, and PostgreSQL
doesn't validate a foreign key against a `NULL` — there's nothing for the constraint to
check. A plain `AddField` is safe inline, constraint included:

```python
# backend/boards/migrations/00XX_card_reviewer.py
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0051_board_card_density"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="card",
            name="reviewer",
            field=models.ForeignKey(
                blank=True,
                db_index=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
```

`boards/0044_cardchecklist_created_by` and `accounts/0031_user_pending_email_address`
(#1273) are the precedents in the tree — both add a nullable `ForeignKey` to an existing
table in one plain `AddField`, no `NOT VALID` split needed.

`db_index=False` is the part worth not skipping. `ForeignKey` builds a b-tree index on the
column by default — same as an explicit `db_index=True` on any other field — and that index
build *does* scan the whole table under `ACCESS EXCLUSIVE`, whether the new column's values
are `NULL` or not; only the constraint validation is free for a new column, not the index
build. `accounts/0031` splits it out for exactly this reason: `db_index=False` here, then a
separate `AddIndexConcurrently` in `accounts/0032_user_pending_email_addr_idx`. Follow that
shape for new work — `boards/0044` predates the split and left its default index inline,
which was only harmless because `cardchecklist` was small at the time.

### A foreign key on a column that already holds data

Once the column already has real, non-`NULL` values — an existing plain integer column being
turned into a proper `ForeignKey`, or a nullable one already backfilled with real
references — PostgreSQL can't skip the scan, and a plain `AddField` / `AlterField` /
`AddConstraint` validates the whole table under `ACCESS EXCLUSIVE` for as long as the scan
takes. The safe path is the same shape as a check constraint — add `NOT VALID`, validate
later, under a weaker lock — but reached by hand, because there's no
`AddConstraintNotValid` for a `ForeignKey`:

```python
# backend/boards/migrations/00XX_card_reviewer_fk_not_valid.py
from django.db import migrations


def add_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    # NOT VALID is catalog-only: it takes ACCESS EXCLUSIVE, but only long enough to
    # write the constraint, not to scan `cards`.
    schema_editor.execute(
        "ALTER TABLE cards "
        "ADD CONSTRAINT card_reviewer_id_fk_users_id "
        "FOREIGN KEY (reviewer_id) REFERENCES users (id) "
        "NOT VALID"
    )


def drop_not_valid(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(
        "ALTER TABLE cards DROP CONSTRAINT IF EXISTS card_reviewer_id_fk_users_id"
    )


class Migration(migrations.Migration):

    dependencies = [("boards", "0051_board_card_reviewer_backfilled")]

    operations = [
        # The field itself must already declare db_constraint=False (see below) so
        # Django never tries to add its own FK constraint on top of this one.
        migrations.RunPython(add_not_valid, drop_not_valid),
    ]
```

```python
# backend/boards/migrations/00XX_card_reviewer_fk_validate.py
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

from visiban.db_operations import ValidateConstraint


class Migration(migrations.Migration):
    # ValidateConstraint scans the whole table; running it inside the default
    # transaction would hold the constraint's ACCESS EXCLUSIVE catalog lock until
    # commit, across the whole scan — the same reasoning as the check-constraint pair
    # above.
    atomic = False

    dependencies = [("boards", "0052_card_reviewer_fk_not_valid")]

    operations = [
        # ValidateConstraint only needs the table and the constraint name — it has no
        # opinion on what kind of constraint it is, so the same wrapper used for
        # check constraints works here unmodified.
        ValidateConstraint(model_name="card", name="card_reviewer_id_fk_users_id"),
        # database_operations=[] on purpose: the constraint already exists in the
        # database from the NOT VALID migration. This only tells Django's state that
        # the field is now backed by a real DB constraint, so a future
        # makemigrations does not try to add one.
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="card",
                    name="reviewer",
                    field=models.ForeignKey(
                        blank=True,
                        db_constraint=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
        ),
    ]
```

The field itself must carry `db_constraint=False` from the moment the column is added (and
until the validate migration above flips it back) — that's what stops Django's own
`AddField`/`AlterField` from emitting a second, competing `FOREIGN KEY` clause on top of the
one added by hand. `db_constraint=False` doesn't remove `on_delete` behavior at the Python
level; it only means PostgreSQL isn't enforcing it, which is exactly the gap the `NOT VALID`
migration closes.

**Neither checker flags the `RunPython` in the first migration.**
`check_migration_concurrency`'s raw-SQL scan only matches `CREATE INDEX` text
(`RAW_CREATE_INDEX`), never `ADD CONSTRAINT`, so an `ALTER TABLE ... ADD CONSTRAINT ...
FOREIGN KEY ... NOT VALID` inside `RunPython`/`RunSQL` needs no `# concurrency-exempt:`
comment — the checker has no rule that would fire on it in the first place.
`check_migration_constraint_safety` doesn't scan raw SQL string content at all, so it's
silent on that migration too.

**The second migration doesn't get the same protection a check constraint's does — verify
this shape against `check_migration_constraint_safety.py` yourself before trusting it.**

- `ValidateConstraint` is the operation the checker watches for a `CheckConstraint`, by name, regardless of what kind of constraint it validates.
- It's exempted whenever the migration's own `dependencies` names another migration, in the same app, whose operations list contains a top-level `RunPython`/`RunSQL` (the "adjacent migration" rule: a migration depending on a dedicated repair migration is assumed already safe). The exemption checks only that such an operation exists in the dependency, never what it does.
- Migration 1 above *is* a top-level `RunPython` (it just adds a constraint instead of repairing a row), and migration 2 depends on it directly. So this recipe's shape trips the exemption every time: `ValidateConstraint` in migration 2 is silently waved through whether or not `reviewer_id` holds a single orphaned reference.
- Writing migration 1 as `RunSQL` makes no difference; the checker treats the two names identically.

This is a genuine gap in the checker, not a design choice. There's no way to add a hand-written `NOT VALID` constraint without a `RunPython`/`RunSQL` operation to carry it, so the gap is unavoidable with this recipe. Restructuring the migrations doesn't fix it.

**Watch out:** Judge the need for a repair step as if the check were turned off. If `reviewer_id` could hold a value that doesn't point at an existing row (data written before an application-level guard existed, a row deleted out from under a reference, anything restored from an old backup), add a real `RunPython` repair step ahead of `ValidateConstraint` before relying on it. CI won't catch a missing one here.

The `# constraint-safe:` comment convention used elsewhere on this page doesn't help either. The adjacent-migration exemption suppresses the violation before the scanner reaches the point where it would look for that comment, so writing one on `ValidateConstraint` in migration 2 has no effect.

`VALIDATE CONSTRAINT` itself takes `SHARE UPDATE EXCLUSIVE`, the same weak lock a check constraint's validation takes. That's the whole reason the two-step split is worth doing.

### Teaching the checker to see this

Optional follow-up, out of scope for this page:

- `check_migration_concurrency` could flag an `AddField`/`AlterField` that adds a
  `ForeignKey` with `db_constraint` left at its default (`True`) against an app's
  non-initial migration, the same way it already flags `db_index=True`.
- `check_migration_constraint_safety`'s adjacent-migration exemption can't tell a genuine
  data-repair `RunPython` from a schema-only one like the `NOT VALID` step above — both
  satisfy `has_top_level_repair()` by name alone. Narrowing that exemption would need the
  scanner to look at what the dependency's `RunPython`/`RunSQL` does, not just that
  one exists, which the rest of both checkers deliberately avoid doing (see "The scan does
  not verify a repair step touches the *right* rows" above) — so this is a real trade-off to
  work out, not a one-line fix.

No issue is currently filed for either; file one before picking either up rather than
inferring scope from this paragraph.

### Changing an existing foreign key's nullability

A plain `AlterField` that only adds `null=True` to a `ForeignKey` looks catalog-only, and it
isn't. Django's schema editor drops and re-adds the foreign key constraint whenever any
database-relevant attribute of the field changes, and `null` is one (`on_delete` isn't —
it emits no SQL). `sqlmigrate` shows the full sequence:

```sql
ALTER TABLE "card_movements" DROP CONSTRAINT "card_movements_card_id_..._fk_cards_id";
ALTER TABLE "card_movements" ALTER COLUMN "card_id" DROP NOT NULL;
ALTER TABLE "card_movements" ADD CONSTRAINT "..." FOREIGN KEY ("card_id") REFERENCES "cards" ("id") DEFERRABLE INITIALLY DEFERRED;
```

The re-`ADD` validates every row against the referenced table, holding `ACCESS EXCLUSIVE` on
the referencing table (the migration is atomic) and `SHARE ROW EXCLUSIVE` on the referenced
one for the whole scan. Neither checker flags it yet (#1798).

The change that's needed is only `ALTER COLUMN ... DROP NOT NULL`, which is
catalog-only and leaves the existing constraint in place. `boards/0079_cardmovement_card_nullable`
(#1469) is the precedent: a small `AlterField` subclass whose PostgreSQL `database_forwards`
runs only that statement and whose state change is the inherited `AlterField`'s, so
`makemigrations --check` stays clean. Other backends fall through to the normal path (SQLite
rebuilds the table, which is fine locally). Its `database_backwards` refuses while any row
holds `NULL`, rather than deleting data to restore `NOT NULL`. Confirm the result with
`python manage.py sqlmigrate <app> <migration>` against PostgreSQL: the output should be the
single `DROP NOT NULL`.

---

## SQLite

Visiban supports a SQLite configuration for local development and small single-user installs,
and those installs run `migrate` too. Every operation in `django.contrib.postgres.operations`
emits PostgreSQL-only SQL with no vendor guard, so importing them directly would make the
migration un-runnable there.

`visiban.db_operations` exists for exactly this. Each wrapper keeps the `CONCURRENTLY` /
`NOT VALID` path on PostgreSQL and falls back to the plain operation elsewhere — harmless,
because SQLite takes a whole-database lock for any DDL regardless and those installs have no
concurrent traffic to protect. **Always import from `visiban.db_operations`, never from
`django.contrib.postgres.operations` directly.**

Hand-written `RunSQL` / `RunPython` DDL must carry its own
`schema_editor.connection.vendor != "postgresql"` guard, as in the unique-constraint example
above.

---

## The escape hatch

Some tables genuinely don't need the ceremony — most often a table created in the same
migration, which no session can be reading yet. Add an inline comment naming the reason:

```python
operations = [
    migrations.CreateModel(name="CardReminder", fields=[...]),
    # concurrency-exempt: table created in this same migration, no rows and no readers
    migrations.AddIndex(
        model_name="cardreminder",
        index=models.Index(fields=["card", "remind_at"], name="reminder_card_at_idx"),
    ),
]
```

The comment must sit on the operation's own line or within the four lines above it. The reason after the colon is mandatory: a bare `# concurrency-exempt:` still fails the check. The reason lets the next reader see why the lock was acceptable without re-deriving it.

---

## Constraint safety on populated tables

Everything above is about how long a lock is held. This section is about a different
failure: an operation that validates every existing row and **fails outright** if one of
them doesn't comply. A migration that adds a `CheckConstraint`, makes an existing column
`NOT NULL`, or turns on `unique=True` doesn't degrade gracefully when a row disagrees — the
migration partially applies, the deploying pod's migrate step errors, health checks fail, and
the deploy is stuck in a crash-loop until someone intervenes by hand. That is a worse outcome
than a migration that refuses to run (#1098).

The CI `migration-check` job also fails the pipeline for this:

```bash
cd backend
python manage.py check_migration_constraint_safety
```

It's a second, independent scan alongside `check_migration_concurrency` — same syntactic
AST approach, same job, different rule. The two overlap in which operations they watch but
not in what they check: `check_migration_concurrency` asks "how long is the lock held",
this one asks "can this fail against the data that is already there". A migration can pass
one and fail the other. In particular, `AddConstraintNotValid` (the concurrency-safe half of
the #1081 pattern) never fails against existing data — that's what `NOT VALID` means — but
the `ValidateConstraint` that must follow it still scans the whole table and fails exactly
the way a plain `AddConstraint` would. This check watches `ValidateConstraint`, not
`AddConstraintNotValid`, for that reason.

| Pattern | Flagged | Why |
|---|---|---|
| `migrations.AddConstraint` | yes | validates every row when applied |
| `visiban.db_operations.ValidateConstraint` | yes | the deferred half of the NOT VALID pair still scans every row |
| `AlterUniqueTogether` / `AlterIndexTogether` | yes | rebuilds the table's unique index, fails on any duplicate |
| `AddField` with no `null=True`, no `default=` and no `db_default=` | yes | Django can't add the column to a populated table with nothing to put in existing rows |
| `AlterField` with explicit `null=False` | yes | making an existing column NOT NULL fails if any row is still NULL |
| `AddField` / `AlterField` with `unique=True` | yes, with one exception below | fails on any pre-existing duplicate value |
| `AddField` with `unique=True` **and** `null=True` | **no** | PostgreSQL doesn't treat NULL as equal to NULL, so a unique index over a nullable brand-new column never rejects a pre-existing row — every one of them just gets NULL (`boards/0034_board_share_token`, `groups/0010_hash_group_invite_token` are this exact shape) |
| `AddConstraintNotValid` on its own | **no** | `NOT VALID` defers the scan; nothing fails yet |
| any of the above on a table created earlier in the same migration | **no** | a table with no rows can't have a violating row — not an escape-hatch case, correct behavior |
| any of the above under `SeparateDatabaseAndState(state_operations=...)` | **no** | state-only, emits no DDL |
| `db_index=True` | **no** | a plain index never rejects a row — that risk is #1081's lock-duration concern, not a data-validity one |

### The rule

Any flagged operation must be preceded by a data-repair step — a `RunPython` (or `RunSQL`)
that removes or fixes whatever rows would otherwise violate it. "Preceded" means one of two
things:

1. **Same migration** — an earlier element of the same migration's `operations` list is a
   `RunPython` / `RunSQL` step. `boards/0018_add_stable_uids` and
   `boards/0043_column_unique_name_per_board` are the worked examples already in the tree:
   both backfill or deduplicate before the operation that would otherwise fail.
2. **An adjacent migration in the same MR** — the migration's own `dependencies` names
   another migration, in the same app, whose operations are themselves a repair step.
   `accounts/0021_unique_username_ci` depends directly on
   `accounts/0020_resolve_ci_username_collisions`, a dedicated `RunPython` migration that
   renames every colliding username before the unique constraint is added. The check reads
   the dependency graph to confirm this, not just the file in front of it.

The scan doesn't verify a repair step touches the *right* rows — same coarseness
`check_migration_concurrency` accepts for its own "is this concurrent" question —
it only confirms one exists in the right place. Requiring *some* explicit repair step there
is the point; auditing that the repair is correct is still a human review job.

### The escape hatch

Some operations are safe for reasons the scan can't see — most commonly, a constraint whose
default values make every pre-existing row comply without any repair step at all. Add an
inline comment naming the reason:

```python
operations = [
    # constraint-safe: verified against a prod snapshot — no row violates this today
    migrations.AddConstraint(
        model_name="card",
        constraint=models.CheckConstraint(
            condition=models.Q(position__gte=0), name="card_position_non_negative"
        ),
    ),
]
```

Same convention as `# concurrency-exempt:` — the comment must sit on the operation's own
line or within the four lines above it, and the reason after the colon is mandatory.

`groups/0014_group_invite_link_used_at_constraint` is the real example this covers: its
`CheckConstraint` requires `single_use=True OR used_at IS NULL`, and both columns were added
by the immediately preceding migration with defaults of `False` / `NULL` — every
pre-existing row already satisfies the constraint by construction, but that fact lives in a
field default the scanner never inspects. It predates this check and is grandfathered by
filename in `GRANDFATHERED` rather than commented in place, for the same reason #1081's
fourteen are: the migration is already applied everywhere, and editing applied history to
add a comment is a needless risk for a file nobody will hand-author again.
`accounts/migrations/0002_user_display_name.py` is grandfathered alongside it — a genuinely
unsafe `AddField`, but from `accounts`' second-ever migration, applied only ever against an
empty `users` table on every install that has run it, including every fresh install today.

### `--self-test`

Every bespoke gate script ships a self-test that proves it still fires (#1093):

```bash
python manage.py check_migration_constraint_safety --self-test
```

It runs the scanner against known-bad and known-good fixture migrations built in memory —
no files touched, no database, no real migration tree — and fails if a known-bad fixture is
not caught or a known-good one is. CI runs it immediately before the real scan, in the same
`migration-check` job, so a regression in the rule itself is caught before it has a chance to
pass a real migration through undetected.

---

## The pre-#1081 migrations — decision and reasoning

Fourteen migrations predate this rule and build an index or constraint with a lock. #1081
originally named eight. The other six surfaced only as the check grew past `AddIndex` — three
when it learned to see `db_index=True` and raw SQL, and three more when it learned to see
`unique=True` and `AlterUniqueTogether`. Each widening found more, which is the argument
against every narrower version of this check, including the one the issue originally asked
for.

| Migration | What it adds | Table | How |
|---|---|---|---|
| `accounts/0021_unique_username_ci` | `UniqueConstraint` on `Lower(username)` | `users` | `AddConstraint` |
| `accounts/0022_add_can_access_all_content_index` | partial index | `users` | `AddIndex` |
| `boards/0018_add_stable_uids` | five unique indexes | `boards`, `columns`, `swimlanes`, `labels`, `cards` | `unique=True` |
| `boards/0019_add_card_archived_at` | index on a new column | `cards` | `db_index=True` |
| `boards/0024_enforce_wip_limits_and_card_index` | `AddField` + composite index | `cards` | `AddIndex` |
| `boards/0030_card_trigram_search_indexes` | two trigram GIN indexes | `cards` | raw SQL |
| `boards/0034_board_share_token` | unique index on a new column | `boards` | `unique=True` |
| `boards/0036_cardmovement_type_and_index` | index on an existing column | `card_movements` | `db_index=True` |
| `boards/0038_add_notification_cardmovement_indexes` | two indexes | `card_movements`, `notifications` | `AddIndex` |
| `boards/0043_column_unique_name_per_board` | `unique_together` | `columns` | `AlterUniqueTogether` |
| `boards/0045_add_activity_comment_composite_indexes` | two composite indexes | `card_comments`, `card_activities` | `AddIndex` |
| `boards/0047_add_cardchecklist_card_pos_index` | composite index | `card_checklist_items` | `AddIndex` |
| `groups/0010_hash_group_invite_token` | index on a new column | `group_invite_links` | `db_index=True` |
| `groups/0014_group_invite_link_used_at_constraint` | `CheckConstraint` | `group_invite_links` | `AddConstraint` |

**Decision: all fourteen are left exactly as they are, and are permanently exempted from the
CI check by name** (the `GRANDFATHERED` set in
`backend/boards/management/commands/check_migration_concurrency.py`). They are listed
individually rather than filtered by migration number, so the exemption can only shrink.

The reasoning, because this is the part worth not re-litigating:

The alternative that was considered and rejected was editing
`boards/0030_card_trigram_search_indexes` **in place** — it's already raw SQL with
`IF NOT EXISTS`, so adding `CONCURRENTLY` and `atomic = False` is nearly a two-word change,
and it's the slowest build in the tree. It's declined on the grounds in the `0030` paragraph
below. Should a future release want to revisit it, that's a deliberate decision to edit
applied history and needs its own issue and its own sign-off — not a quiet amendment here.

**Re-issuing them as new concurrent migrations helps nobody.** An install that has already
applied `0038` won't apply it again; a new `0052` that rebuilds the same index would be a
no-op for them and pure churn for everyone else. Re-issuing only pays off if the *original* is
also neutered — which means editing applied history.

**Editing applied history is worse than the problem.** It makes migration `0038` mean two
different things depending on when you installed, which is the kind of difference that makes a
support conversation unfalsifiable. And `0024` in particular combines `AddField` with
`AddIndex`: adding `atomic = False` to it would trade a guaranteed-atomic migration for one
that can leave the column added while Django records the migration as unapplied, breaking the
retry. That is a real regression imposed on every normal upgrade to buy a benefit in a rare
one.

**`0030` is the one worth arguing about, and it still loses.** Its trigram GIN indexes on
`cards` are by far the slowest build in the tree, and unlike the others it's already
raw-SQL-with-`IF NOT EXISTS`, so switching it to `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
would be a two-word edit. The argument against is the interaction between those two clauses: a
`CONCURRENTLY` build that's interrupted leaves an **INVALID** index behind — present in the
catalog, used by no query — and `IF NOT EXISTS` would then skip recreating it on the retry.
The current idempotency, which is the whole reason that migration was written the way it was,
would start silently hiding a broken index. Trading a loud lock for a quiet wrong answer is
the wrong trade.

**Fresh installs never pay this cost at all.** They apply the whole chain against empty tables,
before the instance serves any traffic: the lock is real and contended by nobody.

**The population that pays is narrow, and has a better remedy.** It's the operator
restoring a large pre-1.1 dump into a 1.2 binary and then running `migrate` to catch up — a
deliberate, offline maintenance operation. For them the answer isn't a code change but a
procedure: build the index by hand first, then tell Django it's done.

```bash
# 1. Build the index concurrently, with the application still serving traffic.
psql "$DATABASE_URL" -c "CREATE INDEX CONCURRENTLY checklist_card_pos_idx
                         ON card_checklist_items (card_id, position);"

# 2. Confirm it is valid — an interrupted CONCURRENTLY build leaves an INVALID index
#    that serves no queries.
psql "$DATABASE_URL" -c "SELECT indisvalid FROM pg_index
                         WHERE indexrelid = 'checklist_card_pos_idx'::regclass;"

# 3. Record the migration as applied without re-running its DDL.
python manage.py migrate boards 0047 --fake
```

Use the exact index name and definition from the migration — `--fake` tells Django the schema
matches, and it's on you to make that true.

!!! danger "`--fake` marks the whole migration applied, not just the index"
    `boards/0047` is used here because its **only** operation is the index. The procedure is
    only safe for a migration like that.

    `boards/0024` is the counter-example, and the trap: it bundles
    `AddField(board.enforce_wip_limits)` with its `AddIndex`. Building only the index by hand
    and then faking `0024` would leave Django believing `enforce_wip_limits` exists when the
    column doesn't — and the first card move that consults a WIP limit fails with
    `ProgrammingError: column "enforce_wip_limits" does not exist`. Before faking any
    migration, read it and hand-apply **every** operation in it, not just the one you came
    for. It's the same reason new migrations must never combine a concurrent operation with
    anything else.

This procedure is the reason
[#860's upgrade playbook](../administration/upgrade.md#zero-downtime-migration-rules) can
describe a genuine zero-downtime path across the whole migration history, including the
fourteen above, without any of them changing.

**Everything after #1081 is concurrent by construction**, so the exemption list doesn't grow.

---

## Known gaps in the 1.1 to 1.2 migrations

Found by the 1.2 pre-release audit (#1662). The shipped migrations weren't edited, because
installs have already run them; these are documented instead.

- **Foreign keys are not flagged by the concurrency checker.** `accounts/0031` adds a nullable
  FK (`pending_email_address`). Even with `db_index=False`, PostgreSQL emits
  `ADD CONSTRAINT ... FOREIGN KEY`, which takes `SHARE ROW EXCLUSIVE` on `users` and
  `account_emailaddress` briefly. With every row `NULL` this is fast. For future FKs on large
  tables use the `NOT VALID` then `VALIDATE` pattern above.
- **`RunPython` UPDATE shares a transaction with `ADD COLUMN`.** `accounts/0030` updates
  `users` in the same transaction as its column additions, so the UPDATE runs while
  `ACCESS EXCLUSIVE` is held. (`accounts/0036` is a standalone `RunPython` with no schema
  change; it only row-locks superuser rows, which is negligible.) Fine for typical sizes; see the
  [upgrade guide](../administration/upgrade.md#upgrading-to-12x) for large installs.
- **`boards/0054` overwrites system template columns** by slug, and its reverse restores
  constants rather than prior database values. See the upgrade guide.
- **`accounts/0033` has an unneeded dependency** on `boards/0061` and `auth/0012` (an
  autodetector artifact). Remove it at the next squash; don't edit it now.
- **Frozen history:** the duplicate `boards/0033` (merged by `0035`) and the missing
  `boards/0053` aren't to be renumbered.
- **allauth pin:** `accounts/0031` and `0033` depend on allauth's
  `account.0009_emailaddress_unique_primary_email`. 1.1.0 and 1.2 both pin
  `django-allauth==65.14.3`, which ships it;
  `accounts/tests/test_migration_upgrade_path_1662.py` fails if a pin change drops it.

---

## When migrations are squashed

`squashmigrations` reproduces historical operations into a new file, under a name that isn't
in the grandfathered set — so a squash that absorbs any of the fourteen above would otherwise
surface them as brand-new violations. The check therefore **skips any migration whose
`Migration` class defines `replaces`**, which is exactly the set of squashed migrations.

Visiban has never run `squashmigrations`, so this path is reasoned about rather than observed.
The first time it runs:

1. Verify the check still passes and that the squashed file was skipped for the right reason
   (`replaces` present), not because the detection silently missed its operations.
2. Prune the now-deleted filenames from `GRANDFATHERED`. The command prints a warning naming
   each grandfathered entry that no longer exists on disk, so it tells you which.
3. Re-check any operation the squash *added* rather than absorbed — those are new, and the
   `replaces` skip would hide them.
