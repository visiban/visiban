# Generated manually for #572 — backfill Notification.action_type rows that
# were created with the empty-string default before the field was tightened.
# Inference is based on verb substrings which are stable system-controlled
# templates (never user-supplied free text).

from django.db import migrations


def backfill_action_type(apps, schema_editor):
    Notification = apps.get_model("boards", "Notification")
    qs = Notification.objects.filter(action_type="")
    for n in qs:
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
        # Rows that cannot be inferred remain as "" — they will not cause
        # errors at the database level (CharField, not NOT NULL constrained).
        n.save(update_fields=["action_type"])


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0039_alter_notification_action_type"),
    ]

    operations = [
        migrations.RunPython(backfill_action_type, migrations.RunPython.noop),
    ]
