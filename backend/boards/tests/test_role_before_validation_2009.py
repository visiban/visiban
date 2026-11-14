"""Admin-only writes check the role before validating the body (#2009).

DRF validates the serializer before ``perform_create``/``perform_update``, so a
caller below admin sending an invalid body got a 400 that named the bad fields,
while a valid body got 403. ``CardViewSet.update`` already checked first; the
board, column, label, swimlane and both custom-field viewsets now do too, for
PUT/PATCH (board: update only) and POST (the five sub-resources).
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, CustomFieldDefinition, Label, Swimlane, SwimlaneCustomFieldDefinition


class RoleBeforeValidationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="rbv_owner", password="pass")
        self.board = Board.objects.create(name="RBV", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.column = Column.objects.create(board=self.board, name="Todo", position=0)
        self.users = {}
        for role in (
            BoardMembership.Role.VIEWER,
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.MEMBER,
        ):
            user = User.objects.create_user(username=f"rbv_{role}", password="pass")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            self.users[role] = user
        self.board_url = f"/api/v1/boards/{self.board.pk}/"
        self.column_url = f"/api/v1/boards/{self.board.pk}/columns/{self.column.pk}/"

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_below_admin_invalid_board_body_is_403(self):
        bad = {"name": "", "staleness_threshold_days": "not-a-number"}
        for role, user in self.users.items():
            for method in ("patch", "put"):
                with self.subTest(role=role, method=method):
                    r = getattr(self._client(user), method)(self.board_url, bad, format="json")
                    self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
                    self.assertNotIn("staleness_threshold_days", r.json())
        self.board.refresh_from_db()
        self.assertEqual(self.board.name, "RBV")

    def test_below_admin_invalid_column_body_is_403(self):
        bad = {"name": "", "wip_limit": "not-a-number"}
        for role, user in self.users.items():
            for method in ("patch", "put"):
                with self.subTest(role=role, method=method):
                    r = getattr(self._client(user), method)(self.column_url, bad, format="json")
                    self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
                    self.assertNotIn("wip_limit", r.json())
        self.column.refresh_from_db()
        self.assertEqual(self.column.name, "Todo")

    def test_admin_invalid_body_is_still_400(self):
        admin = self._client(self.owner)
        r = admin.patch(self.board_url, {"staleness_threshold_days": "not-a-number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("staleness_threshold_days", r.json())
        r = admin.patch(self.column_url, {"wip_limit": "not-a-number"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("wip_limit", r.json())

    def test_admin_valid_patch_still_applies(self):
        admin = self._client(self.owner)
        r = admin.patch(self.board_url, {"name": "Renamed"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["name"], "Renamed")
        r = admin.patch(self.column_url, {"name": "Doing"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.json()["name"], "Doing")

    def test_non_member_still_gets_404(self):
        outsider = User.objects.create_user(username="rbv_out", password="pass")
        c = self._client(outsider)
        self.assertEqual(c.patch(self.board_url, {"name": ""}, format="json").status_code, 404)
        self.assertEqual(c.patch(self.column_url, {"name": ""}, format="json").status_code, 404)


class RoleBeforeValidationSubResourceTests(TestCase):
    """Labels, swimlanes and both custom-field viewsets follow the same order (#2009)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="rbv2_owner", password="pass")
        self.board = Board.objects.create(name="RBV2", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.users = {}
        for role in (
            BoardMembership.Role.VIEWER,
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.MEMBER,
        ):
            user = User.objects.create_user(username=f"rbv2_{role}", password="pass")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            self.users[role] = user
        base = f"/api/v1/boards/{self.board.pk}"
        label = Label.objects.create(board=self.board, name="L", color="#112233")
        lane = Swimlane.objects.create(board=self.board, name="S", position=0)
        cf = CustomFieldDefinition.objects.create(board=self.board, name="CF", field_type="text", position=0)
        scf = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="SCF", field_type="text", position=0
        )
        self.cases = {
            "label": (f"{base}/labels/{label.pk}/", {"name": ""}),
            "swimlane": (f"{base}/swimlanes/{lane.pk}/", {"name": ""}),
            "custom_field": (f"{base}/custom-fields/{cf.pk}/", {"name": ""}),
            "swimlane_custom_field": (f"{base}/swimlane-custom-fields/{scf.pk}/", {"name": ""}),
        }

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_below_admin_invalid_body_is_403(self):
        for name, (url, bad) in self.cases.items():
            for role, user in self.users.items():
                for method in ("patch", "put"):
                    with self.subTest(resource=name, role=role, method=method):
                        r = getattr(self._client(user), method)(url, bad, format="json")
                        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)

    def test_admin_invalid_body_is_still_400(self):
        admin = self._client(self.owner)
        for name, (url, bad) in self.cases.items():
            for method in ("patch", "put"):
                with self.subTest(resource=name, method=method):
                    r = getattr(admin, method)(url, bad, format="json")
                    self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_non_member_still_gets_404(self):
        outsider = self._client(User.objects.create_user(username="rbv2_out", password="pass"))
        for name, (url, bad) in self.cases.items():
            with self.subTest(resource=name):
                self.assertEqual(outsider.patch(url, bad, format="json").status_code, 404)


class RoleBeforeValidationCreateTests(RoleBeforeValidationSubResourceTests):
    """POST on the five admin-only sub-resource collections (#2009)."""

    def setUp(self):
        super().setUp()
        base = f"/api/v1/boards/{self.board.pk}"
        self.create_urls = {
            "column": f"{base}/columns/",
            "label": f"{base}/labels/",
            "swimlane": f"{base}/swimlanes/",
            "custom_field": f"{base}/custom-fields/",
            "swimlane_custom_field": f"{base}/swimlane-custom-fields/",
        }
        self.valid = {
            "column": {"name": "New col"},
            "label": {"name": "New label", "color": "#445566"},
            "swimlane": {"name": "New lane"},
            "custom_field": {"name": "New CF", "field_type": "text"},
            "swimlane_custom_field": {"name": "New SCF", "field_type": "text"},
        }

    def test_below_admin_invalid_create_is_403(self):
        for name, url in self.create_urls.items():
            for role, user in self.users.items():
                with self.subTest(resource=name, role=role):
                    r = self._client(user).post(url, {"name": ""}, format="json")
                    self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)

    def test_admin_invalid_create_is_still_400(self):
        admin = self._client(self.owner)
        for name, url in self.create_urls.items():
            with self.subTest(resource=name):
                r = admin.post(url, {"name": ""}, format="json")
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_non_member_create_still_gets_404(self):
        outsider = self._client(User.objects.create_user(username="rbv2_out2", password="pass"))
        for name, url in self.create_urls.items():
            with self.subTest(resource=name):
                self.assertEqual(outsider.post(url, {"name": ""}, format="json").status_code, 404)

    def test_admin_valid_create_is_201(self):
        admin = self._client(self.owner)
        for name, url in self.create_urls.items():
            with self.subTest(resource=name):
                r = admin.post(url, self.valid[name], format="json")
                self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)


class RoleBeforeValidationCardCreateTests(TestCase):
    """POST on the card collection checks the mutation role first (#2191)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="rbv3_owner", password="pass")
        self.board = Board.objects.create(name="RBV3", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.column = Column.objects.create(
            board=self.board, name="Todo", position=0, allow_card_creation=True
        )
        self.lane = Swimlane.objects.create(board=self.board, name="S", position=0)
        self.users = {}
        for role in (
            BoardMembership.Role.VIEWER,
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.MEMBER,
        ):
            user = User.objects.create_user(username=f"rbv3_{role}", password="pass")
            BoardMembership.objects.create(board=self.board, user=user, role=role)
            self.users[role] = user
        self.url = f"/api/v1/boards/{self.board.pk}/cards/"
        self.bad = {"title": "", "column": "zz"}

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_below_member_invalid_create_is_403(self):
        for role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            with self.subTest(role=role):
                r = self._client(self.users[role]).post(self.url, self.bad, format="json")
                self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN, r.content)
                self.assertNotIn("column", r.json())

    def test_member_invalid_create_is_still_400(self):
        r = self._client(self.users[BoardMembership.Role.MEMBER]).post(self.url, self.bad, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.content)

    def test_non_member_invalid_create_still_gets_404(self):
        outsider = self._client(User.objects.create_user(username="rbv3_out", password="pass"))
        self.assertEqual(outsider.post(self.url, self.bad, format="json").status_code, 404)

    def test_member_valid_create_is_201_and_viewer_valid_is_403(self):
        body = {"title": "Hello", "column": self.column.pk, "swimlane": self.lane.pk}
        member = self._client(self.users[BoardMembership.Role.MEMBER])
        self.assertEqual(member.post(self.url, body, format="json").status_code, 201)
        viewer = self._client(self.users[BoardMembership.Role.VIEWER])
        self.assertEqual(viewer.post(self.url, body, format="json").status_code, 403)

    def test_check_adds_no_query_to_valid_create(self):
        """The early role check reuses the per-request board/role cache (#2191)."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        body = {"title": "Q", "column": self.column.pk, "swimlane": self.lane.pk}
        member = self._client(self.users[BoardMembership.Role.MEMBER])
        member.post(self.url, body, format="json")  # warm caches
        with CaptureQueriesContext(connection) as with_check:
            member.post(self.url, body, format="json")
        from boards.services import cards as card_services
        from unittest import mock

        # Same request with the early check stubbed out: the counts must match.
        with mock.patch.object(card_services, "require_mutation_role", return_value=None):
            with CaptureQueriesContext(connection) as without_check:
                member.post(self.url, body, format="json")
        self.assertEqual(len(with_check), len(without_check))
