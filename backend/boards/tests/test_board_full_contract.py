"""Serializer contract tests for GET /api/v1/boards/{id}/full/.

Locks in fields that the frontend `BoardFull` TypeScript interface depends
on. Removing any of these from `BoardFullSerializer.Meta.fields` is a
breaking change for every client and must fail the suite early.

Regression guard for #543 — `owner` was previously missing from BoardFull
even though `Board` exposed it, forcing a second API call for ownership
checks in the frontend.
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane


class BoardFullSerializerContractTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="ownsit", password="pass")
        self.board = Board.objects.create(name="Contract Board", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        Swimlane.objects.create(board=self.board, name="General", position=0)

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_full_response_exposes_owner(self):
        """`owner` must be present in the /full/ payload so frontend can
        perform ownership checks without a second API call."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("owner", r.data)
        self.assertIsNotNone(r.data["owner"])

    def test_full_response_owner_has_boarduser_shape(self):
        """`owner` must match BoardUserSerializer's shape: id, username,
        display_name, avatar_url — no email or privilege flags leak."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        owner_payload = r.data["owner"]
        self.assertEqual(set(owner_payload.keys()), {"id", "username", "display_name", "avatar_url"})
        self.assertEqual(owner_payload["id"], self.owner.id)
        self.assertEqual(owner_payload["username"], "ownsit")

    def test_full_response_includes_frontend_required_fields(self):
        """Fields the frontend `BoardFull` interface depends on must all
        be present. Missing any of these silently breaks the client."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        required = {
            "id", "uid", "name", "description", "owner", "group", "group_name",
            "columns", "swimlanes", "cards", "labels", "members",
            "staleness_threshold_days", "stale_warning_pct", "allowed_priorities",
            "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits",
            "created_at", "updated_at", "current_user_role", "is_starred",
            "share_token", "capabilities",
        }
        missing = required - set(r.data.keys())
        self.assertFalse(missing, f"BoardFull response is missing fields: {missing}")
