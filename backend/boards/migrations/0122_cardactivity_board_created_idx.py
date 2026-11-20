# #1799 step 5 of 5: index for a deleted card's retained activity rows, read by
# board (the JSON export's deleted_card_history, #1796), and for the
# board-delete cascade's DELETE ... WHERE board_id IN (...). Built after the
# 0119 backfill so that full-table UPDATE does not churn it, and after the
# 0121 VALIDATE so the two table scans do not overlap.
# Kept alone in its own non-atomic migration (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0121_cardactivity_board_fk_validate"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardactivity",
            index=models.Index(fields=["board", "-created_at"], name="activity_board_created_idx"),
        ),
    ]
