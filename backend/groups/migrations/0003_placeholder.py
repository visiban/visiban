# This migration number was intentionally skipped during development.
# A 0003 migration existed on branch feat/invite-link-improvements (#99) but was
# not merged into main. This placeholder was later added so that 0004 could
# declare a clean dependency chain (0004 depends on 0003, 0003 depends on 0002).
#
# If your database has 0004 applied but 0003 unapplied (causing an
# InconsistentMigrationHistory error), run:
#
#   python manage.py migrate groups 0003 --fake
#
# The --fake flag marks the placeholder as applied without running any operations
# (this migration has none). This restores a consistent migration history.
# This state can only occur on databases set up before this placeholder was added.
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0002_groupmembership_viewer_role"),
    ]

    operations = []
