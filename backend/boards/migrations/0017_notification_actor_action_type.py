import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Add structured actor and action_type fields to Notification.

    These fields let callers identify who triggered a notification and what
    action occurred without parsing the free-form ``verb`` string.  Both are
    nullable/blank so that existing rows are unaffected.
    """

    dependencies = [
        ("boards", "0016_cardmovement_denorm_names"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="notification",
            name="actor",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="triggered_notifications",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="notification",
            name="action_type",
            field=models.CharField(
                blank=True,
                choices=[("assigned", "assigned"), ("mentioned", "mentioned")],
                default="",
                max_length=32,
            ),
        ),
    ]
