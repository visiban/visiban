"""Tests for role-gated swimlane field exposure.

SwimlaneSerializer (public) omits contact_email and notes.
SwimlaneAdminSerializer (admin-only) includes them.

Verifies that:
- Viewer and member roles do NOT receive contact_email/notes via REST or
  the board full/ endpoint.
- Admin and site_admin roles DO receive those fields.
- WebSocket broadcast payloads use the public serializer so PII is never
  broadcast to all connected clients regardless of their role.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Swimlane


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="PII Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _add_member(board, user, role):
    BoardMembership.objects.create(board=board, user=user, role=role)


def _make_swimlane(board):
    return Swimlane.objects.create(
        board=board, name="Acme Corp", position=0,
        contact_email="acme@example.com", notes="Enterprise SLA — 4h response",
    )


class SwimlaneListFieldExposureTests(TestCase):
    """GET /api/boards/{id}/swimlanes/ exposes different fields by role."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.board = _make_board(self.admin)
        self.swimlane = _make_swimlane(self.board)
        self.client = APIClient()

    def _get_swimlanes(self, user):
        self.client.force_authenticate(user)
        return self.client.get(f"/api/boards/{self.board.id}/swimlanes/")

    def test_admin_sees_contact_email_and_notes(self):
        r = self._get_swimlanes(self.admin)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["results"][0]
        self.assertIn("contact_email", lane)
        self.assertIn("notes", lane)
        self.assertEqual(lane["contact_email"], "acme@example.com")
        self.assertEqual(lane["notes"], "Enterprise SLA — 4h response")

    def test_site_admin_sees_contact_email_and_notes(self):
        site_admin = User.objects.create_user(username="siteadmin", password="pass")
        site_admin.is_site_admin = True
        site_admin.save()
        r = self._get_swimlanes(site_admin)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["results"][0]
        self.assertIn("contact_email", lane)
        self.assertIn("notes", lane)

    def test_member_does_not_see_contact_email_or_notes(self):
        member = User.objects.create_user(username="member", password="pass")
        _add_member(self.board, member, BoardMembership.Role.MEMBER)
        r = self._get_swimlanes(member)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["results"][0]
        self.assertNotIn("contact_email", lane)
        self.assertNotIn("notes", lane)

    def test_viewer_does_not_see_contact_email_or_notes(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        _add_member(self.board, viewer, BoardMembership.Role.VIEWER)
        r = self._get_swimlanes(viewer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["results"][0]
        self.assertNotIn("contact_email", lane)
        self.assertNotIn("notes", lane)


class BoardFullSwimlanePIITests(TestCase):
    """GET /api/boards/{id}/full/ swimlanes field respects role."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin2", password="pass")
        self.board = _make_board(self.admin)
        self.swimlane = _make_swimlane(self.board)
        self.client = APIClient()

    def _get_full(self, user):
        self.client.force_authenticate(user)
        return self.client.get(f"/api/boards/{self.board.id}/full/")

    def test_admin_sees_pii_in_full_endpoint(self):
        r = self._get_full(self.admin)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["swimlanes"][0]
        self.assertIn("contact_email", lane)
        self.assertIn("notes", lane)

    def test_viewer_does_not_see_pii_in_full_endpoint(self):
        viewer = User.objects.create_user(username="viewer2", password="pass")
        _add_member(self.board, viewer, BoardMembership.Role.VIEWER)
        r = self._get_full(viewer)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["swimlanes"][0]
        self.assertNotIn("contact_email", lane)
        self.assertNotIn("notes", lane)

    def test_member_does_not_see_pii_in_full_endpoint(self):
        member = User.objects.create_user(username="member2", password="pass")
        _add_member(self.board, member, BoardMembership.Role.MEMBER)
        r = self._get_full(member)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        lane = r.json()["swimlanes"][0]
        self.assertNotIn("contact_email", lane)
        self.assertNotIn("notes", lane)


class SwimlaneWriteResponsePIITests(TestCase):
    """POST/PATCH response payloads use role-appropriate serializer.

    broadcast_board_event is patched to verify the event payload uses the
    public serializer (no contact_email/notes) regardless of the actor's role —
    WebSocket events are broadcast to all connected clients, not just admins.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="admin3", password="pass")
        self.board = _make_board(self.admin)
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_broadcast_payload_omits_pii(self):
        """The WebSocket broadcast must not include contact_email or notes."""
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(
                    f"/api/boards/{self.board.id}/swimlanes/",
                    {"name": "Beta Corp", "contact_email": "beta@example.com", "notes": "Internal"},
                    format="json",
                )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED)
            self.assertTrue(mock_broadcast.called)
            broadcast_data = mock_broadcast.call_args[0][2]  # third positional arg = data dict
            swimlane_payload = broadcast_data.get("swimlane", broadcast_data)
            self.assertNotIn("contact_email", swimlane_payload)
            self.assertNotIn("notes", swimlane_payload)
