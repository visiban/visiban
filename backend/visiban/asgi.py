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

application = ProtocolTypeRouter(
    {
        "http": get_asgi_application(),
        "websocket": AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
    }
)
