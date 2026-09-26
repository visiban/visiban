"""Outbound email configuration resolution and the DB-aware mail backend (#306).

Why a custom EMAIL_BACKEND rather than per-call-site wiring
-----------------------------------------------------------
Nothing in this repo calls ``send_mail`` / ``EmailMessage`` / ``get_connection``
directly. The only sender is django-allauth: ``accounts/forms.py`` calls
``adapter.send_mail(...)``, and allauth's confirmation flow sends internally
without passing through any Visiban code. Intercepting per call site would mean
patching another library's internals in two places and would still miss
whatever allauth adds next.

A single backend assigned to ``EMAIL_BACKEND`` sits underneath every sender —
allauth's internal sends, the admin test endpoint, and any future caller — with
zero call-site changes.

Preserving the env var's meaning (backward compatibility)
---------------------------------------------------------
``CLAUDE.md`` forbids changing an existing env var's default in a way that
alters behavior for existing installs. ``EMAIL_BACKEND`` is threaded to respect
that exactly:

* If the operator **explicitly set** ``EMAIL_BACKEND``, it is honored verbatim
  and this module never runs. DB configuration is ignored entirely and the API
  reports ``effective_source='env_backend_override'``. An operator who pointed
  the variable at a third-party relay keeps that relay.
* Only when ``EMAIL_BACKEND`` is unset does this backend become the default —
  and it then reproduces today's behavior precisely: the console backend under
  ``DEBUG``, SMTP from the ``EMAIL_*`` variables otherwise.

Without that split, a development install running the console backend could
silently start sending real mail.
"""
import logging
import smtplib
import socket
import ssl

from django.conf import settings
from django.views.decorators.debug import sensitive_variables
from django.db import OperationalError, ProgrammingError
from django.core.mail.backends.base import BaseEmailBackend
from django.core.mail.backends.console import EmailBackend as ConsoleEmailBackend
from django.core.mail.backends.smtp import EmailBackend as SMTPEmailBackend

logger = logging.getLogger(__name__)

# Sanitized failure taxonomy returned by the admin test endpoint. These strings
# are a public contract the SPA switches on — add values freely, never rename or
# remove one. The raw smtplib error is deliberately NOT among them: some MTAs
# echo the offending protocol line back in the error text, which on an AUTH
# failure can carry base64-encoded credentials.
ERROR_DNS_FAILURE = "dns_failure"
ERROR_CONNECTION_REFUSED = "connection_refused"
ERROR_TLS_FAILURE = "tls_failure"
ERROR_AUTH_FAILED = "auth_failed"
ERROR_TIMEOUT = "timeout"
ERROR_UNKNOWN = "unknown"
ERROR_CONFIG_UNUSABLE = "config_unusable"
# The operator pinned EMAIL_BACKEND, so neither source is consulted for real
# mail and a test send here would exercise a path production never uses.
ERROR_BACKEND_PINNED = "backend_pinned"

PLACEHOLDER_FROM_DOMAINS = ("example.com",)


class EmailConfigUnusable(Exception):
    """The selected email configuration cannot be used to send mail.

    Carries a machine-readable ``code`` from the taxonomy above plus an
    operator-facing ``detail``. Raised rather than silently falling back to the
    other source: when an admin has explicitly selected database configuration,
    re-routing their mail through a *different server than they chose* is worse
    than not sending it. Silently delivering password-reset mail via an
    unintended relay is not a recoverable mistake.
    """

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


class ResolvedEmailConfig:
    """A flat, source-tagged view of the SMTP settings actually in effect."""

    def __init__(self, *, source, host, port, username, password, use_tls, use_ssl,
                 from_email, timeout):
        self.source = source
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.use_tls = use_tls
        self.use_ssl = use_ssl
        self.from_email = from_email
        self.timeout = timeout

    def __repr__(self):  # pragma: no cover - diagnostics only
        # Never interpolates the password. This object ends up in tracebacks.
        return (
            f"<ResolvedEmailConfig source={self.source} host={self.host!r} "
            f"port={self.port} use_tls={self.use_tls} use_ssl={self.use_ssl}>"
        )


def env_email_config() -> ResolvedEmailConfig:
    """The configuration expressed by the EMAIL_* environment variables."""
    return ResolvedEmailConfig(
        source="env",
        host=settings.EMAIL_HOST,
        port=settings.EMAIL_PORT,
        username=settings.EMAIL_HOST_USER,
        password=settings.EMAIL_HOST_PASSWORD,
        use_tls=settings.EMAIL_USE_TLS,
        use_ssl=getattr(settings, "EMAIL_USE_SSL", False),
        from_email=settings.DEFAULT_FROM_EMAIL,
        # None means "no explicit socket timeout", which is Django's own
        # default and what env-configured installs had before #306.
        timeout=getattr(settings, "EMAIL_TIMEOUT", None),
    )


def _checked(config: ResolvedEmailConfig) -> ResolvedEmailConfig:
    """Refuse to send from the shipped placeholder sender address.

    This is where the guard demoted from import time in ``settings.py`` is
    actually enforced. It lives in ``build_smtp_backend`` — the single point
    where an SMTP connection is constructed — rather than in
    ``resolve_email_config``.

    That placement is deliberate and was got wrong once: checking during
    *resolution* also caught the console backend, which broke every outbound
    email on a stock development install (``.env.example`` ships ``DEBUG=true``
    and no ``DEFAULT_FROM_EMAIL``, so the placeholder default applies). Printing
    a message to stdout is not delivering mail from a domain you do not own, so
    the check has no business firing there. Django's test runner swaps in the
    locmem backend, so no suite catches that class of mistake — only a test
    instantiating ``DatabaseAwareEmailBackend`` directly does.

    The realistic failure it catches is a partial environment config: an
    operator sets EMAIL_HOST/EMAIL_HOST_USER/EMAIL_HOST_PASSWORD against a real
    relay but forgets DEFAULT_FROM_EMAIL. Without this check the instance
    happily sends live password-reset mail from ``noreply@example.com`` — a
    domain they do not control — so the messages fail SPF/DMARC alignment and
    are dropped or spam-foldered, and account recovery silently stops working.
    Failing loudly is strictly better than delivering undeliverable mail.
    """
    if sender_is_placeholder(config.from_email):
        raise EmailConfigUnusable(
            ERROR_CONFIG_UNUSABLE,
            "The sender address is still the example.com placeholder. Set "
            "DEFAULT_FROM_EMAIL, or configure a sender address in "
            "Admin → Settings → Email.",
        )
    return config


def sender_is_placeholder(from_email: str) -> bool:
    """True when the sender address is still the shipped placeholder.

    Enforced here and in the admin serializer rather than at import time — see
    the note in ``visiban/settings.py`` about why the boot-time guard was
    demoted to a warning.
    """
    lowered = (from_email or "").lower()
    return any(domain in lowered for domain in PLACEHOLDER_FROM_DOMAINS)


@sensitive_variables("password")
def resolve_email_config(cfg=None, *, need_password: bool = True) -> ResolvedEmailConfig:
    """Return the configuration that should be used for the next send.

    All-or-nothing per source: fields are never merged across env and database.
    A field-level merge is exactly how a half-filled row silently breaks mail,
    and it produces states no operator can reason about.

    ``cfg`` lets a caller that already holds the singleton pass it in rather
    than triggering a second fetch of the same row.

    ``need_password=False`` resolves everything except the credential, for
    callers that only want to report *which* configuration is in effect. That
    is a security-hygiene switch more than a performance one: the admin GET
    payload has no use for the plaintext password, and decrypting a secret in
    order to discard it puts it in a local variable — and therefore in any
    traceback captured from that frame — for no reason.

    NOTE for a future bulk sender: this runs per ``send_messages()`` call, so a
    loop that sends N messages pays N queries and N key derivations. The only
    send loop today (``accounts/forms.py``) is bounded to ~1 iteration by
    ``ACCOUNT_UNIQUE_EMAIL``. A digest or bulk-invite feature should resolve
    once per batch and reuse the connection, not call this per message.
    """
    from accounts.models import SiteEmailSetting
    from visiban.crypto import SecretDecryptionError

    try:
        if cfg is None:
            cfg = SiteEmailSetting.get()
    except (OperationalError, ProgrammingError):
        # Narrow on purpose. A missing table (mid-migration, or a management
        # command running before migrate) must not make the app unable to send
        # mail at all — but a bare `except Exception` would also swallow a
        # transient deadlock or connection blip and silently re-route the
        # admin's mail through a server they did not choose, which is the exact
        # outcome EmailConfigUnusable exists to prevent.
        logger.warning("SiteEmailSetting unavailable; falling back to environment config")
        return env_email_config()

    if cfg.config_source != SiteEmailSetting.ConfigSource.DATABASE:
        return env_email_config()

    if not cfg.db_config_is_complete():
        raise EmailConfigUnusable(
            ERROR_CONFIG_UNUSABLE,
            "Email is set to use the configuration stored in the admin UI, but it is "
            "incomplete. Set a host and a sender address in Admin → Settings → Email.",
        )

    if not need_password:
        # Still report the row as unusable when the key changed — the caller
        # needs that fact — but learn it from the stored fingerprint rather
        # than by decrypting.
        if not cfg.password_decryptable:
            raise EmailConfigUnusable(
                ERROR_CONFIG_UNUSABLE,
                "The stored SMTP password could not be decrypted because the instance "
                "encryption key changed. Re-enter the password in Admin → Settings → Email.",
            )
        password = ""
    else:
        try:
            password = cfg.get_password()
        except SecretDecryptionError:
            # The actionable string asked for by the #306 architect review.
            # Logged at ERROR because nothing else in the system will ever
            # connect "password resets stopped arriving" back to a rotation.
            logger.error(
                "stored SMTP password could not be decrypted (encryption key changed) — "
                "re-enter it in Admin → Settings → Email"
            )
            raise EmailConfigUnusable(
                ERROR_CONFIG_UNUSABLE,
                "The stored SMTP password could not be decrypted because the instance "
                "encryption key changed. Re-enter the password in Admin → Settings → Email.",
            ) from None

    return ResolvedEmailConfig(
        source="database",
        host=cfg.host,
        port=cfg.port,
        username=cfg.username,
        password=password,
        use_tls=cfg.use_tls,
        use_ssl=cfg.use_ssl,
        from_email=cfg.from_email,
        timeout=cfg.timeout or 10,
    )


def build_smtp_backend(config: ResolvedEmailConfig, **kwargs) -> SMTPEmailBackend:
    """Construct Django's SMTP backend from a resolved configuration.

    Every real SMTP send funnels through here, which is why the placeholder
    sender check lives at this point rather than during resolution.
    """
    config = _checked(config)
    return SMTPEmailBackend(
        host=config.host,
        port=config.port,
        username=config.username or None,
        password=config.password or None,
        use_tls=config.use_tls,
        use_ssl=config.use_ssl,
        timeout=config.timeout,
        **kwargs,
    )


def classify_smtp_error(exc: BaseException) -> str:
    """Map an exception from a send attempt onto the sanitized taxonomy.

    Never returns any part of the exception text — see the note on the taxonomy
    constants above.
    """
    if isinstance(exc, EmailConfigUnusable):
        return exc.code
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return ERROR_AUTH_FAILED
    if isinstance(exc, socket.gaierror):
        return ERROR_DNS_FAILURE
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return ERROR_TIMEOUT
    if isinstance(exc, ConnectionRefusedError):
        return ERROR_CONNECTION_REFUSED
    if isinstance(exc, (ssl.SSLError, smtplib.SMTPNotSupportedError)):
        return ERROR_TLS_FAILURE
    if isinstance(exc, smtplib.SMTPConnectError):
        return ERROR_CONNECTION_REFUSED
    if isinstance(exc, smtplib.SMTPServerDisconnected):
        return ERROR_TLS_FAILURE
    if isinstance(exc, OSError):
        return ERROR_CONNECTION_REFUSED
    return ERROR_UNKNOWN


class DatabaseAwareEmailBackend(BaseEmailBackend):
    """Default ``EMAIL_BACKEND`` — delegates to whichever source is in effect.

    Resolution happens per ``send_messages`` call, not at construction, so an
    admin changing the configuration takes effect on the very next send with no
    restart. That is the whole point of #306.

    Under ``DEBUG`` with no database configuration selected this delegates to
    the console backend, preserving today's development behavior exactly.

    ``timeout`` (added for #356) is a *floor*, not an override: it is applied
    only when the resolved configuration expresses no socket timeout of its own.
    ``EMAIL_TIMEOUT`` defaults to ``None`` deliberately (see the note in
    ``settings.py``), which leaves env-configured installs with no timeout at
    all — fine for account mail sent from a form submission, not fine for
    notification mail sent from the card-mutation path, where a blackholed SMTP
    port would hang a worker. A caller that needs a bounded send passes one;
    an operator who configured a timeout keeps theirs.

    Django instantiates email backends via ``get_connection(**kwargs)``, and
    ``BaseEmailBackend.__init__`` silently swallows unknown keyword arguments —
    so this has to be accepted explicitly or it would be accepted and ignored.
    """

    def __init__(self, *, timeout=None, **kwargs):
        super().__init__(**kwargs)
        self._timeout_floor = timeout

    def send_messages(self, email_messages):
        if not email_messages:
            return 0

        config = resolve_email_config()
        if config.timeout is None and self._timeout_floor is not None:
            config.timeout = self._timeout_floor

        if config.source == "env" and settings.DEBUG:
            backend = ConsoleEmailBackend(fail_silently=self.fail_silently)
        else:
            backend = build_smtp_backend(config, fail_silently=self.fail_silently)

        # Stamp the resolved sender on any message that did not set one
        # explicitly. Django applies DEFAULT_FROM_EMAIL at construction time,
        # so a database-configured sender would otherwise never be used.
        if config.from_email:
            for message in email_messages:
                if not message.from_email or message.from_email == settings.DEFAULT_FROM_EMAIL:
                    message.from_email = config.from_email

        return backend.send_messages(email_messages)
