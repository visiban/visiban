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


_SIGNED_COOKIES_ENGINE = "django.contrib.sessions.backends.signed_cookies"


@checks.register(checks.Tags.security)
def check_session_engine_supports_ws_revocation(app_configs, **kwargs):
    """Warn when SESSION_ENGINE cannot support WebSocket credential revocation (#1483).

    An open board or group socket is closed at its access re-check once the
    session it connected with no longer exists (``accounts.ws_auth``). The
    ``signed_cookies`` engine keeps no server-side session, so a logout is not
    observable there and an open socket stays bound to a session that still
    decodes. A Warning, not an Error: it is a supported Django engine and the
    rest of the app works with it, but the operator should know.
    """
    from django.conf import settings

    if getattr(settings, "SESSION_ENGINE", "") != _SIGNED_COOKIES_ENGINE:
        return []
    return [
        checks.Warning(
            "SESSION_ENGINE is signed_cookies: a logout cannot be observed for "
            "WebSocket connections that are already open.",
            hint=(
                "Use the default database session engine (or a cache engine). "
                "To accept this deliberately, add \"accounts.W001\" to "
                "SILENCED_SYSTEM_CHECKS. See docs/api/websockets.md."
            ),
            id="accounts.W001",
        )
    ]


@checks.register(checks.Tags.security)
def check_frontend_url_outside_pending_action_gate(app_configs, **kwargs):
    """Fail if FRONTEND_URL points under a path the forced-change gate covers (#1551).

    ``visiban.middleware.PendingAccountActionMiddleware`` redirects a pending
    user on ``/accounts/`` and ``/admin/`` to ``FRONTEND_URL``. If that URL's
    path were itself under one of those prefixes, the redirect would land back
    on the gate and loop.
    """
    from urllib.parse import urlsplit

    from django.conf import settings

    from visiban.middleware import is_pending_action_gated_path

    frontend_url = getattr(settings, "FRONTEND_URL", "") or ""
    path = urlsplit(frontend_url).path or "/"
    if not is_pending_action_gated_path(path):
        return []
    return [
        checks.Error(
            f"FRONTEND_URL path {path!r} is under a path the forced-change gate redirects away from.",
            hint=(
                "Set FRONTEND_URL to the SPA origin (or a path outside /accounts/ and "
                "/admin/), otherwise a user with a pending password or username change "
                "is redirected in a loop."
            ),
            id="accounts.E003",
        )
    ]


@checks.register(checks.Tags.security)
def check_pending_action_extra_gated_prefixes(app_configs, **kwargs):
    """Fail on a malformed PENDING_ACTION_EXTRA_GATED_PREFIXES entry (#1551).

    The middleware ignores such an entry rather than guess at it, so the
    operator or extension author has to hear about it here.
    """
    from django.conf import settings

    from visiban.middleware import is_well_formed_gated_prefix

    extra = getattr(settings, "PENDING_ACTION_EXTRA_GATED_PREFIXES", ()) or ()
    if isinstance(extra, str):
        extra = (extra,)
    return [
        checks.Error(
            f"PENDING_ACTION_EXTRA_GATED_PREFIXES entry {prefix!r} is not a path prefix.",
            hint='Use a leading and trailing slash, for example "/sso/".',
            id="accounts.E004",
        )
        for prefix in extra
        if not is_well_formed_gated_prefix(prefix)
    ]
