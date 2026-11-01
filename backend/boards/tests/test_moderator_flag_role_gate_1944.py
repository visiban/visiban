"""#1944: the ``is_moderator`` flag is honored only on a member or admin row.

The members endpoint refuses the flag on a collaborator or viewer, but a row
written through the Django admin, a shell or a future writer can carry it. These
tests build such rows directly through the ORM and drive the delete endpoints, so
they prove the gate at the surface a client reaches, not just the helper.
"""
from django.core.files.base import ContentFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardAttachment, CardChecklist, CardComment,
    Column, Swimlane,
)
from boards.permissions import can_modify_others_content

Role = BoardMembership.Role


class ModeratorFlagRoleGateTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="o1944", password="pass")
        self.board = Board.objects.create(name="B", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=Role.ADMIN)
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        swim = Swimlane.objects.create(board=self.board, name="G", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim,
            title="C", created_by=self.owner, position=0,
        )
        self.author = User.objects.create_user(username="a1944", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.author, role=Role.MEMBER)
        self.client = APIClient()
        self.base = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}"

    def _flagged(self, name, role):
        user = User.objects.create_user(username=name, password="pass")
        # Direct ORM write: the state the API refuses to create.
        BoardMembership.objects.create(
            board=self.board, user=user, role=role, is_moderator=True
        )
        return user

    def _targets(self):
        comment = CardComment.objects.create(card=self.card, author=self.author, body="x")
        att = CardAttachment(
            card=self.card, filename="f.txt", size=1, uploaded_by=self.author
        )
        att.file.save("f.txt", ContentFile(b"x"), save=True)
        item = CardChecklist.objects.create(
            card=self.card, text="i", position=0, created_by=self.author
        )
        return {
            "comment": (f"{self.base}/comments/{comment.pk}/", CardComment, comment.pk),
            "attachment": (f"{self.base}/attachments/{att.pk}/", CardAttachment, att.pk),
            "checklist": (f"{self.base}/checklist/{item.pk}/", CardChecklist, item.pk),
        }

    def _assert_delete(self, user, expected):
        self.client.force_authenticate(user)
        for name, (url, model, pk) in self._targets().items():
            with self.subTest(target=name):
                r = self.client.delete(url)
                self.assertEqual(r.status_code, expected, r.content)
                self.assertEqual(
                    model.objects.filter(pk=pk).exists(),
                    expected == status.HTTP_403_FORBIDDEN,
                )
            model.objects.filter(pk=pk).delete()

    def test_flagged_collaborator_cannot_delete_others_content(self):
        self._assert_delete(self._flagged("c1944", Role.COLLABORATOR), status.HTTP_403_FORBIDDEN)

    def test_flagged_viewer_cannot_delete_others_content(self):
        # Defense-in-depth pin: a viewer is refused earlier by the annotation role
        # gate, so this passes with or without #1944; the helper test below is
        # what proves the flag itself is ignored on a viewer row.
        self.client.force_authenticate(self._flagged("v1944", Role.VIEWER))
        for name, (url, model, pk) in self._targets().items():
            with self.subTest(target=name):
                r = self.client.delete(url)
                self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
                self.assertTrue(model.objects.filter(pk=pk).exists())

    def test_flagged_member_can_delete_others_content(self):
        self._assert_delete(self._flagged("m1944", Role.MEMBER), status.HTTP_204_NO_CONTENT)

    def test_admin_unchanged(self):
        self._assert_delete(self.owner, status.HTTP_204_NO_CONTENT)

    def test_helper_ignores_flag_on_collaborator_and_viewer(self):
        for role in (Role.COLLABORATOR, Role.VIEWER):
            with self.subTest(role=role):
                user = self._flagged(f"h{role}1944", role)
                fresh = Board.objects.get(pk=self.board.pk)
                self.assertIs(can_modify_others_content(fresh, role, user), False)

    def test_helper_honors_flag_on_flagged_admin_row_via_cache_paths(self):
        # A non-owner admin-role row with the flag: the stamped-membership and
        # prefetched paths must agree with the live-query path.
        user = self._flagged("ad1944", Role.ADMIN)
        membership = BoardMembership.objects.get(board=self.board, user=user)
        for setup in ("cached", "prefetched"):
            board = Board.objects.get(pk=self.board.pk)
            if setup == "cached":
                board._cached_membership = membership
            else:
                board._prefetched_memberships = [membership]
            self.assertIs(can_modify_others_content(board, Role.MEMBER, user), True)

    def test_cached_and_prefetched_paths_ignore_flag_on_collaborator(self):
        user = self._flagged("cc1944", Role.COLLABORATOR)
        membership = BoardMembership.objects.get(board=self.board, user=user)
        for attr, value in (("_cached_membership", membership),
                            ("_prefetched_memberships", [membership])):
            board = Board.objects.get(pk=self.board.pk)
            setattr(board, attr, value)
            self.assertIs(can_modify_others_content(board, Role.COLLABORATOR, user), False)
