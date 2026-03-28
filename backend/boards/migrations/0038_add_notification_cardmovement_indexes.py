from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0037_add_is_moderator_to_boardmembership"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="cardmovement",
            index=models.Index(
                fields=["card", "-moved_at"],
                name="movement_card_moved_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["recipient", "read", "-created_at"],
                name="notif_recipient_unread_idx",
            ),
        ),
    ]
