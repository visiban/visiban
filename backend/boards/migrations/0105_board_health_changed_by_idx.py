# #2242: the boards last-change FK index, built concurrently. Kept alone in
# its own non-atomic migration (docs/development/database-migrations.md): the
# user-delete SET NULL scans boards by health_status_changed_by_id.

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0104_health_status_history"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="board",
            index=models.Index(
                fields=["health_status_changed_by"],
                name="board_health_changed_by_idx",
                condition=models.Q(health_status_changed_by__isnull=False),
            ),
        ),
    ]
