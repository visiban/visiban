"""Tests for per-board export threshold (#843) and export audit log (#842).

Covers the permission boundary (below-threshold roles cannot export), the
audit-log write on success (no write on denial), the owner/site-admin bypass,
the role-at-export capture, and the admin-only export-history endpoint.
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardExportLog, BoardMembership, Card, Column, Swimlane,
)


def _make_board(owner, export_min_role="viewer"):
    board = Board.objects.create(
        name="Export Board", owner=owner, export_min_role=export_min_role
    )
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN
    )
    col = Column.objects.create(board=board, name="Todo", position=0)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    Card.objects.create(
        board=board, column=col, swimlane=swim, title="C1",
        created_by=owner, position=0,
    )
    Card.objects.create(
        board=board, column=col, swimlane=swim, title="C2",
        created_by=owner, position=1,
    )
    return board


def _add_member(board, user, role):
    BoardMembership.objects.create(board=board, user=user, role=role)


class ExportMinRoleGateTests(TestCase):
    """#843 — the per-board threshold is enforced on /export/."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.collab = User.objects.create_user(username="collab", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.admin = User.objects.create_user(username="admin_user", password="pass")
        self.board = _make_board(self.owner)
        _add_member(self.board, self.viewer, BoardMembership.Role.VIEWER)
        _add_member(self.board, self.collab, BoardMembership.Role.COLLABORATOR)
        _add_member(self.board, self.member, BoardMembership.Role.MEMBER)
        _add_member(self.board, self.admin, BoardMembership.Role.ADMIN)

    def _get(self, user, fmt="csv"):
        # ``?format=csv`` is not used here: DRF's content negotiation treats
        # ``format=`` as a renderer-selection query param and returns 404 when
        # it doesn't match a registered renderer. The default export format is
        # CSV, so an empty querystring is equivalent for this gate test.
        c = APIClient()
        c.force_authenticate(user)
        qs = "" if fmt == "csv" else f"?format={fmt}"
        return c.get(f"/api/v1/boards/{self.board.id}/export/{qs}")

    def test_default_viewer_threshold_allows_every_role(self):
        for u in (self.viewer, self.collab, self.member, self.admin, self.owner):
            r = self._get(u)
            self.assertEqual(r.status_code, status.HTTP_200_OK, f"{u.username} blocked")

    def test_admin_threshold_blocks_below_admin(self):
        self.board.export_min_role = "admin"
        self.board.save(update_fields=["export_min_role"])
        for u in (self.viewer, self.collab, self.member):
            r = self._get(u)
            self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, f"{u.username}")
            body = r.json()
            self.assertEqual(body["code"], "export_restricted")
            self.assertEqual(body["min_role"], "admin")
        r_admin = self._get(self.admin)
        self.assertEqual(r_admin.status_code, status.HTTP_200_OK)

    def test_member_threshold_allows_member_and_above(self):
        self.board.export_min_role = "member"
        self.board.save(update_fields=["export_min_role"])
        self.assertEqual(self._get(self.viewer).status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self._get(self.collab).status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self._get(self.member).status_code, status.HTTP_200_OK)
        self.assertEqual(self._get(self.admin).status_code, status.HTTP_200_OK)

    def test_owner_bypasses_admin_threshold(self):
        """Even if the threshold is ``admin`` and the owner has no explicit
        admin membership (edge case), the owner can still export."""
        self.board.export_min_role = "admin"
        self.board.save(update_fields=["export_min_role"])
        # Remove the owner's explicit admin membership to prove the bypass is
        # driven by Board.owner, not by the membership row.
        BoardMembership.objects.filter(board=self.board, user=self.owner).delete()
        self.board.memberships.create(user=self.owner, role=BoardMembership.Role.VIEWER)
        r = self._get(self.owner)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_site_admin_bypasses_threshold(self):
        self.board.export_min_role = "admin"
        self.board.save(update_fields=["export_min_role"])
        site_admin = User.objects.create_user(
            username="site", password="pass", can_access_all_content=True
        )
        r = self._get(site_admin)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_denied_export_does_not_create_audit_row(self):
        """Failed / denied exports are deliberately not logged."""
        self.board.export_min_role = "admin"
        self.board.save(update_fields=["export_min_role"])
        self._get(self.viewer)
        self.assertEqual(
            BoardExportLog.objects.filter(board=self.board).count(), 0
        )

    def test_patch_export_min_role_validates_allowed_values(self):
        c = APIClient()
        c.force_authenticate(self.owner)
        bad = c.patch(
            f"/api/v1/boards/{self.board.id}/",
            {"export_min_role": "site_admin"},
            format="json",
        )
        self.assertEqual(bad.status_code, status.HTTP_400_BAD_REQUEST)

        ok = c.patch(
            f"/api/v1/boards/{self.board.id}/",
            {"export_min_role": "admin"},
            format="json",
        )
        self.assertEqual(ok.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.export_min_role, "admin")

    def test_non_admin_cannot_change_export_min_role(self):
        c = APIClient()
        c.force_authenticate(self.member)
        r = c.patch(
            f"/api/v1/boards/{self.board.id}/",
            {"export_min_role": "admin"},
            format="json",
        )
        # perform_update() raises PermissionDenied → 403 for non-admin edits.
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


class ExportAuditLogTests(TestCase):
    """#842 — BoardExportLog is written after every successful export."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.admin = User.objects.create_user(username="admin_user", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = _make_board(self.owner)
        _add_member(self.board, self.admin, BoardMembership.Role.ADMIN)
        _add_member(self.board, self.member, BoardMembership.Role.MEMBER)

    def _export(self, user, fmt="csv"):
        c = APIClient()
        c.force_authenticate(user)
        qs = "" if fmt == "csv" else f"?format={fmt}"
        return c.get(f"/api/v1/boards/{self.board.id}/export/{qs}")

    def test_csv_export_creates_log_row(self):
        r = self._export(self.member, fmt="csv")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        log = BoardExportLog.objects.get(board=self.board)
        self.assertEqual(log.actor, self.member)
        self.assertEqual(log.role_at_export, "member")
        self.assertEqual(log.export_format, "csv")
        self.assertEqual(log.row_count, 2)

    def test_json_export_creates_log_row(self):
        r = self._export(self.admin, fmt="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        log = BoardExportLog.objects.get(board=self.board)
        self.assertEqual(log.actor, self.admin)
        self.assertEqual(log.role_at_export, "admin")
        self.assertEqual(log.export_format, "json")

    def test_owner_export_records_role_as_owner_not_admin(self):
        """Owner is a distinct audit identity — Jordan's retro case."""
        r = self._export(self.owner)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        log = BoardExportLog.objects.filter(board=self.board).latest("created_at")
        self.assertEqual(log.role_at_export, "owner")

    def test_site_admin_export_records_role_as_site_admin(self):
        site = User.objects.create_user(
            username="site", password="pass", can_access_all_content=True
        )
        r = self._export(site)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        log = BoardExportLog.objects.filter(board=self.board).latest("created_at")
        self.assertEqual(log.role_at_export, "site_admin")

    def test_role_at_export_is_snapshotted_not_recomputed(self):
        """After the export, if the actor is demoted, the audit row still
        shows their role at the time of export — the whole point of the log.
        """
        self._export(self.member)
        log = BoardExportLog.objects.get(board=self.board, actor=self.member)
        # Demote the member to viewer.
        BoardMembership.objects.filter(board=self.board, user=self.member).update(
            role=BoardMembership.Role.VIEWER
        )
        log.refresh_from_db()
        self.assertEqual(log.role_at_export, "member")

    def test_audit_row_survives_actor_deactivation(self):
        """``actor`` is SET_NULL so an admin investigating can still see the
        row and the role after the user is deleted."""
        self._export(self.member)
        log_id = BoardExportLog.objects.get(board=self.board, actor=self.member).id
        self.member.delete()
        log = BoardExportLog.objects.get(pk=log_id)
        self.assertIsNone(log.actor)
        self.assertEqual(log.role_at_export, "member")


class ExportHistoryEndpointTests(TestCase):
    """#842 — GET /boards/{id}/export-history/ is admin+ only."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.admin = User.objects.create_user(username="admin_user", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.board = _make_board(self.owner)
        _add_member(self.board, self.admin, BoardMembership.Role.ADMIN)
        _add_member(self.board, self.member, BoardMembership.Role.MEMBER)
        _add_member(self.board, self.viewer, BoardMembership.Role.VIEWER)

        # Seed a couple of export log rows so the response has something.
        BoardExportLog.objects.create(
            board=self.board, actor=self.owner,
            role_at_export="owner", export_format="json", row_count=5,
        )
        BoardExportLog.objects.create(
            board=self.board, actor=self.admin,
            role_at_export="admin", export_format="csv", row_count=3,
        )

    def _get(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c.get(f"/api/v1/boards/{self.board.id}/export-history/")

    def test_admin_can_read_history(self):
        r = self._get(self.admin)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        # The viewset's pagination wraps results under ``results``.
        entries = data["results"] if isinstance(data, dict) and "results" in data else data
        self.assertEqual(len(entries), 2)

    def test_owner_can_read_history(self):
        """Owner is treated as admin+ for export-history — board.owner FK
        always implies admin-level access through get_board_for_user()."""
        r = self._get(self.owner)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_member_cannot_read_history(self):
        r = self._get(self.member)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_read_history(self):
        r = self._get(self.viewer)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_unauthenticated_gets_401(self):
        r = APIClient().get(f"/api/v1/boards/{self.board.id}/export-history/")
        self.assertIn(r.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))

    def test_history_ordered_newest_first(self):
        r = self._get(self.admin)
        data = r.json()
        entries = data["results"] if isinstance(data, dict) and "results" in data else data
        timestamps = [e["created_at"] for e in entries]
        self.assertEqual(timestamps, sorted(timestamps, reverse=True))

    def test_history_payload_fields(self):
        r = self._get(self.admin)
        data = r.json()
        entries = data["results"] if isinstance(data, dict) and "results" in data else data
        entry = entries[0]
        self.assertEqual(
            set(entry.keys()),
            {"id", "actor", "role_at_export", "export_format", "row_count", "created_at"},
        )
