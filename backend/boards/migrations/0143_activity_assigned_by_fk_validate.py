# #2594 step 3 of 4: validate the assigned_by foreign key 0142 added NOT VALID.
#
# One scan of card_activities under SHARE UPDATE EXCLUSIVE -- readers and
# writers keep going. Alone in its own non-atomic migration so the catalog lock
# is not held across the scan. Every pre-existing row is NULL (no backfill:
# rows written before #2594 show no assigner), and users rows are removed only
# through the SET_NULL that clears these references, so no repair step is
# needed before validating.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

from visiban.db_operations import ValidateConstraint


class Migration(migrations.Migration):
    # VALIDATE CONSTRAINT must not share a transaction with the catalog lock.
    atomic = False

    dependencies = [
        ("boards", "0142_activity_assigned_by_fk_not_valid"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # A no-op off PostgreSQL, where 0142 added nothing to validate.
        ValidateConstraint(model_name="cardactivity", name="card_activities_assigned_by_id_fk_users_id"),
        # State only: tells Django the field is now backed by a real constraint.
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(
                    model_name="cardactivity",
                    name="assigned_by",
                    field=models.ForeignKey(
                        blank=True,
                        db_index=False,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
        ),
    ]
