from django.apps import AppConfig


class GitLensConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "git_lens"
    verbose_name = "Issue Board Lens"

    def ready(self):
        # Importing the providers module registers the built-in GitHub/GitLab
        # backends into the internal registry.
        #
        # The PUBLIC ``boards.hooks.GIT_LENS_PROVIDER_BACKENDS`` extension hook is
        # intentionally NOT shipped in this experiment: publishing it would freeze
        # a permanent 1.0+ enterprise contract for a feature that may be removed.
        # The internal registry keeps the provider seam clean and promotable to a
        # public hook at keep-time without forcing a fork in the meantime.
        from . import providers  # noqa: F401  (import triggers provider registration)
