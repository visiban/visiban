"""
Tests for #673: Django admin mutations on Card/Column must broadcast via
broadcast_board_event(), deferred through transaction.on_commit(), so clients
viewing the affected board see admin edits in real time.
"""
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase

from accounts.models import User
from boards.admin import CardAdmin, ColumnAdmin
from boards.models import Board, BoardMembership, Card, Column, Swimlane


class _DummyForm:
    """Minimal stand-in for a ModelForm; ModelAdmin.save_model ignores it here."""


def _make_request(user):
    request = RequestFactory().post("/admin/")
    request.user = user
    return request


class CardAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin", password="p", email="a@x")
        self.board = Board.objects.create(name="Admin Test Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.admin = CardAdmin(Card, AdminSite())

    def _new_card(self):
        return Card(
            board=self.board,
            column=self.column,
            swimlane=self.swimlane,
            title="From admin",
            created_by=self.admin_user,
            position=0,
        )

    def test_save_model_on_create_broadcasts_card_created_after_commit(self):
        request = _make_request(self.admin_user)
        card = self._new_card()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, card, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "card.created")
            self.assertEqual(payload["uid"], card.uid)

    def test_save_model_on_update_broadcasts_card_updated(self):
        card = self._new_card()
        card.save()
        request = _make_request(self.admin_user)
        card.title = "Edited in admin"
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, card, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "card.updated")

    def test_save_model_does_not_broadcast_before_commit(self):
        request = _make_request(self.admin_user)
        card = self._new_card()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.admin.save_model(request, card, _DummyForm(), change=False)
                mock_broadcast.assert_not_called()

    def test_delete_model_broadcasts_card_deleted_with_uid(self):
        card = self._new_card()
        card.save()
        card_uid = card.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, card)
            mock_broadcast.assert_called_once_with(
                self.board.id, "card.deleted", {"card_uid": card_uid}
            )

    def test_delete_queryset_broadcasts_once_per_card(self):
        c1, c2 = self._new_card(), self._new_card()
        c1.title = "One"; c1.save()
        c2.title = "Two"; c2.save()
        uids = {c1.uid, c2.uid}
        request = _make_request(self.admin_user)
        qs = Card.objects.filter(pk__in=[c1.pk, c2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["card_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)


class ColumnAdminBroadcastTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(username="admin2", password="p", email="b@x")
        self.board = Board.objects.create(name="Admin Column Board", owner=self.admin_user)
        BoardMembership.objects.create(
            board=self.board, user=self.admin_user, role=BoardMembership.Role.ADMIN
        )
        self.admin = ColumnAdmin(Column, AdminSite())

    def _new_column(self, position=0, name="New Col"):
        return Column(board=self.board, name=name, position=position, allow_card_creation=True)

    def test_save_model_on_create_broadcasts_column_created(self):
        request = _make_request(self.admin_user)
        col = self._new_column()
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, col, _DummyForm(), change=False)
            mock_broadcast.assert_called_once()
            board_id, event_type, payload = mock_broadcast.call_args[0]
            self.assertEqual(board_id, self.board.id)
            self.assertEqual(event_type, "column.created")
            self.assertEqual(payload["uid"], col.uid)

    def test_save_model_on_update_broadcasts_column_updated(self):
        col = self._new_column()
        col.save()
        col.name = "Edited"
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.save_model(request, col, _DummyForm(), change=True)
            mock_broadcast.assert_called_once()
            _, event_type, _ = mock_broadcast.call_args[0]
            self.assertEqual(event_type, "column.updated")

    def test_delete_model_broadcasts_column_deleted_with_uid(self):
        col = self._new_column()
        col.save()
        col_uid = col.uid
        request = _make_request(self.admin_user)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_model(request, col)
            mock_broadcast.assert_called_once_with(
                self.board.id, "column.deleted", {"column_uid": col_uid}
            )

    def test_delete_queryset_broadcasts_once_per_column(self):
        c1, c2 = self._new_column(position=0, name="A"), self._new_column(position=1, name="B")
        c1.save(); c2.save()
        uids = {c1.uid, c2.uid}
        request = _make_request(self.admin_user)
        qs = Column.objects.filter(pk__in=[c1.pk, c2.pk])
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.admin.delete_queryset(request, qs)
            self.assertEqual(mock_broadcast.call_count, 2)
            emitted = {call.args[2]["column_uid"] for call in mock_broadcast.call_args_list}
            self.assertEqual(emitted, uids)
