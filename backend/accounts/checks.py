from django.core import checks

_HINT = (
    "ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR must name "
    "accounts.tokens.VisibanPasswordResetTokenGenerator or a subclass of it "
    "(subclasses are accepted); a later settings include, such as the "
    "enterprise one, may have overridden it. To opt out deliberately, add "
    '"accounts.E001" to SILENCED_SYSTEM_CHECKS. See '
    "docs/architecture/open-core-boundary.md."
)


@checks.register(checks.Tags.security)
def check_password_reset_token_generator(app_configs, **kwargs):
    """Fail if the effective reset-token generator lost the #1337 address binding.

    ``visiban/settings.py`` sets ``ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR``, but
    the enterprise settings include (``from enterprise.settings import *``)
    runs after it and could replace it without anyone noticing: reset links
    would keep working, just without the binding. Checking the instances
    allauth actually built — the ones both redemption entry points use —
    catches any such override. Subclasses are accepted.

    Also refuses allauth's by-code reset flow (``PASSWORD_RESET_BY_CODE_ENABLED``):
    it ignores ``token_generator`` entirely and bypasses both the #1314
    reset-link gate and this binding.
    """
    try:
        from allauth.account import app_settings as allauth_settings
        from allauth.account import forms as allauth_forms

        from .tokens import VisibanPasswordResetTokenGenerator
    except Exception as exc:  # a broken import must surface as a check result, not a crash
        return [
            checks.Error(
                f"Could not inspect the password-reset token generator ({type(exc).__name__}).",
                hint=_HINT,
                id="accounts.E001",
            )
        ]

    user_token_form = getattr(allauth_forms, "UserTokenForm", None)
    generators = {
        "allauth.account.forms.default_token_generator": getattr(
            allauth_forms, "default_token_generator", None
        ),
        "allauth.account.forms.UserTokenForm.token_generator": getattr(
            user_token_form, "token_generator", None
        ),
    }
    errors = [
        checks.Error(
            f"{name} is {type(generator).__name__}, not a VisibanPasswordResetTokenGenerator.",
            hint=_HINT,
            id="accounts.E001",
        )
        for name, generator in generators.items()
        if not isinstance(generator, VisibanPasswordResetTokenGenerator)
    ]
    if getattr(allauth_settings, "PASSWORD_RESET_BY_CODE_ENABLED", False):
        errors.append(
            checks.Error(
                "ACCOUNT_PASSWORD_RESET_BY_CODE_ENABLED is on, but allauth's by-code "
                "reset flow bypasses Visiban's reset-link rules (#1314, #1337).",
                hint="Leave ACCOUNT_PASSWORD_RESET_BY_CODE_ENABLED off; the flow is unsupported.",
                id="accounts.E002",
            )
        )
    return errors
