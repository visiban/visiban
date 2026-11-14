# #2242: the groups last-change FK index, built concurrently. Kept alone in
# its own non-atomic migration (docs/development/database-migrations.md): the
# user-delete SET NULL scans groups by health_status_changed_by_id.

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("groups", "0025_health_status_history"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="group",
            index=models.Index(
                fields=["health_status_changed_by"],
                name="group_health_changed_by_idx",
                condition=models.Q(health_status_changed_by__isnull=False),
            ),
        ),
    ]
