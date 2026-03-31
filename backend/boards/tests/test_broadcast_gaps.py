"""
Tests for #203: broadcast_board_event wired to previously-silent mutation
endpoints (comment, checklist, attachment, label, membership, reorder) and
confirmed to fire via transaction.on_commit().

Pattern: patch boards.broadcast.broadcast_board_event, use captureOnCommitCallbacks,
make the API call, assert the expected event_type was broadcast.
"""
import tempfile
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardAttachment, CardChecklist,
    Column, Label, Swimlane,
)


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


class BroadcastGapsMixin:
    """Shared setUp used by all classes below."""

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="admin_user", password="pass")
        self.client.force_authenticate(self.user)
        self.board = make_board(self.user)
        self.col = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True
        )
        self.swim = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.card = make_card(self.board, self.col, self.swim, self.user)


# ---------------------------------------------------------------------------
# Card sub-resources → card.updated
# ---------------------------------------------------------------------------

class CommentAddBroadcastTests(BroadcastGapsMixin, TestCase):

    def _url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/"

    def test_comment_add_broadcasts_card_updated_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._url(), {"body": "Hello!"})
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.updated", event_types)

    def test_comment_add_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._url(), {"body": "Hello!"})
                mock_broadcast.assert_not_called()


@override_settings(
    DEFAULT_FILE_STORAGE="django.core.files.storage.FileSystemStorage",
    MEDIA_ROOT=tempfile.mkdtemp(),
)
class AttachmentBroadcastTests(BroadcastGapsMixin, TestCase):

    def _url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/"

    def test_attachment_add_broadcasts_card_updated_after_commit(self):
        fake_file = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with patch("boards.views.cards._validate_upload_mime", return_value=None):
                with self.captureOnCommitCallbacks(execute=True):
                    resp = self.client.post(self._url(), {"file": fake_file}, format="multipart")
                self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
                event_types = [c[0][1] for c in mock_broadcast.call_args_list]
                self.assertIn("card.updated", event_types)

    def test_attachment_delete_broadcasts_card_updated_after_commit(self):
        attachment = CardAttachment.objects.create(
            card=self.card,
            filename="test.txt",
            size=5,
            uploaded_by=self.user,
        )
        del_url = f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{attachment.pk}/"
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with patch.object(attachment.file, "delete", return_value=None):
                with self.captureOnCommitCallbacks(execute=True):
                    resp = self.client.delete(del_url)
                self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
                event_types = [c[0][1] for c in mock_broadcast.call_args_list]
                self.assertIn("card.updated", event_types)


class ChecklistBroadcastTests(BroadcastGapsMixin, TestCase):

    def _list_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/"

    def _item_url(self, pk):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{pk}/"

    def test_checklist_add_broadcasts_card_updated_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._list_url(), {"text": "Step one"})
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.updated", event_types)

    def test_checklist_add_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._list_url(), {"text": "Step one"})
                mock_broadcast.assert_not_called()

    def test_checklist_update_broadcasts_card_updated_after_commit(self):
        item = CardChecklist.objects.create(card=self.card, text="Step one", position=0)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.patch(self._item_url(item.pk), {"is_checked": True})
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.updated", event_types)

    def test_checklist_delete_broadcasts_card_updated_after_commit(self):
        item = CardChecklist.objects.create(card=self.card, text="Step one", position=0)
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._item_url(item.pk))
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.updated", event_types)


# ---------------------------------------------------------------------------
# Label CRUD → label.created / label.updated / label.deleted
# ---------------------------------------------------------------------------

class LabelBroadcastTests(BroadcastGapsMixin, TestCase):

    def _list_url(self):
        return f"/api/boards/{self.board.pk}/labels/"

    def _detail_url(self, pk):
        return f"/api/boards/{self.board.pk}/labels/{pk}/"

    def test_label_create_broadcasts_label_created_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(self._list_url(), {"name": "Bug", "color": "#EF4444"})
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("label.created", event_types)

    def test_label_create_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(self._list_url(), {"name": "Bug", "color": "#EF4444"})
                mock_broadcast.assert_not_called()

    def test_label_update_broadcasts_label_updated_after_commit(self):
        label = Label.objects.create(board=self.board, name="Bug", color="#EF4444")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.patch(self._detail_url(label.pk), {"name": "Bug (revised)"})
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("label.updated", event_types)

    def test_label_delete_broadcasts_label_deleted_after_commit(self):
        label = Label.objects.create(board=self.board, name="Bug", color="#EF4444")
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._detail_url(label.pk))
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("label.deleted", event_types)

    def test_label_deleted_payload_contains_label_uid(self):
        label = Label.objects.create(board=self.board, name="Bug", color="#EF4444")
        label_uid = label.uid
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(self._detail_url(label.pk))
            delete_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "label.deleted"]
            self.assertEqual(len(delete_calls), 1)
            payload = delete_calls[0][0][2]
            self.assertEqual(payload["label_uid"], label_uid)


# ---------------------------------------------------------------------------
# Membership → member.added / member.updated / member.removed
# ---------------------------------------------------------------------------

class MembershipBroadcastTests(BroadcastGapsMixin, TestCase):

    def setUp(self):
        super().setUp()
        self.other_user = User.objects.create_user(username="other_user", password="pass")

    def _members_url(self):
        return f"/api/boards/{self.board.pk}/members/"

    def _remove_url(self, user_id):
        return f"/api/boards/{self.board.pk}/members/{user_id}/"

    def test_member_add_broadcasts_member_added_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    self._members_url(),
                    {"user_id": self.other_user.pk, "role": "member"},
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("member.added", event_types)

    def test_member_update_broadcasts_member_updated_after_commit(self):
        # Pre-existing membership → role change → member.updated
        BoardMembership.objects.create(
            board=self.board, user=self.other_user, role=BoardMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    self._members_url(),
                    {"user_id": self.other_user.pk, "role": "viewer"},
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("member.updated", event_types)
            self.assertNotIn("member.added", event_types)

    def test_member_remove_broadcasts_member_removed_after_commit(self):
        BoardMembership.objects.create(
            board=self.board, user=self.other_user, role=BoardMembership.Role.MEMBER
        )
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(self._remove_url(self.other_user.pk))
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("member.removed", event_types)

    def test_member_removed_payload_contains_user_id(self):
        BoardMembership.objects.create(
            board=self.board, user=self.other_user, role=BoardMembership.Role.MEMBER
        )
        user_id = self.other_user.pk
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(self._remove_url(self.other_user.pk))
            remove_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "member.removed"]
            self.assertEqual(len(remove_calls), 1)
            payload = remove_calls[0][0][2]
            self.assertEqual(payload["user_id"], user_id)


# ---------------------------------------------------------------------------
# Reorder → columns.reordered / swimlanes.reordered
# ---------------------------------------------------------------------------

class ReorderBroadcastTests(BroadcastGapsMixin, TestCase):

    def setUp(self):
        super().setUp()
        self.col2 = Column.objects.create(board=self.board, name="In Progress", position=1)
        self.swim2 = Swimlane.objects.create(board=self.board, name="Beta Corp", position=1)

    def test_column_reorder_broadcasts_columns_reordered_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/boards/{self.board.pk}/columns/reorder/",
                    {"order": [self.col2.pk, self.col.pk]},
                )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("columns.reordered", event_types)

    def test_column_reorder_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(
                    f"/api/boards/{self.board.pk}/columns/reorder/",
                    {"order": [self.col2.pk, self.col.pk]},
                )
                mock_broadcast.assert_not_called()

    def test_swimlane_reorder_broadcasts_swimlanes_reordered_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.post(
                    f"/api/boards/{self.board.pk}/swimlanes/reorder/",
                    {"order": [self.swim2.pk, self.swim.pk]},
                )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("swimlanes.reordered", event_types)

    def test_swimlane_reorder_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.post(
                    f"/api/boards/{self.board.pk}/swimlanes/reorder/",
                    {"order": [self.swim2.pk, self.swim.pk]},
                )
                mock_broadcast.assert_not_called()


# ---------------------------------------------------------------------------
# Previously-bare broadcasts now wrapped in on_commit
# ---------------------------------------------------------------------------

class CardDeletedOnCommitTests(BroadcastGapsMixin, TestCase):

    def test_card_deleted_broadcast_fires_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.delete(
                    f"/api/boards/{self.board.pk}/cards/{self.card.pk}/"
                )
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.deleted", event_types)

    def test_card_deleted_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.delete(f"/api/boards/{self.board.pk}/cards/{self.card.pk}/")
                mock_broadcast.assert_not_called()

    def test_card_deleted_payload_contains_card_uid(self):
        card_uid = self.card.uid
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(f"/api/boards/{self.board.pk}/cards/{self.card.pk}/")
            delete_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "card.deleted"]
            self.assertEqual(len(delete_calls), 1)
            payload = delete_calls[0][0][2]
            self.assertEqual(payload["card_uid"], card_uid)
            self.assertNotIn("card_id", payload)


class ColumnDeletedPayloadTests(BroadcastGapsMixin, TestCase):

    def test_column_deleted_payload_contains_column_uid(self):
        col2 = Column.objects.create(board=self.board, name="Done", position=1, allow_card_creation=True)
        col_uid = col2.uid
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(f"/api/boards/{self.board.pk}/columns/{col2.pk}/")
            delete_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "column.deleted"]
            self.assertEqual(len(delete_calls), 1)
            payload = delete_calls[0][0][2]
            self.assertEqual(payload["column_uid"], col_uid)
            self.assertNotIn("column_id", payload)


class SwimlaneDeletedPayloadTests(BroadcastGapsMixin, TestCase):

    def test_swimlane_deleted_payload_contains_swimlane_uid(self):
        swim2 = Swimlane.objects.create(board=self.board, name="Beta Corp", position=1)
        swim_uid = swim2.uid
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.delete(f"/api/boards/{self.board.pk}/swimlanes/{swim2.pk}/")
            delete_calls = [c for c in mock_broadcast.call_args_list if c[0][1] == "swimlane.deleted"]
            self.assertEqual(len(delete_calls), 1)
            payload = delete_calls[0][0][2]
            self.assertEqual(payload["swimlane_uid"], swim_uid)
            self.assertNotIn("swimlane_id", payload)


class CardUpdatedOnCommitTests(BroadcastGapsMixin, TestCase):

    def test_card_updated_broadcast_fires_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                resp = self.client.patch(
                    f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
                    {"title": "Updated Title"},
                )
            self.assertEqual(resp.status_code, status.HTTP_200_OK)
            event_types = [c[0][1] for c in mock_broadcast.call_args_list]
            self.assertIn("card.updated", event_types)

    def test_card_updated_broadcast_not_called_before_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False):
                self.client.patch(
                    f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
                    {"title": "Updated Title"},
                )
                mock_broadcast.assert_not_called()
