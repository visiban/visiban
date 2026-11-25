# #2594 step 4 of 4: partial index for the user-delete SET_NULL cascade on
# card_activities.assigned_by (UPDATE card_activities SET assigned_by_id = NULL
# WHERE assigned_by_id = ...), which would otherwise scan card_activities.
# Partial because only assignee override_used rows carry an assigner. Alone in
# its own non-atomic migration (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0143_activity_assigned_by_fk_validate"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardactivity",
            index=models.Index(
                condition=models.Q(("assigned_by__isnull", False)),
                fields=["assigned_by"],
                name="activity_assigned_by_idx",
            ),
        ),
    ]
