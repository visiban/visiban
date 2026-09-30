"""`archived_card_count` on the board payloads (#1289).

Card.board is ``on_delete=CASCADE``, so deleting a board also deletes its
archived cards. ``card_count`` deliberately stays active-only (#693), so the
three board-delete confirmations read this additive companion field to require
typed-name confirmation for a board that holds only archived cards.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from groups.models import Group, GroupMembership


def _board_with_cards(owner, name, *, active, archived, group=None):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Todo", position=0)
    lane = Swimlane.objects.create(board=board, name="General", position=0)
    pos = 0
    for i in range(active):
        Card.objects.create(board=board, column=col, swimlane=lane, title=f"A{i}", created_by=owner, position=pos)
        pos += 1
    for i in range(archived):
        Card.objects.create(
            board=board, column=col, swimlane=lane, title=f"X{i}", created_by=owner,
            position=pos, archived_at=timezone.now(),
        )
        pos += 1
    return board


class BoardArchivedCardCountTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="acc_owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _list_row(self, board):
        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, 200)
        return next(b for b in r.data["results"] if b["id"] == board.id)

    def test_list_reports_archived_only_board(self):
        """The #1289 case: 0 active cards, N archived — card_count alone reads 0."""
        board = _board_with_cards(self.owner, "Only archived", active=0, archived=3)
        row = self._list_row(board)
        self.assertEqual(row["card_count"], 0, "card_count stays active-only (#693)")
        self.assertEqual(row["archived_card_count"], 3)

    def test_list_counts_active_and_archived_separately(self):
        board = _board_with_cards(self.owner, "Mixed", active=2, archived=1)
        row = self._list_row(board)
        self.assertEqual(row["card_count"], 2)
        self.assertEqual(row["archived_card_count"], 1)

    def test_counts_do_not_multiply_across_memberships(self):
        """Both counts share the memberships join; distinct=True must keep them exact."""
        board = _board_with_cards(self.owner, "Members", active=2, archived=3)
        for i in range(3):
            u = User.objects.create_user(username=f"acc_m{i}", password="pass")
            BoardMembership.objects.create(board=board, user=u, role=BoardMembership.Role.MEMBER)
        row = self._list_row(board)
        self.assertEqual(row["member_count"], 4)
        self.assertEqual(row["card_count"], 2)
        self.assertEqual(row["archived_card_count"], 3)

    def test_empty_board_reports_zero(self):
        board = _board_with_cards(self.owner, "Empty", active=0, archived=0)
        self.assertEqual(self._list_row(board)["archived_card_count"], 0)

    def test_retrieve_reports_archived_card_count(self):
        board = _board_with_cards(self.owner, "Retrieve", active=0, archived=2)
        r = self.client.get(f"/api/v1/boards/{board.id}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["archived_card_count"], 2)

    def test_full_reports_archived_card_count_and_keeps_cards_active_only(self):
        board = _board_with_cards(self.owner, "Full", active=1, archived=4)
        r = self.client.get(f"/api/v1/boards/{board.id}/full/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["cards"]), 1, "/full/ cards stay active-only")
        self.assertEqual(r.data["archived_card_count"], 4)

    def test_full_reports_zero_without_archived_cards(self):
        """Coalesce: the correlated subquery yields NULL with no rows, never None on the wire."""
        board = _board_with_cards(self.owner, "Full empty", active=1, archived=0)
        r = self.client.get(f"/api/v1/boards/{board.id}/full/")
        self.assertEqual(r.data["archived_card_count"], 0)

    def test_group_boards_action_reports_archived_card_count(self):
        group = Group.objects.create(name="ACC Group", owner=self.owner)
        GroupMembership.objects.create(group=group, user=self.owner, role=GroupMembership.Role.ADMIN)
        board = _board_with_cards(self.owner, "Grouped", active=0, archived=2, group=group)
        r = self.client.get(f"/api/v1/groups/{group.id}/boards/")
        self.assertEqual(r.status_code, 200)
        row = next(b for b in r.json() if b["id"] == board.id)
        self.assertEqual(row["card_count"], 0)
        self.assertEqual(row["archived_card_count"], 2)

    def test_deleting_board_cascades_to_archived_cards(self):
        """The reason the field exists: archived cards do not survive board deletion."""
        board = _board_with_cards(self.owner, "Doomed", active=0, archived=2)
        r = self.client.delete(f"/api/v1/boards/{board.id}/")
        self.assertIn(r.status_code, (200, 204))
        self.assertFalse(Card.objects.filter(board_id=board.id).exists())


class BoardArchivedCardCountQueryTests(TestCase):
    """The new count is an annotation, not a per-board query."""

    def setUp(self):
        self.owner = User.objects.create_user(username="acc_q", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.boards = [
            _board_with_cards(self.owner, f"Q{i}", active=1, archived=0) for i in range(3)
        ]

    def _count(self, fn):
        with CaptureQueriesContext(connection) as ctx:
            r = fn()
        self.assertEqual(r.status_code, 200)
        return len(ctx)

    def test_list_query_count_constant_as_archived_boards_grow(self):
        baseline = self._count(lambda: self.client.get("/api/v1/boards/"))
        for i in range(10):
            _board_with_cards(self.owner, f"Q-more{i}", active=0, archived=2)
        grown = self._count(lambda: self.client.get("/api/v1/boards/"))
        self.assertEqual(baseline, grown, "archived_card_count must not add a query per board")

    def _archived_count_queries(self, url):
        """Return (queries that compute the archived count, standalone fallback COUNTs)."""
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200)
        sqls = [q["sql"] for q in ctx.captured_queries]
        archived = [q for q in sqls if '"archived_at" IS NOT NULL' in q]
        # The serializer fallback, obj.cards.filter(archived_at__isnull=False).count(),
        # is a per-board query of its own whose outermost FROM is the card table.
        fallback = [q for q in archived if q.lstrip().startswith(f'SELECT COUNT(*) AS "__count" FROM "{Card._meta.db_table}"')]
        return r, archived, fallback

    def test_full_computes_archived_count_inside_the_board_query(self):
        """Discriminating: with the /full/ annotation disabled, the serializer
        falls back to a separate COUNT — one constant extra query that a
        count-comparison test cannot tell apart from the annotated path."""
        board = self.boards[0]
        col, lane = board.columns.first(), board.swimlanes.first()
        Card.objects.create(
            board=board, column=col, swimlane=lane, title="late", created_by=self.owner,
            position=10, archived_at=timezone.now(),
        )
        r, archived, fallback = self._archived_count_queries(f"/api/v1/boards/{board.id}/full/")
        self.assertEqual(r.data["archived_card_count"], 1)
        self.assertEqual(fallback, [], "archived_card_count fell back to a standalone COUNT query")
        self.assertTrue(
            any(f'FROM "{Board._meta.db_table}"' in q for q in archived),
            "the board SELECT must carry the archived-count subquery annotation",
        )

    def test_list_computes_archived_count_inside_the_board_query(self):
        r, archived, fallback = self._archived_count_queries("/api/v1/boards/")
        self.assertEqual(fallback, [], "archived_card_count fell back to a per-board COUNT query")
        self.assertTrue(any(f'FROM "{Board._meta.db_table}"' in q for q in archived))
