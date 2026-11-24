# #2557: the (group_id, joined_at, id) membership index for member_preview,
# built concurrently. Kept alone in its own non-atomic migration
# (docs/development/database-migrations.md): the group list ranks each listed
# group's direct memberships by joined_at, id and keeps the first five.

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("groups", "0028_auto_health_status"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="groupmembership",
            index=models.Index(fields=["group", "joined_at", "id"], name="group_member_joined_idx"),
        ),
    ]
