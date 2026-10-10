"""Board-level event payloads carry only role-neutral board fields.

Admin-only board state (the share-link fields) is served by ``/full/`` and the
``share`` action's own response; it must not appear in the ``board.*`` frames
that every board and group subscriber receives, nor in the change feed rows that
replay them.
"""

import contextlib
import types
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from boards.models import BoardEvent, BoardMembership
from boards.tests.conftest import _make_board, _make_membership, _make_user
from groups.models import Group, GroupMembership

ADMIN_ONLY_FIELDS = ("share_token", "share_token_expires_at")


@contextlib.contextmanager
def _capture_layer():
    sent = []

    async def _group_send(group, message):
        sent.append((group, message))

    layer = types.SimpleNamespace(group_send=_group_send)
    with patch("boards.broadcast.get_channel_layer", return_value=layer), \
            patch("groups.broadcast.get_channel_layer", return_value=layer):
        yield sent


class BoardEventPayloadFieldTests(TestCase):
    def setUp(self):
        self.admin = _make_user("pf_admin")
        self.group = Group.objects.create(name="PF Group", owner=self.admin)
        self.other_group = Group.objects.create(name="PF Other", owner=self.admin)
        self.board = _make_board(self.admin, name="PF Board")
        self.board.group = self.group
        self.board.save()
        self.viewer = _make_user("pf_viewer")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)
        GroupMembership.objects.create(group=self.group, user=self.viewer)
        self.c = APIClient()
        self.c.force_authenticate(self.admin)

    def _assert_frames_clean(self, sent):
        board_frames = [m for g, m in sent if g.startswith("board_")]
        self.assertTrue(board_frames, "expected at least one board-channel frame")
        for group, message in sent:
            data = message["payload"]["data"]
            for field in ADMIN_ONLY_FIELDS:
                self.assertNotIn(field, data, f"{field} on {group} {message['payload']['event']}")

    def _assert_feed_clean_for_viewer(self):
        v = APIClient()
        v.force_authenticate(self.viewer)
        resp = v.get(f"/api/v1/boards/{self.board.id}/events/")
        self.assertEqual(resp.status_code, 200)
        rows = resp.data["results"] if isinstance(resp.data, dict) and "results" in resp.data else resp.data
        self.assertTrue(rows)
        for row in rows:
            for field in ADMIN_ONLY_FIELDS:
                self.assertNotIn(field, row["data"])
        for row in BoardEvent.objects.filter(board_id=self.board.id):
            for field in ADMIN_ONLY_FIELDS:
                self.assertNotIn(field, row.data)

    def test_share_enable(self):
        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            r = self.c.post(f"/api/v1/boards/{self.board.id}/share/", {"expires_in_days": 7}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.data["share_token"])
        self._assert_frames_clean(sent)
        self._assert_feed_clean_for_viewer()

    def test_board_update(self):
        self.c.post(f"/api/v1/boards/{self.board.id}/share/", {}, format="json")
        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            r = self.c.patch(f"/api/v1/boards/{self.board.id}/", {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, 200)
        self._assert_frames_clean(sent)
        self._assert_feed_clean_for_viewer()

    def test_move_group(self):
        self.c.post(f"/api/v1/boards/{self.board.id}/share/", {}, format="json")
        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            r = self.c.post(
                f"/api/v1/boards/{self.board.id}/move-group/", {"group_id": self.other_group.id}, format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertTrue(any(g.startswith("group_") for g, _ in sent))
        self._assert_frames_clean(sent)
        self._assert_feed_clean_for_viewer()
