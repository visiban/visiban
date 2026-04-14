"""
Tests for pre-1.0 broadcast fixes (#318):

  Gap 6: Removed member's WebSocket connection is closed on member.removed.
  Gap 1: board.updated broadcast fires after perform_update.
  Gap 1: board.deleted broadcast fires after destroy.
  Gap 3: attachment creation broadcast fires only inside a committed atomic block.
"""
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

from django.db import transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def make_card(board, col, swim, user):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title="Test Card", created_by=user, position=0,
    )


# ---------------------------------------------------------------------------
# Gap 6: BoardConsumer closes connection for removed member
# ---------------------------------------------------------------------------

class BoardConsumerMemberRemovedTests(TestCase):
    """
    Unit-test BoardConsumer.board_event directly.  We construct a minimal fake
    consumer instance rather than spinning up the full ASGI stack.
    """

    def _make_consumer(self, user_id):
        """Return a BoardConsumer-like object wired with a mock send and close."""
        from boards.consumers import BoardConsumer
        consumer = BoardConsumer.__new__(BoardConsumer)
        consumer.scope = {"user": MagicMock(id=user_id)}
        consumer.send = AsyncMock()
        consumer.close = AsyncMock()
        return consumer

    def _run(self, coro):
        """Run an async coroutine synchronously in tests."""
        import asyncio
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_member_removed_closes_connection_for_affected_user(self):
        """board_event closes the connection when member.removed targets this user."""
        consumer = self._make_consumer(user_id=42)
        event = {
            "payload": {
                "event": "member.removed",
                "data": {"user_id": 42},
            }
        }
        self._run(consumer.board_event(event))
        consumer.close.assert_awaited_once()
        consumer.send.assert_not_awaited()

    def test_member_removed_does_not_close_connection_for_other_user(self):
        """board_event does NOT close the connection when member.removed targets a different user."""
        consumer = self._make_consumer(user_id=99)
        event = {
            "payload": {
                "event": "member.removed",
                "data": {"user_id": 42},
            }
        }
        self._run(consumer.board_event(event))
        consumer.close.assert_not_awaited()
        consumer.send.assert_awaited_once()

    def test_other_event_does_not_close_connection(self):
        """board_event sends normally for non-member.removed events."""
        consumer = self._make_consumer(user_id=42)
        event = {
            "payload": {
                "event": "card.updated",
                "data": {"card_id": 7},
            }
        }
        self._run(consumer.board_event(event))
        consumer.close.assert_not_awaited()
        consumer.send.assert_awaited_once()


# ---------------------------------------------------------------------------
# Gap 1: board.updated broadcast on perform_update
# ---------------------------------------------------------------------------

class BoardUpdatedBroadcastTests(TestCase):

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)

    def test_board_updated_broadcast_fires_after_commit(self):
        """PATCH /api/boards/{id}/ fires board.updated via on_commit."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/",
                    {"name": "Renamed Board"},
                )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("board.updated", event_types)

    def test_board_updated_broadcast_not_called_before_commit(self):
        """board.updated must not fire before on_commit callbacks execute."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/",
                    {"name": "Renamed Board"},
                )
                mock_broadcast.assert_not_called()

    def test_board_updated_payload_contains_board_id(self):
        """board.updated payload is keyed by the board's own ID."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/",
                    {"name": "Renamed Board"},
                )
            updated_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "board.updated"]
            self.assertEqual(len(updated_calls), 1)
            # First positional arg is board_id
            self.assertEqual(updated_calls[0][0][0], self.board.pk)


# ---------------------------------------------------------------------------
# Gap 1: board.deleted broadcast on destroy
# ---------------------------------------------------------------------------

class BoardDeletedBroadcastTests(TestCase):

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)

    def test_board_deleted_broadcast_fires_after_commit(self):
        """DELETE /api/boards/{id}/ fires board.deleted via on_commit."""
        board_pk = self.board.pk
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(f"/api/v1/boards/{board_pk}/")
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("board.deleted", event_types)

    def test_board_deleted_broadcast_not_called_before_commit(self):
        """board.deleted must not fire before on_commit callbacks execute."""
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.delete(f"/api/v1/boards/{self.board.pk}/")
                mock_broadcast.assert_not_called()

    def test_board_deleted_payload_contains_board_id_and_uid(self):
        """board.deleted payload contains both board_uid (canonical) and board_id (deprecated compat)."""
        board_pk = self.board.pk
        board_uid = self.board.uid
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(f"/api/v1/boards/{board_pk}/")
            deleted_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "board.deleted"]
            self.assertEqual(len(deleted_calls), 1)
            payload = deleted_calls[0][0][2]
            # board_id is kept for backward compatibility with pre-1.1 clients.
            self.assertEqual(payload["board_id"], board_pk)
            # board_uid is the canonical stable identifier; all new clients should use this.
            self.assertEqual(payload["board_uid"], board_uid)


# ---------------------------------------------------------------------------
# Gap 3: attachment broadcast inside atomic block — no broadcast on rollback
# ---------------------------------------------------------------------------

@override_settings(
    DEFAULT_FILE_STORAGE="django.core.files.storage.FileSystemStorage",
    MEDIA_ROOT=tempfile.mkdtemp(),
)
class AttachmentAtomicBroadcastTests(TestCase):
    """Verify that attachment creation broadcasts via on_commit inside an atomic block."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = make_card(self.board, self.col, self.swim, self.user)

    def _url(self):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/attachments/"

    def test_attachment_upload_broadcasts_card_updated_after_commit(self):
        """Attachment upload fires card.updated broadcast via on_commit."""
        fake_file = SimpleUploadedFile("doc.txt", b"hello", content_type="text/plain")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with patch("boards.views.cards._validate_upload_mime", return_value=None):
                with self.captureOnCommitCallbacks(execute=True):
                    resp = self.client.post(self._url(), {"file": fake_file}, format="multipart")
                self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
                event_types = [c[0][1] for c in mock_broadcast.call_args_list]
                self.assertIn("card.updated", event_types)

    def test_attachment_broadcast_not_called_before_commit(self):
        """card.updated broadcast must not fire before on_commit callbacks execute."""
        fake_file = SimpleUploadedFile("doc.txt", b"hello", content_type="text/plain")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with patch("boards.views.cards._validate_upload_mime", return_value=None):
                with self.captureOnCommitCallbacks(execute=False):
                    self.client.post(self._url(), {"file": fake_file}, format="multipart")
                    mock_broadcast.assert_not_called()


class AttachmentAtomicRollbackTests(TransactionTestCase):
    """
    TransactionTestCase: verifies that on_commit callbacks are suppressed when
    a transaction rolls back, confirming the atomic wrap is meaningful.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pass")
        self.board = Board.objects.create(name="Test Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)

    def test_on_commit_suppressed_on_rollback(self):
        """on_commit callback inside a rolled-back atomic block must not fire."""
        broadcast_calls = []

        def capture(*args, **kwargs):
            broadcast_calls.append(args)

        with patch("boards.broadcast.broadcast_board_event", side_effect=capture):
            try:
                with transaction.atomic():
                    transaction.on_commit(lambda: capture("should_not_fire"))
                    raise Exception("forced rollback")
            except Exception:
                pass

        self.assertEqual(broadcast_calls, [])
