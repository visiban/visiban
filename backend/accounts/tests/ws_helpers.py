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
