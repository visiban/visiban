"""Card search uses the ``ci_contains`` lookup so the trigram indexes apply (#1809)."""

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
import unittest

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
        # The term's LIKE metacharacter is escaped, so the unescaped pattern
        # must not appear in the statement.
        self.assertNotIn("%a%b%", sql)
