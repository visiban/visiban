"""Add the admin action audit log (#1126).

Zero-downtime deploy: safe. A single ``CreateModel`` and nothing else — the new
table has no rows and no readers, so its own indexes are built uncontended and
do not need the concurrent path (``check_migration_concurrency`` does not flag
indexes declared inside ``CreateModel`` for exactly this reason; see
docs/development/database-migrations.md). ``atomic`` is therefore left at its
default ``True``, and no concurrent operation is present to require otherwise.

``SiteSetting`` is deliberately untouched here: this release only *reads* it to
build audit rows, so there is no column change to coordinate.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0027_maintenance_mode'),
    ]

    operations = [
        migrations.CreateModel(
            name='AdminActionLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(help_text="What happened, as '<subject>.<verb>'. One of: maintenance_mode.enabled, maintenance_mode.disabled, maintenance_message.changed, registration_mode.changed, uploads_enabled.enabled, uploads_enabled.disabled. Validated at the serializer boundary, not by a column constraint.", max_length=64)),
                ('actor_id', models.BigIntegerField(blank=True, help_text='User who performed the action; NULL when there was no authenticated actor (e.g. a management command). Deliberately not a ForeignKey — see the model docstring.', null=True)),
                ('actor_username', models.CharField(blank=True, default='', help_text='Username captured at write time so the actor stays identifiable after the account is deleted. Blank when there was no authenticated actor.', max_length=150)),
                ('source', models.CharField(default='admin_api', help_text='Operator path used: admin_api, django_admin, or cli.', max_length=20)),
                ('metadata', models.JSONField(blank=True, default=dict, help_text="Action-specific detail — e.g. {'from': ..., 'to': ...} for a changed value. Keys are additive-only: never remove or repurpose one, since existing rows are never rewritten.")),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'admin_action_logs',
                'ordering': ['-created_at', '-id'],
                'indexes': [models.Index(fields=['-created_at'], name='aal_created_idx'), models.Index(fields=['action', '-created_at'], name='aal_action_created_idx')],
            },
        ),
    ]
