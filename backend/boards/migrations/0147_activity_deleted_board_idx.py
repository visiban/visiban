from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    """Partial ``card IS NULL`` index for the deleted-card history export (#2581).

    Built concurrently (``atomic = False``) so the table stays writable.
    """

    atomic = False

    dependencies = [
        ("boards", "0146_movement_deleted_board_idx"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardactivity",
            index=models.Index(
                condition=models.Q(("card__isnull", True)),
                fields=["board", "created_at", "id"],
                name="activity_deleted_board_idx",
            ),
        ),
    ]
