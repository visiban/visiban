"""Tests for the find_cross_board_cards management command (#1106).

The command is a read-only diagnostic for cards left in a corrupted state by
the PATCH/PUT vulnerability fixed in #1106 (column/swimlane accepted from any
board). It cannot be reproduced through the API anymore once that fix is in
place, so these tests write the corrupted state directly via the ORM, the way
a pre-fix client request would have left it.
"""
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane


def _run(**kwargs):
    out = StringIO()
    call_command("find_cross_board_cards", stdout=out, **kwargs)
    return out.getvalue()


class FindCrossBoardCardsTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board_a = Board.objects.create(name="A", owner=self.owner)
        BoardMembership.objects.create(board=self.board_a, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.col_a = Column.objects.create(board=self.board_a, name="A1", position=0)
        self.swim_a = Swimlane.objects.create(board=self.board_a, name="LA", position=0)

        self.board_b = Board.objects.create(name="B", owner=self.owner)
        self.col_b = Column.objects.create(board=self.board_b, name="B1", position=0)
        self.swim_b = Swimlane.objects.create(board=self.board_b, name="LB", position=0)

    def test_reports_nothing_on_clean_data(self):
        Card.objects.create(
            board=self.board_a, column=self.col_a, swimlane=self.swim_a,
            title="clean", created_by=self.owner, position=0,
        )
        output = _run()
        self.assertIn("No cross-board cards found.", output)

    def test_reports_card_with_foreign_column(self):
        card = Card.objects.create(
            board=self.board_a, column=self.col_a, swimlane=self.swim_a,
            title="corrupted", created_by=self.owner, position=0,
        )
        # Simulate the pre-fix corruption directly (bypasses the now-fixed API).
        Card.objects.filter(pk=card.pk).update(column=self.col_b)

        output = _run()
        self.assertIn(f"Card {card.pk} (", output)
        self.assertIn("column", output)
        self.assertIn("1 card(s)", output)

    def test_reports_card_with_foreign_swimlane(self):
        card = Card.objects.create(
            board=self.board_a, column=self.col_a, swimlane=self.swim_a,
            title="corrupted", created_by=self.owner, position=0,
        )
        Card.objects.filter(pk=card.pk).update(swimlane=self.swim_b)

        output = _run()
        self.assertIn(f"Card {card.pk} (", output)
        self.assertIn("swimlane", output)

    def test_does_not_modify_data(self):
        card = Card.objects.create(
            board=self.board_a, column=self.col_a, swimlane=self.swim_a,
            title="corrupted", created_by=self.owner, position=0,
        )
        Card.objects.filter(pk=card.pk).update(column=self.col_b)

        _run()

        card.refresh_from_db()
        self.assertEqual(card.column_id, self.col_b.id)  # unchanged — command is read-only

    def test_board_filter_restricts_scan(self):
        card_a = Card.objects.create(
            board=self.board_a, column=self.col_a, swimlane=self.swim_a,
            title="corrupted-a", created_by=self.owner, position=0,
        )
        Card.objects.filter(pk=card_a.pk).update(column=self.col_b)

        other_owner = User.objects.create_user(username="other", password="pass")
        board_c = Board.objects.create(name="C", owner=other_owner)
        col_c = Column.objects.create(board=board_c, name="C1", position=0)
        swim_c = Swimlane.objects.create(board=board_c, name="LC", position=0)
        card_c = Card.objects.create(
            board=board_c, column=col_c, swimlane=swim_c,
            title="corrupted-c", created_by=other_owner, position=0,
        )
        Card.objects.filter(pk=card_c.pk).update(column=self.col_b)

        output = _run(board=self.board_a.id)
        self.assertIn(f"Card {card_a.pk} (", output)
        self.assertNotIn(f"Card {card_c.pk} (", output)
