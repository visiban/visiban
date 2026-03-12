from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0002_groupmembership_viewer_role"),
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
                choices=[
                    ("admin", "Admin"),
                    ("member", "Member"),
                    ("viewer", "Viewer"),
                ],
                default="member",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="groupinvitelink",
            name="expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
