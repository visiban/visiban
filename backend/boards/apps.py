from django.apps import AppConfig


class BoardsConfig(AppConfig):
    name = "boards"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        import boards.signals  # noqa: F401
