"""Tests for ownership-gated destructive actions (#362 PR2).

Members may only delete/archive cards they created and delete comments they
authored, unless they have the is_moderator entitlement or are an admin.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardComment, Column, Swimlane,
)


def _make_board(owner):
    board = Board.objects.create(name="Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class CardDeleteOwnershipTests(TestCase):
    """Members can only delete cards they created unless moderator/admin."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        self.other = User.objects.create_user(username="other", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        self.client = APIClient()

    def _make_card(self, created_by):
        return Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test", created_by=created_by, position=0,
        )

    def test_member_can_delete_own_card(self):
        card = self._make_card(created_by=self.member)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_member_cannot_delete_others_card(self):
        card = self._make_card(created_by=self.other)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn("cards you created", r.data["detail"])

    def test_moderator_can_delete_others_card(self):
        card = self._make_card(created_by=self.other)
        BoardMembership.objects.filter(board=self.board, user=self.member).update(is_moderator=True)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_admin_can_delete_others_card(self):
        card = self._make_card(created_by=self.other)
        self.client.force_authenticate(self.owner)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_null_created_by_blocked_for_member(self):
        card = self._make_card(created_by=None)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_null_created_by_allowed_for_moderator(self):
        card = self._make_card(created_by=None)
        BoardMembership.objects.filter(board=self.board, user=self.member).update(is_moderator=True)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{card.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)


class CardArchiveOwnershipTests(TestCase):
    """Members can only archive/unarchive cards they created unless moderator/admin."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        self.other = User.objects.create_user(username="other", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        self.client = APIClient()

    def _make_card(self, created_by):
        return Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test", created_by=created_by, position=0,
        )

    def test_member_can_archive_own_card(self):
        card = self._make_card(created_by=self.member)
        self.client.force_authenticate(self.member)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/cards/{card.id}/archive/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_member_cannot_archive_others_card(self):
        card = self._make_card(created_by=self.other)
        self.client.force_authenticate(self.member)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/cards/{card.id}/archive/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_moderator_can_archive_others_card(self):
        card = self._make_card(created_by=self.other)
        BoardMembership.objects.filter(board=self.board, user=self.member).update(is_moderator=True)
        self.client.force_authenticate(self.member)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/cards/{card.id}/archive/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_member_cannot_unarchive_others_card(self):
        card = self._make_card(created_by=self.other)
        from django.utils import timezone
        card.archived_at = timezone.now()
        card.save()
        self.client.force_authenticate(self.member)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/cards/{card.id}/unarchive/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_moderator_can_unarchive_others_card(self):
        card = self._make_card(created_by=self.other)
        from django.utils import timezone
        card.archived_at = timezone.now()
        card.save()
        BoardMembership.objects.filter(board=self.board, user=self.member).update(is_moderator=True)
        self.client.force_authenticate(self.member)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/cards/{card.id}/unarchive/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)


class CommentDeleteOwnershipTests(TestCase):
    """Members can only delete comments they authored unless moderator/admin."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        self.other = User.objects.create_user(username="other", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Test", created_by=self.owner, position=0,
        )
        self.client = APIClient()

    def test_member_can_delete_own_comment(self):
        comment = CardComment.objects.create(card=self.card, author=self.member, body="My comment")
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_member_cannot_delete_others_comment(self):
        comment = CardComment.objects.create(card=self.card, author=self.other, body="Their comment")
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn("your own comments", r.data["detail"])

    def test_moderator_can_delete_others_comment(self):
        comment = CardComment.objects.create(card=self.card, author=self.other, body="Their comment")
        BoardMembership.objects.filter(board=self.board, user=self.member).update(is_moderator=True)
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_admin_can_delete_others_comment(self):
        comment = CardComment.objects.create(card=self.card, author=self.other, body="Their comment")
        self.client.force_authenticate(self.owner)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_null_author_blocked_for_member(self):
        comment = CardComment.objects.create(card=self.card, author=None, body="Orphaned")
        self.client.force_authenticate(self.member)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_null_author_allowed_for_admin(self):
        comment = CardComment.objects.create(card=self.card, author=None, body="Orphaned")
        self.client.force_authenticate(self.owner)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_collaborator_can_still_delete_own_comment(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        comment = CardComment.objects.create(card=self.card, author=collab, body="My comment")
        self.client.force_authenticate(collab)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)

    def test_collaborator_cannot_delete_others_comment(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        comment = CardComment.objects.create(card=self.card, author=self.other, body="Their comment")
        self.client.force_authenticate(collab)
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/comments/{comment.id}/")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
