"""A non-numeric id in a board-scoped URL must 404, not 500.

Board-scoped routes are registered through DRF's router, whose default
lookup regex accepts any non-slash string for a pk. Every model behind these
routes uses a plain integer AutoField, so a non-numeric id used to reach
``get_object_or_404(queryset, pk=<garbage>)`` and raise an uncaught
``ValueError`` from the ORM's int coercion instead of the intended 404.
Fixed by constraining ``lookup_value_regex`` (and the few hand-written
``url_path`` regexes) to digits only, so the URL simply fails to match and
Django 404s before the view runs.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardComment, Column, Swimlane


class NonNumericPkReturns404Tests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pw", email="owner@example.com")
        self.board = Board.objects.create(name="Board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.column = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.swimlane = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Card 1", created_by=self.owner, position=0,
        )
        self.comment = CardComment.objects.create(card=self.card, author=self.owner, body="hi")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_nonnumeric_board_pk_404s(self):
        resp = self.client.get("/api/v1/boards/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_board_pk_404s_on_nested_route(self):
        resp = self.client.get(f"/api/v1/boards/not-a-number/columns/{self.column.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_column_pk_404s(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/columns/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_card_pk_404s(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/cards/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_member_user_id_404s(self):
        resp = self.client.delete(f"/api/v1/boards/{self.board.pk}/members/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_comment_pk_404s(self):
        resp = self.client.delete(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_nonnumeric_checklist_item_pk_404s(self):
        resp = self.client.delete(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/checklist/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_valid_numeric_pks_still_work(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_valid_numeric_comment_pk_still_works(self):
        resp = self.client.delete(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/{self.comment.pk}/"
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
