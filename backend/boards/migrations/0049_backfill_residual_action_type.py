# Generated manually for #822 — second-pass backfill for Notification.action_type
# rows that 0040 could not infer from the verb text.
#
# 0040 left unmatchable rows as ``action_type=""`` (see line 27 of that file).
# 0041 then set ``blank=False`` on the model field. Those legacy rows cannot be
# re-saved via ModelForm/serializer without a validation error. This migration
# assigns the catch-all ``card_moved`` value so every row becomes editable and
# matches a valid ``ActionType`` choice. ``card_moved`` is the most common
# historical action and the frontend already has a renderer for it; the
# displayed text still comes from the ``verb`` field so the backfill does not
# alter what the user sees.
#
# Idempotent: only touches rows where action_type="" still, so a partial-apply
# re-run is safe. Reverse is a noop (pre-forward state is "" which would
# re-introduce the validation gap we just closed).

from django.db import migrations


def backfill_residual(apps, schema_editor):
    Notification = apps.get_model("boards", "Notification")
    batch = []
    for n in Notification.objects.filter(action_type="").iterator(chunk_size=500):
        n.action_type = "card_moved"
        batch.append(n)
        if len(batch) >= 500:
            Notification.objects.bulk_update(batch, ["action_type"])
            batch = []
    if batch:
        Notification.objects.bulk_update(batch, ["action_type"])


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0048_board_share_token_expires_at"),
    ]

    operations = [
        migrations.RunPython(backfill_residual, migrations.RunPython.noop),
    ]
