"""Tests for the constraint-safety migration scanner (#1098).

Companion to ``test_migration_concurrency.py`` (#1081) — same shape, different rule.
This one is not about lock duration; it is about whether a constraint-adding operation
can fail outright against rows that already exist.
"""

import textwrap
from io import StringIO
from pathlib import Path
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from boards.management.commands.check_migration_constraint_safety import (
    EXEMPT_MARKER,
    GRANDFATHERED,
    _dependencies,
    has_top_level_repair,
    scan_source,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]


class ScannerTests(SimpleTestCase):
    """Unit tests for the AST scan behind `manage.py check_migration_constraint_safety`."""

    def _scan(self, source, adjacent_has_repair=False):
        return scan_source(
            textwrap.dedent(source),
            "boards/migrations/0099_x.py",
            adjacent_has_repair=adjacent_has_repair,
        )

    def test_flags_add_constraint_with_no_repair_step(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
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
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])

    def test_flags_validate_constraint_with_no_repair_step(self):
        # The NOT VALID half of #1081's own pattern never fails against existing data —
        # ValidateConstraint is where the deferred scan actually happens.
        findings = self._scan(
            """
            from django.db import migrations, models

            from visiban.db_operations import AddConstraintNotValid, ValidateConstraint

            class Migration(migrations.Migration):
                atomic = False
                operations = [
                    AddConstraintNotValid(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                    ValidateConstraint(model_name="card", name="x_chk"),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["ValidateConstraint"])

    def test_add_constraint_not_valid_alone_is_never_flagged(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            from visiban.db_operations import AddConstraintNotValid

            class Migration(migrations.Migration):
                atomic = False
                operations = [
                    AddConstraintNotValid(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_flags_alter_field_explicit_null_false(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterField(
                        model_name="card",
                        name="uid",
                        field=models.CharField(max_length=16, null=False),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterField(null-false)"])

    def test_ignores_alter_field_that_never_mentions_null(self):
        # Django omits `null` from the generated kwargs whenever it equals the field's
        # default (False) — an AlterField with no `null` kwarg at all is just as likely to
        # be an unrelated change (max_length, help_text, ...) as a real transition, so
        # flagging it would make this fire on ordinary field edits throughout the tree.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterField(
                        model_name="card",
                        name="title",
                        field=models.CharField(max_length=300),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_flags_add_field_not_nullable_with_no_default(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="card",
                        name="priority",
                        field=models.IntegerField(),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddField(not-null)"])

    def test_add_field_nullable_is_never_flagged(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="card",
                        name="archived_at",
                        field=models.DateTimeField(null=True),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_add_field_with_a_default_is_never_flagged_for_nullability(self):
        # Django backfills every existing row with the constant default as part of the
        # same ADD COLUMN statement — there is nothing left to fail against.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="card",
                        name="priority",
                        field=models.IntegerField(default=0),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_add_field_unique_and_nullable_is_safe(self):
        # PostgreSQL does not consider NULL equal to NULL, so a unique index over a
        # nullable brand-new column never rejects a pre-existing row (boards/0034,
        # groups/0010 in this repo's real history — both are this exact shape).
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="board",
                        name="share_token",
                        field=models.UUIDField(default=None, null=True, unique=True),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_add_field_unique_and_not_nullable_is_flagged(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddField(
                        model_name="board",
                        name="slug",
                        field=models.CharField(max_length=32, default="x", unique=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddField(unique=True)"])

    def test_alter_field_unique_is_always_flagged_regardless_of_null(self):
        # Unlike AddField, the column already holds real historical values — nullability
        # going forward says nothing about whether two of those already collide.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterField(
                        model_name="card",
                        name="uid",
                        field=models.CharField(max_length=16, null=True, unique=True),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterField(unique=True)"])

    def test_flags_alter_unique_together(self):
        findings = self._scan(
            """
            from django.db import migrations

            class Migration(migrations.Migration):
                operations = [
                    migrations.AlterUniqueTogether(
                        name="column",
                        unique_together={("board", "name")},
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AlterUniqueTogether"])

    def test_preceding_run_python_in_same_migration_clears_the_finding(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            def repair(apps, schema_editor):
                pass

            class Migration(migrations.Migration):
                operations = [
                    migrations.RunPython(repair, migrations.RunPython.noop),
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_run_python_after_the_risky_op_does_not_retroactively_clear_it(self):
        # Ordering matters: a repair step that runs after the constraint is added was too
        # late to prevent the constraint validation from failing.
        findings = self._scan(
            """
            from django.db import migrations, models

            def repair(apps, schema_editor):
                pass

            class Migration(migrations.Migration):
                operations = [
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                    migrations.RunPython(repair, migrations.RunPython.noop),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])

    def test_ignores_operation_on_a_table_created_in_the_same_migration(self):
        # Not an escape-hatch case — a table with no rows yet cannot have a violating row.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(name="Widget", fields=[]),
                    migrations.AddConstraint(
                        model_name="widget",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_new_table_exemption_does_not_apply_to_a_different_model(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.CreateModel(name="Widget", fields=[]),
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])

    def test_ignores_state_only_operations(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    migrations.SeparateDatabaseAndState(
                        database_operations=[],
                        state_operations=[
                            migrations.AddConstraint(
                                model_name="card",
                                constraint=models.UniqueConstraint(
                                    fields=["board", "slug"], name="x_uniq"
                                ),
                            ),
                        ],
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_squashed_migrations_are_not_relinted(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                replaces = [("boards", "0024_enforce_wip_limits_and_card_index")]
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
        self.assertEqual(findings, [])

    def test_inline_exemption_with_a_reason_suppresses_the_finding(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    # {EXEMPT_MARKER} verified against a prod snapshot, no violating rows
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual(findings, [])

    def test_bare_exemption_marker_without_a_reason_still_fails(self):
        findings = self._scan(
            f"""
            from django.db import migrations, models

            class Migration(migrations.Migration):
                operations = [
                    # {EXEMPT_MARKER}
                    migrations.AddConstraint(
                        model_name="card",
                        constraint=models.CheckConstraint(
                            condition=models.Q(position__gte=0), name="x_chk"
                        ),
                    ),
                ]
            """
        )
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])

    def test_adjacent_has_repair_clears_a_migration_with_no_local_repair_step(self):
        # accounts/0021_unique_username_ci's real shape: the constraint migration itself
        # has no RunPython, but it depends directly on accounts/0020, a dedicated repair
        # migration. `adjacent_has_repair` is how the caller tells the scanner that.
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                dependencies = [("accounts", "0020_resolve_ci_username_collisions")]
                operations = [
                    migrations.AddConstraint(
                        model_name="user",
                        constraint=models.UniqueConstraint(
                            fields=["username"], name="unique_username_ci"
                        ),
                    ),
                ]
            """,
            adjacent_has_repair=True,
        )
        self.assertEqual(findings, [])

    def test_without_adjacent_has_repair_the_same_migration_is_flagged(self):
        findings = self._scan(
            """
            from django.db import migrations, models

            class Migration(migrations.Migration):
                dependencies = [("accounts", "0020_resolve_ci_username_collisions")]
                operations = [
                    migrations.AddConstraint(
                        model_name="user",
                        constraint=models.UniqueConstraint(
                            fields=["username"], name="unique_username_ci"
                        ),
                    ),
                ]
            """,
            adjacent_has_repair=False,
        )
        self.assertEqual([f.operation for f in findings], ["AddConstraint"])


class DependencyAndRepairHelperTests(SimpleTestCase):
    """Unit tests for the two helpers `handle()` uses to build the adjacency map."""

    def test_dependencies_reads_literal_tuples(self):
        tree = __import__("ast").parse(
            textwrap.dedent(
                """
                from django.db import migrations

                class Migration(migrations.Migration):
                    dependencies = [
                        ("boards", "0020_x"),
                        ("accounts", "0005_y"),
                    ]
                    operations = []
                """
            )
        )
        self.assertEqual(
            _dependencies(tree), [("boards", "0020_x"), ("accounts", "0005_y")]
        )

    def test_dependencies_skips_swappable_dependency(self):
        tree = __import__("ast").parse(
            textwrap.dedent(
                """
                from django.conf import settings
                from django.db import migrations

                class Migration(migrations.Migration):
                    dependencies = [
                        ("groups", "0013_x"),
                        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
                    ]
                    operations = []
                """
            )
        )
        self.assertEqual(_dependencies(tree), [("groups", "0013_x")])

    def test_has_top_level_repair_true_for_a_pure_runpython_migration(self):
        tree = __import__("ast").parse(
            textwrap.dedent(
                """
                from django.db import migrations

                def repair(apps, schema_editor):
                    pass

                class Migration(migrations.Migration):
                    dependencies = []
                    operations = [migrations.RunPython(repair, migrations.RunPython.noop)]
                """
            )
        )
        self.assertTrue(has_top_level_repair(tree))

    def test_has_top_level_repair_false_for_a_plain_add_field(self):
        tree = __import__("ast").parse(
            textwrap.dedent(
                """
                from django.db import migrations, models

                class Migration(migrations.Migration):
                    dependencies = []
                    operations = [
                        migrations.AddField(
                            model_name="groupinvitelink",
                            name="single_use",
                            field=models.BooleanField(default=False),
                        ),
                    ]
                """
            )
        )
        self.assertFalse(has_top_level_repair(tree))


class CheckCommandTests(SimpleTestCase):
    def test_repository_baseline_is_clean(self):
        """Every migration outside the grandfathered set is already constraint-safe.

        This is the regression guard: it fails the moment somebody adds an unsafe
        constraint-adding migration without a repair step or an exemption comment.
        """
        out, err = StringIO(), StringIO()
        call_command("check_migration_constraint_safety", stdout=out, stderr=err)
        self.assertIn("no unsafe constraint operations found", out.getvalue())
        self.assertEqual(err.getvalue(), "")

    def test_grandfathered_migrations_all_still_exist(self):
        missing = [e for e in GRANDFATHERED if not (BACKEND_ROOT / e).exists()]
        self.assertEqual(missing, [])

    def test_command_fails_on_a_violating_migration(self):
        with mock.patch(
            "boards.management.commands.check_migration_constraint_safety"
            ".iter_migration_files"
        ) as iter_files:
            fake = mock.Mock()
            fake.relative_to.return_value = Path("boards/migrations/0099_bad.py")
            fake.read_text.return_value = (
                "from django.db import migrations, models\n"
                "class Migration(migrations.Migration):\n"
                "    dependencies = []\n"
                "    operations = [migrations.AddConstraint(model_name='card', "
                "constraint=models.CheckConstraint("
                "condition=models.Q(position__gte=0), name='x_chk'))]\n"
            )
            iter_files.return_value = [fake]

            with self.assertRaises(CommandError) as ctx:
                call_command(
                    "check_migration_constraint_safety",
                    stdout=StringIO(),
                    stderr=StringIO(),
                )

        self.assertIn("1 constraint-safety violation", str(ctx.exception))

    def test_self_test_flag_passes_and_prints_a_summary(self):
        out, err = StringIO(), StringIO()
        call_command(
            "check_migration_constraint_safety", "--self-test", stdout=out, stderr=err
        )
        self.assertIn("All self-test assertions passed", out.getvalue())
        self.assertEqual(err.getvalue(), "")

    def test_self_test_flag_does_not_touch_the_real_migration_tree(self):
        with mock.patch(
            "boards.management.commands.check_migration_constraint_safety"
            ".iter_migration_files"
        ) as iter_files:
            call_command(
                "check_migration_constraint_safety",
                "--self-test",
                stdout=StringIO(),
                stderr=StringIO(),
            )
            iter_files.assert_not_called()
