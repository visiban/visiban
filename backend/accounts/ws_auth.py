"""Short-lived, single-use WebSocket tickets (#1109).

Channels' ``AuthMiddlewareStack`` resolves only the Django session cookie, so a
client holding a PAT or a DRF token can call every REST endpoint but cannot open
``ws/boards/<id>/`` or ``ws/groups/<id>/`` — the consumer closes it with 4001.
Session and CSRF cookies are ``SameSite=Lax``, so this also locks out any front
end served from a different origin, as well as native/CLI clients that have no
cookie jar at all.

The fix is a ticket, not a token in the URL: the caller proves who it is over
REST (any authentication class in ``DEFAULT_AUTHENTICATION_CLASSES``), receives a
one-shot credential, and spends it on the WebSocket upgrade.

Why not simply put the PAT in the query string: query strings are recorded in
reverse-proxy access logs (``$request`` in Nginx's default combined format) and
in proxy history. A long-lived PAT landing there is a credential leak with an
unbounded window. A ticket still travels in the query string — that exposure is
reduced, *not* eliminated — but it is single-use and expires in
``WS_TICKET_TTL`` seconds.

Be precise about what that does and does not buy. It is not "the logged value is
useless": a log-ingestion pipeline fast enough to read the access log and redeem
the ticket before the legitimate client's own upgrade lands would win the race
and connect as that user for one connection. Single use makes that failure
*loud* rather than silent — the real client is then closed with 4001 instead of
both connections succeeding — which is the right trade, but it is a trade, not
an elimination. Narrowing this further belongs at the proxy: drop the query
string from the access-log format for the WebSocket upgrade location.

The ticket **authenticates only**. Authorization is untouched: ``BoardConsumer``
and ``GroupConsumer`` still resolve the caller's role themselves and still close
with 4003 for a non-member, no matter how ``scope["user"]`` was populated.
"""

import hashlib
import secrets
from datetime import timedelta
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.middleware import BaseMiddleware
from django.core.cache import cache
from django.utils import timezone

# Seconds a ticket stays redeemable. Long enough to cover the round trip from
# the REST response to the WebSocket upgrade (including a slow mobile network),
# short enough that a ticket captured from an access log is already dead.
WS_TICKET_TTL = 30

WS_TICKET_CACHE_PREFIX = "ws_ticket:"

# Upper bound on the query-string value we are willing to hash. A real ticket is
# 43 characters (``secrets.token_urlsafe(32)``); anything far larger is a probe,
# and rejecting it early keeps an attacker from making us hash megabytes.
_MAX_TICKET_LENGTH = 512

# Upper bound on the raw query string we are willing to decode and parse at all.
# The handshake URLs this project issues carry one short parameter, so 1 KiB is
# generous. The bound matters because ``parse_qs`` will happily decode and split
# a multi-megabyte, densely ``&``-delimited string before any per-value check
# could fire. In the bundled deployment nginx's default
# ``large_client_header_buffers`` already rejects an oversized request line, but
# that backstop is absent when the ASGI server is reached directly — a bare
# ingress, or local development — so do not rely on it.
_MAX_QUERY_STRING_LENGTH = 1024


def _ticket_cache_key(raw_ticket: str) -> str:
    """Return the cache key for *raw_ticket*.

    The raw value is never stored — only its SHA-256 digest, mirroring how
    ``PersonalAccessToken`` and ``InviteLink`` persist their secrets. Anyone who
    can read the cache therefore still cannot open a connection.
    """
    digest = hashlib.sha256(raw_ticket.encode()).hexdigest()
    return f"{WS_TICKET_CACHE_PREFIX}{digest}"


def issue_ws_ticket(user):
    """Mint a single-use WebSocket ticket for *user*.

    Returns ``(raw_ticket, expires_at)``. The raw value is available here and in
    the HTTP response exactly once and is never recoverable afterwards — the
    same contract as ``PersonalAccessToken.generate``.
    """
    raw_ticket = secrets.token_urlsafe(32)
    expires_at = timezone.now() + timedelta(seconds=WS_TICKET_TTL)
    cache.set(_ticket_cache_key(raw_ticket), {"user_id": user.id}, WS_TICKET_TTL)
    return raw_ticket, expires_at


def consume_ws_ticket(raw_ticket: str):
    """Atomically spend *raw_ticket*, returning its ``user_id`` or ``None``.

    Returns ``None`` for a ticket that is missing, unknown, tampered with,
    expired (the cache entry is gone), or already spent.

    **The single-use guarantee lives in the ``cache.delete()`` return value, not
    in the ``cache.get()``.** Django's cache API has no atomic get-and-delete, so
    two concurrent connects racing on the same ticket will *both* see a payload
    from ``get()``. Only one of them can win ``delete()``: Redis ``DEL`` and
    ``LocMemCache.delete()`` (which holds a lock) each report whether *this*
    caller was the one that actually removed the key. Gating acceptance on that
    boolean — rather than on ``payload is not None`` — is what makes the claim
    atomic. Reversing the two, or trusting the payload alone, silently
    reintroduces the race and lets both connections in.

    This mirrors the first-writer-wins ``cache.add()`` claims in
    ``git_lens/views.py``; the primitive differs only because this is an
    issue-then-redeem flow rather than a lock acquisition.
    """
    if not raw_ticket or len(raw_ticket) > _MAX_TICKET_LENGTH:
        return None

    key = _ticket_cache_key(raw_ticket)
    payload = cache.get(key)
    if payload is None:
        return None
    if not cache.delete(key):
        # Another connection spent this ticket first — single use means this
        # caller loses, even though its get() succeeded a moment ago.
        return None
    return payload.get("user_id")


def _extract_ticket(query_string: bytes) -> str:
    """Pull the ``ticket`` parameter out of a raw ASGI query string.

    The length bound is checked against the raw bytes, before any decoding or
    parsing, so a hostile handshake cannot make us do that work on an arbitrarily
    large input. An over-long query string is treated as carrying no ticket,
    which falls through to the session path.
    """
    if not query_string or len(query_string) > _MAX_QUERY_STRING_LENGTH:
        return ""
    try:
        params = parse_qs(query_string.decode("utf-8"))
    except UnicodeDecodeError:
        return ""
    values = params.get("ticket") or []
    return values[0] if values else ""


@database_sync_to_async
def _resolve_ticket_user(raw_ticket: str):
    """Spend *raw_ticket* and return the matching active user, or ``None``."""
    from django.contrib.auth import get_user_model

    user_id = consume_ws_ticket(raw_ticket)
    if user_id is None:
        return None

    user_model = get_user_model()
    try:
        user = user_model.objects.get(pk=user_id)
    except user_model.DoesNotExist:
        return None

    # Re-check liveness at redemption. The account can be deactivated inside the
    # ticket's TTL, and a ticket must never outlive the access it stands for —
    # the same guard PATAuthentication applies on every REST call.
    if not user.is_active:
        return None
    return user


class TicketAuthMiddleware(BaseMiddleware):
    """Authenticate a WebSocket upgrade from a ``?ticket=`` query parameter.

    **Nesting matters, and is the opposite of what "in front of
    ``AuthMiddlewareStack``" suggests.** This middleware must sit *inside* the
    stack::

        AuthMiddlewareStack(TicketAuthMiddleware(URLRouter(...)))

    ``channels.auth.AuthMiddleware.populate_scope`` only creates
    ``scope["user"]`` when the key is absent, but ``resolve_scope`` then does an
    unconditional ``scope["user"]._wrapped = await get_user(scope)``. So an outer
    ticket middleware would have its work overwritten by the session lookup on
    every single connection — for a token client with no session that means
    ``AnonymousUser`` and a 4001, i.e. exactly the bug this module exists to fix.
    Running inside the stack means the session has already been resolved and this
    middleware gets the final say.

    With no ``?ticket=`` present the scope is passed through untouched, so the
    browser SPA's session-cookie handshake behaves exactly as it did before.
    """

    async def __call__(self, scope, receive, send):
        scope = dict(scope)
        raw_ticket = _extract_ticket(scope.get("query_string", b""))

        if raw_ticket:
            user = await _resolve_ticket_user(raw_ticket)
            if user is not None:
                scope["user"] = user
            else:
                # A ticket was presented and it did not check out. Fail closed
                # rather than falling back to whatever the session said: a
                # presented-but-invalid credential must not silently downgrade
                # to a different one. The consumer turns this into a 4001.
                #
                # Imported here, not at module scope, because this module is
                # imported from asgi.py during startup wiring.
                from django.contrib.auth.models import AnonymousUser

                scope["user"] = AnonymousUser()

        # The raw ticket is deliberately never logged, here or anywhere else —
        # it is a credential (repo rule: never log tokens or secrets).
        return await super().__call__(scope, receive, send)
