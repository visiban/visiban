"""Tests for the cross-board card query endpoint: GET /api/v1/cards/ (#1112).

Covers access scoping (owner / member / group-inherited / non-member / site
admin), filtering, cursor pagination shape and stability, ordering, and the
query-count guard. Card mutation and the existing per-board endpoints
(/boards/{id}/cards/, /boards/{id}/full/) are covered elsewhere and are not
touched by this endpoint.
"""
import datetime

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, Column, Label, Swimlane,
)

URL = "/api/v1/cards/"


def _make_board(owner, name="Board", group=None):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, **kwargs):
    kwargs.setdefault("title", "Card")
    kwargs.setdefault("position", 0)
    return Card.objects.create(board=board, column=col, swimlane=swim, created_by=user, **kwargs)


class CardQueryAccessScopingTests(TestCase):
    """Access must be scoped identically to the board-list queryset — a
    non-member must never see a card via this endpoint, even by guessing a
    ?board= id (IDOR prevention)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="x")
        self.other = User.objects.create_user(username="other", password="x")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner, title="Owner's card")
        self.client = APIClient()

    def test_owner_sees_own_card(self):
        self.client.force_authenticate(self.owner)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertIn("Owner's card", titles)

    def test_non_member_sees_no_cards(self):
        self.client.force_authenticate(self.other)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["results"], [])

    def test_non_member_cannot_use_board_filter_to_bypass_scoping(self):
        """Explicitly filtering ?board=<id> for a board the user cannot access
        must still return nothing — the accessible-boards scoping applies
        before any filter, not instead of it."""
        self.client.force_authenticate(self.other)
        r = self.client.get(URL, {"board": self.board.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["results"], [])

    def test_direct_member_sees_card(self):
        member = User.objects.create_user(username="member", password="x")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.VIEWER)
        self.client.force_authenticate(member)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.data["results"]), 1)

    def test_group_inherited_member_sees_card(self):
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="G", owner=self.owner)
        board, col, swim = _make_board(self.owner, name="Group Board", group=group)
        _make_card(board, col, swim, self.owner, title="Group card")

        group_user = User.objects.create_user(username="group_u", password="x")
        GroupMembership.objects.create(group=group, user=group_user, role="member")

        self.client.force_authenticate(group_user)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertIn("Group card", titles)
        self.assertNotIn("Owner's card", titles)

    def test_ancestor_group_member_sees_descendant_board_card(self):
        """A user whose membership is on an ANCESTOR group must still see cards
        on a board belonging to a DESCENDANT group — this is the direction
        get_board_role() actually grants (walking up from the board's own
        group through its ancestors looking for a membership), so it must
        keep working after scoping to descendants-only inheritance."""
        from groups.models import Group, GroupMembership

        parent = Group.objects.create(name="Parent", owner=self.owner)
        child = Group.objects.create(name="Child", owner=self.owner, parent=parent)
        board, col, swim = _make_board(self.owner, name="Child Board", group=child)
        _make_card(board, col, swim, self.owner, title="Child board card")

        parent_member = User.objects.create_user(username="parent_member", password="x")
        GroupMembership.objects.create(group=parent, user=parent_member, role="member")

        self.client.force_authenticate(parent_member)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertIn("Child board card", titles)

    def test_descendant_group_member_does_not_see_ancestor_board_card(self):
        """The inverse of the above must NOT hold: a user whose only
        membership is on a DESCENDANT (child) group must NOT see cards on a
        board belonging to an ANCESTOR (parent) group. get_board_role() grants
        no role in this direction (membership on a subgroup does not grant
        access to the parent org's boards), so this endpoint's accessible-
        boards scoping must not either — get_accessible_boards_queryset() must
        use get_group_ids_for_board_access() (descendants only), not
        get_accessible_group_ids() (which also walks up to ancestors for
        sidebar navigation and would incorrectly admit this board)."""
        from groups.models import Group, GroupMembership

        parent = Group.objects.create(name="Parent2", owner=self.owner)
        child = Group.objects.create(name="Child2", owner=self.owner, parent=parent)
        board, col, swim = _make_board(self.owner, name="Parent Board", group=parent)
        _make_card(board, col, swim, self.owner, title="Parent board card")

        child_member = User.objects.create_user(username="child_member", password="x")
        GroupMembership.objects.create(group=child, user=child_member, role="member")

        self.client.force_authenticate(child_member)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertNotIn("Parent board card", titles)
        # Also confirm explicitly requesting that board by id yields nothing —
        # not a 403 that would confirm the board's existence.
        r2 = self.client.get(URL, {"board": board.id})
        self.assertEqual(r2.data["results"], [])

    def test_site_admin_sees_all_boards(self):
        admin = User.objects.create_user(username="admin", password="x", can_access_all_content=True)
        self.client.force_authenticate(admin)
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertIn("Owner's card", titles)

    def test_card_includes_board_id(self):
        """Unlike the single-board endpoints, this cross-board endpoint must
        say which board each card belongs to."""
        self.client.force_authenticate(self.owner)
        r = self.client.get(URL)
        self.assertEqual(r.data["results"][0]["board"], self.board.id)


class CardQueryResponseShapeTests(TestCase):
    """Response envelope is {results, next_cursor} — distinct from
    OffsetCountPagination's {count, offset, page_size, results}."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_response_envelope(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("results", r.data)
        self.assertIn("next_cursor", r.data)
        self.assertNotIn("count", r.data)
        self.assertNotIn("offset", r.data)

    def test_next_cursor_is_none_on_last_page(self):
        r = self.client.get(URL, {"page_size": 50})
        self.assertIsNone(r.data["next_cursor"])


class CardQueryFilterTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        self.col2 = Column.objects.create(board=self.board, name="Doing", position=1)
        self.swim2 = Swimlane.objects.create(board=self.board, name="Lane 2", position=1)
        self.assignee = User.objects.create_user(username="assignee", password="x")
        BoardMembership.objects.create(board=self.board, user=self.assignee, role=BoardMembership.Role.MEMBER)
        self.label = Label.objects.create(board=self.board, name="Bug", color="#EF4444")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _titles(self, params):
        r = self.client.get(URL, params)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        return [c["title"] for c in r.data["results"]]

    def test_filter_by_board(self):
        board2, col2, swim2 = _make_board(self.user, name="Board 2")
        _make_card(self.board, self.col, self.swim, self.user, title="On board 1")
        _make_card(board2, col2, swim2, self.user, title="On board 2")
        titles = self._titles({"board": self.board.id})
        self.assertIn("On board 1", titles)
        self.assertNotIn("On board 2", titles)

    def test_filter_by_column(self):
        _make_card(self.board, self.col, self.swim, self.user, title="In Backlog")
        _make_card(self.board, self.col2, self.swim, self.user, title="In Doing")
        titles = self._titles({"column": self.col2.id})
        self.assertEqual(titles, ["In Doing"])

    def test_filter_by_swimlane(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Lane 1 card")
        _make_card(self.board, self.col, self.swim2, self.user, title="Lane 2 card")
        titles = self._titles({"swimlane": self.swim2.id})
        self.assertEqual(titles, ["Lane 2 card"])

    def test_filter_by_assignee(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Unassigned")
        _make_card(self.board, self.col, self.swim, self.user, title="Assigned", assignee=self.assignee)
        titles = self._titles({"assignee": self.assignee.id})
        self.assertEqual(titles, ["Assigned"])

    def test_filter_by_label(self):
        c1 = _make_card(self.board, self.col, self.swim, self.user, title="Labeled")
        c1.labels.add(self.label)
        _make_card(self.board, self.col, self.swim, self.user, title="Unlabeled")
        titles = self._titles({"label": self.label.id})
        self.assertEqual(titles, ["Labeled"])

    def test_label_from_inaccessible_board_returns_no_rows(self):
        """?board=<accessible> combined with a label id from a board the user
        cannot access must yield nothing, not the accessible board's cards
        unfiltered — the base board_id__in scoping must apply BEFORE the label
        filter, not be bypassable by it."""
        other_owner = User.objects.create_user(username="other_owner", password="x")
        other_board, other_col, other_swim = _make_board(other_owner, name="Other")
        foreign_label = Label.objects.create(board=other_board, name="Foreign", color="#000")

        titles = self._titles({"board": self.board.id, "label": foreign_label.id})
        self.assertEqual(titles, [])

    def test_filter_by_priority(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Low", priority="low")
        _make_card(self.board, self.col, self.swim, self.user, title="Urgent", priority="urgent")
        titles = self._titles({"priority": "urgent"})
        self.assertEqual(titles, ["Urgent"])

    def test_filter_by_due_before_and_after(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Early", due_date="2026-01-01")
        _make_card(self.board, self.col, self.swim, self.user, title="Late", due_date="2026-12-31")
        titles = self._titles({"due_before": "2026-06-01"})
        self.assertEqual(titles, ["Early"])
        titles = self._titles({"due_after": "2026-06-01"})
        self.assertEqual(titles, ["Late"])

    def test_filter_by_updated_since(self):
        old = _make_card(self.board, self.col, self.swim, self.user, title="Old")
        Card.objects.filter(pk=old.pk).update(updated_at=timezone.now() - datetime.timedelta(days=10))
        _make_card(self.board, self.col, self.swim, self.user, title="Fresh")
        cutoff = (timezone.now() - datetime.timedelta(days=1)).isoformat()
        titles = self._titles({"updated_since": cutoff})
        self.assertEqual(titles, ["Fresh"])

    def test_search_by_title(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Fix login bug")
        _make_card(self.board, self.col, self.swim, self.user, title="Update readme")
        titles = self._titles({"search": "login"})
        self.assertEqual(titles, ["Fix login bug"])

    def test_include_archived_excluded_by_default(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Active")
        archived = _make_card(self.board, self.col, self.swim, self.user, title="Archived")
        archived.archived_at = timezone.now()
        archived.save(update_fields=["archived_at"])
        titles = self._titles({})
        self.assertIn("Active", titles)
        self.assertNotIn("Archived", titles)

    def test_include_archived_true_includes_them(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Active")
        archived = _make_card(self.board, self.col, self.swim, self.user, title="Archived")
        archived.archived_at = timezone.now()
        archived.save(update_fields=["archived_at"])
        titles = self._titles({"include_archived": "true"})
        self.assertIn("Active", titles)
        self.assertIn("Archived", titles)


class CardQueryOrderingTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_default_ordering_is_most_recently_updated_first(self):
        _make_card(self.board, self.col, self.swim, self.user, title="First")
        _make_card(self.board, self.col, self.swim, self.user, title="Second")
        r = self.client.get(URL)
        titles = [c["title"] for c in r.data["results"]]
        self.assertEqual(titles, ["Second", "First"])

    def test_ordering_param_updated_at_ascending(self):
        _make_card(self.board, self.col, self.swim, self.user, title="First")
        _make_card(self.board, self.col, self.swim, self.user, title="Second")
        r = self.client.get(URL, {"ordering": "updated_at"})
        titles = [c["title"] for c in r.data["results"]]
        self.assertEqual(titles, ["First", "Second"])

    def test_invalid_ordering_param_falls_back_to_default(self):
        _make_card(self.board, self.col, self.swim, self.user, title="First")
        _make_card(self.board, self.col, self.swim, self.user, title="Second")
        r = self.client.get(URL, {"ordering": "priority"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        titles = [c["title"] for c in r.data["results"]]
        self.assertEqual(titles, ["Second", "First"])


class CardQueryCursorStabilityTests(TestCase):
    """Walking next_cursor to exhaustion must return every card exactly once,
    even when many cards share the same updated_at (the tiebreaker case)."""

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_full_traversal_no_duplicates_or_gaps_with_tied_updated_at(self):
        cards = [
            _make_card(self.board, self.col, self.swim, self.user, title=f"Card {i}")
            for i in range(23)
        ]
        # Force every card to the exact same updated_at (auto_now would
        # otherwise stagger them by microseconds) so the id tiebreaker is the
        # only thing keeping pagination stable.
        tied = timezone.now()
        Card.objects.filter(board=self.board).update(updated_at=tied)

        seen_ids = []
        cursor = None
        for _ in range(50):  # generous upper bound on page count
            params = {"page_size": 5}
            if cursor:
                params["cursor"] = cursor
            r = self.client.get(URL, params)
            self.assertEqual(r.status_code, status.HTTP_200_OK)
            seen_ids.extend(c["id"] for c in r.data["results"])
            cursor = r.data["next_cursor"]
            if not cursor:
                break

        self.assertEqual(sorted(seen_ids), sorted(c.id for c in cards))
        self.assertEqual(len(seen_ids), len(set(seen_ids)), "cursor traversal returned a duplicate card")


class CardQueryCountTests(TestCase):
    """GET /api/v1/cards/ must not issue per-card queries, regardless of how
    many cards or boards are in scope."""

    # Measured minimum is 6 (accessible-boards lookup + main card select +
    # labels/attachments/checklist_items/movements prefetches); budget is 2x
    # that, matching the headroom convention in test_query_counts.py.
    BUDGET = 12

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        label = Label.objects.create(board=self.board, name="l", color="#000")
        for i in range(10):
            card = _make_card(self.board, self.col, self.swim, self.user, title=f"Card {i}")
            card.labels.add(label)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get(self):
        return self.client.get(URL)

    def test_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get()
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertGreater(len(r.data["results"]), 0)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"cards/ used {len(ctx)} queries — budget is {self.BUDGET}. An N+1 was introduced.",
        )

    def test_query_count_constant_across_card_count(self):
        def _count():
            with CaptureQueriesContext(connection) as ctx:
                self._get()
            return len(ctx)

        baseline = _count()
        for i in range(20):
            _make_card(self.board, self.col, self.swim, self.user, title=f"Extra {i}")
        scaled = _count()
        self.assertEqual(
            baseline, scaled,
            f"cards/ query count grew from {baseline} to {scaled} when cards were added.",
        )

    def test_query_count_constant_across_board_count(self):
        """Adding more accessible boards (each contributing to the board_id__in
        subquery) must not add per-board queries either."""
        def _count():
            with CaptureQueriesContext(connection) as ctx:
                self._get()
            return len(ctx)

        baseline = _count()
        for i in range(5):
            _make_board(self.user, name=f"Extra board {i}")
        scaled = _count()
        self.assertEqual(
            baseline, scaled,
            f"cards/ query count grew from {baseline} to {scaled} when boards were added.",
        )


class CardQuerySerializerFieldParityTests(TestCase):
    """CardQuerySerializer is a hand-maintained field-set copy of CardSerializer
    (deliberately — see its docstring), not a reuse. That means a sensitive
    field added to Card/CardSerializer later could be silently exposed here
    too, or silently missing, without either serializer's own test suite
    catching it. Guard the two field sets' relationship explicitly so drift
    fails CI instead of failing silently."""

    def test_fields_are_a_subset_of_cardserializer_non_write_fields(self):
        from boards.views.card_query import CardQuerySerializer
        from boards.serializers import CardSerializer

        card_fields = set(CardSerializer().fields.keys())
        card_write_only = {
            name for name, field in CardSerializer().fields.items() if field.write_only
        }
        card_readable_fields = card_fields - card_write_only

        query_fields = set(CardQuerySerializer().fields.keys())
        # "board" is the one intentional addition — see CardQuerySerializer's
        # docstring (single-board endpoints omit it; a cross-board list can't).
        extra = query_fields - card_readable_fields
        self.assertEqual(
            extra, {"board"},
            f"CardQuerySerializer exposes fields not on CardSerializer's readable "
            f"field set (beyond the intentional 'board' addition): {extra - {'board'}}. "
            "If a new field was intentionally added to both, update this test's "
            "expected set; if not, it may be an unreviewed exposure.",
        )
        missing = card_readable_fields - query_fields
        self.assertEqual(
            missing, set(),
            f"CardQuerySerializer is missing fields CardSerializer exposes: {missing}",
        )
