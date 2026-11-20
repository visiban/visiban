# #2400: the board History orders by (-moved_at, -id) so offset pages are
# stable at same-instant ties. movement_board_moved_idx ends at moved_at, so
# PostgreSQL served the new order with an Incremental Sort over the joined
# rows, about three times slower at a deep offset. This index carries the
# tie-break. Kept alone in its own non-atomic migration
# (docs/development/database-migrations.md).

from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0115_card_parent_link"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardmovement",
            index=models.Index(fields=["board", "-moved_at", "-id"], name="movement_board_moved_id_idx"),
        ),
    ]
