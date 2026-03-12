from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0004_group_default_settings_grouplabel"),
    ]

    operations = [
        migrations.AddField(
            model_name="groupinvitelink",
            name="name",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.AddField(
            model_name="groupinvitelink",
            name="role",
            field=models.CharField(
                choices=[("member", "Member"), ("viewer", "Viewer")],
                default="member",
                max_length=10,
            ),
        ),
        migrations.AddField(
            model_name="groupinvitelink",
            name="expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="grouplabel",
            name="id",
            field=models.BigAutoField(
                auto_created=True,
                primary_key=True,
                serialize=False,
                verbose_name="ID",
            ),
        ),
    ]
