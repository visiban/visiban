# Generated for #1390 — add the "url" value to CustomFieldDefinition.FieldType,
# which SwimlaneCustomFieldDefinition.field_type reuses.
#
# Zero-downtime deploy: safe, and this migration emits no DDL at all
# (`sqlmigrate boards 0063` prints "(no-op)" for both operations). ``choices`` is
# enforced by Django and DRF, never by the database — there is no CHECK
# constraint on either column — so this is a state-only AlterField: no table
# lock, no rewrite, no ordering constraint against the code deploy. No index or
# constraint is added, so the concurrent-build rule does not apply.
#
# Additive for API clients: the value is new and no existing value changes
# meaning. Values stay in the existing text column; clients that do not know
# the type render the value as plain text (docs/api/boards.md#url-fields).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0062_notification_comment_added_action_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='customfielddefinition',
            name='field_type',
            field=models.CharField(choices=[('text', 'Text'), ('number', 'Number'), ('date', 'Date'), ('dropdown', 'Dropdown'), ('checkbox', 'Checkbox'), ('url', 'URL')], default='text', max_length=20),
        ),
        migrations.AlterField(
            model_name='swimlanecustomfielddefinition',
            name='field_type',
            field=models.CharField(choices=[('text', 'Text'), ('number', 'Number'), ('date', 'Date'), ('dropdown', 'Dropdown'), ('checkbox', 'Checkbox'), ('url', 'URL')], default='text', max_length=20),
        ),
    ]
