import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class BoardsConfig(AppConfig):
    name = "boards"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        import boards.signals  # noqa: F401

        from django.db.models.signals import post_migrate

        def _sync_board_templates(sender, **kwargs):
            # Guard against the table not existing yet (e.g. a management
            # command run before the boards app's own migrations have
            # applied) and against a misbehaving TEMPLATE_PROVIDERS callable
            # (already caught individually in template_sync, but a defensive
            # outer guard keeps `migrate` itself from failing on anything
            # unexpected here) — this is startup/deploy plumbing, not a
            # request path, so fail soft and log rather than block.
            try:
                from boards.template_sync import sync_board_templates
                sync_board_templates()
            except Exception:
                logger.warning("sync_board_templates() failed after migrate", exc_info=True)

        # Only fire for this app's own migrations, not e.g. every unrelated
        # app's post_migrate during a full `migrate` run (#1115).
        post_migrate.connect(_sync_board_templates, sender=self, dispatch_uid="boards_sync_templates")
