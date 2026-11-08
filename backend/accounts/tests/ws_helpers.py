"""Shared fixtures for WebSocket credential-binding tests (#1483).

Since #1483 every ticket is bound to the credential that minted it, and every
socket's re-check fails closed without a recorded credential. These helpers
give tests a real, revocable credential — a logged-in database session —
instead of each file restating how to build one.
"""
from importlib import import_module

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY

from accounts.ws_auth import WS_CREDENTIAL_SCOPE_KEY, _bind, issue_ws_ticket, session_credential


def login_session(user):
    """Create a server-side session authenticated as *user*; return its key."""
    store = import_module(settings.SESSION_ENGINE).SessionStore()
    store[SESSION_KEY] = user._meta.pk.value_to_string(user)
    store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
    store[HASH_SESSION_KEY] = user.get_session_auth_hash()
    store.create()
    return store.session_key


def session_ticket(user, session_key=None):
    """Mint a ticket for *user* bound to a (new, unless given) logged-in session."""
    return issue_ws_ticket(user, session_credential(session_key or login_session(user)))


def bound_scope(user, session_key=None):
    """``{WS_CREDENTIAL_SCOPE_KEY: ...}`` for a hand-built consumer scope.

    What TicketAuthMiddleware records for a cookie handshake on that session.
    """
    key = session_key or login_session(user)
    return {WS_CREDENTIAL_SCOPE_KEY: _bind(session_credential(key), user)}


async def handshake(communicator, timeout=1):
    """Connect *communicator*; return ``(admitted, close_code)`` as a client sees it.

    The board and group consumers refuse a handshake by accepting and closing
    at once (``accounts.ws_auth.refuse_handshake``, #2145), so their 4001/4003
    reach a client under Daphne; the middlewares' 1011 and origin refusals
    still close before accept. Both count as a refusal here, so a test reads
    the same ``(False, code)`` either way. ``WebsocketCommunicator.connect``
    alone reports ``(True, None)`` for an accept-then-close, which is why a
    test that needs an admitted socket must use this, not ``connect()``.

    The verdict is decided by the first message after the accept, without
    consuming anything but a close:

    - nothing within 0.1 s, or a frame first (an event, or a keepalive ping a
      test shortened): admitted, ``(True, None)``. The frame stays queued for
      the caller, and the socket is left open.
    - a close first: refused, ``(False, code)``. The communicator is then
      disconnected, so the consumer's ``disconnect()`` runs (an error in it
      fails the test).

    So a consumer that sends anything before its close reads as admitted,
    and a refusal test asserting ``(False, code)`` fails on it: a refused
    socket must carry no frame, and this never reports one as refused.
    """
    connected, detail = await communicator.connect(timeout=timeout)
    if not connected:
        return False, detail
    # The refusal's close follows the accept with no await in between, so it
    # is queued at once; an admitted socket sends nothing until its first
    # broadcast or keepalive ping.
    if await communicator.receive_nothing(timeout=0.1):
        return True, None
    # Peek, don't consume: an admitted socket's first frame belongs to the
    # caller. asyncio.Queue has no public peek; _queue is its deque.
    first = communicator.output_queue._queue[0]
    if first.get("type") != "websocket.close":
        return True, None
    message = await communicator.receive_output(timeout=timeout)
    await communicator.disconnect()
    return False, message.get("code", 1000)
