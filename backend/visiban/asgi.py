import os
import django
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
django.setup()

from boards.routing import websocket_urlpatterns as board_ws_patterns  # noqa: E402 — must be after setup()
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

application = ProtocolTypeRouter(
    {
        # mount_mcp_server() wraps the Django HTTP app so that /mcp reaches the
        # MCP server (#511) and every other path falls through to Django
        # unchanged. It returns the Django app as-is when MCP_SERVER_ENABLED is
        # off. Only the "http" value is wrapped — the "websocket" branch and
        # its enterprise routing extension point above are deliberately
        # untouched, since enterprise registers against their current shape.
        "http": mount_mcp_server(get_asgi_application()),
        "websocket": AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
    }
)
