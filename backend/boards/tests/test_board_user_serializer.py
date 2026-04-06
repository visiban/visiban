"""Tests for BoardUserSerializer — private field leakage prevention (#533).

Verifies that board API payloads (card assignees, movement authors, comment
authors, board members, etc.) expose only the four public fields and never
leak notification preferences, UI preferences, or the can_access_all_content
privilege flag to other board members.

The full UserSerializer shape is reserved for /api/auth/me/ only.
"""

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardMovement


# ---------------------------------------------------------------------------
# Private fields that must NEVER appear in board resource payloads
# ---------------------------------------------------------------------------

PRIVATE_FIELDS = {
    "email",
    "first_name",
    "last_name",
    "is_site_admin",
    "can_access_all_content",
    "must_change_password",
    "must_change_username",
    "has_usable_password",
    "timezone",
    "date_format",
    "time_format",
    "number_locale",
    "close_editor_on_enter",
    "has_completed_tour",
    "notif_card_assigned",
    "notif_mentioned",
    "notif_due_soon",
    "notif_card_moved",
    "notif_comment_added",
    "notif_board_invite",
    "default_board_id",
    "uploads_enabled",
}

PUBLIC_FIELDS = {"id", "username", "display_name", "avatar_url"}


def _make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _add_member(board, username):
    user = User.objects.create_user(username=username, password="pass")
    BoardMembership.objects.create(board=board, user=user, role=BoardMembership.Role.MEMBER)
    return user


def _assert_board_user_shape(test_case, user_obj, context_label):
    """Assert user_obj has only public fields and none of the private ones."""
    if user_obj is None:
        return
    present_fields = set(user_obj.keys())
    leaked = present_fields & PRIVATE_FIELDS
    test_case.assertFalse(
        leaked,
        f"{context_label}: private fields leaked into board payload: {leaked}",
    )
    # All four public fields must be present.
    for field in PUBLIC_FIELDS:
        test_case.assertIn(field, present_fields, f"{context_label}: expected field '{field}' missing")


class BoardUserSerializerShapeTests(TestCase):
    """BoardUserSerializer must include only the four public fields."""

    def setUp(self):
        from accounts.serializers import BoardUserSerializer, UserSerializer
        self.owner = User.objects.create_user(
            username="owner",
            password="pass",
            email="owner@example.com",
            notif_card_assigned=True,
        )
        self.board_user_serializer_class = BoardUserSerializer
        self.user_serializer_class = UserSerializer

    def test_board_user_serializer_exposes_only_public_fields(self):
        data = self.board_user_serializer_class(self.owner).data
        present = set(data.keys())
        leaked = present & PRIVATE_FIELDS
        self.assertFalse(leaked, f"BoardUserSerializer leaked private fields: {leaked}")
        for f in PUBLIC_FIELDS:
            self.assertIn(f, present)

    def test_user_serializer_still_includes_full_shape(self):
        """UserSerializer (for /api/auth/me/) must still include private fields."""
        from rest_framework.test import APIRequestFactory
        factory = APIRequestFactory()
        request = factory.get("/")
        request.user = self.owner
        data = self.user_serializer_class(self.owner, context={"request": request}).data
        present = set(data.keys())
        # Spot-check a few private fields remain in the full serializer.
        for field in ("email", "notif_card_assigned", "close_editor_on_enter", "can_access_all_content"):
            self.assertIn(field, present, f"UserSerializer missing expected field '{field}'")


class BoardFullMembersPrivacyTests(TestCase):
    """GET /api/boards/{id}/full/ — members list must not expose private fields."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass", email="admin@example.com")
        self.board, self.col, self.swim = _make_board(self.admin)
        self.member = _add_member(self.board, "member_user")
        self.client = APIClient()
        self.client.force_authenticate(self.member)

    def test_members_list_user_fields_are_public_only(self):
        response = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(response.status_code, 200)
        members = response.data.get("members", [])
        self.assertGreater(len(members), 0, "Expected at least one member in the list")
        for m in members:
            _assert_board_user_shape(self, m.get("user"), "boards.full members")


class CardAssigneePrivacyTests(TestCase):
    """Card assignee field must not expose private user fields."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass", email="admin@example.com")
        self.board, self.col, self.swim = _make_board(self.admin)
        self.member = _add_member(self.board, "member_user")
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Test Card",
            description="",
            priority="medium",
            position=0,
            created_by=self.admin,
            assignee=self.admin,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.member)

    def test_card_assignee_exposes_only_public_fields(self):
        response = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(response.status_code, 200)
        cards = response.data.get("cards", [])
        card = next((c for c in cards if c["id"] == self.card.id), None)
        self.assertIsNotNone(card, "Card not found in board full response")
        assignee = card.get("assignee")
        _assert_board_user_shape(self, assignee, "card.assignee")

    def test_card_detail_assignee_exposes_only_public_fields(self):
        response = self.client.get(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/")
        self.assertEqual(response.status_code, 200)
        assignee = response.data.get("assignee")
        _assert_board_user_shape(self, assignee, "card detail assignee")


class MovementMovedByPrivacyTests(TestCase):
    """CardMovement.moved_by must not expose private user fields."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass", email="admin@example.com")
        self.board, self.col, self.swim = _make_board(self.admin)
        self.col2 = Column.objects.create(board=self.board, name="Done", position=1, allow_card_creation=True)
        self.member = _add_member(self.board, "member_user")
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Move Me",
            description="",
            priority="medium",
            position=0,
            created_by=self.admin,
        )
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col,
            to_column=self.col2,
            from_swimlane=self.swim,
            to_swimlane=self.swim,
            moved_by=self.admin,
            movement_type="move",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.member)

    def test_movement_moved_by_exposes_only_public_fields(self):
        response = self.client.get(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/movements/")
        self.assertEqual(response.status_code, 200)
        movements = response.data if isinstance(response.data, list) else response.data.get("results", [])
        self.assertGreater(len(movements), 0, "Expected at least one movement")
        for movement in movements:
            _assert_board_user_shape(self, movement.get("moved_by"), "movement.moved_by")


class MeEndpointFullShapeTests(TestCase):
    """/api/v1/auth/me/ must still return the full UserSerializer shape for the current user."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="selfuser",
            password="pass",
            email="self@example.com",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_me_endpoint_returns_full_shape(self):
        response = self.client.get("/api/v1/auth/me/")
        self.assertEqual(response.status_code, 200)
        data = response.data if not hasattr(response.data, "get") else response.data
        # The /me/ endpoint must still expose private fields for the current user.
        for field in ("email", "notif_card_assigned", "notif_mentioned", "close_editor_on_enter"):
            self.assertIn(field, data, f"/api/v1/auth/me/ missing expected field '{field}'")
