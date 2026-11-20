# #2408: movement_board_moved_idx (board, -moved_at) is a prefix of
# movement_board_moved_id_idx (board, -moved_at, -id), added in 0116 (#2400), so
# it only costs write amplification on card_movements. Dropped in its own
# migration, apart from the one that added its replacement, and alone in it
# because DROP INDEX CONCURRENTLY cannot share a migration with another schema
# operation (docs/development/database-migrations.md).

from django.db import migrations

from visiban.db_operations import RemoveIndexConcurrently


class Migration(migrations.Migration):
    # DROP INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0116_cardmovement_board_moved_id_idx"),
    ]

    operations = [
        RemoveIndexConcurrently(
            model_name="cardmovement",
            name="movement_board_moved_idx",
        ),
    ]
