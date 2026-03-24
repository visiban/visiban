from django.contrib.postgres.indexes import GinIndex
from django.db import migrations


def _create_trgm_all(apps, schema_editor):
    """Create pg_trgm extension and GIN indexes on PostgreSQL; no-op on SQLite."""
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    # IF NOT EXISTS makes this idempotent if the migration was already applied.
    schema_editor.execute(
        "CREATE INDEX IF NOT EXISTS card_title_trgm_idx ON cards "
        "USING gin (title gin_trgm_ops);"
    )
    schema_editor.execute(
        "CREATE INDEX IF NOT EXISTS card_desc_trgm_idx ON cards "
        "USING gin (description gin_trgm_ops);"
    )


def _drop_trgm_all(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("DROP INDEX IF EXISTS card_desc_trgm_idx;")
    schema_editor.execute("DROP INDEX IF EXISTS card_title_trgm_idx;")


class Migration(migrations.Migration):
    """Add pg_trgm extension and GIN trigram indexes on Card.title and Card.description.

    The ILIKE search used by the card search endpoint (?search=) performs a sequential
    scan without these indexes. pg_trgm GIN indexes support ILIKE with leading wildcards
    and keep search fast as card counts grow.

    SQLite safety: GIN indexes are PostgreSQL-only. The database operations are guarded
    by a vendor check so the migration is a no-op on SQLite (used for local testing).
    SeparateDatabaseAndState keeps Django's migration state consistent on both backends.
    """

    dependencies = [
        ("boards", "0029_seed_board_templates_v2"),
    ]

    operations = [
        # database_operations=[] — actual SQL handled by RunPython above (vendor-guarded).
        # state_operations — tell Django's ORM about the indexes so makemigrations
        # does not detect drift against Card.Meta.indexes.
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
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
            ],
        ),
        migrations.RunPython(_create_trgm_all, _drop_trgm_all),
    ]
