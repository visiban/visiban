"""Card search uses the ``ci_contains`` lookup so the trigram indexes apply (#1809)."""

from django.db import connection
from django.db.models import CharField, F, Transform
from django.test import TestCase
from django.test.utils import CaptureQueriesContext, register_lookup
import unittest

from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


class CardCiContainsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(username="u1809", password="pass")
        cls.board = Board.objects.create(name="B", owner=cls.user)
        BoardMembership.objects.create(
            board=cls.board, user=cls.user, role=BoardMembership.Role.ADMIN
        )
        col = Column.objects.create(board=cls.board, name="C", position=0)
        swim = Swimlane.objects.create(board=cls.board, name="S", position=0)
        for i, (title, desc) in enumerate(
            [
                ("Fix Login Bug", ""),
                ("Plain", "OAuth TOKEN refresh"),
                ("Discount 50% off", ""),
                ("snake_case name", ""),
                ("snakeXcase name", ""),
                ("back\\slash", ""),
                ("Unrelated", "nothing"),
            ]
        ):
            Card.objects.create(
                board=cls.board,
                column=col,
                swimlane=swim,
                title=title,
                description=desc,
                created_by=cls.user,
                position=i,
            )

    def _titles(self, term):
        qs = Card.objects.filter(title__ci_contains=term) | Card.objects.filter(
            description__ci_contains=term
        )
        return sorted(qs.values_list("title", flat=True))

    def test_case_insensitive_match_on_title_and_description(self):
        self.assertEqual(self._titles("login"), ["Fix Login Bug"])
        self.assertEqual(self._titles("token"), ["Plain"])

    def test_percent_underscore_and_backslash_are_literal(self):
        self.assertEqual(self._titles("50%"), ["Discount 50% off"])
        self.assertEqual(self._titles("%"), ["Discount 50% off"])
        self.assertEqual(self._titles("e_c"), ["snake_case name"])
        self.assertEqual(self._titles("\\"), ["back\\slash"])

    def test_matches_same_rows_as_icontains(self):
        for term in ("login", "TOKEN", "%", "_", "e_c", "\\", "zzz", "o"):
            via_lookup = sorted(
                Card.objects.filter(title__ci_contains=term).values_list(
                    "pk", flat=True
                )
            )
            via_icontains = sorted(
                Card.objects.filter(title__icontains=term).values_list("pk", flat=True)
            )
            self.assertEqual(via_lookup, via_icontains, term)

    @unittest.skipUnless(
        connection.vendor == "postgresql", "ILIKE rendering is PostgreSQL-specific"
    )
    def test_renders_ilike_on_postgresql_with_parameterized_term(self):
        qs = Card.objects.filter(title__ci_contains="a%b")
        with CaptureQueriesContext(connection) as ctx:
            list(qs)
        sql = ctx.captured_queries[0]["sql"]
        self.assertIn("ILIKE", sql)
        self.assertNotIn("UPPER(", sql)

    def test_expression_right_hand_side_is_rejected(self):
        # An F() right-hand side would render without % wrapping or escaping.
        with self.assertRaises(NotImplementedError):
            str(Card.objects.filter(title__ci_contains=F("description")).query)

    def test_bilateral_transform_is_rejected(self):
        # A bilateral transform would wrap the unescaped pattern and turn the
        # substring match into an exact match.
        class BilateralLower(Transform):
            lookup_name = "blower"
            function = "LOWER"
            bilateral = True

        with register_lookup(CharField, BilateralLower):
            with self.assertRaises(NotImplementedError):
                str(Card.objects.filter(title__blower__ci_contains="abc").query)

    def _assert_search_uses_ilike(self, url):
        client = APIClient()
        client.force_authenticate(self.user)
        with CaptureQueriesContext(connection) as ctx:
            r = client.get(url, {"search": "login"})
        self.assertEqual(r.status_code, 200)
        card_sql = [
            q["sql"]
            for q in ctx.captured_queries
            if 'FROM "cards"' in q["sql"] and "login" in q["sql"]
        ]
        self.assertTrue(card_sql, "no card query carried the search term")
        for sql in card_sql:
            self.assertIn("ILIKE", sql)
            self.assertNotIn("UPPER(", sql)

    @unittest.skipUnless(
        connection.vendor == "postgresql", "ILIKE rendering is PostgreSQL-specific"
    )
    def test_board_card_list_search_renders_ilike(self):
        self._assert_search_uses_ilike(f"/api/v1/boards/{self.board.id}/cards/")

    @unittest.skipUnless(
        connection.vendor == "postgresql", "ILIKE rendering is PostgreSQL-specific"
    )
    def test_cross_board_card_query_search_renders_ilike(self):
        self._assert_search_uses_ilike("/api/v1/cards/")
