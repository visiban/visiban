from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    """Partial ``card IS NULL`` index for the deleted-card history export (#2581).

    Built concurrently (``atomic = False``) so the table stays writable.
    """

    atomic = False

    dependencies = [
        ("boards", "0145_movement_board_moved_card_idx"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardmovement",
            index=models.Index(
                condition=models.Q(("card__isnull", True)),
                fields=["board", "moved_at", "id"],
                name="movement_deleted_board_idx",
            ),
        ),
    ]
