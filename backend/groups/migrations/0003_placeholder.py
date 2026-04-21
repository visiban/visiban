"""Intentional no-op placeholder to reserve the ``0003`` migration slot.

A 0003 migration existed on branch ``feat/invite-link-improvements`` (#99)
but was never merged into main. This placeholder was added later so that
``0004`` could declare a clean dependency chain
(``0004 → 0003 → 0002``).

Rollback / re-run guidance
--------------------------
There is nothing to reverse — ``operations = []`` means this migration
neither adds nor removes schema or data. No forward re-run is required
for a disaster-recovery scenario: if the history marker is lost the
migration can safely be marked applied again with no side-effects.

If a database has 0004 applied but 0003 unapplied (raising
``InconsistentMigrationHistory`` on ``migrate``), run:

    python manage.py migrate groups 0003 --fake

The ``--fake`` flag marks this placeholder as applied without running any
operations. This restores a consistent migration history. The state can
only occur on databases set up before this placeholder was added.
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0002_groupmembership_viewer_role"),
    ]

    operations = []
