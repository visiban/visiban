from django.apps import AppConfig


class WebhooksConfig(AppConfig):
    """Outbound webhooks over the board change feed (#863).

    Always installed, so the tables exist on every install and turning the
    feature on is a setting change rather than a migration. ``WEBHOOKS_ENABLED``
    gates it at runtime: the API refuses every action but ``status/`` and the
    dispatcher exits without writing anything.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "webhooks"
    verbose_name = "Webhooks"

    def ready(self):
        from . import checks  # noqa: F401  (registers the system checks)
