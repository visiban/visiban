# #2208 part 2: Board.default_child_board, where "Add child" creates a new
# child card. Nullable with no default, so ADD COLUMN is catalog-only; the
# boards table is small (precedent: docs/development/database-migrations.md,
# the swimlane_rollup_field add). The FK index is built CONCURRENTLY on its
# own in 0125, so the field is declared db_index=False.
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0123_cardactivity_board_created_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="default_child_board",
            field=models.ForeignKey(
                blank=True,
                db_index=False,
                help_text=(
                    "The board where Add child on this board's cards creates the new "
                    "child card, in its first column (#2208). Empty means ask each time."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="default_child_board_of",
                to="boards.board",
            ),
        ),
    ]
