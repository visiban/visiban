from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    """Add a partial index on Card(board, -updated_at) for the cross-board card
    query endpoint (#1112): ?board=, ?updated_since=, and cursor pagination all
    filter/sort on this pair. The condition matches the dominant query shape —
    include_archived defaults off, same as the existing card-list consumers.

    Built CONCURRENTLY per #1081 — see docs/development/database-migrations.md.
    """

    # Required: CREATE INDEX CONCURRENTLY cannot run inside a transaction, and
    # Django wraps every migration in one by default.
    atomic = False

    dependencies = [
        ("boards", "0054_fix_board_template_drift"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="card",
            index=models.Index(
                fields=["board", "-updated_at"],
                name="card_board_updated_idx",
                condition=models.Q(archived_at__isnull=True),
            ),
        ),
    ]
