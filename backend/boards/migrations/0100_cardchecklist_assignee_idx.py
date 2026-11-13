# #445: the checklist assignee FK index, built concurrently. Kept alone in its
# own non-atomic migration (docs/development/database-migrations.md): the
# user-delete SET NULL scans card_checklist_items by assignee_id.

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0099_cardchecklist_assignee_due_date"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardchecklist",
            index=models.Index(fields=["assignee"], name="checklist_assignee_idx"),
        ),
    ]
