from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0016_add_invite_link'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='has_completed_tour',
            field=models.BooleanField(default=False),
        ),
    ]
