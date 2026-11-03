"""Placing a board in a group needs group admin on every path (#1658).

``POST /boards/{id}/move-group/`` and the JSON, CSV and Trello importers use the
same rule as ``POST /groups/{id}/boards/``. A group that does not exist and a
group the caller cannot see answer the same 404.
"""
import io
import json

from django.core.cache import cache
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board
from groups.models import Group, GroupMembership

Role = GroupMembership.Role
DENIED_ROLES = (Role.VIEWER, Role.COLLABORATOR, Role.MEMBER)

JSON_URL = "/api/v1/boards/import/"
TRELLO_URL = "/api/v1/boards/import/trello/"


def _json_file():
    data = {
        "name": "Imp",
        "columns": [{"name": "To Do", "position": 0}],
        "swimlanes": [{"name": "General", "position": 0}],
        "labels": [],
        "cards": [{"title": "A", "column": "To Do", "swimlane": "General", "position": 0}],
    }
    f = io.BytesIO(json.dumps(data).encode())
    f.name = "board.json"
    return f


def _csv_file():
    f = io.BytesIO(b"Title,Column,Swimlane\nA,To Do,General\n")
    f.name = "board.csv"
    return f


def _trello_file():
    data = {
        "name": "T",
        "lists": [{"id": "l1", "name": "To Do", "closed": False, "pos": 1}],
        "cards": [{
            "id": "c1", "name": "A", "idList": "l1", "closed": False, "pos": 1,
            "desc": "", "idLabels": [], "idMembers": [], "idChecklists": [],
        }],
        "labels": [], "checklists": [], "members": [], "actions": [],
    }
    f = io.BytesIO(json.dumps(data).encode())
    f.name = "trello.json"
    return f


class GroupPlacementRoleTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="actor", password="x")
        self.owner = User.objects.create_user(username="gowner", password="x")
        self.group = Group.objects.create(name="Team", owner=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _join(self, role):
        GroupMembership.objects.create(group=self.group, user=self.user, role=role)

    def _move(self, group_id):
        board = Board.objects.create(name="Mine", owner=self.user)
        resp = self.client.post(
            f"/api/v1/boards/{board.pk}/move-group/", {"group_id": group_id}, format="json"
        )
        board.refresh_from_db()
        return resp, board

    def _import(self, kind, group_id):
        cache.clear()
        if kind == "json":
            return self.client.post(
                JSON_URL, {"file": _json_file(), "group_id": group_id}, format="multipart"
            )
        if kind == "csv":
            return self.client.post(
                JSON_URL, {"file": _csv_file(), "group_id": group_id}, format="multipart"
            )
        return self.client.post(
            TRELLO_URL + "?confirm=true",
            {"file": _trello_file(), "group_id": group_id},
            format="multipart",
        )

    # --- move-group ----------------------------------------------------

    def test_move_group_denied_below_admin(self):
        for role in DENIED_ROLES:
            with self.subTest(role=role):
                GroupMembership.objects.filter(group=self.group, user=self.user).delete()
                self._join(role)
                resp, board = self._move(self.group.pk)
                self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
                self.assertIsNone(board.group_id)

    def test_move_group_allowed_for_admin(self):
        self._join(Role.ADMIN)
        resp, board = self._move(self.group.pk)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(board.group_id, self.group.pk)

    def test_move_group_missing_and_inaccessible_answer_alike(self):
        missing, _ = self._move(999999)
        inaccessible, board = self._move(self.group.pk)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(inaccessible.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.json(), inaccessible.json())
        self.assertIsNone(board.group_id)

    def test_move_to_personal_still_allowed(self):
        board = Board.objects.create(name="Mine", owner=self.user, group=self.group)
        resp = self.client.post(
            f"/api/v1/boards/{board.pk}/move-group/", {"group_id": None}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    # --- importers -----------------------------------------------------

    def test_import_denied_below_admin(self):
        for kind in ("json", "csv", "trello"):
            for role in DENIED_ROLES:
                with self.subTest(kind=kind, role=role):
                    GroupMembership.objects.filter(group=self.group, user=self.user).delete()
                    self._join(role)
                    resp = self._import(kind, self.group.pk)
                    self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
                    self.assertFalse(Board.objects.exists())

    def test_import_allowed_for_admin(self):
        self._join(Role.ADMIN)
        for kind in ("json", "csv", "trello"):
            with self.subTest(kind=kind):
                resp = self._import(kind, self.group.pk)
                self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        self.assertEqual(Board.objects.filter(group=self.group).count(), 3)

    def test_import_missing_and_inaccessible_answer_alike(self):
        for kind in ("json", "csv", "trello"):
            with self.subTest(kind=kind):
                missing = self._import(kind, 999999)
                inaccessible = self._import(kind, self.group.pk)
                self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(inaccessible.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(missing.json(), inaccessible.json())
        self.assertFalse(Board.objects.exists())

    def test_trello_dry_run_applies_same_rule(self):
        self._join(Role.MEMBER)
        resp = self.client.post(
            TRELLO_URL + "?dry_run=true",
            {"file": _trello_file(), "group_id": self.group.pk},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_trello_dry_run_denied_for_each_role_below_admin(self):
        for role in DENIED_ROLES:
            with self.subTest(role=role):
                GroupMembership.objects.filter(group=self.group, user=self.user).delete()
                self._join(role)
                resp = self.client.post(
                    TRELLO_URL + "?dry_run=true",
                    {"file": _trello_file(), "group_id": self.group.pk},
                    format="multipart",
                )
                self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # --- ancestors, owners, all-content site admins ---------------------

    def test_ancestor_group_admin_allowed_on_move_and_imports(self):
        child = Group.objects.create(name="Child", owner=self.owner, parent=self.group)
        self._join(Role.ADMIN)  # admin of the parent only
        resp, board = self._move(child.pk)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(board.group_id, child.pk)
        for kind in ("json", "csv", "trello"):
            with self.subTest(kind=kind):
                self.assertEqual(self._import(kind, child.pk).status_code, status.HTTP_201_CREATED)

    def test_child_group_admin_cannot_use_parent_group(self):
        child = Group.objects.create(name="Child", owner=self.owner, parent=self.group)
        GroupMembership.objects.create(group=child, user=self.user, role=Role.ADMIN)
        resp, board = self._move(self.group.pk)
        # The parent is visible for navigation but not administered.
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIsNone(board.group_id)

    def test_grandparent_group_visible_but_not_administered(self):
        mid = Group.objects.create(name="Mid", owner=self.owner, parent=self.group)
        leaf = Group.objects.create(name="Leaf", owner=self.owner, parent=mid)
        GroupMembership.objects.create(group=leaf, user=self.user, role=Role.ADMIN)
        resp, board = self._move(self.group.pk)
        # The grandparent lists for navigation (#2080), so it answers 403 like
        # the parent, not the 404 of a group the caller cannot see.
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIsNone(board.group_id)

    def test_all_content_site_admin_allowed_without_membership(self):
        self.user.can_access_all_content = True
        self.user.save(update_fields=["can_access_all_content"])
        resp, board = self._move(self.group.pk)
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(board.group_id, self.group.pk)
        self.assertEqual(self._import("json", self.group.pk).status_code, status.HTTP_201_CREATED)

    def test_group_owner_without_admin_membership_row_is_refused(self):
        # Since #1829 ownership alone does not make the group visible either,
        # so the owner gets the 404 of a group they cannot see (it was a 403).
        owner_client = APIClient()
        owner_client.force_authenticate(self.owner)
        board = Board.objects.create(name="Owned", owner=self.owner)
        resp = owner_client.post(
            f"/api/v1/boards/{board.pk}/move-group/", {"group_id": self.group.pk}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        resp = owner_client.post(
            JSON_URL, {"file": _json_file(), "group_id": self.group.pk}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        board.refresh_from_db()
        self.assertIsNone(board.group_id)

    # --- malformed ids -------------------------------------------------

    MALFORMED_IDS = ("abc", "[1]", "99999999999999999999999999", "-1", "1.5")

    def test_malformed_group_id_answers_like_a_missing_group(self):
        self._join(Role.ADMIN)
        baseline, _ = self._move(999999)
        self.assertEqual(baseline.status_code, status.HTTP_404_NOT_FOUND)
        for bad in self.MALFORMED_IDS:
            with self.subTest(group_id=bad, path="move-group"):
                resp, board = self._move(bad)
                self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
                self.assertEqual(resp.json(), baseline.json())
                self.assertIsNone(board.group_id)
        import_baseline = self._import("json", 999999)
        for kind in ("json", "csv", "trello"):
            for bad in self.MALFORMED_IDS:
                with self.subTest(group_id=bad, path=kind):
                    resp = self._import(kind, bad)
                    self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
                    self.assertEqual(resp.json(), import_baseline.json())
        self.assertFalse(Board.objects.filter(group__isnull=False).exists())
