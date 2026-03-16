"""Tests for stable hex UID fields on core board models (#202)."""
import re

from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, Column, Swimlane, Label, Card, CardMovement

_UID_RE = re.compile(r"^[0-9a-f]{16}$")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_board(owner, name="Test Board"):
    board = Board.objects.create(name=name, owner=owner)
    column = Column.objects.create(board=board, name="Todo", position=0)
    swimlane = Swimlane.objects.create(board=board, name="Lane A", position=0)
    label = Label.objects.create(board=board, name="Bug", color="#ff0000")
    card = Card.objects.create(
        board=board, column=column, swimlane=swimlane,
        title="Test card", created_by=owner, position=0,
    )
    return board, column, swimlane, label, card


# ---------------------------------------------------------------------------
# Unit tests — model-level uid behaviour
# ---------------------------------------------------------------------------

class UidFormatTests(TestCase):
    """uid fields are 16 lowercase hex characters."""

    def setUp(self):
        self.user = User.objects.create_user(username="u1", password="pass")
        self.board, self.col, self.lane, self.lbl, self.card = _make_board(self.user)

    def test_board_uid_format(self):
        self.assertRegex(self.board.uid, _UID_RE)

    def test_column_uid_format(self):
        self.assertRegex(self.col.uid, _UID_RE)

    def test_swimlane_uid_format(self):
        self.assertRegex(self.lane.uid, _UID_RE)

    def test_label_uid_format(self):
        self.assertRegex(self.lbl.uid, _UID_RE)

    def test_card_uid_format(self):
        self.assertRegex(self.card.uid, _UID_RE)


class UidUniquenessTests(TestCase):
    """uid values are unique across rows of the same model."""

    def setUp(self):
        self.user = User.objects.create_user(username="u2", password="pass")

    def test_column_uids_are_unique(self):
        board = Board.objects.create(name="B", owner=self.user)
        c1 = Column.objects.create(board=board, name="A", position=0)
        c2 = Column.objects.create(board=board, name="B", position=1)
        self.assertNotEqual(c1.uid, c2.uid)

    def test_card_uids_are_unique(self):
        board = Board.objects.create(name="B", owner=self.user)
        col = Column.objects.create(board=board, name="C", position=0)
        lane = Swimlane.objects.create(board=board, name="L", position=0)
        c1 = Card.objects.create(board=board, column=col, swimlane=lane, title="X", position=0)
        c2 = Card.objects.create(board=board, column=col, swimlane=lane, title="Y", position=1)
        self.assertNotEqual(c1.uid, c2.uid)


class UidImmutabilityTests(TestCase):
    """uid cannot be changed via the API (read_only=True in serializer)."""

    def setUp(self):
        self.user = User.objects.create_user(username="u3", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board, self.col, self.lane, self.lbl, self.card = _make_board(self.user)
        # Admin membership required for write operations
        from boards.models import BoardMembership
        BoardMembership.objects.get_or_create(
            board=self.board, user=self.user,
            defaults={"role": BoardMembership.Role.ADMIN},
        )

    def test_patch_column_cannot_change_uid(self):
        original_uid = self.col.uid
        url = reverse("board-column-detail", kwargs={"board_pk": self.board.pk, "pk": self.col.pk})
        resp = self.client.patch(url, {"uid": "deadbeefdeadbeef", "name": "Renamed"}, format="json")
        self.assertIn(resp.status_code, [200, 204])
        self.col.refresh_from_db()
        self.assertEqual(self.col.uid, original_uid)

    def test_patch_card_cannot_change_uid(self):
        original_uid = self.card.uid
        url = reverse("board-card-detail", kwargs={"board_pk": self.board.pk, "pk": self.card.pk})
        resp = self.client.patch(url, {"uid": "aaaaaaaaaaaaaaaa", "title": "Updated"}, format="json")
        self.assertIn(resp.status_code, [200, 204])
        self.card.refresh_from_db()
        self.assertEqual(self.card.uid, original_uid)


# ---------------------------------------------------------------------------
# Serializer output tests — uid present in API responses
# ---------------------------------------------------------------------------

class UidInApiResponseTests(TestCase):
    """uid fields appear in all relevant API responses."""

    def setUp(self):
        self.user = User.objects.create_user(username="u4", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board, self.col, self.lane, self.lbl, self.card = _make_board(self.user)
        from boards.models import BoardMembership
        BoardMembership.objects.get_or_create(
            board=self.board, user=self.user,
            defaults={"role": BoardMembership.Role.ADMIN},
        )

    def test_full_board_contains_uid_on_board(self):
        url = reverse("board-full", kwargs={"pk": self.board.pk})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("uid", resp.data)
        self.assertRegex(resp.data["uid"], _UID_RE)

    def test_full_board_columns_contain_uid(self):
        url = reverse("board-full", kwargs={"pk": self.board.pk})
        resp = self.client.get(url)
        col = resp.data["columns"][0]
        self.assertIn("uid", col)
        self.assertRegex(col["uid"], _UID_RE)

    def test_full_board_swimlanes_contain_uid(self):
        url = reverse("board-full", kwargs={"pk": self.board.pk})
        resp = self.client.get(url)
        lane = resp.data["swimlanes"][0]
        self.assertIn("uid", lane)
        self.assertRegex(lane["uid"], _UID_RE)

    def test_full_board_cards_contain_uid(self):
        url = reverse("board-full", kwargs={"pk": self.board.pk})
        resp = self.client.get(url)
        card = resp.data["cards"][0]
        self.assertIn("uid", card)
        self.assertRegex(card["uid"], _UID_RE)

    def test_full_board_labels_contain_uid(self):
        url = reverse("board-full", kwargs={"pk": self.board.pk})
        resp = self.client.get(url)
        label = resp.data["labels"][0]
        self.assertIn("uid", label)
        self.assertRegex(label["uid"], _UID_RE)

    def test_board_list_contains_uid(self):
        url = reverse("board-list")
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        board_data = next(b for b in resp.data["results"] if b["id"] == self.board.pk)
        self.assertIn("uid", board_data)
        self.assertRegex(board_data["uid"], _UID_RE)


# ---------------------------------------------------------------------------
# CardMovement uid fields
# ---------------------------------------------------------------------------

class CardMovementUidTests(TestCase):
    """CardMovement captures uid fields at write time."""

    def setUp(self):
        self.user = User.objects.create_user(username="u5", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board, self.col, self.lane, self.lbl, self.card = _make_board(self.user)
        from boards.models import BoardMembership
        BoardMembership.objects.get_or_create(
            board=self.board, user=self.user,
            defaults={"role": BoardMembership.Role.ADMIN},
        )

    def _create_card_via_api(self):
        """Create a card via the API so CardMovement is written by the view."""
        # Allow card creation in the column
        self.col.allow_card_creation = True
        self.col.save()
        url = reverse("board-card-list", kwargs={"board_pk": self.board.pk})
        resp = self.client.post(url, {
            "column": self.col.pk,
            "swimlane": self.lane.pk,
            "title": "API card",
            "priority": "medium",
            "weight": 1,
        }, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        return Card.objects.get(pk=resp.data["id"])

    def test_card_creation_movement_captures_to_uids(self):
        card = self._create_card_via_api()
        mv = CardMovement.objects.filter(card=card, notes="Card created").first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.to_column_uid, self.col.uid)
        self.assertEqual(mv.to_swimlane_uid, self.lane.uid)
        self.assertEqual(mv.from_column_uid, "")
        self.assertEqual(mv.from_swimlane_uid, "")

    def test_card_move_captures_from_and_to_uids(self):
        card = self._create_card_via_api()
        target_col = Column.objects.create(board=self.board, name="Done", position=1)
        url = reverse("board-card-move", kwargs={"board_pk": self.board.pk, "pk": card.pk})
        resp = self.client.post(url, {
            "column_id": target_col.pk,
            "swimlane_id": self.lane.pk,
            "position": 0,
        }, format="json")
        self.assertEqual(resp.status_code, 200)

        mv = CardMovement.objects.filter(card=card).exclude(notes="Card created").first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.from_column_uid, self.col.uid)
        self.assertEqual(mv.to_column_uid, target_col.uid)
        self.assertEqual(mv.from_swimlane_uid, self.lane.uid)
        self.assertEqual(mv.to_swimlane_uid, self.lane.uid)

    def test_movement_serializer_exposes_uid_fields(self):
        card = self._create_card_via_api()
        url = reverse("board-card-movements", kwargs={"board_pk": self.board.pk, "pk": card.pk})
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        mv = resp.data[0]
        self.assertIn("to_column_uid", mv)
        self.assertIn("from_column_uid", mv)
        self.assertIn("to_swimlane_uid", mv)
        self.assertIn("from_swimlane_uid", mv)
