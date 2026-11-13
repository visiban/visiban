# #1122: threshold marking on custom field definitions. Five additive
# AddFields: the direction has a db_default and the four values are nullable,
# so the migration is zero-downtime and needs no concurrent operation (no
# index, no constraint).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0100_cardchecklist_assignee_idx'),
    ]

    operations = [
        migrations.AddField(
            model_name='customfielddefinition',
            name='threshold_alert',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='threshold_alert_days',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='threshold_direction',
            field=models.CharField(blank=True, choices=[('', 'Off'), ('above', 'Above'), ('below', 'Below')], db_default='', default='', max_length=5),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='threshold_warn',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='customfielddefinition',
            name='threshold_warn_days',
            field=models.SmallIntegerField(blank=True, null=True),
        ),
    ]
