from django.db import migrations, models


def backfill_can_access_all_content(apps, schema_editor):
    """Set can_access_all_content=True for all existing site admins so they
    retain board/group omniscient access after the flag split (#247)."""
    User = apps.get_model("accounts", "User")
    User.objects.filter(is_site_admin=True).update(can_access_all_content=True)


def reverse_can_access_all_content(apps, schema_editor):
    """On reverse migration, clear can_access_all_content for site admins."""
    User = apps.get_model("accounts", "User")
    User.objects.filter(is_site_admin=True).update(can_access_all_content=False)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0013_sitesetting_uploads_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="can_access_all_content",
            field=models.BooleanField(
                default=False,
                help_text="Grants read/write access to all boards and groups on this instance regardless of membership. Independent of is_site_admin.",
            ),
        ),
        migrations.RunPython(
            backfill_can_access_all_content,
            reverse_code=reverse_can_access_all_content,
        ),
    ]
