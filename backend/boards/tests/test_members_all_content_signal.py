"""``has_all_content_access`` on ``/full/`` member rows (#1301).

A user with ``can_access_all_content`` resolves to full access ahead of any
explicit membership, so a row can store ``viewer`` while the user still has
full access. The roster must say so, but only to a reader who may see
instance-wide facts (#1714).
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
        self.board = Board.objects.create(name="B1301", owner=self.owner)
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
        self.assertIs(rows[self.plain.pk]["has_all_content_access"], False)
        self.assertIs(rows[self.owner.pk]["has_all_content_access"], False)

    def test_other_readers_never_get_flag(self):
        for user in (self.owner, self.plain, self.reader):
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
