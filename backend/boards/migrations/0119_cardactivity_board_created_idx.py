# #1799 step 3 of 3: index for a deleted card's retained activity rows, read by
# board (the JSON export's deleted_card_history, #1796), and for the
# board-delete cascade's DELETE ... WHERE board_id IN (...). Built after the
# 0118 backfill so that full-table UPDATE does not churn it.
# Kept alone in its own non-atomic migration (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0118_backfill_cardactivity_board_snapshots"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardactivity",
            index=models.Index(fields=["board", "-created_at"], name="activity_board_created_idx"),
        ),
    ]
