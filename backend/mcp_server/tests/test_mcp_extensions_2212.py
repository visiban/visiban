"""Card-detail extension sections never reach MCP (#2212, Rule 12).

Serializer-level: drives ``tools.card_detail`` and ``tools._serialize_card``
directly with a registered extension, skipping the HTTP transport (the
extension is only ever called from the REST extensions endpoint).
"""
import json
from unittest.mock import patch

import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

from django.test import TestCase
from rest_framework.utils.encoders import JSONEncoder

from boards import hooks
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

NEEDLE = "ZZ-EXT-NEEDLE-2212"


class _Ext:
    id = "deal"
    min_role = "viewer"

    def __init__(self):
        self.calls = 0

    def section(self, card, user, role):
        self.calls += 1
        return {"title": NEEDLE, "fields": [{"key": "k", "label": NEEDLE, "type": "text", "value": NEEDLE}]}


class McpOmitsExtensionsTests(TestCase):
    def test_card_detail_and_serialize_card_omit_extension_content(self):
        from mcp_server import tools

        user = _make_user()
        board = _make_board(user)
        card = _make_card(_make_column(board), _make_swimlane(board))
        ext = _Ext()
        with patch.object(hooks, "CARD_DETAIL_EXTENSIONS", [ext]), patch(
            "mcp_server.tools.get_current_user", return_value=user
        ):
            detail = tools.card_detail(card_id=card.pk)
            serialized = tools._serialize_card(card)
        for payload in (detail, serialized):
            self.assertNotIn(NEEDLE, json.dumps(payload, cls=JSONEncoder, default=str))
        self.assertEqual(ext.calls, 0)
