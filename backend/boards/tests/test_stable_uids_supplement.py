"""
Supplementary tests for !290 stable UID fields — covers gaps in
test_stable_uids.py: immutability on remaining models, deleted-FK
uid persistence, and movement uid visibility by role.
"""
import re

from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Label, Swimlane

_UID_RE = re.compile(r"^[0-9a-f]{16}$")


def _setup_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Todo", position=0)
    lane = Swimlane.objects.create(board=board, name="Lane A", position=0)
    label = Label.objects.create(board=board, name="Bug", color="#ff0000")
    card = Card.objects.create(
        board=board, column=col, swimlane=lane,
        title="Card", created_by=owner, position=0,
    )
    return board, col, lane, label, card


# ---------------------------------------------------------------------------
# Immutability — remaining models not covered by existing tests
# ---------------------------------------------------------------------------

class UidImmutabilityRemainingModelsTests(TestCase):
    """PATCH cannot change uid on Board, Swimlane, or Label."""

    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board, self.col, self.lane, self.label, self.card = _setup_board(self.user)

    def test_patch_board_cannot_change_uid(self):
        original = self.board.uid
        url = reverse("board-detail", kwargs={"pk": self.board.pk})
        resp = self.client.patch(url, {"uid": "deadbeefdeadbeef", "name": "Renamed"}, format="json")
        self.assertIn(resp.status_code, [200, 204])
        self.board.refresh_from_db()
        self.assertEqual(self.board.uid, original)

    def test_patch_swimlane_cannot_change_uid(self):
        original = self.lane.uid
        url = reverse("board-swimlane-detail", kwargs={"board_pk": self.board.pk, "pk": self.lane.pk})
        resp = self.client.patch(url, {"uid": "deadbeefdeadbeef", "name": "Renamed"}, format="json")
        self.assertIn(resp.status_code, [200, 204])
        self.lane.refresh_from_db()
        self.assertEqual(self.lane.uid, original)

    def test_patch_label_cannot_change_uid(self):
        original = self.label.uid
        url = reverse("board-label-detail", kwargs={"board_pk": self.board.pk, "pk": self.label.pk})
        resp = self.client.patch(url, {"uid": "deadbeefdeadbeef", "name": "Renamed"}, format="json")
        self.assertIn(resp.status_code, [200, 204])
        self.label.refresh_from_db()
        self.assertEqual(self.label.uid, original)


# ---------------------------------------------------------------------------
# Deleted-FK persistence — the primary use case from issue #202
# ---------------------------------------------------------------------------

class DeletedFkUidPersistenceTests(TestCase):
    """
    CardMovement retains uid fields even after the referenced column or
    swimlane is deleted (FK nulled). This is the key correctness invariant
    for #202 — uid allows history to remain meaningful post-deletion.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="owner2", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board, self.col, self.lane, self.label, self.card = _setup_board(self.user)
        self.target_col = Column.objects.create(board=self.board, name="Done", position=1)

    def _move_card(self, column, swimlane=None):
        url = reverse("board-card-move", kwargs={
            "board_pk": self.board.pk, "pk": self.card.pk,
        })
        resp = self.client.post(url, {
            "column_id": column.pk,
            "swimlane_id": (swimlane or self.lane).pk,
            "position": 0,
        }, format="json")
        self.assertEqual(resp.status_code, 200, resp.data)

    def test_from_column_uid_persists_after_column_deleted(self):
        # from_column_uid survives FK nullification when source column is deleted.
        source_uid = self.col.uid
        self._move_card(self.target_col)

        mv = CardMovement.objects.filter(card=self.card).exclude(notes="Card created").first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.from_column_uid, source_uid)

        self.col.delete()
        mv.refresh_from_db()

        self.assertIsNone(mv.from_column)
        self.assertEqual(mv.from_column_uid, source_uid)

    def test_to_column_uid_persists_after_column_deleted(self):
        # to_column_uid survives FK nullification when destination column is deleted.
        target_uid = self.target_col.uid
        self._move_card(self.target_col)

        mv = CardMovement.objects.filter(card=self.card).exclude(notes="Card created").first()
        self.assertEqual(mv.to_column_uid, target_uid)

        self.target_col.delete()
        mv.refresh_from_db()

        self.assertIsNone(mv.to_column)
        self.assertEqual(mv.to_column_uid, target_uid)

    def test_from_swimlane_uid_persists_after_swimlane_deleted(self):
        # from_swimlane_uid survives FK nullification when source swimlane is deleted.
        source_lane_uid = self.lane.uid
        target_lane = Swimlane.objects.create(board=self.board, name="Lane B", position=1)
        self._move_card(self.col, swimlane=target_lane)

        mv = CardMovement.objects.filter(card=self.card).exclude(notes="Card created").first()
        self.assertEqual(mv.from_swimlane_uid, source_lane_uid)

        self.lane.delete()
        mv.refresh_from_db()

        self.assertIsNone(mv.from_swimlane)
        self.assertEqual(mv.from_swimlane_uid, source_lane_uid)


# ---------------------------------------------------------------------------
# Role visibility — movement uid fields visible to all board members
# ---------------------------------------------------------------------------

class MovementUidRoleVisibilityTests(TestCase):
    """
    All board roles (admin, member, viewer) can read uid fields in movement
    history. Non-members are denied. uid fields are stable public identifiers,
    not sensitive data.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner3", password="pw")
        self.member = User.objects.create_user(username="member", password="pw")
        self.viewer = User.objects.create_user(username="viewer", password="pw")
        self.board, self.col, self.lane, self.label, self.card = _setup_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER,
        )
        target = Column.objects.create(board=self.board, name="Done", position=1)
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col, from_column_uid=self.col.uid,
            to_column=target, to_column_uid=target.uid,
            from_swimlane=self.lane, from_swimlane_uid=self.lane.uid,
            to_swimlane=self.lane, to_swimlane_uid=self.lane.uid,
            moved_by=self.owner,
            notes="Moved",
        )

    def _get_movements(self, user):
        client = APIClient()
        client.force_authenticate(user)
        url = reverse("board-card-movements", kwargs={
            "board_pk": self.board.pk, "pk": self.card.pk,
        })
        return client.get(url)

    def test_admin_sees_uid_in_movements(self):
        resp = self._get_movements(self.owner)
        self.assertEqual(resp.status_code, 200)
        self.assertRegex(resp.data[0]["to_column_uid"], _UID_RE)

    def test_member_sees_uid_in_movements(self):
        resp = self._get_movements(self.member)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("to_column_uid", resp.data[0])

    def test_viewer_sees_uid_in_movements(self):
        resp = self._get_movements(self.viewer)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("to_column_uid", resp.data[0])

    def test_non_member_cannot_read_movements(self):
        outsider = User.objects.create_user(username="outsider", password="pw")
        resp = self._get_movements(outsider)
        self.assertEqual(resp.status_code, 403)
