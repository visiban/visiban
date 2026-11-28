# #2718: entry requirements gain the upper-bound operators ``lt`` ("is less
# than") and ``lte`` ("is at most") for number fields.
#
# The operator column is a CharField(max_length=16): new choices are
# state-only (Django emits no SQL for a choices change). What does change in
# the database is the operand rule: ``lt``/``lte`` need an operand, so the
# check constraint that pins "operand present iff the operator compares" is
# replaced by one listing all five comparing operators.
#
# Replaced without a window where the table has no rule, and without an
# ACCESS EXCLUSIVE lock held across a scan (docs/development/
# database-migrations.md, "Adding a check constraint"):
#
# 1. add the new rule NOT VALID under a new name (catalog-only);
# 2. validate it under SHARE UPDATE EXCLUSIVE, in its own transaction;
# 3. drop the old rule (catalog-only) in the NEXT migration, 0152: a concurrent
#    NOT VALID/VALIDATE pair never shares a migration with another schema
#    operation (database-migrations.md, "The rule that matters more than the
#    syntax"). If the drop failed here, a retry would die on "already exists".
#
# If step 2 ever failed, the old rule would still be in place. It cannot fail:
# every existing row's operator is one of the pre-#2718 choices, and for those
# the new condition is exactly the old one.
#
# column_entry_requirements was added in 1.3 (0150) and holds at most 10 rows
# per column, so even the scan is small; the split is followed anyway.
#
# Between 0151 and 0152 both rules exist; they agree on every row, so a
# deploy stopped between the two is safe.
from django.db import migrations, models

from visiban.db_operations import AddConstraintNotValid, ValidateConstraint

OPERAND_OPERATORS = ["min_count", "gt", "gte", "lt", "lte"]


class Migration(migrations.Migration):
    atomic = False  # NOT VALID and VALIDATE must land in separate transactions

    dependencies = [
        ("boards", "0150_column_entry_requirements"),
    ]

    operations = [
        # Choices only: Django emits no SQL for this on any backend, so it is
        # state-only and safe to retry beside the non-atomic constraint steps.
        migrations.AlterField(
            model_name="columnentryrequirement",
            name="operator",
            field=models.CharField(
                choices=[
                    ("filled", "is filled"),
                    ("min_count", "has at least N choices"),
                    ("gt", "is more than"),
                    ("gte", "is at least"),
                    ("satisfied", "is satisfied"),
                    ("set_complete", "whole field set complete"),
                    ("lt", "is less than"),
                    ("lte", "is at most"),
                ],
                max_length=16,
            ),
        ),
        AddConstraintNotValid(
            model_name="columnentryrequirement",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(operator__in=OPERAND_OPERATORS, operand__isnull=False)
                    | (~models.Q(operator__in=OPERAND_OPERATORS) & models.Q(operand__isnull=True))
                ),
                name="entry_req_operand_iff_needed_v2",
            ),
        ),
        # constraint-safe: every existing row has a pre-#2718 operator, for which the new rule equals the old one
        ValidateConstraint(
            model_name="columnentryrequirement",
            name="entry_req_operand_iff_needed_v2",
        ),
    ]
