# #2208 part 2: the partial index for Board.default_child_board, serving the
# SET NULL when a target board is deleted and the flag-flip check "this board
# is another board's default". Kept alone in its own non-atomic migration
# (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0125_board_default_child_board"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="board",
            index=models.Index(
                condition=models.Q(default_child_board__isnull=False),
                fields=["default_child_board"],
                name="board_default_child_idx",
            ),
        ),
    ]
