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
    resolve_personal_access_token,
)

from .context import reset_current_user, set_current_user

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
            await self.app(scope, receive, send)
            return

        raw_token = _extract_bearer_token(scope)
        if not raw_token:
            await _send_401(send, "Authorization header with Bearer token required.")
            return

        try:
            # resolve_personal_access_token touches the ORM (lookup plus the
            # last_used_at write), so it must not run on the event loop.
            # thread_sensitive=True keeps it on the single sync worker thread
            # that shares Django's per-thread DB connection.
            pat = await sync_to_async(
                resolve_personal_access_token, thread_sensitive=True
            )(raw_token)
        except InvalidPersonalAccessToken as exc:
            # Never log the token itself, and do not log the username either —
            # this path is reachable by unauthenticated callers.
            logger.warning("Rejected MCP request: %s", exc.detail)
            await _send_401(send, exc.detail)
            return

        token = set_current_user(pat.user)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_current_user(token)
