"""``has_all_content_access`` on ``/full/`` member rows (#1301).

A user with ``can_access_all_content`` resolves to full access ahead of any
explicit membership, so a row can store ``viewer`` while the user still has
full access. The roster must say so to the readers who render the Members
controls (board admins and site admins), on every row, and to nobody below
admin. The synthesized roster rows stay limited to site-admin readers (#1714).
"""
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership


class HasAllContentAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner1301", password="pass")
        self.plain = User.objects.create_user(username="plain1301", password="pass")
        self.reader = User.objects.create_user(username="reader1301", password="pass")
        self.allcontent = User.objects.create_user(
            username="allcontent1301", password="pass", can_access_all_content=True
        )
        self.ghost = User.objects.create_user(
            username="ghost1301", password="pass", can_access_all_content=True
        )
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="G1301", owner=self.owner)
        # Group-inherited all-content user: no membership row on the board.
        self.inherited = User.objects.create_user(
            username="inherited1301", password="pass", can_access_all_content=True
        )
        GroupMembership.objects.create(group=group, user=self.inherited, role="member")
        self.board = Board.objects.create(name="B1301", owner=self.owner, group=group)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.plain, role="member")
        BoardMembership.objects.create(board=self.board, user=self.reader, role="viewer")
        # Explicit membership that has no effect on the user's real access.
        BoardMembership.objects.create(board=self.board, user=self.allcontent, role="viewer")

    def _members(self, user):
        client = APIClient()
        client.force_authenticate(user)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        return {m["user"]["id"]: m for m in resp.json()["members"]}

    def test_site_admin_reader_sees_flag_on_every_row(self):
        rows = self._members(self.allcontent)
        self.assertIs(rows[self.allcontent.pk]["has_all_content_access"], True)
        self.assertEqual(rows[self.allcontent.pk]["role"], "viewer")
        self.assertIs(rows[self.ghost.pk]["has_all_content_access"], True)
        self.assertEqual(rows[self.ghost.pk]["role"], "site_admin")
        self.assertIs(rows[self.inherited.pk]["has_all_content_access"], True)
        self.assertIs(rows[self.plain.pk]["has_all_content_access"], False)
        self.assertIs(rows[self.owner.pk]["has_all_content_access"], False)

    def test_board_admin_gets_flag_on_every_row_but_not_the_synthesized_roster(self):
        # The owner is a board admin and not a site admin (#1301 owner ruling).
        rows = self._members(self.owner)
        # Auditor case: all-content, not is_site_admin, explicit viewer row.
        self.assertIs(rows[self.allcontent.pk]["has_all_content_access"], True)
        self.assertEqual(rows[self.allcontent.pk]["role"], "viewer")
        # Group-inherited row (id null).
        self.assertIsNone(rows[self.inherited.pk]["id"])
        self.assertIs(rows[self.inherited.pk]["has_all_content_access"], True)
        self.assertIs(rows[self.plain.pk]["has_all_content_access"], False)
        self.assertIs(rows[self.owner.pk]["has_all_content_access"], False)
        # Who else has instance-wide access is still not listed (#1714).
        self.assertNotIn(self.ghost.pk, rows)

    def test_readers_below_admin_never_get_flag(self):
        for user in (self.plain, self.reader):
            for row in self._members(user).values():
                self.assertNotIn("has_all_content_access", row)

    def test_instance_site_admin_reader_without_all_content_gets_flag(self):
        # Roster-visible through User.is_site_admin, the second clause of
        # site_admin_roster_visible(), even with an ordinary board role.
        siteadmin = User.objects.create_user(
            username="siteonly1301", password="pass", is_site_admin=True
        )
        BoardMembership.objects.create(board=self.board, user=siteadmin, role="member")
        rows = self._members(siteadmin)
        self.assertIs(rows[self.allcontent.pk]["has_all_content_access"], True)
        self.assertIs(rows[self.plain.pk]["has_all_content_access"], False)

    def test_instance_site_admin_with_viewer_role_gets_flag(self):
        siteadmin = User.objects.create_user(
            username="siteviewer1301", password="pass", is_site_admin=True
        )
        BoardMembership.objects.create(board=self.board, user=siteadmin, role="viewer")
        rows = self._members(siteadmin)
        self.assertIs(rows[self.inherited.pk]["has_all_content_access"], True)


class StoredRoleSurvivesRevocationTests(TestCase):
    """A stored board role is dormant, not discarded, while all-content access holds (#1301).

    The Members panel says "Board role: Viewer, not in effect while this
    account has all-content access". That clause is only true if the stored
    membership takes effect once the access is revoked.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner1301b", password="pass")
        self.user = User.objects.create_user(
            username="dormant1301", password="pass", can_access_all_content=True
        )
        self.board = Board.objects.create(name="B1301b", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.user, role="viewer")

    def _row(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        return next(m for m in resp.json()["members"] if m["user"]["id"] == self.user.pk)

    def test_stored_role_is_listed_then_takes_effect_after_revocation(self):
        from boards.permissions import get_board_role

        row = self._row()
        self.assertEqual(row["role"], "viewer")  # the stored role, not "site_admin"
        self.assertIsNotNone(row["id"])
        self.assertIs(row["has_all_content_access"], True)
        self.assertEqual(get_board_role(self.user, self.board), "site_admin")

        self.user.can_access_all_content = False
        self.user.save(update_fields=["can_access_all_content"])
        self.board = Board.objects.get(pk=self.board.pk)  # drop the role cached on the instance
        self.assertEqual(get_board_role(self.user, self.board), "viewer")
        row = self._row()
        self.assertEqual(row["role"], "viewer")
        self.assertIs(row["has_all_content_access"], False)
