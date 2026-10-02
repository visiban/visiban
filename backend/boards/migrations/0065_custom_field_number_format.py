# Generated for #1391 — display-only number formatting: add number_prefix,
# number_suffix and number_decimals to CustomFieldDefinition and to
# SwimlaneCustomFieldDefinition (the two models share no abstract base, so
# each gets its own three AddFields).
#
# Zero-downtime deploy: safe. Every column is either NOT NULL with a constant
# default (the two CharFields, default "") or nullable (number_decimals), so on
# PostgreSQL 11+ each ADD COLUMN is a metadata-only change — no table rewrite,
# and the ACCESS EXCLUSIVE lock is held only briefly. No index and no unique
# is added, so the concurrent-build rule does not apply and this migration
# stays atomic. The one constraint is the column-level CHECK (>= 0) that
# PositiveSmallIntegerField carries; PostgreSQL verifies it with a read-only
# scan of each definition table, which is bounded by (number of boards x the
# per-board field cap: 30 card fields, 15 swimlane fields) — not by card
# count — and every existing row is NULL, so it cannot fail.
#
# Rolling deploys: between this migration and the last old pod draining, old
# code still INSERTs definitions without naming the two new CharFields. A plain
# ``default=""`` is dropped from the column after AddField, so those INSERTs
# would hit a NOT NULL violation. ``db_default=""`` keeps a database-level
# DEFAULT '' on both columns, so old-pod creates keep working through that
# window; number_decimals is nullable and needs nothing.
#
# Additive for API clients: three new optional fields on both definition
# serializers, defaulting to "", "" and null — the exact pre-#1391 rendering.
# Stored values are untouched; the options are display-only
# (docs/api/boards.md#number-formatting).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0064_custom_field_multi_select_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='customfielddefinition',
            name='number_decimals',
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='number_prefix',
            field=models.CharField(blank=True, db_default='', default='', max_length=10),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='number_suffix',
            field=models.CharField(blank=True, db_default='', default='', max_length=10),
        ),
        migrations.AddField(
            model_name='swimlanecustomfielddefinition',
            name='number_decimals',
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='swimlanecustomfielddefinition',
            name='number_prefix',
            field=models.CharField(blank=True, db_default='', default='', max_length=10),
        ),
        migrations.AddField(
            model_name='swimlanecustomfielddefinition',
            name='number_suffix',
            field=models.CharField(blank=True, db_default='', default='', max_length=10),
        ),
    ]
