# #2444: the (card, moved_at, id) index on card_movements that cumulative
# flow's per-card deciding-row probes walk: one LIMIT 1 index probe per row
# kind instead of reading every row of the card. Kept alone in its own
# non-atomic migration (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0132_card_parent_link_needed_col_idx"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardmovement",
            index=models.Index(fields=["card", "moved_at", "id"], name="movement_card_moved_at_id_idx"),
        ),
    ]
