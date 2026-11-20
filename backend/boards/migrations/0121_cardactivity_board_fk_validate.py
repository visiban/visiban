# #1799 step 4 of 5: validate the board foreign key 0120 added NOT VALID.
#
# One scan of card_activities, after the 0119 backfill, under SHARE UPDATE
# EXCLUSIVE -- readers and writers keep going. Kept alone in its own
# non-atomic migration: inside the default transaction the constraint's
# catalog lock would be held until commit, across the whole scan.
#
# The constraint-safety checker's adjacent-migration rule waves this
# ValidateConstraint through because 0120 is a RunPython, so judge the data
# as if the check were off: every board_id here is copied from cards.board_id
# (0119's backfill, set_null_keeping_board, and the activity writers), and
# boards rows are only removed by the cascade that removes these rows with
# them, so no repair step is needed before validating.
import django.db.models.deletion
from django.db import migrations, models

from visiban.db_operations import ValidateConstraint


class Migration(migrations.Migration):
    # VALIDATE CONSTRAINT must not share a transaction with the catalog lock.
    atomic = False

    dependencies = [
        ("boards", "0120_cardactivity_board_fk_not_valid"),
    ]

    operations = [
        # A no-op off PostgreSQL, where 0120 added nothing to validate.
        ValidateConstraint(
            model_name="cardactivity", name="card_activities_board_id_fk_boards_id"
        ),
        # State only: the constraint already exists from 0120. This tells Django
        # the field is now backed by a real constraint so makemigrations does
        # not try to add a second one.
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="cardactivity",
                    name="board",
                    field=models.ForeignKey(
                        blank=True,
                        db_index=False,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to="boards.board",
                    ),
                ),
            ],
        ),
    ]
