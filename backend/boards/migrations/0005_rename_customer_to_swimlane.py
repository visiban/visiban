from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0004_add_card_attachments'),
    ]

    operations = [
        # Rename the Python model class (Customer → Swimlane).
        # Does not change the DB table because db_table was set explicitly.
        migrations.RenameModel(
            old_name='Customer',
            new_name='Swimlane',
        ),
        # Rename the DB table from 'customers' to 'swimlanes'.
        migrations.AlterModelTable(
            name='swimlane',
            table='swimlanes',
        ),
        # Rename card.customer → card.swimlane (DB column: customer_id → swimlane_id).
        migrations.RenameField(
            model_name='card',
            old_name='customer',
            new_name='swimlane',
        ),
        # Rename CardMovement FK fields.
        migrations.RenameField(
            model_name='cardmovement',
            old_name='from_customer',
            new_name='from_swimlane',
        ),
        migrations.RenameField(
            model_name='cardmovement',
            old_name='to_customer',
            new_name='to_swimlane',
        ),
    ]
