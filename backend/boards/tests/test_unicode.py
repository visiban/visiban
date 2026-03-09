"""Tests for unicode and special character handling across models and API."""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Swimlane,
)


PATCH_BROADCAST = "boards.views.broadcast_board_event"


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class BoardNameUnicodeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_board_name_with_emoji(self):
        resp = self.client.post("/api/boards/", {"name": "\U0001f680 Rocket Board"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "\U0001f680 Rocket Board")

    def test_board_name_with_cjk(self):
        resp = self.client.post("/api/boards/", {"name": "\u770b\u677f\u30dc\u30fc\u30c9"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "\u770b\u677f\u30dc\u30fc\u30c9")

    def test_board_name_with_arabic(self):
        resp = self.client.post("/api/boards/", {"name": "\u0644\u0648\u062d\u0629 \u0627\u0644\u0645\u0647\u0627\u0645"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], "\u0644\u0648\u062d\u0629 \u0627\u0644\u0645\u0647\u0627\u0645")

    def test_board_name_with_mixed_scripts(self):
        name = "Board \u30dc\u30fc\u30c9 \U0001f3af \u0644\u0648\u062d\u0629"
        resp = self.client.post("/api/boards/", {"name": name})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.data["name"], name)


class CardTitleUnicodeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_card_title_with_emoji(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "\u2728 Fix bug \U0001f41b", "column": self.col.id, "swimlane": self.swim.id},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["title"], "\u2728 Fix bug \U0001f41b")

    @patch(PATCH_BROADCAST)
    def test_card_description_with_mixed_unicode(self, _):
        desc = "Description with \u00e9\u00e0\u00fc\u00f1 and \u4e2d\u6587 and \U0001f4dd"
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/",
            {"title": "Card", "column": self.col.id, "swimlane": self.swim.id, "description": desc},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["description"], desc)


class CommentBodyUnicodeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.swim = _make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_comment_with_special_characters(self, _):
        body = "Comment with <html> & \"quotes\" and \u2019curly\u2019 and \U0001f525"
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/",
            {"body": body},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["body"], body)

    @patch(PATCH_BROADCAST)
    def test_comment_with_newlines_and_tabs(self, _):
        body = "Line 1\nLine 2\n\tIndented"
        resp = self.client.post(
            f"/api/boards/{self.board.id}/cards/{self.card.id}/comments/",
            {"body": body},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["body"], body)


class LabelNameUnicodeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, _, _ = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_label_name_with_emoji(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/labels/",
            {"name": "\U0001f41b Bug", "color": "#FF0000"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["name"], "\U0001f41b Bug")

    @patch(PATCH_BROADCAST)
    def test_label_name_with_cjk(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/labels/",
            {"name": "\u7d27\u6025", "color": "#FF0000"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["name"], "\u7d27\u6025")


class SwimlaneNameUnicodeTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, _, _ = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_swimlane_name_with_unicode(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/swimlanes/",
            {"name": "\u00c4kme Corp \U0001f3e2", "color": "#00FF00"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["name"], "\u00c4kme Corp \U0001f3e2")

    @patch(PATCH_BROADCAST)
    def test_swimlane_name_with_arabic(self, _):
        resp = self.client.post(
            f"/api/boards/{self.board.id}/swimlanes/",
            {"name": "\u0639\u0645\u064a\u0644 \u0627\u0644\u0634\u0631\u0643\u0629", "color": "#0000FF"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        self.assertEqual(resp.json()["name"], "\u0639\u0645\u064a\u0644 \u0627\u0644\u0634\u0631\u0643\u0629")
