from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="groupmembership",
            name="role",
            field=models.CharField(
                choices=[
                    ("admin", "Admin"),
                    ("member", "Member"),
                    ("viewer", "Viewer"),
                ],
                default="member",
                max_length=10,
            ),
        ),
    ]
