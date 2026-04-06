# Generated manually for #572 — backfill Notification.action_type rows that
# were created with the empty-string default before the field was tightened.
# Inference is based on verb substrings which are stable system-controlled
# templates (never user-supplied free text).

from django.db import migrations


def backfill_action_type(apps, schema_editor):
    Notification = apps.get_model("boards", "Notification")
    # Process in batches of 500 to avoid holding a table lock for the full
    # migration duration on large production instances.
    batch = []
    for n in Notification.objects.filter(action_type="").iterator(chunk_size=500):
        verb = n.verb
        if "mentioned" in verb:
            n.action_type = "mentioned"
        elif "assigned" in verb:
            n.action_type = "assigned"
        elif "added you to" in verb or "invite" in verb.lower():
            n.action_type = "board_invite"
        elif "hasn't moved" in verb or "stale" in verb.lower():
            n.action_type = "stale"
        elif "moved" in verb:
            n.action_type = "card_moved"
        else:
            # Cannot infer action_type — leave as "" (DB does not enforce NOT NULL)
            continue
        batch.append(n)
        if len(batch) >= 500:
            Notification.objects.bulk_update(batch, ["action_type"])
            batch = []
    if batch:
        Notification.objects.bulk_update(batch, ["action_type"])


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0039_alter_notification_action_type"),
    ]

    operations = [
        migrations.RunPython(backfill_action_type, migrations.RunPython.noop),
    ]
