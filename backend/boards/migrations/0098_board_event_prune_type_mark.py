# #2079: the prune record per board, event type and per-user owner, so a change
# feed reader or webhook is expired only by a pruned event it could have seen.
# A CreateModel of a new, empty table, built with its constraint, and one column
# with a constant database default on the small board_event_prune_marks table
# (no rewrite, and an insert that omits it still works). board_events is not
# touched. No backfill: existing prune marks have no type detail and keep expiring
# every reader, as described on BoardEventPruneMark. The AlterField only rewords
# help text, to say so; it runs no SQL.

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("boards", "0097_board_default_preset"),
    ]

    operations = [
        migrations.AlterField(
            model_name="boardeventprunemark",
            name="max_pruned_id",
            field=models.BigIntegerField(
                help_text=(
                    "Events of this board at or below this id were deleted with no type recorded, "
                    "so it counts for every reader and webhook. 0 if none. Never decreases."
                ),
            ),
        ),
        migrations.AddField(
            model_name="boardeventprunemark",
            name="unrecorded_floor",
            field=models.BigIntegerField(
                db_default=0,
                default=0,
                help_text=(
                    "One below the lowest id of this board's first recorded prune: anything a "
                    "pre-#2058 pruner removed is below it. Counts for change-feed readers only."
                ),
            ),
        ),
        migrations.CreateModel(
            name="BoardEventPruneTypeMark",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "board_id",
                    models.BigIntegerField(
                        help_text=(
                            "Board whose change feed was pruned. Deliberately not a "
                            "ForeignKey — see BoardEventPruneMark."
                        ),
                    ),
                ),
                ("event", models.CharField(help_text="Event type of the pruned rows.", max_length=64)),
                (
                    "actor_id",
                    models.BigIntegerField(
                        db_default=0,
                        default=0,
                        help_text="Owner of a per-user event; 0 for every other event type.",
                    ),
                ),
                (
                    "max_pruned_id",
                    models.BigIntegerField(
                        help_text=(
                            "Highest BoardEvent id of this board, type and owner that was "
                            "deleted. Never decreases."
                        ),
                    ),
                ),
            ],
            options={
                "db_table": "board_event_prune_type_marks",
                "constraints": [
                    models.UniqueConstraint(
                        fields=("board_id", "event", "actor_id"), name="bev_prune_type_mark_uniq"
                    ),
                ],
            },
        ),
    ]
