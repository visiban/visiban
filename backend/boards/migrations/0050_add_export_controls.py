"""Add per-board export threshold and export audit log (#842, #843)."""
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0049_backfill_residual_action_type"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="board",
            name="export_min_role",
            field=models.CharField(
                default="viewer",
                help_text=(
                    "Minimum BoardMembership.Role required to export this board (#843). "
                    "Default ``viewer`` preserves pre-1.1 behavior where every role with "
                    "read access can export. Owners and site admins always bypass this "
                    "threshold. The valid values are viewer / collaborator / member / "
                    "admin — validated at the serializer layer so the DB column stays "
                    "a simple CharField that will accept future values without a "
                    "schema migration."
                ),
                max_length=20,
            ),
        ),
        migrations.CreateModel(
            name="BoardExportLog",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "role_at_export",
                    models.CharField(
                        help_text=(
                            "Board role the actor held when the export ran. "
                            "One of: viewer, collaborator, member, admin, owner, site_admin. "
                            "Captured verbatim so later role changes do not rewrite history."
                        ),
                        max_length=20,
                    ),
                ),
                (
                    "export_format",
                    models.CharField(
                        help_text="Export format string as requested (e.g. ``json`` / ``csv``).",
                        max_length=20,
                    ),
                ),
                (
                    "row_count",
                    models.PositiveIntegerField(
                        help_text="Number of cards included in the export payload."
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "board",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="export_logs",
                        to="boards.board",
                    ),
                ),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.deletion.SET_NULL,
                        related_name="board_export_logs",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "board_export_logs",
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["board", "-created_at"], name="bel_board_created_idx"),
                ],
            },
        ),
    ]
