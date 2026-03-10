"""Extra coverage tests: card move, card activities, attachments, move-group, analytics with movements."""
import io
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardMovement,
    Column, Swimlane, Label,
)
from groups.models import Group, GroupMembership


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col2 = Column.objects.create(board=board, name="Done", position=1, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, col2, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


# ---------------------------------------------------------------------------
# Card move
# ---------------------------------------------------------------------------

class CardMoveTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_move_card_creates_movement(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col2.id, "swimlane_id": self.swim.id, "position": 0},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)

    def test_collaborator_cannot_move_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR
        )
        self.client.force_authenticate(collab)
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col2.id, "swimlane_id": self.swim.id, "position": 0},
            format="json",
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


# ---------------------------------------------------------------------------
# Card update — extra activity types
# ---------------------------------------------------------------------------

class CardUpdateExtraTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_update_weight_logs_activity(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"weight": 5},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.WEIGHT_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_description_logs_activity(self, _):
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"description": "New description"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.DESCRIPTION_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_remove_label_logs_activity(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        self.card.labels.add(label)
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": []},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.LABEL_CHANGE
            ).exists()
        )

    def test_collaborator_cannot_update_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR
        )
        self.client.force_authenticate(collab)
        r = self.client.patch(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/",
            {"title": "Hacked"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

class CardAttachmentTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_list_attachments_empty(self):
        r = self.client.get(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_upload_attachment(self):
        content = b"hello file content"
        upload = io.BytesIO(content)
        upload.name = "test.txt"
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {"file": upload},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["filename"], "test.txt")

    def test_upload_missing_file_rejected(self):
        r = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_delete_attachment(self):
        # Upload first
        upload = io.BytesIO(b"data")
        upload.name = "del.txt"
        r_up = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {"file": upload},
            format="multipart",
        )
        self.assertEqual(r_up.status_code, status.HTTP_201_CREATED)
        att_id = r_up.json()["id"]
        r = self.client.delete(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/attachments/{att_id}/"
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Board move-group action
# ---------------------------------------------------------------------------

class BoardMoveGroupTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        self.group = Group.objects.create(name="MyGroup", owner=self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    @patch(PATCH_BROADCAST)
    def test_owner_can_move_board_to_group(self, _):
        r = self.client.post(
            f"/api/boards/{self.board.id}/move-group/",
            {"group_id": self.group.id},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.group_id, self.group.id)

    @patch(PATCH_BROADCAST)
    def test_owner_can_move_board_to_personal(self, _):
        self.board.group = self.group
        self.board.save()
        r = self.client.post(
            f"/api/boards/{self.board.id}/move-group/",
            {"group_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.group_id)

    @patch(PATCH_BROADCAST)
    def test_non_group_member_cannot_move_to_group(self, _):
        # other has no group membership
        BoardMembership.objects.create(
            board=self.board, user=self.other, role=BoardMembership.Role.ADMIN
        )
        self.client.force_authenticate(self.other)
        r = self.client.post(
            f"/api/boards/{self.board.id}/move-group/",
            {"group_id": self.group.id},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# Analytics with actual card movements
# ---------------------------------------------------------------------------

class BoardAnalyticsWithMovementsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        # Create a card and add movements so the analytics loop executes
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        CardMovement.objects.create(
            card=self.card, to_column=self.col, to_swimlane=self.swim, moved_by=self.user
        )
        CardMovement.objects.create(
            card=self.card, to_column=self.col2, to_swimlane=self.swim, moved_by=self.user
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_analytics_with_movements_returns_ok(self):
        r = self.client.get(f"/api/boards/{self.board.id}/analytics/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("swimlanes", data)
        self.assertIn("columns", data)


# ---------------------------------------------------------------------------
# Site admin board queryset
# ---------------------------------------------------------------------------

class SiteAdminBoardListTests(TestCase):
    def setUp(self):
        self.site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True
        )
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.site_admin)

    def test_site_admin_sees_all_boards(self):
        r = self.client.get("/api/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [b["id"] for b in r.json()["results"]]
        self.assertIn(self.board.id, ids)
