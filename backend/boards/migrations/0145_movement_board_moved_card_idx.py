# #2579: a covering index for the flow loaders' recent-movement subqueries
# (flow_metrics.movements_on_board): one board's movements in a range read
# index-only, instead of the instance-wide card_movements_moved_at scan. Kept
# alone in its own non-atomic migration (docs/development/database-migrations.md).

from django.conf import settings
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ('boards', '0144_activity_assigned_by_idx'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        AddIndexConcurrently(
            model_name='cardmovement',
            index=models.Index(fields=['board', 'moved_at', 'card'], name='movement_board_moved_card_idx'),
        ),
    ]
