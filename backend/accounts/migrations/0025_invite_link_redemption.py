# Generated manually for #925 — per-email dedup on multi-use invite links.
#
# Adds an additive table that records each successful redemption of a multi-use
# invite link, keyed on a SHA-256 hash of the normalised email so the same
# email cannot redeem the same link twice. The unique_together constraint is
# what enforces the dedup; consume_invite_token converts an IntegrityError
# raised by this constraint into an InviteTokenError("invite_already_redeemed").
# Single-use links are unaffected — they continue to be gated by the existing
# used_at flag.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0024_user_theme'),
    ]

    operations = [
        migrations.CreateModel(
            name='InviteLinkRedemption',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email_hash', models.CharField(max_length=64)),
                ('redeemed_at', models.DateTimeField(auto_now_add=True)),
                ('invite_link', models.ForeignKey(
                    on_delete=models.deletion.CASCADE,
                    related_name='redemptions',
                    to='accounts.invitelink',
                )),
            ],
            options={
                'db_table': 'invite_link_redemptions',
                'unique_together': {('invite_link', 'email_hash')},
                'indexes': [
                    models.Index(fields=['invite_link', 'redeemed_at'], name='invite_redm_invite__idx'),
                ],
            },
        ),
    ]
