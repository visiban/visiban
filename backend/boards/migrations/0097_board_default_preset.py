# #1146: a board's default preset id ("classic" / "default"), null for none.
# Nullable with no database default (default=None) and no index, so on
# PostgreSQL the ADD COLUMN is a catalog-only change: it neither rewrites nor
# scans boards, and an older pod's INSERT that omits the column stores NULL,
# which is the "no board default" value every existing board keeps. The value
# set is enforced by the serializer, not by a database constraint.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0096_board_health_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="default_preset",
            field=models.CharField(
                blank=True,
                choices=[("classic", "Classic"), ("default", "Default")],
                default=None,
                help_text=(
                    "Id of the board preset members see by default (#1146): ``classic`` "
                    "or ``default``, or null for none. A member's own preset choice and a "
                    "``?preset=`` link both take precedence. Validated at the serializer layer."
                ),
                max_length=32,
                null=True,
            ),
        ),
    ]
