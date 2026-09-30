from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"

    def ready(self):
        from .signals import _connect_user_signals
        _connect_user_signals()

        from allauth.account.signals import email_confirmed

        from .email_change import apply_confirmed_email_change

        email_confirmed.connect(
            apply_confirmed_email_change,
            dispatch_uid="accounts.apply_confirmed_email_change",
        )
