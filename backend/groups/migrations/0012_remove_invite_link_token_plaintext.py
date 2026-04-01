"""Remove the legacy plaintext token column from group_invite_links.

The token_hash + prefix scheme was introduced in 0010 and backfilled in 0011.
All new invite links have been stored as hashes since then; the plaintext
token column is no longer read anywhere in the codebase (#605).
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0011_backfill_token_hashes"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="groupinvitelink",
            name="token",
        ),
    ]
