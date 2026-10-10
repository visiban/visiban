"""Board-level event payloads carry only role-neutral board fields.

Admin-only board state (the share-link fields) is served by ``/full/`` and the
``share`` action's own response; it must not appear in the ``board.*`` frames
that every board and group subscriber receives, nor in the change feed rows that
replay them.
"""

import contextlib
import types
import uuid
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

    def _assert_created_frames_clean(self, sent):
        created = [m for _, m in sent if m["payload"]["event"] == "board.created"]
        self.assertTrue(created, "expected a board.created frame")
        self.assertTrue(any(g.startswith("group_") for g, _ in sent), "expected a group-channel frame")
        self._assert_frames_clean(sent)

    def test_board_create_in_group(self):
        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            r = self.c.post("/api/v1/boards/", {"name": "Created", "group": self.group.id}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self._assert_created_frames_clean(sent)
        row = BoardEvent.objects.get(board_id=r.data["id"], event="board.created")
        for field in ADMIN_ONLY_FIELDS:
            self.assertNotIn(field, row.data)

    def test_group_boards_create(self):
        GroupMembership.objects.create(group=self.group, user=self.admin, role=GroupMembership.Role.ADMIN)
        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            r = self.c.post(f"/api/v1/groups/{self.group.id}/boards/", {"name": "Via group"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self._assert_created_frames_clean(sent)
        row = BoardEvent.objects.get(board_id=r.data["id"], event="board.created")
        for field in ADMIN_ONLY_FIELDS:
            self.assertNotIn(field, row.data)


class BoardEventPayloadHelperTests(TestCase):
    """The write and read paths drop admin-only fields whatever built the payload.

    The view-level tests above pass today partly because ``BoardSerializer``
    does not declare these fields. These tests feed the shared helpers a payload
    that does carry them (as a payload built from ``BoardFullSerializer`` with an
    admin context would), so the guard holds for any current or future caller,
    including the Django admin's ``save_model`` path.
    """

    def setUp(self):
        self.admin = _make_user("pfh_admin")
        self.viewer = _make_user("pfh_viewer")
        self.board = _make_board(self.admin, name="PFH Board")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)

    def _admin_payload(self):
        """A board payload built with an admin context while a link is live."""
        from boards.serializers import BoardFullSerializer

        self.board.share_token = uuid.uuid4()
        self.board.save(update_fields=["share_token"])
        data = dict(BoardFullSerializer(self.board, context={"role": BoardMembership.Role.ADMIN}).data)
        self.assertTrue(data["share_token"], "precondition: the admin payload carries the field")
        return data

    def test_broadcast_board_event_drops_fields(self):
        from boards.broadcast import EVT_BOARD_UPDATED, broadcast_board_event

        payload = self._admin_payload()
        with _capture_layer() as sent:
            broadcast_board_event(self.board.id, EVT_BOARD_UPDATED, payload)
        self.assertEqual(len(sent), 1)
        data = sent[0][1]["payload"]["data"]
        for field in ADMIN_ONLY_FIELDS:
            self.assertNotIn(field, data)
        self.assertEqual(data["name"], "PFH Board")
        # The caller's dict is not mutated.
        self.assertIn("share_token", payload)

    def test_broadcast_group_event_drops_fields(self):
        from boards.broadcast import EVT_BOARD_UPDATED
        from groups.broadcast import broadcast_group_event

        with _capture_layer() as sent:
            broadcast_group_event(1, EVT_BOARD_UPDATED, self._admin_payload())
        data = sent[0][1]["payload"]["data"]
        for field in ADMIN_ONLY_FIELDS:
            self.assertNotIn(field, data)

    def test_record_board_event_drops_fields_from_row_and_frame(self):
        from boards.broadcast import EVT_BOARD_UPDATED, record_board_event

        with _capture_layer() as sent, self.captureOnCommitCallbacks(execute=True):
            event_id = record_board_event(self.board.id, EVT_BOARD_UPDATED, self._admin_payload())
        row = BoardEvent.objects.get(pk=event_id)
        for field in ADMIN_ONLY_FIELDS:
            self.assertNotIn(field, row.data)
            self.assertNotIn(field, sent[0][1]["payload"]["data"])

    def test_feed_drops_fields_from_previously_stored_rows(self):
        """A row written before the write-path guard is served without the fields."""
        BoardEvent.objects.create(
            board_id=self.board.id, event="board.updated", actor_id=self.admin.id,
            data={"id": self.board.id, "name": "PFH Board",
                  "share_token": str(uuid.uuid4()), "share_token_expires_at": None},
        )
        for user in (self.viewer, self.admin):
            client = APIClient()
            client.force_authenticate(user)
            resp = client.get(f"/api/v1/boards/{self.board.id}/events/")
            self.assertEqual(resp.status_code, 200)
            rows = resp.data["results"] if isinstance(resp.data, dict) and "results" in resp.data else resp.data
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["data"]["name"], "PFH Board")
            for field in ADMIN_ONLY_FIELDS:
                self.assertNotIn(field, rows[0]["data"], f"{field} served to {user.username}")

    def test_helper_leaves_other_payloads_alone(self):
        from boards.broadcast import without_admin_only_board_fields

        payload = {"id": 1, "name": "x"}
        self.assertIs(without_admin_only_board_fields(payload), payload)
        self.assertIsNone(without_admin_only_board_fields(None))
        self.assertEqual(without_admin_only_board_fields([1, 2]), [1, 2])

    def test_helper_is_top_level_only(self):
        """Nested values pass through unchanged; the guard covers top-level keys only."""
        from boards.broadcast import without_admin_only_board_fields

        nested = {"id": 1, "board": {"id": 2, "share_token": "nested-value"}}
        self.assertIs(without_admin_only_board_fields(nested), nested)
        self.assertEqual(nested["board"]["share_token"], "nested-value")


class BoardSerializerFieldSetTests(TestCase):
    """``BoardSerializer`` builds every board event payload, so it must never
    declare an admin-only board field (an additive field there would otherwise
    only be caught by the top-level guard)."""

    def test_board_serializer_declares_no_admin_only_field(self):
        from boards.broadcast import ADMIN_ONLY_BOARD_FIELDS
        from boards.serializers import BoardSerializer

        declared = set(BoardSerializer.Meta.fields) | set(BoardSerializer().fields)
        self.assertEqual(declared & ADMIN_ONLY_BOARD_FIELDS, set())
