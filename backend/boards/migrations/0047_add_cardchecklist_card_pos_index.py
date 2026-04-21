from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0046_add_savedfilter_state_version"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="cardchecklist",
            index=models.Index(
                fields=["card", "position"], name="checklist_card_pos_idx"
            ),
        ),
    ]
