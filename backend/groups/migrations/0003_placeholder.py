# This migration number was intentionally skipped.
# A 0003 migration existed on branch feat/invite-link-improvements (#99) but was
# not merged into main. Migration 0004 was corrected to depend on 0002 directly
# (see commit 7336de3). This placeholder preserves the numeric sequence for
# readability and future reference.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0002_groupmembership_viewer_role"),
    ]

    operations = []
