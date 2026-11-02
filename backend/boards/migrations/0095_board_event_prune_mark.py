# #2058: per-board record of the highest change-feed event id that
# prune_board_events deleted, so the feed can tell a cursor that missed pruned
# events from one whose own row was merely pruned. A CreateModel of a new,
# empty table (its primary-key index is built with it); board_events and boards
# are not touched. No backfill: a board pruned before this migration has no row,
# and the feed keeps its previous behavior for it until its next prune.

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("boards", "0094_notification_webhook_disabled_action_type"),
    ]

    operations = [
        migrations.CreateModel(
            name="BoardEventPruneMark",
            fields=[
                (
                    "board_id",
                    models.BigIntegerField(
                        help_text=(
                            "Board whose change feed was pruned. Deliberately not a "
                            "ForeignKey — see the model docstring."
                        ),
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "max_pruned_id",
                    models.BigIntegerField(
                        help_text=(
                            "Highest BoardEvent id that prune_board_events deleted for "
                            "this board. Never decreases."
                        ),
                    ),
                ),
            ],
            options={
                "db_table": "board_event_prune_marks",
            },
        ),
    ]
