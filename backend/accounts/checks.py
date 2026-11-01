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
                "SILENCED_SYSTEM_CHECKS (set the SILENCED_SYSTEM_CHECKS "
                "environment variable; Helm: backend.settings.silencedSystemChecks). "
                "See docs/api/websockets.md."
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


_PENDING_ACTION_MIDDLEWARE = "visiban.middleware.PendingAccountActionMiddleware"
_AUTHENTICATION_MIDDLEWARE = "django.contrib.auth.middleware.AuthenticationMiddleware"


def _middleware_index(middleware, target) -> int | None:
    """Index of *target* in *middleware*, accepting a subclass named by another path.

    An entry that cannot be imported is matched by its dotted name only, so an
    unusual middleware module yields a check result rather than an exception.
    """
    from django.core.exceptions import ImproperlyConfigured
    from django.utils.module_loading import import_string

    target_class = import_string(target)
    for index, dotted in enumerate(middleware):
        if dotted == target:
            return index
        try:
            candidate = import_string(dotted)
        except (ImportError, ImproperlyConfigured):
            continue
        if isinstance(candidate, type) and issubclass(candidate, target_class):
            return index
    return None


@checks.register(checks.Tags.security)
def check_pending_action_middleware_installed(app_configs, **kwargs):
    """Require the forced-change gate in MIDDLEWARE (#1561, registry Rule 1).

    ``visiban/settings.py`` installs ``PendingAccountActionMiddleware``, and a
    later settings include (the enterprise one) can replace ``MIDDLEWARE``
    wholesale. This check keeps the gate installed and ordered after
    ``AuthenticationMiddleware``, which sets the ``request.user`` it reads. A
    subclass is accepted.
    """
    from django.conf import settings

    middleware = list(getattr(settings, "MIDDLEWARE", None) or [])
    hint = (
        f'Keep "{_PENDING_ACTION_MIDDLEWARE}" in MIDDLEWARE, after '
        f'"{_AUTHENTICATION_MIDDLEWARE}". See docs/development/security-invariants.md, Rule 1.'
    )
    gate = _middleware_index(middleware, _PENDING_ACTION_MIDDLEWARE)
    if gate is None:
        return [
            checks.Error(
                "MIDDLEWARE does not include PendingAccountActionMiddleware.",
                hint=hint,
                id="accounts.E005",
            )
        ]
    auth = _middleware_index(middleware, _AUTHENTICATION_MIDDLEWARE)
    if auth is None or gate < auth:
        return [
            checks.Error(
                "PendingAccountActionMiddleware must come after AuthenticationMiddleware in MIDDLEWARE.",
                hint=hint,
                id="accounts.E005",
            )
        ]
    return []


# One stable ID per command so SILENCED_SYSTEM_CHECKS can waive each
# independently (#1824); IDs are never reused or renumbered.
_OPERATOR_COMMANDS = (
    ("changepassword", "accounts.E008"),
    ("createsuperuser", "accounts.E009"),
)


@checks.register(checks.Tags.security)
def check_operator_changepassword_command(app_configs, **kwargs):
    """Fail if an operator command does not resolve to the project's command (registry Rule 3).

    Covers ``changepassword`` (token revocation on the operator reset path) and
    ``createsuperuser`` (the admin action log entry, #1801). Both are provided
    by ``operator_commands``, which must precede ``django.contrib.auth`` in
    ``INSTALLED_APPS``. A later settings include (the enterprise one) can
    replace ``INSTALLED_APPS`` wholesale and silently restore Django's command.
    ``changepassword`` reports ``accounts.E008`` and ``createsuperuser`` reports
    ``accounts.E009``.
    """
    from django.core.management import get_commands

    commands = get_commands()
    errors = []
    for name, check_id in _OPERATOR_COMMANDS:
        provider = commands.get(name)
        if provider == "operator_commands":
            continue
        errors.append(
            checks.Error(
                f"The {name} command is provided by {provider!r}, not by operator_commands.",
                hint=(
                    'Keep "operator_commands" in INSTALLED_APPS, before "django.contrib.auth". '
                    "See docs/development/security-invariants.md, Rule 3."
                ),
                id=check_id,
            )
        )
    return errors


@checks.register(checks.Tags.security)
def check_pending_action_extra_exempt_views(app_configs, **kwargs):
    """Fail on a malformed PENDING_ACTION_EXTRA_EXEMPT_VIEWS entry (#1561).

    Each entry must name exactly one view; the middleware ignores anything
    else rather than guess, so the extension author has to hear about it here.
    """
    from django.conf import settings

    from visiban.middleware import is_well_formed_exempt_view

    extra = getattr(settings, "PENDING_ACTION_EXTRA_EXEMPT_VIEWS", ()) or ()
    if isinstance(extra, str):
        extra = (extra,)
    return [
        checks.Error(
            f"PENDING_ACTION_EXTRA_EXEMPT_VIEWS entry {name!r} is not a view name.",
            hint='Use one exact URL name (for example "saml_acs" or "myapp:callback"), no wildcards or paths.',
            id="accounts.E006",
        )
        for name in extra
        if not is_well_formed_exempt_view(name)
    ]


@checks.register(checks.Tags.security)
def check_pending_action_extra_exempt_views_not_oss_gated(app_configs, **kwargs):
    """Fail on a PENDING_ACTION_EXTRA_EXEMPT_VIEWS entry that names an OSS-gated view (#1589, #1593).

    The setting exists for an extension package's OWN views. Exempting an
    OSS session view (the admin index, allauth's email management) would let
    an account with a forced change pending bypass the gate, so a trusted
    operator's typo or a careless extension must fail at startup, not widen
    the gate silently. Views already exempt in OSS are harmless to repeat and
    are allowed. Admission rule: a view may be exempt only if anonymous users
    reach it with the same effect, or it gates itself. "OSS-gated" covers
    every view that can serve a path under ``/accounts/`` or ``/admin/``
    (regex and converter mounts included) and every OSS view under a
    ``PENDING_ACTION_EXTRA_GATED_PREFIXES`` entry; see
    ``visiban.middleware.oss_gated_view_names``.
    """
    from django.conf import settings

    from visiban.middleware import (
        PENDING_ACTION_EXEMPT_VIEWS,
        is_well_formed_exempt_view,
        oss_gated_view_names,
    )

    extra = getattr(settings, "PENDING_ACTION_EXTRA_EXEMPT_VIEWS", ()) or ()
    if isinstance(extra, str):
        extra = (extra,)
    # Malformed entries are accounts.E006's business.
    candidates = [n for n in extra if is_well_formed_exempt_view(n)]
    if not candidates:
        return []
    oss_gated = oss_gated_view_names() - PENDING_ACTION_EXEMPT_VIEWS
    return [
        checks.Error(
            f"PENDING_ACTION_EXTRA_EXEMPT_VIEWS entry {name!r} names a gated view that is not the extension's own.",
            hint=(
                "Only an extension's own views may be exempt, and only if an anonymous visitor "
                "reaches them with the same effect or they apply the forced-change gate themselves. "
                "A name shared with a view under /accounts/ or /admin/, or with an OSS view under "
                "an extra gated prefix, is rejected even when your view is mounted elsewhere; "
                "rename your URL, and register it through the root URLconf's extension point "
                "(extension_urlpatterns). See docs/development/authorization-entry-points.md."
            ),
            id="accounts.E007",
        )
        for name in candidates
        if name in oss_gated
    ]


@checks.register(checks.Tags.security)
def check_wildcard_allowed_hosts(app_configs, **kwargs):
    """Warn when browser WebSockets would be refused for lack of a listed origin (#1697).

    The WebSocket Origin check (``accounts.ws_origin``) no longer applies ``*``
    or leading-dot ``ALLOWED_HOSTS`` entries; a present Origin must equal a
    configured origin or an exact ``ALLOWED_HOSTS`` host. An install that
    relies on a pattern entry and lists no exact public host or non-loopback origin in
    ``CORS_ALLOWED_ORIGINS`` / ``CSRF_TRUSTED_ORIGINS`` would have every browser
    WebSocket refused after upgrading, so this flags exactly that setup. A
    Warning, not an Error: the rest of the app works, and failing
    ``manage.py check`` on an existing install would turn an upgrade into an
    outage. Skipped when ``DEBUG`` is on.
    """
    from urllib.parse import urlsplit

    from django.conf import settings

    from .ws_origin import exact_host

    if settings.DEBUG:
        return []
    hosts = getattr(settings, "ALLOWED_HOSTS", None) or []
    if not any(h and exact_host(h) is None for h in hosts):
        return []
    loopback = {"localhost", "127.0.0.1", "::1"}

    def is_public(host):
        # An empty or wildcard host never matches a real Origin.
        return bool(host) and "*" not in host and host not in loopback

    # An exact public ALLOWED_HOSTS entry still matches browser origins.
    # Classified by the same normalizer the matcher uses.
    if any(is_public(exact_host(h)) for h in hosts if h):
        return []
    origins = [
        *(getattr(settings, "CORS_ALLOWED_ORIGINS", None) or []),
        *(getattr(settings, "CSRF_TRUSTED_ORIGINS", None) or []),
    ]
    if any(is_public(urlsplit(o).hostname or "") for o in origins):
        return []
    return [
        checks.Warning(
            "ALLOWED_HOSTS uses a wildcard entry and no public origin is listed, "
            "so browser WebSocket connections will be refused.",
            hint=(
                "List your public origin (for example https://boards.example.com) "
                "in CORS_ALLOWED_ORIGINS or CSRF_TRUSTED_ORIGINS, or list exact "
                "hostnames in ALLOWED_HOSTS. If intended, silence with the "
                "SILENCED_SYSTEM_CHECKS=accounts.W002 environment variable "
                "(Helm: backend.settings.silencedSystemChecks). "
                "See docs/api/websockets.md."
            ),
            id="accounts.W002",
        )
    ]
