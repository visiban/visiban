# #1816: when purge_card_history redacted a change-feed row's card content.
# Nullable with no default and no index, so on PostgreSQL the ADD COLUMN is a
# catalog-only change: it neither rewrites nor scans board_events, which can be
# large on an install that never prunes it.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0092_column_policy"),
    ]

    operations = [
        migrations.AddField(
            model_name="boardevent",
            name="redacted_at",
            field=models.DateTimeField(
                blank=True,
                help_text=(
                    "When purge_card_history redacted this row's card content (#1816); "
                    "NULL for a row that was never redacted."
                ),
                null=True,
            ),
        ),
    ]
