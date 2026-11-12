"""Pin the #2172 privacy trade-off.

For a reader below board admin, an all-content user whose explicit board row is
``viewer`` shows the stored role and no ``has_all_content_access`` key (so the
client's assignee picker cannot tell and keeps them hidden), while the server
still accepts them as an assignee. Exposing an "assignable" signal would reveal
instance-wide access to every reader, so this must stay fail-closed.
"""
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


class AllContentHiddenFromNonAdminReadersTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner2172", password="pass")
        self.member = User.objects.create_user(username="member2172", password="pass")
        self.collab = User.objects.create_user(username="collab2172", password="pass")
        self.allcontent = User.objects.create_user(
            username="allcontent2172", password="pass", can_access_all_content=True
        )
        self.board = Board.objects.create(name="B2172", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.member, role="member")
        BoardMembership.objects.create(board=self.board, user=self.collab, role="collaborator")
        BoardMembership.objects.create(board=self.board, user=self.allcontent, role="viewer")
        col = Column.objects.create(board=self.board, name="C", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="S", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="T", created_by=self.owner, position=0
        )

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_non_admin_reader_sees_stored_role_and_no_signal(self):
        for reader in (self.member, self.collab):
            resp = self._client(reader).get(f"/api/v1/boards/{self.board.pk}/full/")
            self.assertEqual(resp.status_code, 200)
            rows = {m["user"]["id"]: m for m in resp.json()["members"]}
            row = rows[self.allcontent.pk]
            self.assertEqual(row["role"], "viewer")
            self.assertNotIn("has_all_content_access", row)
            self.assertNotEqual(row["role"], "site_admin")

    def test_admin_reader_does_see_the_signal(self):
        # Positive control: the key exists for admins, so the non-admin
        # assertion above cannot pass just because the key was dropped for all.
        resp = self._client(self.owner).get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        rows = {m["user"]["id"]: m for m in resp.json()["members"]}
        self.assertIs(rows[self.allcontent.pk]["has_all_content_access"], True)

    def test_unrecognized_role_row_is_shown_as_stored_and_still_assignable(self):
        BoardMembership.objects.filter(board=self.board, user=self.allcontent).update(role="bogus")
        resp = self._client(self.member).get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        rows = {m["user"]["id"]: m for m in resp.json()["members"]}
        row = rows[self.allcontent.pk]
        self.assertEqual(row["role"], "bogus")
        self.assertNotIn("has_all_content_access", row)
        resp = self._client(self.owner).patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": self.allcontent.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)

    def test_server_still_accepts_the_user_as_assignee(self):
        resp = self._client(self.owner).patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": self.allcontent.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["assignee"]["id"], self.allcontent.pk)
