"""Tests for #1462: a committed write must not return 500 when the channel layer is down.

The WebSocket publish runs in a ``transaction.on_commit`` callback, i.e. after the
mutation and its ``BoardEvent`` change-feed row are already committed. If the
channel layer (Valkey) is unreachable, ``group_send`` raises; before #1462 that
exception escaped into the view and the client got a 500 for a change that *was*
saved — and, with no idempotency keys, a retry created a duplicate.

The broadcast helpers are now best-effort: they log a WARNING (board/group id,
event type, exception class — never the payload) and return. Clients recover the
missed frame from the durable change feed (``GET /boards/<id>/events/?after=``).

These tests patch ``get_channel_layer`` rather than ``broadcast_board_event`` so
the real send helper — the code under test — runs against a layer whose
``group_send`` raises.
"""
from unittest.mock import AsyncMock, MagicMock, patch

from django.db import transaction
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.broadcast import broadcast_board_event
from boards.models import Board, BoardEvent, BoardMembership, Card, Column, Swimlane
from groups.broadcast import broadcast_group_event
from groups.models import Group, GroupMembership

SECRET_TITLE = "Confidential-title-1462"


def _down_layer():
    """A channel layer whose group_send fails the way an unreachable Valkey does."""
    layer = MagicMock()
    layer.group_send = AsyncMock(side_effect=ConnectionError("Connection refused"))
    return layer


class _LayerDownMixin:
    def setUp(self):
        super().setUp()
        self.layer = _down_layer()
        for target in ("boards.broadcast.get_channel_layer", "groups.broadcast.get_channel_layer"):
            p = patch(target, return_value=self.layer)
            p.start()
            self.addCleanup(p.stop)


class BroadcastHelperBestEffortTests(_LayerDownMixin, TestCase):
    def test_broadcast_board_event_swallows_and_logs(self):
        with self.assertLogs("boards.broadcast", level="WARNING") as logs:
            broadcast_board_event(42, "card.created", {"title": SECRET_TITLE}, event_id=7)
        self.layer.group_send.assert_awaited_once()
        output = "\n".join(logs.output)
        self.assertIn("42", output)
        self.assertIn("card.created", output)
        self.assertIn("ConnectionError", output)
        # No payload contents (and so no PII) in the log line.
        self.assertNotIn(SECRET_TITLE, output)
        self.assertNotIn("Connection refused", output)

    def test_broadcast_group_event_swallows_and_logs(self):
        with self.assertLogs("groups.broadcast", level="WARNING") as logs:
            broadcast_group_event(9, "board.created", {"name": SECRET_TITLE})
        self.layer.group_send.assert_awaited_once()
        output = "\n".join(logs.output)
        self.assertIn("9", output)
        self.assertIn("board.created", output)
        self.assertIn("ConnectionError", output)
        self.assertNotIn(SECRET_TITLE, output)


class CardWritesWithChannelLayerDownTests(_LayerDownMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.user = User.objects.create_user(username="tester", password="pass")
        self.client.force_authenticate(self.user)
        self.board = Board.objects.create(name="Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.col_a = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.col_b = Column.objects.create(board=self.board, name="Done", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="Lane", position=0)

    def test_card_create_returns_201_and_persists(self):
        with self.assertLogs("boards.broadcast", level="WARNING"):
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/v1/boards/{self.board.pk}/cards/",
                    {"title": SECRET_TITLE, "column": self.col_a.pk, "swimlane": self.swim.pk},
                )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Card.objects.filter(pk=resp.data["id"], title=SECRET_TITLE).exists())
        self.assertTrue(BoardEvent.objects.filter(board_id=self.board.pk, event="card.created").exists())
        self.layer.group_send.assert_awaited()

    def test_card_move_returns_200_and_persists(self):
        card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Move me", created_by=self.user, position=0,
        )
        with self.assertLogs("boards.broadcast", level="WARNING"):
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
                    {"column_id": self.col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
                )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        card.refresh_from_db()
        self.assertEqual(card.column_id, self.col_b.pk)
        self.assertTrue(BoardEvent.objects.filter(board_id=self.board.pk, event="card.moved").exists())
        self.layer.group_send.assert_awaited()


class GroupBoardCreateWithChannelLayerDownTests(_LayerDownMixin, TestCase):
    """Board create in a group fans out to both the board and group channels from
    one on_commit callback; neither failing send may 500 the request."""

    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.user)
        self.group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)

    def test_group_board_create_returns_201_and_persists(self):
        with self.assertLogs(level="WARNING"):
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(f"/api/v1/groups/{self.group.id}/boards/", {"name": "Live Board"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertTrue(Board.objects.filter(group=self.group, name="Live Board").exists())
        sent_to = {c.args[0] for c in self.layer.group_send.await_args_list}
        self.assertIn(f"group_{self.group.id}", sent_to)


class BroadcastFailureScopeTests(TestCase):
    """The catch is deliberately broad, and a failed send must not abandon the
    on_commit callbacks queued after it (#1462 gate follow-up)."""

    def _layer(self, side_effect):
        layer = MagicMock()
        layer.group_send = AsyncMock(side_effect=side_effect)
        return layer

    def test_later_on_commit_broadcasts_still_run_after_first_send_raises(self):
        # First send fails, the rest succeed: every queued callback must still
        # reach group_send, and the transaction's caller must see no exception.
        layer = self._layer([ConnectionError("down"), None, None])
        with patch("boards.broadcast.get_channel_layer", return_value=layer):
            with self.assertLogs("boards.broadcast", level="WARNING") as logs:
                with self.captureOnCommitCallbacks(execute=True) as callbacks:
                    with transaction.atomic():
                        for i in range(3):
                            transaction.on_commit(
                                lambda i=i: broadcast_board_event(1, "card.updated", {"n": i})
                            )
        self.assertEqual(len(callbacks), 3)
        self.assertEqual(layer.group_send.await_count, 3)
        self.assertEqual(len([r for r in logs.records if r.levelname == "WARNING"]), 1)

    def test_non_connection_error_is_swallowed_and_logged_the_same_way(self):
        layer = self._layer(TypeError("can't serialize " + SECRET_TITLE))
        with patch("boards.broadcast.get_channel_layer", return_value=layer):
            with self.assertLogs("boards.broadcast", level="DEBUG") as logs:
                broadcast_board_event(5, "card.moved", {"title": SECRET_TITLE})
        warnings = [r for r in logs.records if r.levelname == "WARNING"]
        self.assertEqual(len(warnings), 1)
        msg = warnings[0].getMessage()
        self.assertIn("board_id=5", msg)
        self.assertIn("event=card.moved", msg)
        self.assertIn("TypeError", msg)
        self.assertNotIn(SECRET_TITLE, msg)
        self.assertIsNone(warnings[0].exc_info)
        # The traceback is available only at DEBUG.
        debug = [r for r in logs.records if r.levelname == "DEBUG"]
        self.assertEqual(len(debug), 1)
        self.assertIsNotNone(debug[0].exc_info)

    def test_group_helper_non_connection_error_is_swallowed(self):
        layer = self._layer(TypeError("boom"))
        with patch("groups.broadcast.get_channel_layer", return_value=layer):
            with self.assertLogs("groups.broadcast", level="DEBUG") as logs:
                broadcast_group_event(3, "board.updated", {"name": "x"})
        warnings = [r for r in logs.records if r.levelname == "WARNING"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("TypeError", warnings[0].getMessage())
        self.assertTrue(any(r.levelname == "DEBUG" and r.exc_info for r in logs.records))

    def test_payload_serialization_error_still_raises(self):
        # Outside the try on purpose: an unserializable payload is a code bug.
        layer = self._layer(None)
        with patch("boards.broadcast.get_channel_layer", return_value=layer):
            with self.assertRaises(Exception):
                broadcast_board_event(1, "card.updated", {"bad": object()})
        layer.group_send.assert_not_awaited()
