"""#1945: oversized ids in WebSocket URLs must not route to a consumer."""
import re

from django.test import SimpleTestCase

from boards.routing import websocket_urlpatterns as board_patterns
from groups.routing import websocket_urlpatterns as group_patterns


def _matches(patterns, path):
    return any(re.search(p.pattern.regex.pattern, path) for p in patterns)


class WebSocketRoutingBoundsTests(SimpleTestCase):
    def test_normal_ids_route(self):
        self.assertTrue(_matches(board_patterns, "ws/boards/123/"))
        self.assertTrue(_matches(group_patterns, "ws/groups/123/"))

    def test_max_bigint_scale_id_routes_below_bound(self):
        self.assertTrue(_matches(board_patterns, "ws/boards/" + "9" * 18 + "/"))

    def test_oversized_ids_do_not_route(self):
        self.assertFalse(_matches(board_patterns, "ws/boards/" + "9" * 30 + "/"))
        self.assertFalse(_matches(board_patterns, "ws/boards/" + "9" * 19 + "/"))
        self.assertFalse(_matches(group_patterns, "ws/groups/" + "9" * 19 + "/"))
        self.assertFalse(_matches(group_patterns, "ws/groups/" + "9" * 30 + "/"))
