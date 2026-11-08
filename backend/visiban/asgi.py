import os
import django
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
django.setup()

from accounts.ws_auth import HandshakeOutageMiddleware, TicketAuthMiddleware  # noqa: E402 — must be after setup()
from accounts.ws_origin import OptionalOriginValidator  # noqa: E402
from boards.routing import websocket_urlpatterns as board_ws_patterns  # noqa: E402
from groups.routing import websocket_urlpatterns as group_ws_patterns  # noqa: E402

websocket_urlpatterns = [*board_ws_patterns, *group_ws_patterns]

# Enterprise extension point — the enterprise package registers additional
# WebSocket URL patterns here without modifying this file. Mirrors the
# HTTP URL extension point in ``visiban/urls.py``. Silently skipped when
# the enterprise package is not installed (#1009).
try:
    from enterprise.routing import enterprise_websocket_urlpatterns  # type: ignore[import]  # noqa: E402
    websocket_urlpatterns += enterprise_websocket_urlpatterns
except ImportError:
    pass

from mcp_server.asgi_mount import mount_mcp_server  # noqa: E402

# TicketAuthMiddleware nests INSIDE AuthMiddlewareStack, not outside it (#1109).
# AuthMiddleware.resolve_scope() unconditionally overwrites scope["user"] from
# the session, so an outer ticket middleware would be clobbered on every
# connection. Running inside means the session is resolved first and the ticket
# — when one is supplied — gets the final say. Connections with no ?ticket=
# parameter are passed straight through, leaving the SPA's cookie handshake
# byte-identical to its pre-#1109 behavior.
application = ProtocolTypeRouter(
    {
        # mount_mcp_server() wraps the Django HTTP app so that /mcp reaches the
        # MCP server (#511) and every other path falls through to Django
        # unchanged. It returns the Django app as-is when MCP_SERVER_ENABLED is
        # off. Only the "http" value is wrapped — the enterprise routing
        # extension point above is deliberately untouched, since enterprise
        # registers against its current shape.
        "http": mount_mcp_server(get_asgi_application()),
        # OptionalOriginValidator is outermost: a present Origin header must
        # match the configured origins; a missing one (non-browser ticket
        # clients) passes through to the auth middleware unchanged.
        #
        # HandshakeOutageMiddleware wraps AuthMiddlewareStack from OUTSIDE
        # (#2144): a database or cache outage raised by the session lookup,
        # by TicketAuthMiddleware, or by any routed consumer's connect() —
        # enterprise ones included, since the router is inside it — refuses
        # the handshake with 1011 instead of escaping as a Daphne HTTP 500
        # whose log line carries the exception message. It never fails open:
        # a caught outage always ends in a close. Under Daphne that pre-accept
        # close still reaches a browser as HTTP 403 (#2145).
        "websocket": OptionalOriginValidator(
            HandshakeOutageMiddleware(
                AuthMiddlewareStack(
                    TicketAuthMiddleware(URLRouter(websocket_urlpatterns))
                )
            )
        ),
    }
)
