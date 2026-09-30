# Generated for #1295 — email opt-in for the #1277 COMMENT_ADDED notification.
#
# Zero-downtime deploy: safe. A single BooleanField with a default and no
# db_index/unique, the same shape as the four email_notif_* columns in 0030:
# on PostgreSQL 11+ the AddField is metadata-only (no table rewrite, no long
# lock) and there is no index or constraint to build concurrently. See
# docs/development/database-migrations.md.
#
# Deploy ordering: migrate before or with the new code (the repo's normal
# additive rule) — the new serializer and email path read this column.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0033_add_user_email_upper_index"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="email_notif_comment_added",
            field=models.BooleanField(default=False),
        ),
    ]
