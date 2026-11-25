# #2570 part 2: the index on custom_field_definitions.field_set, serving the
# SET NULL when a field set is deleted and the per-set field lookups. Kept
# alone in its own non-atomic migration (docs/development/database-migrations.md).
from django.db import migrations, models

from visiban.db_operations import AddIndexConcurrently


class Migration(migrations.Migration):
    # CREATE INDEX CONCURRENTLY cannot run inside a transaction.
    atomic = False

    dependencies = [
        ("boards", "0138_custom_field_set"),
    ]

    operations = [
        AddIndexConcurrently(
            model_name="customfielddefinition",
            index=models.Index(fields=["field_set"], name="cfdef_field_set_idx"),
        ),
    ]
