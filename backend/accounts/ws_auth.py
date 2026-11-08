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

Credential binding (#1483)
--------------------------
An open socket outlives the handshake that authenticated it, so it must be
tied to the credential that authenticated it: logging out, changing the
password, revoking a PAT or deleting the session closes the socket at the
consumers' periodic access re-check (#1477).

Every authenticated socket records, in ``scope[WS_CREDENTIAL_SCOPE_KEY]``,
the credential that let it in: the session for a cookie handshake, or for a
ticket handshake whatever credential minted the ticket (session, PAT or DRF
token). ``load_live_ws_user`` — called from both consumers' re-check — fails
closed unless that credential is still live *and* the password has not changed
since the handshake. See ``ws_credential_is_live`` for the per-kind rules.

Why record-and-recheck rather than have logout and password change broadcast a
per-user eviction: the re-check already runs (throttled, fail-closed) on every
forwarded frame (and keepalive ping) past the window, so this costs one extra
indexed lookup per window and needs no new channel-layer group or event type. A broadcast would
also miss every revocation path that does not go through a view — an admin
deleting a session row or a PAT, ``clearsessions``, a token expiring.

SECRET_KEY rotation: the session auth hash is an HMAC keyed by SECRET_KEY, so
after a rotation that does not list the old key in ``SECRET_KEY_FALLBACKS``
no recorded hash or session hash matches any more, and every open socket
closes once with 4003 at its next re-check. That is deliberate fail-closed
behavior, the same outcome as Django logging every session out; with the old
key in ``SECRET_KEY_FALLBACKS`` sockets stay open, as sessions do.

Outages at the handshake (#2086)
--------------------------------
A handshake whose authentication cannot be *evaluated* — the cache or the
database raised while redeeming a ticket, or the cache-only session backend
raised while reading the cookie's session — is refused with
``CLOSE_AUTH_UNAVAILABLE`` (1011), never with 4001 and never admitted. 4001
tells a client its credential is gone (the web app signs the user out on it);
an outage says nothing about the credential. 1011 is the code the consumers
already use when their mid-stream re-check cannot complete (#2003, #2014), so
the same "server error, retry" reading holds before and after accept.

Transport caveat: every refusal here happens before accept. The ASGI spec has
the server answer a close before accept with HTTP 403, and Daphne does so
whatever the code, so no client ever receives 4001 or 1011 from a handshake
(a browser reports a failed upgrade, 1006). The code is therefore only the
application's verdict: what the ASGI test communicator observes and what a
future accept-then-close handshake would deliver (#2145). The refusal must
still not raise: an exception here is a Daphne 500 whose log line carries the
exception message.

The handshake-time outages that raise outside this middleware —
``cached_db`` during a cache outage (its ``load()`` falls back to the
database, then the cache write-back raises), the ``db`` engine during a
database outage, and the consumers' connect() lookups — are refused the same
way by ``HandshakeOutageMiddleware``, which wraps ``AuthMiddlewareStack`` and
the router (#2144).
"""

import hashlib
import logging
import secrets
from datetime import timedelta
from importlib import import_module
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.middleware import BaseMiddleware
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from django.utils.crypto import constant_time_compare

from visiban.authorization import INACTIVE, authorize_account

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


# Scope key under which the auth layer records the credential an authenticated
# socket was admitted with (#1483). Namespaced so it cannot collide with a key
# Channels or a future middleware adds.
WS_CREDENTIAL_SCOPE_KEY = "visiban.ws_credential"

CREDENTIAL_SESSION = "session"
CREDENTIAL_PAT = "pat"
CREDENTIAL_TOKEN = "token"
_CREDENTIAL_KINDS = (CREDENTIAL_SESSION, CREDENTIAL_PAT, CREDENTIAL_TOKEN)

# HKDF domain-separation label for sealing a session key inside a ticket's cache
# payload. Its own label, per visiban.crypto's rule that no two secrets share
# key material.
_TICKET_SESSION_INFO = b"visiban.ws-ticket-session-key.v1"

# Close code for a handshake whose authentication could not be evaluated
# (#2086, see the module docstring). Same value as the consumers'
# CLOSE_ACCESS_CHECK_FAILED; restated rather than imported because
# boards.consumers imports this module.
CLOSE_AUTH_UNAVAILABLE = 1011

logger = logging.getLogger(__name__)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def session_credential(session_key: str) -> dict:
    """Credential descriptor for a Django session. ``ref`` is the session key.

    The key is a bearer secret: it lives in this descriptor only in process
    memory (the connection scope) and is sealed before it goes anywhere else.
    """
    return {"kind": CREDENTIAL_SESSION, "ref": session_key}


def pat_credential(pat) -> dict:
    """Credential descriptor for a ``PersonalAccessToken`` (by primary key)."""
    return {"kind": CREDENTIAL_PAT, "ref": pat.pk}


def token_credential(token) -> dict:
    """Credential descriptor for a DRF ``authtoken.Token``.

    DRF's Token primary key *is* the raw secret, so only its digest is kept.
    """
    return {"kind": CREDENTIAL_TOKEN, "ref": _sha256(token.key)}


def credential_for_request(request):
    """The credential descriptor that authenticated a DRF *request*, or ``None``.

    ``None`` means the request was authenticated by something whose later
    revocation this module cannot observe (e.g. a future authentication class).
    The ticket endpoint refuses such a request rather than mint a ticket that
    could never be revoked from the socket side — fail closed.
    """
    from rest_framework.authtoken.models import Token

    from .models import PersonalAccessToken

    from .credentials import request_is_interactive_session

    auth = request.auth
    if isinstance(auth, PersonalAccessToken):
        return pat_credential(auth)
    if isinstance(auth, Token):
        return token_credential(auth)
    # The shared positive session check: an authenticator that returns no
    # credential object is not a session, even on a request with a session cookie.
    if request_is_interactive_session(request):
        session = getattr(request, "session", None)
        session_key = getattr(session, "session_key", None)
        if session_key:
            return session_credential(session_key)
    return None


def _seal_credential(credential: dict) -> dict:
    """Make *credential* safe to put in the shared cache.

    A session key is encrypted (visiban.crypto, its own HKDF label) so that
    reading the cache still yields nothing that can be presented anywhere —
    the same property the ticket digest key gives the ticket itself. PAT
    primary keys and Token digests are not secrets and pass through.
    """
    from visiban.crypto import encrypt_secret

    if credential["kind"] == CREDENTIAL_SESSION:
        return {
            "kind": CREDENTIAL_SESSION,
            "sealed_ref": encrypt_secret(credential["ref"], info=_TICKET_SESSION_INFO),
        }
    return {"kind": credential["kind"], "ref": credential["ref"]}


def _unseal_credential(sealed):
    """Inverse of ``_seal_credential``; ``None`` for anything malformed."""
    from visiban.crypto import SecretDecryptionError, decrypt_secret

    if not isinstance(sealed, dict) or sealed.get("kind") not in _CREDENTIAL_KINDS:
        return None
    if sealed["kind"] == CREDENTIAL_SESSION:
        try:
            session_key = decrypt_secret(sealed.get("sealed_ref") or "", info=_TICKET_SESSION_INFO)
        except SecretDecryptionError:
            return None
        return session_credential(session_key) if session_key else None
    if not sealed.get("ref"):
        return None
    return {"kind": sealed["kind"], "ref": sealed["ref"]}


def _ticket_cache_key(raw_ticket: str) -> str:
    """Return the cache key for *raw_ticket*.

    The raw value is never stored — only its SHA-256 digest, mirroring how
    ``PersonalAccessToken`` and ``InviteLink`` persist their secrets. Anyone who
    can read the cache therefore still cannot open a connection.
    """
    digest = hashlib.sha256(raw_ticket.encode()).hexdigest()
    return f"{WS_TICKET_CACHE_PREFIX}{digest}"


def issue_ws_ticket(user, credential):
    """Mint a single-use WebSocket ticket for *user*, bound to *credential*.

    *credential* is the descriptor (``session_credential`` / ``pat_credential``
    / ``token_credential``, usually via ``credential_for_request``) of the
    credential the caller used to ask for the ticket. The socket opened with the
    ticket stays open only while that credential stays live (#1483), so it is
    required: an unbound ticket could never be revoked from the socket side.

    Returns ``(raw_ticket, expires_at)``. The raw value is available here and in
    the HTTP response exactly once and is never recoverable afterwards — the
    same contract as ``PersonalAccessToken.generate``.
    """
    if not isinstance(credential, dict) or credential.get("kind") not in _CREDENTIAL_KINDS:
        raise ValueError("issue_ws_ticket requires a credential descriptor")
    raw_ticket = secrets.token_urlsafe(32)
    expires_at = timezone.now() + timedelta(seconds=WS_TICKET_TTL)
    payload = {"user_id": user.id, "credential": _seal_credential(credential)}
    cache.set(_ticket_cache_key(raw_ticket), payload, WS_TICKET_TTL)
    return raw_ticket, expires_at


def consume_ws_ticket(raw_ticket: str):
    """Atomically spend *raw_ticket*, returning its ``user_id`` or ``None``.

    Thin wrapper over ``_consume_ws_ticket_payload`` for callers that need only
    the identity.
    """
    payload = _consume_ws_ticket_payload(raw_ticket)
    return payload.get("user_id") if payload else None


def _consume_ws_ticket_payload(raw_ticket: str):
    """Atomically spend *raw_ticket*, returning its cache payload or ``None``.

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
    return payload


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
    """Spend *raw_ticket*; return ``(user, credential)`` or ``None``.

    *credential* is the unsealed descriptor of what minted the ticket. A ticket
    without a usable binding is refused outright (fail closed, #1483).
    """
    from django.contrib.auth import get_user_model

    payload = _consume_ws_ticket_payload(raw_ticket)
    if payload is None:
        return None
    user_id = payload.get("user_id")
    credential = _unseal_credential(payload.get("credential"))
    if user_id is None or credential is None:
        return None

    user_model = get_user_model()
    try:
        user = user_model.objects.get(pk=user_id)
    except user_model.DoesNotExist:
        return None

    # Re-check liveness at redemption. The account can be deactivated inside the
    # ticket's TTL, and a ticket must never outlive the access it stands for —
    # the same shared gate PATAuthentication applies on every REST call. Only
    # the inactive gate: a forced-change user is refused by the consumer's
    # authorize_account() check with 4003, and refusing here instead would
    # turn that into a 4001 (#1517 keeps close codes unchanged).
    if INACTIVE.blocks(user):
        return None
    # The minting credential may already have been revoked inside the TTL
    # (a logout right after minting); refuse the handshake rather than let
    # the first re-check close it a few seconds later.
    if not _credential_ref_is_live(credential, user):
        return None
    return user, credential


def _bind(credential: dict, user) -> dict:
    """Credential descriptor plus the user's session auth hash at handshake.

    The hash is an HMAC of the password hash, so it changes on every password
    change, whichever endpoint made it. Recording it makes a password change
    close the socket whatever credential admitted it, including any the
    change does not itself revoke. It never leaves process memory.
    """
    return {**credential, "auth_hash": user.get_session_auth_hash()}


def _session_is_live(session_key: str, user) -> bool:
    """True if *session_key* still authenticates *user* (sync; one lookup).

    Mirrors ``django.contrib.auth.get_user``: the session must still exist and
    be unexpired, name this user, and carry a session hash that matches the
    current password (or a SECRET_KEY_FALLBACKS hash, which ``get_user`` also
    accepts). ``load()`` reads without writing — a missing or expired session
    comes back empty rather than being recreated. The cache engine is read
    directly instead, from the store's own cache (#2014, see the inline
    comment), so a cache outage raises;
    a custom subclass of that engine that overrides ``load()`` is bypassed.

    Limitation: with the ``signed_cookies`` session engine there is no server
    side session to delete, so a logout cannot be observed here (Django itself
    cannot revoke such a session either). The default ``db`` engine — and the
    cache engines — are covered. System check ``accounts.W001`` warns when the
    signed-cookie engine is configured.
    """
    from django.contrib.auth import HASH_SESSION_KEY, SESSION_KEY

    store = import_module(settings.SESSION_ENGINE).SessionStore(session_key=session_key)
    if _is_cache_only_store(store):
        # Why not store.load() (#2014): the cache engine's load() swallows
        # every cache exception and returns {}, so a cache outage would read as
        # "session revoked" and close the socket with the final 4003. Read the
        # cache directly so an outage raises and the consumer closes with the
        # reconnectable 1011 (#2003). A genuine miss still returns None, which
        # fails closed below. cached_db is not matched here (it subclasses the
        # db store) and keeps using load().
        if not store.session_key:
            return False
        data = _read_cache_session(store) or {}
    else:
        data = store.load()
    if str(data.get(SESSION_KEY)) != user._meta.pk.value_to_string(user):
        return False
    return _matches_session_auth_hash(data.get(HASH_SESSION_KEY), user)


def _is_cache_only_store(store) -> bool:
    """True for the cache-only session engine (or a subclass), not ``cached_db``.

    ``cached_db`` subclasses the db store, not the cache one, so it is not
    matched: its ``load()`` falls back to the database on a cache error and
    never conflates an outage with an absent session. (Its write-back to the
    cache after that fallback can still raise during an outage, which is a
    raise, not a false denial; at the handshake ``HandshakeOutageMiddleware``
    turns it into a 1011, #2144.)
    """
    from django.contrib.sessions.backends.cache import SessionStore as CacheSessionStore

    return isinstance(store, CacheSessionStore)


def _read_cache_session(store):
    """The raw session dict for a cache-only *store*, or ``None`` on a miss.

    Raises whatever the cache backend raises: that is the point (#2014,
    #2086), since ``store.load()`` would swallow it. ``store._cache`` is the
    exact cache ``load()`` would read (a subclass may point it elsewhere than
    ``SESSION_CACHE_ALIAS``).
    """
    return store._cache.get(store.cache_key)


@database_sync_to_async
def _cookie_session_unreadable(session_key: str) -> bool:
    """True if the cache-only session backend raised reading *session_key*.

    Called only for a cookie handshake that presented a session cookie and
    still came out anonymous (#2086). Channels' ``AuthMiddleware`` read that
    session through ``load()``, which turns a cache outage into an empty
    session, so "anonymous" there can mean either "no such session" or "the
    cache is down". One direct read tells them apart. It never authenticates
    anything: either answer refuses the handshake, it only picks the code.

    False for every other engine (no extra read; the default ``db`` engine's
    handshake is unchanged), for a malformed key, and when the read succeeds
    (the session is absent, or present but rejected for another reason, such
    as a changed password — both a genuine 4001).
    """
    store = import_module(settings.SESSION_ENGINE).SessionStore(session_key=session_key)
    if not _is_cache_only_store(store) or not store.session_key:
        return False
    try:
        _read_cache_session(store)
    except Exception:  # noqa: BLE001 — any backend error is an outage, see docstring
        return True
    return False


def _matches_session_auth_hash(value, user) -> bool:
    """True if *value* is *user*'s current session auth hash.

    Also accepts a hash made under a ``SECRET_KEY_FALLBACKS`` key, as
    ``django.contrib.auth.get_user`` does, so a SECRET_KEY rotation that keeps
    the old key as a fallback does not close open sockets. Without the
    fallback nothing matches and the socket fails closed (see module
    docstring).
    """
    if not value:
        return False
    if constant_time_compare(value, user.get_session_auth_hash()):
        return True
    fallbacks = getattr(user, "get_session_auth_fallback_hash", None)
    return bool(fallbacks) and any(
        constant_time_compare(value, fallback) for fallback in fallbacks()
    )


def _credential_ref_is_live(credential: dict, user) -> bool:
    """True if the credential itself (ignoring the password check) is live."""
    from rest_framework.authtoken.models import Token

    from .authentication import pat_is_expired

    from .models import PersonalAccessToken

    kind = credential.get("kind")
    ref = credential.get("ref")
    if not ref:
        return False
    if kind == CREDENTIAL_SESSION:
        return _session_is_live(ref, user)
    if kind == CREDENTIAL_PAT:
        # pat_is_expired is the predicate resolve_personal_access_token uses
        # for REST, so the socket and the REST API cannot disagree about
        # when a token expires. Password change deletes every PAT
        # (finalize_password_change), so it lands here too.
        pat = (
            PersonalAccessToken.objects.filter(pk=ref, user_id=user.pk)
            .only("pk", "expires_at")
            .first()
        )
        return pat is not None and not pat_is_expired(pat)
    if kind == CREDENTIAL_TOKEN:
        # OneToOne per user: a logout deletes it (dj-rest-auth), and a
        # re-issued token has a different key, so compare digests.
        key = Token.objects.filter(user_id=user.pk).values_list("key", flat=True).first()
        return key is not None and constant_time_compare(_sha256(key), ref)
    return False


def ws_credential_is_live(credential, user) -> bool:
    """True if the credential a socket was admitted with still stands (#1483).

    Sync (ORM). *user* must be a freshly loaded row, not the handshake-time
    ``scope["user"]``. Fails closed on anything missing or malformed. Two
    conditions, both required:

    - the password has not changed since the handshake (``auth_hash``); and
    - the credential itself is still live: the session still exists and still
      authenticates this user, the PAT still exists and is unexpired, or the
      user's DRF token is still the one that minted the ticket.

    Costs one indexed lookup (session row, PAT row or Token row).
    """
    if not isinstance(credential, dict):
        return False
    if not _matches_session_auth_hash(credential.get("auth_hash"), user):
        return False
    return _credential_ref_is_live(credential, user)


def load_live_ws_user(scope):
    """Fresh active User row for an open socket, or ``None`` (sync; ORM).

    The shared core of ``BoardConsumer._refresh_role`` and
    ``GroupConsumer._refresh_access`` (#1477, #1483): ``None`` when the account
    is gone or deactivated, or when the credential recorded at the handshake
    (``scope[WS_CREDENTIAL_SCOPE_KEY]``) is no longer live. A scope with no
    recorded credential fails closed. The caller turns ``None`` into a 4003.
    """
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.filter(pk=scope["user"].id).first()
    # The shared account-state gates (inactive, forced password or username
    # change) the REST permission classes and the handshake apply (#1517),
    # read from the freshly loaded row so a change after the handshake is seen.
    if user is None or not authorize_account(user):
        return None
    if not ws_credential_is_live(scope.get(WS_CREDENTIAL_SCOPE_KEY), user):
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

    With no ``?ticket=`` present the browser SPA's session-cookie handshake
    behaves exactly as it did before, except that the session it authenticated
    with is recorded in ``scope[WS_CREDENTIAL_SCOPE_KEY]`` (#1483).

    Every authenticated connection leaves here with that key set — the session
    for a cookie handshake, the ticket's minting credential for a ticket
    handshake — which the consumers' re-check uses to close the socket once
    that credential is revoked. Any caller-supplied value is overwritten.

    A handshake whose authentication cannot be evaluated (an outage, #2086) is
    refused here, before routing, with ``CLOSE_AUTH_UNAVAILABLE`` (1011): the
    consumer would only see an anonymous scope and close with 4001.
    """

    async def __call__(self, scope, receive, send):
        scope = dict(scope)
        scope[WS_CREDENTIAL_SCOPE_KEY] = None
        raw_ticket = _extract_ticket(scope.get("query_string", b""))

        if raw_ticket:
            try:
                resolved = await _resolve_ticket_user(raw_ticket)
            except Exception as exc:  # noqa: BLE001 — refused either way, see below
                # The ticket cache, the database, or the minting session's
                # cache-only backend raised. Fail closed, but with the
                # reconnectable 1011 rather than 4001: nothing says the
                # credential is gone (#2086). Before this, the exception
                # escaped the middleware (Daphne answers the upgrade with a
                # 500 and logs the exception message, which can carry cache or
                # database connection details), so the class name only.
                #
                # The ticket stays consumed when the failure came after the
                # claim. Deliberate: single use is decided at the claim, under
                # the cache's atomic delete, and must not depend on whether a
                # later check completed (CLAUDE.md, consume-once tokens). A
                # client already mints a fresh ticket for every attempt, so
                # the retry is unaffected.
                logger.warning(
                    "websocket ticket redemption could not complete: error=%s",
                    type(exc).__name__,
                )
                return await _refuse_unavailable(receive, send)
            if resolved is not None:
                user, credential = resolved
                scope["user"] = user
                scope[WS_CREDENTIAL_SCOPE_KEY] = _bind(credential, user)
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
        else:
            # Cookie handshake: AuthMiddleware has already resolved (and
            # hash-verified) the session, so both objects are loaded here and
            # reading them does no I/O.
            user = scope.get("user")
            session_key = getattr(scope.get("session"), "session_key", None)
            if user is not None and user.is_authenticated and session_key:
                scope[WS_CREDENTIAL_SCOPE_KEY] = _bind(session_credential(session_key), user)
            else:
                # Anonymous despite a session cookie: with the cache-only
                # session engine that can be an outage that load() swallowed
                # (#2086). The cookie, not scope["session"].session_key, is
                # the key to probe: a failed load() clears the store's key.
                cookies = scope.get("cookies") or {}
                cookie_key = cookies.get(settings.SESSION_COOKIE_NAME)
                if cookie_key and await _cookie_session_unreadable(cookie_key):
                    logger.warning(
                        "websocket session lookup could not complete: cache unavailable"
                    )
                    return await _refuse_unavailable(receive, send)

        # The raw ticket is deliberately never logged, here or anywhere else —
        # it is a credential (repo rule: never log tokens or secrets). The same
        # goes for the session key in scope[WS_CREDENTIAL_SCOPE_KEY].
        return await super().__call__(scope, receive, send)


async def _refuse_unavailable(receive, send):
    """Refuse the handshake with ``CLOSE_AUTH_UNAVAILABLE`` (1011), unrouted.

    Same shape as ``OptionalOriginValidator``'s refusal: take the
    ``websocket.connect`` and close before accept, so no consumer runs.
    """
    await receive()  # websocket.connect
    await send({"type": "websocket.close", "code": CLOSE_AUTH_UNAVAILABLE})


def _handshake_outage_errors() -> tuple:
    """The exception classes ``HandshakeOutageMiddleware`` reads as an outage.

    Bounded on purpose: database connection errors (``OperationalError``,
    ``InterfaceError``), the builtin ``ConnectionError`` and ``TimeoutError``
    (socket-level failures a cache client can surface as-is), and redis-py's
    ``ConnectionError`` and ``TimeoutError``, which do *not* subclass the
    builtins (``redis.exceptions.RedisError`` derives from ``Exception``),
    plus its ``ReadOnlyError`` (a write to a replica during a failover).
    Other Redis server replies (OOM, ``MISCONF``) stay outside the set.
    redis-py is what Django's ``RedisCache`` and ``channels_redis`` both use,
    against Redis or Valkey alike. Anything else (a programming error, an
    ``IntegrityError``) still raises, so a bug is not disguised as an outage
    and keeps its traceback.
    """
    from django.db import InterfaceError, OperationalError

    errors = [OperationalError, InterfaceError, ConnectionError, TimeoutError]
    try:
        from redis.exceptions import ConnectionError as RedisConnectionError
        from redis.exceptions import ReadOnlyError as RedisReadOnlyError
        from redis.exceptions import TimeoutError as RedisTimeoutError
    except ImportError:  # pragma: no cover — redis is a hard dependency today
        pass
    else:
        errors += [RedisConnectionError, RedisTimeoutError, RedisReadOnlyError]
    return tuple(errors)


# ASGI messages that answer the handshake. Once one has been sent the
# handshake is decided, and a later exception is no longer this
# middleware's to turn into a refusal.
_HANDSHAKE_ANSWERS = frozenset(
    {"websocket.accept", "websocket.close", "websocket.http.response.start"}
)


class HandshakeOutageMiddleware(BaseMiddleware):
    """Refuse a handshake with 1011 when a backing store fails before accept (#2144).

    Wraps ``AuthMiddlewareStack`` from the outside, so it sits between the
    origin check and the session lookup, and everything the stack runs —
    Channels' session and user resolution, ``TicketAuthMiddleware``, the
    router and every routed consumer's ``connect()``, including the ones
    enterprise registers through ``enterprise_websocket_urlpatterns`` — is
    inside it. Why outside the stack rather than in each consumer:
    ``AuthMiddleware.resolve_scope`` raises before any consumer exists (a
    ``cached_db`` cache write-back during a cache outage, or a ``db`` session
    read during a database outage), so only a wrapper outside it can catch
    that; one wrapper then also covers every consumer's connect-time lookups
    without each consumer, or an enterprise consumer it cannot see,
    restating the rule.

    Why: without it the exception escapes the application, Daphne answers the
    upgrade with HTTP 500, and its log line carries the exception message,
    which can name a database or cache host and credentials. With it the
    handshake gets the same ``CLOSE_AUTH_UNAVAILABLE`` (1011) refusal
    ``TicketAuthMiddleware`` gives the outages it can see (#2086), and only
    the exception class name is logged.

    Never fails open: a caught exception always ends in a close, never in a
    call further down the stack, so no scope (authenticated or anonymous)
    reaches a consumer after an outage. Only the bounded set from
    ``_handshake_outage_errors`` is caught, and only while the handshake is
    still undecided: once anything inside has sent an accept or a close, the
    exception is re-raised unchanged (after accept that is the consumers'
    existing 1011 path, #2003, #2142).

    Transport caveat, as for every pre-accept refusal (#2145): Daphne answers
    a close before accept with HTTP 403 whatever the code, so a browser sees a
    failed upgrade (1006), not 1011. That is the #2086 behavior this matches;
    the code is the application's verdict, and the 500 and its log line are
    what this middleware removes.
    """

    def __init__(self, inner):
        super().__init__(inner)
        self._outage_errors = _handshake_outage_errors()

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "websocket":
            return await self.inner(scope, receive, send)

        connect_received = False
        answered = False

        async def tracked_receive():
            nonlocal connect_received
            message = await receive()
            if message.get("type") == "websocket.connect":
                connect_received = True
            return message

        async def tracked_send(message):
            nonlocal answered
            if message.get("type") in _HANDSHAKE_ANSWERS:
                answered = True
            await send(message)

        try:
            return await self.inner(scope, tracked_receive, tracked_send)
        except self._outage_errors as exc:
            if answered:
                raise
            outage = type(exc).__name__
        # Refuse outside the except block on purpose: if the close itself
        # fails (the client is gone), its traceback must not chain the outage
        # as __context__, or Daphne's log would print the message after all.
        # Class name only: the message can carry connection details.
        logger.warning("websocket handshake could not complete: error=%s", outage)
        if not connect_received:
            # The failure came before anything read the connect message
            # (the session lookup runs before the consumer starts).
            await receive()
        await send({"type": "websocket.close", "code": CLOSE_AUTH_UNAVAILABLE})
