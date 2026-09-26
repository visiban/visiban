# Generated for #356 — per-event email notification preferences, plus the
# notif_stale / notif_due_soon split.
#
# Zero-downtime deploy: safe.
#
# * All five columns are BooleanField with a default and no db_index/unique, so
#   each AddField is a metadata-only operation on PostgreSQL 11+ (no table
#   rewrite, no long lock) and needs no concurrent-build treatment — there is no
#   index or constraint here. See docs/development/database-migrations.md.
# * The RunPython copies notif_due_soon into notif_stale so nobody's effective
#   staleness setting changes when notify_stale_cards starts reading the new
#   field. Batched with .update() rather than row-by-row, and reverse is a no-op
#   because reversing the AddField drops the column anyway.
# * Deploy ordering is free. Old code neither reads nor writes the new columns.
#   The one window worth naming: if a user edits notif_due_soon after this
#   migration runs but before the new code is live, that edit lands on the old
#   field only and their notif_stale keeps the pre-migration value. It is a
#   preference toggle, recoverable by toggling again, and the alternative (a
#   trigger or a dual-write release) is not worth it for this.

from django.db import migrations, models


def copy_due_soon_to_stale(apps, schema_editor):
    """Preserve each user's existing staleness opt-in under the new field name.

    Before 1.2 there was no due-date notification at all, so every user who had
    notif_due_soon=True had set it to receive *staleness* alerts — that is the
    only thing the flag ever gated. Carrying the value over keeps that working.
    Users left on the default (False) need no write, so only the opted-in rows
    are touched.
    """
    User = apps.get_model("accounts", "User")
    User.objects.filter(notif_due_soon=True).update(notif_stale=True)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0029_site_email_settings"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="notif_stale",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="email_notif_card_assigned",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="email_notif_mentioned",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="email_notif_due_soon",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="user",
            name="email_notif_card_moved",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(copy_due_soon_to_stale, migrations.RunPython.noop),
    ]
