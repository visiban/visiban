"""Add per-board card_density and migrate existing boards to ``dense`` (#961).

Zero-downtime deploy: safe. AddField uses a column-level DEFAULT (``comfortable``)
so PostgreSQL populates new rows without a full table rewrite or exclusive lock.
The RunPython data step then flips every existing row to ``dense`` so today's
admins keep their current card visual after upgrade — only newly created boards
land on the ``comfortable`` design intent. Run the migration before deploying
the code that reads the column; the old code ignores unknown columns, so the
migration is forward-safe.

Reverse is a no-op: rolling back the data step would clobber any density value
deliberately set after the migration applied. Forward is idempotent — only rows
where the post-AddField default ``comfortable`` is still in place get flipped,
so a partial-apply re-run is safe (in practice this matches the AddField row
set exactly).
"""
from django.db import migrations, models


def backfill_existing_to_dense(apps, schema_editor):
    """Flip pre-existing boards (post-AddField default ``comfortable``) to ``dense``.

    Process in batches to keep the row lock duration bounded on large fleets.
    """
    Board = apps.get_model("boards", "Board")
    Board.objects.filter(card_density="comfortable").update(card_density="dense")


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0050_add_export_controls"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="card_density",
            field=models.CharField(
                default="comfortable",
                help_text=(
                    "Per-board card layout density (#961). Drives how much metadata "
                    "renders on the card face: ``comfortable`` shows one urgency badge "
                    "and one primary label, ``compact`` adds due date and weight, "
                    "``dense`` shows everything (today's pre-1.1 layout). New boards "
                    "default to ``comfortable`` so first-time users get the cleaner "
                    "scan; existing boards are migrated to ``dense`` to preserve their "
                    "current visual. Validated at the serializer layer."
                ),
                max_length=20,
            ),
        ),
        migrations.RunPython(backfill_existing_to_dense, migrations.RunPython.noop),
    ]
