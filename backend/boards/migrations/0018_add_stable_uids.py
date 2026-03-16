"""Add stable 16-char hex UIDs to Board, Column, Swimlane, Label, Card, and CardMovement.

Three-phase approach for the five models with unique=True constraints:
  Phase 1 — AddField: nullable, no unique constraint (safe for populated tables).
  Phase 2 — RunPython: backfill per-row using secrets.token_hex(8) via bulk_update.
  Phase 3 — AlterField: apply unique=True and null=False once all rows are populated.

CardMovement uid fields use a simpler single-phase AddField(default="") because
they have no unique constraint. The backfill copies the uid from the FK object
where available; rows where the FK was already NULL remain "" — this is
intentional and mirrors the behaviour of the *_name fields added in 0016.
"""
import secrets

from django.db import migrations, models


def _generate_uid():
    # Self-contained copy — migrations must not import from models.py because
    # a future rename/removal would break fresh-DB applies permanently.
    return secrets.token_hex(8)


def backfill_uids(apps, schema_editor):
    """Assign a unique uid to every existing row in the five core models."""
    for model_name in ("Board", "Column", "Swimlane", "Label", "Card"):
        Model = apps.get_model("boards", model_name)
        batch = []
        for obj in Model.objects.filter(uid__isnull=True).iterator():
            obj.uid = _generate_uid()
            batch.append(obj)
            if len(batch) >= 500:
                Model.objects.bulk_update(batch, ["uid"])
                batch = []
        if batch:
            Model.objects.bulk_update(batch, ["uid"])


def backfill_movement_uids(apps, schema_editor):
    """Populate CardMovement *_uid fields from live FK objects where possible.

    Rows where a FK is already NULL (deleted column/swimlane) cannot be
    recovered and remain "".  This is acceptable and consistent with the
    *_name backfill in migration 0016.
    """
    CardMovement = apps.get_model("boards", "CardMovement")
    batch = []
    for mv in CardMovement.objects.select_related(
        "from_column", "to_column", "from_swimlane", "to_swimlane"
    ).iterator():
        changed = False
        if mv.from_column_id and mv.from_column and not mv.from_column_uid:
            mv.from_column_uid = mv.from_column.uid
            changed = True
        if mv.to_column_id and mv.to_column and not mv.to_column_uid:
            mv.to_column_uid = mv.to_column.uid
            changed = True
        if mv.from_swimlane_id and mv.from_swimlane and not mv.from_swimlane_uid:
            mv.from_swimlane_uid = mv.from_swimlane.uid
            changed = True
        if mv.to_swimlane_id and mv.to_swimlane and not mv.to_swimlane_uid:
            mv.to_swimlane_uid = mv.to_swimlane.uid
            changed = True
        if changed:
            batch.append(mv)
            if len(batch) >= 500:
                CardMovement.objects.bulk_update(
                    batch,
                    ["from_column_uid", "to_column_uid", "from_swimlane_uid", "to_swimlane_uid"],
                )
                batch = []
    if batch:
        CardMovement.objects.bulk_update(
            batch,
            ["from_column_uid", "to_column_uid", "from_swimlane_uid", "to_swimlane_uid"],
        )


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0017_notification_actor_action_type"),
    ]

    operations = [
        # ── Phase 1: add nullable uid columns (no unique constraint yet) ──────
        migrations.AddField(
            model_name="board",
            name="uid",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name="column",
            name="uid",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name="swimlane",
            name="uid",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name="label",
            name="uid",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        migrations.AddField(
            model_name="card",
            name="uid",
            field=models.CharField(blank=True, max_length=16, null=True),
        ),
        # CardMovement uid fields — no unique constraint, simpler AddField
        migrations.AddField(
            model_name="cardmovement",
            name="from_column_uid",
            field=models.CharField(blank=True, default="", max_length=16),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="to_column_uid",
            field=models.CharField(blank=True, default="", max_length=16),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="from_swimlane_uid",
            field=models.CharField(blank=True, default="", max_length=16),
        ),
        migrations.AddField(
            model_name="cardmovement",
            name="to_swimlane_uid",
            field=models.CharField(blank=True, default="", max_length=16),
        ),
        # ── Phase 2: backfill ─────────────────────────────────────────────────
        migrations.RunPython(backfill_uids, migrations.RunPython.noop),
        migrations.RunPython(backfill_movement_uids, migrations.RunPython.noop),
        # ── Phase 3: apply unique=True, null=False, and default ───────────────
        migrations.AlterField(
            model_name="board",
            name="uid",
            field=models.CharField(default=_generate_uid, editable=False, max_length=16, unique=True),
        ),
        migrations.AlterField(
            model_name="column",
            name="uid",
            field=models.CharField(default=_generate_uid, editable=False, max_length=16, unique=True),
        ),
        migrations.AlterField(
            model_name="swimlane",
            name="uid",
            field=models.CharField(default=_generate_uid, editable=False, max_length=16, unique=True),
        ),
        migrations.AlterField(
            model_name="label",
            name="uid",
            field=models.CharField(default=_generate_uid, editable=False, max_length=16, unique=True),
        ),
        migrations.AlterField(
            model_name="card",
            name="uid",
            field=models.CharField(default=_generate_uid, editable=False, max_length=16, unique=True),
        ),
    ]
