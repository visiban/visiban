"""Bearer token authentication for the MCP transport.

This is pure ASGI middleware wrapping the mounted MCP app rather than a check
inside each tool. That is deliberate: it means every tool added later (#512,
#513) inherits authentication for free and cannot forget it, instead of each
one re-implementing the same check slightly differently.

It also means an unauthenticated request is rejected *before* any MCP protocol
frame is parsed, keeping the pre-auth attack surface to header inspection only.
"""
import json
import logging

from asgiref.sync import sync_to_async

from accounts.authentication import (
    InvalidPersonalAccessToken,
    enforce_mcp_scope,
    record_token_usage,
    resolve_personal_access_token,
)

from .context import (
    reset_current_scopes, reset_current_user, set_current_scopes, set_current_user,
)

logger = logging.getLogger(__name__)

_BEARER_PREFIX = "Bearer "

# JSON-RPC 2.0 reserved code for "Invalid Request". MCP rides on JSON-RPC, so a
# transport-level rejection is returned in that envelope as well as with the
# HTTP 401 status, so spec-compliant clients surface a useful error either way.
_JSONRPC_INVALID_REQUEST = -32600


def _unauthorized_body(detail):
    return json.dumps({
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": _JSONRPC_INVALID_REQUEST, "message": detail},
    }).encode()


async def _send_401(send, detail):
    body = _unauthorized_body(detail)
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [
            (b"content-type", b"application/json"),
            # Advertise the scheme so compliant clients know how to retry.
            (b"www-authenticate", b'Bearer realm="visiban-mcp"'),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})


def _extract_bearer_token(scope):
    """Return the raw Bearer credential from the ASGI scope, or None."""
    for name, value in scope.get("headers", []):
        if name == b"authorization":
            try:
                header = value.decode("latin-1")
            except UnicodeDecodeError:
                return None
            if header.startswith(_BEARER_PREFIX):
                return header[len(_BEARER_PREFIX):].strip()
            return None
    return None


def _authenticate_and_authorize(raw_token):
    """Resolve, scope-check, and stamp a PAT for an MCP request.

    Synchronous on purpose — the caller sends this to the sync worker thread as
    a single unit (see BearerAuthMiddleware).

    Order matters. Identity is established first, then authority as a separate
    question (#1110): a token that can read every board over REST is NOT
    thereby authorized to drive an agent — it needs the mcp:read scope, and a
    legacy (unscoped) token can never satisfy it. Usage is stamped last, so a
    request denied for scope never records authority it did not exercise.
    """
    pat = resolve_personal_access_token(raw_token)
    presented_scope = enforce_mcp_scope(pat)
    record_token_usage(pat, presented_scope)
    return pat


class BearerAuthMiddleware:
    """Require a valid Visiban personal access token on every MCP request.

    MCP mandates the ``Bearer`` scheme, while the REST API uses ``Token``
    (see ``docs/api/authentication.md``). Both resolve the *same*
    ``PersonalAccessToken`` records through the same shared helper, so a token
    revoked or expired for one is revoked or expired for the other — including
    the "all tokens dropped on password change" invariant.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            # Unreachable as currently wired: visiban/asgi.py's
            # ProtocolTypeRouter dispatches websocket traffic to the Channels
            # stack, so only "http" scopes ever reach this middleware. Kept as a
            # guard rather than an assertion because the consequence of it
            # becoming reachable would be an UNAUTHENTICATED pass-through — if
            # /mcp is ever mounted somewhere that can see other protocol types,
            # this branch must become a rejection, not a delegation.
            await self.app(scope, receive, send)
            return

        raw_token = _extract_bearer_token(scope)
        if not raw_token:
            await _send_401(send, "Authorization header with Bearer token required.")
            return

        try:
            # One hop, not three: the lookup and the usage write both touch the
            # ORM and so must leave the event loop, and thread_sensitive=True
            # pins them to the single sync worker thread that shares Django's
            # per-thread DB connection. Dispatching them separately would pay
            # the scheduling cost twice per request for no benefit, so the whole
            # resolve -> authorize -> record sequence goes over together.
            pat = await sync_to_async(
                _authenticate_and_authorize, thread_sensitive=True
            )(raw_token)
        except InvalidPersonalAccessToken as exc:
            # Never log the token itself, and do not log the username either —
            # this path is reachable by unauthenticated callers.
            logger.warning("Rejected MCP request: %s", exc.detail)
            await _send_401(send, exc.detail)
            return

        user_token = set_current_user(pat.user)
        # A token predating scopes never reaches here — enforce_mcp_scope()
        # already rejected it above — so `pat.scopes` is always a real list at
        # this point, never None. Frozen so a tool cannot accidentally mutate
        # the shared PAT-scopes list through the context carrier.
        scopes_token = set_current_scopes(frozenset(pat.scopes))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_current_scopes(scopes_token)
            reset_current_user(user_token)
