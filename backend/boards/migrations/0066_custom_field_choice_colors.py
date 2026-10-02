# Generated for #1391 — colored dropdown and multi-select choices: add
# choice_colors to CustomFieldDefinition and to SwimlaneCustomFieldDefinition
# (the two models share no abstract base, so each gets its own AddField).
#
# Zero-downtime deploy: safe. The column is NOT NULL with a constant default
# ('{}'), so on PostgreSQL 11+ each ADD COLUMN is a metadata-only change — no
# table rewrite, and the ACCESS EXCLUSIVE lock is held only briefly. No index,
# no unique and no CHECK constraint is added, so the concurrent-build rule does
# not apply and this migration stays atomic.
#
# Rolling deploys: between this migration and the last old pod draining, old
# code still INSERTs definitions without naming the new column. A plain
# ``default=dict`` is dropped from the column after AddField, so those INSERTs
# would hit a NOT NULL violation. ``db_default`` (an empty JSON object) keeps a
# database-level DEFAULT '{}' on both columns, so old-pod creates keep working
# through that window — the same rationale as 0065's number_prefix/suffix.
#
# Additive for API clients: one new optional field on both definition
# serializers, defaulting to {} — every existing choice renders with its
# automatic (hash) dot exactly as before. ``choices`` stays a plain string list
# (docs/api/boards.md#choice-colors).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0065_custom_field_number_format'),
    ]

    operations = [
        migrations.AddField(
            model_name='customfielddefinition',
            name='choice_colors',
            field=models.JSONField(blank=True, db_default=models.Value({}, output_field=models.JSONField()), default=dict),
        ),
        migrations.AddField(
            model_name='swimlanecustomfielddefinition',
            name='choice_colors',
            field=models.JSONField(blank=True, db_default=models.Value({}, output_field=models.JSONField()), default=dict),
        ),
    ]
