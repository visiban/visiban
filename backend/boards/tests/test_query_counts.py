"""Query-count regression tests.

Each test asserts that a key endpoint stays within a fixed query budget.
A budget violation means an N+1 was introduced — fix the prefetch, don't
raise the budget.

We use CaptureQueriesContext (assertNumQueries asserts *exact* equality, which
is too brittle here — DRF/Django middleware can vary by ±1 across versions).
The important invariant is that the count is *constant* regardless of card or
swimlane count: a per-row regression adds O(n) queries and will breach the
budget immediately on any realistic board.

Budgets are set at 2× the measured minimum to absorb minor framework overhead
while still catching any N+1 regression.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardAttachment, CardChecklist,
    CardMovement, Column, Label, Swimlane,
)


# ── fixture helpers ────────────────────────────────────────────────────────────

def _make_board(owner):
    board = Board.objects.create(name="QueryCountBoard", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role="admin")
    return board


def _seed_board(owner, n_cols=5, n_lanes=5, cards_per_cell=2):
    """Create a board with n_cols × n_lanes × cards_per_cell cards.

    Each card has 1 label, 1 attachment, 2 checklist items, and 1 movement
    so the serializer's method fields always have data to resolve.
    """
    board = _make_board(owner)
    label = Label.objects.create(board=board, name="l", color="#000")

    cols = [Column.objects.create(board=board, name=f"C{i}", position=i) for i in range(n_cols)]
    lanes = [Swimlane.objects.create(board=board, name=f"L{i}", position=i) for i in range(n_lanes)]

    for col in cols:
        for lane in lanes:
            for n in range(cards_per_cell):
                card = Card.objects.create(
                    board=board, column=col, swimlane=lane,
                    title=f"Card {n}", created_by=owner, position=n,
                )
                card.labels.add(label)
                CardMovement.objects.create(
                    card=card,
                    to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                    to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
                    from_column=None, from_column_name="", from_column_uid="",
                    from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                    moved_by=owner,
                )
                CardAttachment.objects.create(
                    card=card, uploaded_by=owner,
                    filename="f.txt", file="attachments/f.txt", size=1,
                )
                CardChecklist.objects.create(card=card, text="a", is_checked=False, position=0)
                CardChecklist.objects.create(card=card, text="b", is_checked=True, position=1)

    return board, cols, lanes


def _query_count(fn):
    """Run fn() and return the number of SQL queries it issued."""
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx)


# ── tests ─────────────────────────────────────────────────────────────────────

class CardListQueryCountTests(TestCase):
    """GET /api/boards/{id}/cards/ must not issue per-card queries."""

    # 5 fixed queries (auth, board, cards+prefetches) × 2 headroom = 10; round up to 12.
    BUDGET = 12

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.cols, self.lanes = _seed_board(self.user, n_cols=5, n_lanes=5, cards_per_cell=2)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_cards(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/cards/")

    def test_card_list_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_cards()
        self.assertEqual(r.status_code, 200)
        self.assertGreater(len(r.data), 0)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"cards/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "An N+1 was introduced; fix the prefetch.",
        )

    def test_card_list_budget_scales_with_cards(self):
        """Adding more cards must not increase the query count."""
        baseline = _query_count(self._get_cards)

        # Double the card count.
        for col in self.cols:
            for lane in self.lanes:
                Card.objects.create(
                    board=self.board, column=col, swimlane=lane,
                    title="extra", created_by=self.user, position=99,
                )

        doubled = _query_count(self._get_cards)
        self.assertEqual(
            baseline, doubled,
            f"cards/ query count grew from {baseline} to {doubled} when cards "
            "were added — N+1 regression detected.",
        )


class BoardFullQueryCountTests(TestCase):
    """GET /api/boards/{id}/full/ must not issue per-card queries."""

    BUDGET = 20  # ~12 measured; 20 gives headroom for middleware

    def setUp(self):
        self.user = User.objects.create_user(username="u2", password="x")
        self.board, self.cols, self.lanes = _seed_board(self.user, n_cols=5, n_lanes=5, cards_per_cell=2)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_full_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_full()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["cards"]), 50)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"full/ used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_full_budget_scales_with_cards(self):
        """Adding more cards must not increase the query count."""
        baseline = _query_count(self._get_full)

        for col in self.cols:
            for lane in self.lanes:
                Card.objects.create(
                    board=self.board, column=col, swimlane=lane,
                    title="extra", created_by=self.user, position=99,
                )

        doubled = _query_count(self._get_full)
        self.assertEqual(
            baseline, doubled,
            f"full/ query count grew from {baseline} to {doubled} when cards "
            "were added — N+1 regression detected.",
        )


class BoardFullGroupInheritedQueryCountTests(TestCase):
    """GET /api/boards/{id}/full/ must not issue per-card queries even when
    the board belongs to a group with inherited memberships.

    This catches the N+1 in CardSerializer.__init__ where
    _get_effective_member_ids() was called once per card instance, each
    triggering 2-8 DB queries to walk the group ancestor chain (#490).
    """

    BUDGET = 25  # group-inherited membership adds a few queries; 25 is generous headroom

    def setUp(self):
        from groups.models import Group, GroupMembership

        self.owner = User.objects.create_user(username="g_owner", password="x")
        # Create a two-level group hierarchy with members at each level.
        self.parent_group = Group.objects.create(name="Parent", owner=self.owner)
        self.child_group = Group.objects.create(name="Child", owner=self.owner, parent=self.parent_group)

        self.group_user1 = User.objects.create_user(username="g_u1", password="x")
        self.group_user2 = User.objects.create_user(username="g_u2", password="x")
        GroupMembership.objects.create(group=self.parent_group, user=self.group_user1, role="member")
        GroupMembership.objects.create(group=self.child_group, user=self.group_user2, role="member")

        # Board belongs to the child group — effective members come from both levels.
        self.board = Board.objects.create(name="GroupBoard", owner=self.owner, group=self.child_group)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")

        # Seed cards
        label = Label.objects.create(board=self.board, name="l", color="#000")
        cols = [Column.objects.create(board=self.board, name=f"C{i}", position=i) for i in range(3)]
        lanes = [Swimlane.objects.create(board=self.board, name=f"L{i}", position=i) for i in range(3)]
        self.cols = cols
        self.lanes = lanes
        for col in cols:
            for lane in lanes:
                for n in range(2):
                    card = Card.objects.create(
                        board=self.board, column=col, swimlane=lane,
                        title=f"Card {n}", created_by=self.owner, position=n,
                    )
                    card.labels.add(label)
                    CardMovement.objects.create(
                        card=card,
                        to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                        to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
                        from_column=None, from_column_name="", from_column_uid="",
                        from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                        moved_by=self.owner,
                    )

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_full_with_group_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_full()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["cards"]), 18)  # 3 cols × 3 lanes × 2 cards
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"full/ (group board) used {len(ctx)} queries — budget is {self.BUDGET}. "
            "Member/label lookups may still be running per-card (#490).",
        )

    def test_full_with_group_budget_scales_with_cards(self):
        """Adding more cards must not increase the query count."""
        baseline = _query_count(self._get_full)

        for col in self.cols:
            for lane in self.lanes:
                Card.objects.create(
                    board=self.board, column=col, swimlane=lane,
                    title="extra", created_by=self.owner, position=99,
                )

        doubled = _query_count(self._get_full)
        self.assertEqual(
            baseline, doubled,
            f"full/ (group board) query count grew from {baseline} to {doubled} "
            "when cards were added — N+1 regression detected (#490).",
        )


class SummaryQueryCountTests(TestCase):
    """GET /api/boards/{id}/summary/ must use aggregate queries, not per-swimlane loops."""

    BUDGET = 10  # 2–5 measured; 10 gives generous headroom for auth middleware

    def setUp(self):
        self.user = User.objects.create_user(username="u3", password="x")
        self.board, _, self.lanes = _seed_board(self.user, n_cols=5, n_lanes=10, cards_per_cell=2)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_summary(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/summary/")

    def test_summary_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_summary()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["swimlanes"]), 10)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"summary/ used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_summary_budget_scales_with_swimlanes(self):
        """Adding more swimlanes must not increase the query count."""
        baseline = _query_count(self._get_summary)

        for i in range(10, 20):
            Swimlane.objects.create(board=self.board, name=f"Extra {i}", position=i)

        more = _query_count(self._get_summary)
        self.assertEqual(
            baseline, more,
            f"summary/ query count grew from {baseline} to {more} when swimlanes "
            "were added — the per-swimlane loop regression was reintroduced.",
        )


class BoardListQueryCountTests(TestCase):
    """GET /api/boards/ must not issue per-board queries.

    member_count, card_count, and is_starred are annotated in get_queryset()
    so they resolve in a single query rather than one subquery per board.
    owner and group are select_related to prevent join-per-row for those fields.
    """

    # Auth (1) + boards list with annotations (1) + middleware overhead × 2
    BUDGET = 8

    def setUp(self):
        self.user = User.objects.create_user(username="u4", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        for i in range(5):
            board = Board.objects.create(name=f"Board {i}", owner=self.user)
            BoardMembership.objects.create(board=board, user=self.user, role="admin")

    def _get_boards(self):
        return self.client.get("/api/v1/boards/")

    def test_board_list_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_boards()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["results"]), 5)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"boards/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "An N+1 was introduced; fix the annotation.",
        )

    def test_board_list_budget_scales_with_boards(self):
        """Adding more boards must not increase the query count."""
        baseline = _query_count(self._get_boards)

        for i in range(5, 15):
            board = Board.objects.create(name=f"Board {i}", owner=self.user)
            BoardMembership.objects.create(board=board, user=self.user, role="admin")

        doubled = _query_count(self._get_boards)
        self.assertEqual(
            baseline, doubled,
            f"boards/ query count grew from {baseline} to {doubled} when boards "
            "were added — member_count/card_count/is_starred/owner N+1 regression detected.",
        )
