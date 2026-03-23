from django.contrib.postgres.indexes import GinIndex
from django.db import migrations


class Migration(migrations.Migration):
    """Add pg_trgm extension and GIN trigram indexes on Card.title and Card.description.

    The ILIKE search used by the card search endpoint (?search=) performs a sequential
    scan without these indexes. pg_trgm GIN indexes support ILIKE with leading wildcards
    and keep search fast as card counts grow.
    """

    dependencies = [
        ("boards", "0029_seed_board_templates_v2"),
    ]

    operations = [
        # Enable pg_trgm if not already present. The IF NOT EXISTS guard makes
        # this safe to run on databases where another extension already activated it.
        migrations.RunSQL(
            "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddIndex(
            model_name="card",
            index=GinIndex(
                fields=["title"],
                name="card_title_trgm_idx",
                opclasses=["gin_trgm_ops"],
            ),
        ),
        migrations.AddIndex(
            model_name="card",
            index=GinIndex(
                fields=["description"],
                name="card_desc_trgm_idx",
                opclasses=["gin_trgm_ops"],
            ),
        ),
    ]
