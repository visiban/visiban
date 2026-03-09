"""Cascade deletion tests: verify that deleting parent objects cascades correctly."""
from django.test import TestCase

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardComment, CardMovement,
    Column, Label, Swimlane,
)


def _make_populated_board(owner):
    """Create a board with columns, swimlanes, labels, cards, comments, and movements."""
    board = Board.objects.create(name="Cascade Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)

    col_a = Column.objects.create(board=board, name="Backlog", position=0)
    col_b = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    label = Label.objects.create(board=board, name="Bug", color="#EF4444")

    card = Card.objects.create(
        board=board, column=col_a, swimlane=swim,
        title="Card 1", created_by=owner, position=0,
    )
    card.labels.add(label)

    CardComment.objects.create(card=card, author=owner, body="A comment")

    CardMovement.objects.create(
        card=card,
        from_column=None, to_column=col_a,
        from_swimlane=None, to_swimlane=swim,
        moved_by=owner, notes="Created",
    )
    CardMovement.objects.create(
        card=card,
        from_column=col_a, to_column=col_b,
        from_swimlane=swim, to_swimlane=swim,
        moved_by=owner,
    )

    return board, col_a, col_b, swim, label, card


class BoardCascadeDeletionTests(TestCase):
    """Deleting a board should cascade to all child objects."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col_a, self.col_b, self.swim, self.label, self.card = (
            _make_populated_board(self.owner)
        )

    def test_deleting_board_cascades_columns(self):
        board_id = self.board.pk
        self.board.delete()
        self.assertEqual(Column.objects.filter(board_id=board_id).count(), 0)

    def test_deleting_board_cascades_swimlanes(self):
        board_id = self.board.pk
        self.board.delete()
        self.assertEqual(Swimlane.objects.filter(board_id=board_id).count(), 0)

    def test_deleting_board_cascades_labels(self):
        board_id = self.board.pk
        self.board.delete()
        self.assertEqual(Label.objects.filter(board_id=board_id).count(), 0)

    def test_deleting_board_cascades_cards(self):
        board_id = self.board.pk
        self.board.delete()
        self.assertEqual(Card.objects.filter(board_id=board_id).count(), 0)

    def test_deleting_board_cascades_card_movements(self):
        card_id = self.card.pk
        self.board.delete()
        self.assertEqual(CardMovement.objects.filter(card_id=card_id).count(), 0)

    def test_deleting_board_cascades_card_comments(self):
        card_id = self.card.pk
        self.board.delete()
        self.assertEqual(CardComment.objects.filter(card_id=card_id).count(), 0)

    def test_deleting_board_cascades_memberships(self):
        board_id = self.board.pk
        self.board.delete()
        self.assertEqual(BoardMembership.objects.filter(board_id=board_id).count(), 0)


class ColumnCascadeDeletionTests(TestCase):
    """Deleting a column should cascade to its cards and their movements."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col_a, self.col_b, self.swim, _, self.card = (
            _make_populated_board(self.owner)
        )
        # Place the card in col_a
        self.card.column = self.col_a
        self.card.save()

    def test_deleting_column_cascades_cards(self):
        card_id = self.card.pk
        self.col_a.delete()
        self.assertFalse(Card.objects.filter(pk=card_id).exists())

    def test_deleting_column_cascades_card_movements(self):
        card_id = self.card.pk
        self.col_a.delete()
        self.assertEqual(CardMovement.objects.filter(card_id=card_id).count(), 0)

    def test_deleting_column_cascades_card_comments(self):
        card_id = self.card.pk
        self.col_a.delete()
        self.assertEqual(CardComment.objects.filter(card_id=card_id).count(), 0)

    def test_deleting_column_does_not_affect_other_columns(self):
        """Cards in other columns should remain intact."""
        other_card = Card.objects.create(
            board=self.board, column=self.col_b, swimlane=self.swim,
            title="Other Card", created_by=self.owner, position=0,
        )
        self.col_a.delete()
        self.assertTrue(Card.objects.filter(pk=other_card.pk).exists())


class SwimlaneCascadeDeletionTests(TestCase):
    """Deleting a swimlane should cascade to its cards."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col_a, self.col_b, self.swim, _, self.card = (
            _make_populated_board(self.owner)
        )

    def test_deleting_swimlane_cascades_cards(self):
        card_id = self.card.pk
        self.swim.delete()
        self.assertFalse(Card.objects.filter(pk=card_id).exists())

    def test_deleting_swimlane_cascades_card_movements(self):
        card_id = self.card.pk
        self.swim.delete()
        self.assertEqual(CardMovement.objects.filter(card_id=card_id).count(), 0)

    def test_deleting_swimlane_does_not_affect_other_swimlanes(self):
        """Cards in other swimlanes should remain intact."""
        swim2 = Swimlane.objects.create(board=self.board, name="VIP", position=1)
        other_card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=swim2,
            title="VIP Card", created_by=self.owner, position=0,
        )
        self.swim.delete()
        self.assertTrue(Card.objects.filter(pk=other_card.pk).exists())
