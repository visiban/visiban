"""Data migration: backfill token_hash and prefix for existing GroupInviteLink rows.

Existing plaintext UUID tokens are hashed with SHA-256 and prefixed with 'vbng_'
so they can be looked up via the new hash-based path. The original token column is
kept for one release cycle (backward compatibility) and will be dropped in a future
migration.
"""
import hashlib

from django.db import migrations


GROUP_INVITE_PREFIX = "vbng_"


def backfill_hashes(apps, schema_editor):
    GroupInviteLink = apps.get_model("groups", "GroupInviteLink")
    for link in GroupInviteLink.objects.filter(token_hash__isnull=True).iterator():
        # Existing tokens are plain UUIDs. We hash the prefixed form so that
        # lookup_by_token(GROUP_INVITE_PREFIX + str(uuid)) works for legacy links.
        raw = GROUP_INVITE_PREFIX + str(link.token)
        link.token_hash = hashlib.sha256(raw.encode()).hexdigest()
        link.prefix = raw[:8]
        link.save(update_fields=["token_hash", "prefix"])


def reverse_backfill(apps, schema_editor):
    GroupInviteLink = apps.get_model("groups", "GroupInviteLink")
    GroupInviteLink.objects.all().update(token_hash=None, prefix="")


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0010_hash_group_invite_token"),
    ]

    operations = [
        migrations.RunPython(backfill_hashes, reverse_backfill),
    ]
