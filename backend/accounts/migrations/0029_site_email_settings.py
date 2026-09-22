from django.db import migrations, models


class Migration(migrations.Migration):
    """Add the SiteEmailSetting singleton for DB-backed SMTP config (#306).

    Deliberately a plain, atomic migration. It creates one new table and alters
    one help_text; it adds no index and no constraint, so the concurrent-build
    rule in docs/development/database-migrations.md does not apply — that rule
    covers AddIndex/AddConstraint, db_index=True, unique=True, Alter*Together
    and raw CREATE INDEX, none of which appear here. No field carries
    db_index=True or unique=True on purpose: the primary key is sufficient for
    a singleton, and either flag would pull this into the concurrency rule for
    no benefit.

    Every column carries a default, per the zero-downtime rule that a new
    column must never be NOT NULL without one. Text columns use
    `blank=True, default=""` rather than `null=True`, matching the
    empty-string-as-sentinel contract established by `maintenance_message` and
    `User.avatar_url` in 1.0 — switching "" to null later would be a breaking
    type change under the backward-compatibility rules.

    `config_source` defaults to 'env', so an existing install upgrading to this
    release is behaviorally unchanged: the row materializes empty and is
    ignored until an operator deliberately switches the source over.

    The AlterField on AdminActionLog.action is a help_text change only — it
    enumerates the action vocabulary in prose and six email_settings.* members
    were added. `Action` is deliberately not passed to the field as `choices=`
    (see the AdminActionLog.Action docstring), so the new members themselves
    need no schema change; this emits no DDL beyond Django's own no-op.
    """

    dependencies = [
        ('accounts', '0028_admin_action_log'),
    ]

    operations = [
        migrations.CreateModel(
            name='SiteEmailSetting',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('config_source', models.CharField(choices=[('env', 'Environment variables'), ('database', 'Stored in this admin UI')], default='env', help_text="Which source configures outbound mail: 'env' uses the EMAIL_* environment variables, 'database' uses the fields on this row. Never a field-level merge of the two.", max_length=16)),
                ('host', models.CharField(blank=True, default='', help_text='SMTP server hostname.', max_length=255)),
                ('port', models.PositiveIntegerField(default=587, help_text='SMTP server port. 587 for STARTTLS, 465 for implicit SSL, 25 for unencrypted.')),
                ('username', models.CharField(blank=True, default='', help_text='SMTP authentication username. Blank means the relay accepts unauthenticated mail.', max_length=255)),
                ('password_ciphertext', models.TextField(blank=True, default='', help_text='SMTP password, encrypted at rest (see visiban.crypto). Never returned by the API and never written to the audit log.')),
                ('use_tls', models.BooleanField(default=True, help_text='Use STARTTLS. Mutually exclusive with use_ssl.')),
                ('use_ssl', models.BooleanField(default=False, help_text='Use implicit TLS/SSL. Mutually exclusive with use_tls.')),
                ('from_email', models.CharField(blank=True, default='', help_text="Envelope sender for all outbound mail when config_source is 'database'.", max_length=255)),
                ('timeout', models.PositiveIntegerField(default=10, help_text='Socket timeout in seconds for SMTP connections.')),
            ],
            options={
                'db_table': 'site_email_settings',
            },
        ),
        migrations.AlterField(
            model_name='adminactionlog',
            name='action',
            field=models.CharField(help_text="What happened, as '<subject>.<verb>'. One of: maintenance_mode.enabled, maintenance_mode.disabled, maintenance_message.changed, registration_mode.changed, uploads_enabled.enabled, uploads_enabled.disabled, email_settings.source_changed, email_settings.server_changed, email_settings.from_email_changed, email_settings.username_changed, email_settings.password_changed, email_settings.test_sent. Validated at the serializer boundary, not by a column constraint.", max_length=64),
        ),
    ]
