# Generated for #1273: explicit tracking of a self-service email change awaiting
# confirmation under EMAIL_VERIFICATION=mandatory.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("account", "0009_emailaddress_unique_primary_email"),
        ("accounts", "0030_notification_email_preferences"),
    ]

    operations = [
        # Nullable, no default needed: every existing account starts with no
        # pending change. db_index=False — the index is built concurrently in
        # 0032, not under this migration's table lock.
        migrations.AddField(
            model_name="user",
            name="pending_email_address",
            field=models.ForeignKey(
                blank=True,
                db_index=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="account.emailaddress",
            ),
        ),
    ]
