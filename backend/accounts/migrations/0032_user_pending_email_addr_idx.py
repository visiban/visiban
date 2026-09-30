# #1273: partial index for User.pending_email_address, built concurrently.
# Kept alone in its own non-atomic migration (docs/development/database-migrations.md).

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("accounts", "0031_user_pending_email_address"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="user",
            index=models.Index(
                condition=models.Q(("pending_email_address__isnull", False)),
                fields=["pending_email_address"],
                name="user_pending_email_addr_idx",
            ),
        ),
    ]
