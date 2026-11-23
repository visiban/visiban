# #2371 part 2: the partial index on CardParentLink.needed_at_column, serving
# the SET NULL when a column is deleted and the release lookup on a parent move.
# Kept alone in its own non-atomic migration
# (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0131_card_parent_link_planned"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="cardparentlink",
            index=models.Index(
                condition=models.Q(needed_at_column__isnull=False),
                fields=["needed_at_column"],
                name="cardparentlink_needed_col_idx",
            ),
        ),
    ]
