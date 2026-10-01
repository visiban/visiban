from django.core import checks


@checks.register(checks.Tags.security)
def check_password_reset_token_generator(app_configs, **kwargs):
    """Fail if the effective reset-token generator lost the #1337 address binding.

    ``visiban/settings.py`` sets ``ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR``, but
    the enterprise settings include (``from enterprise.settings import *``)
    runs after it and could replace it without anyone noticing: reset links
    would keep working, just without the binding. Checking the instance
    allauth actually built — the one both redemption entry points use —
    catches any such override. Subclasses are accepted.
    """
    from allauth.account import forms as allauth_forms

    from .tokens import VisibanPasswordResetTokenGenerator

    generators = {
        "allauth.account.forms.default_token_generator": allauth_forms.default_token_generator,
        "allauth.account.forms.UserTokenForm.token_generator": allauth_forms.UserTokenForm.token_generator,
    }
    return [
        checks.Error(
            f"{name} is {type(generator).__name__}, not a VisibanPasswordResetTokenGenerator.",
            hint=(
                "ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR must name "
                "accounts.tokens.VisibanPasswordResetTokenGenerator (or a subclass); "
                "a later settings include may have overridden it."
            ),
            id="accounts.E001",
        )
        for name, generator in generators.items()
        if not isinstance(generator, VisibanPasswordResetTokenGenerator)
    ]
