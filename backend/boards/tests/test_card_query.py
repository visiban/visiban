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
    Board, BoardMembership, Card, CardAttachment, CardChecklist, CardMovement,
    CardRelation, Column, Label, Swimlane,
)

URL = "/api/v1/cards/"


def _make_board(owner, name="Board", group=None, staleness_threshold_days=7):
    board = Board.objects.create(
        name=name, owner=owner, group=group,
        staleness_threshold_days=staleness_threshold_days,
    )
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


def _make_card(board, col, swim, user, **kwargs):
    kwargs.setdefault("title", "Card")
    kwargs.setdefault("position", 0)
    return Card.objects.create(board=board, column=col, swimlane=swim, created_by=user, **kwargs)


def _make_movement(card, col, swim, user, days_ago=0):
    """Create a CardMovement and backdate moved_at (auto_now_add prevents direct set).

    Matches the backdating pattern in test_serializers.py's
    CardSerializerIsStaleTests — moved_at is auto_now_add, so the only way to
    get a movement "in the past" is to create it and then UPDATE the column
    directly, bypassing auto_now_add on the second write.
    """
    mv = CardMovement.objects.create(
        card=card,
        from_column=None, from_column_name="",
        to_column=col, to_column_name=col.name,
        from_swimlane=None, from_swimlane_name="",
        to_swimlane=swim, to_swimlane_name=swim.name,
        moved_by=user,
    )
    if days_ago:
        backdated = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=backdated)
        mv.refresh_from_db()
    return mv


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

    def test_unassigned_card_with_deleted_creator_reports_null(self):
        """#1172: assignee/created_by are nullable FKs (unassigned cards are the
        common case; created_by is SET_NULL on user deletion) — the response
        must actually send null for both rather than omitting or erroring."""
        card = _make_card(self.board, self.col, self.swim, self.user, assignee=None)
        card.created_by = None
        card.save(update_fields=["created_by"])
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        row = next(row for row in r.data["results"] if row["id"] == card.id)
        self.assertIsNone(row["assignee"])
        self.assertIsNone(row["created_by"])


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


class CardQueryFilterOverflowTests(TestCase):
    """An id filter value outside the 64-bit integer range must 400, never 500 (#1120).

    ``board``/``swimlane``/``column``/``assignee``/``label`` are
    ``BoundedIdFilter``s (``boards/views/_helpers.py``) rather than bare
    ``django_filters.NumberFilter``s — the default only bounds to 1e50, which
    is far looser than what the DB driver can actually bind (SQLite/Postgres
    are both 64-bit), so an out-of-range value used to reach the DB layer and
    raise an uncaught ``OverflowError``. Found by `backend-schema-fuzz`'s
    negative-data fuzzing.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="u", password="x")
        self.board, self.col, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_huge_positive_column_value_400s(self):
        r = self.client.get(URL, {"column": "1.0268205282963762e+34"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_huge_negative_board_value_400s(self):
        r = self.client.get(URL, {"board": "-1.7976931348623157e+308"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_in_range_value_still_works(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Card")
        r = self.client.get(URL, {"column": self.col.id})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual([c["title"] for c in r.data["results"]], ["Card"])

    def test_updated_since_out_of_range_utc_offset_400s(self):
        # Postgres rejects a >=16h offset with DataError; SQLite would not, so
        # this asserts the filter-level validation rather than the DB crash.
        r = self.client.get(URL, {"updated_since": "0232-03-12T00:58:04+17:52"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_updated_since_max_valid_utc_offset_still_works(self):
        _make_card(self.board, self.col, self.swim, self.user, title="Card")
        r = self.client.get(URL, {"updated_since": "2000-01-01T00:00:00-15:59"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual([c["title"] for c in r.data["results"]], ["Card"])


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


class CardQueryBlockerCountValueTests(TestCase):
    """`blocker_count` must be correct here, not merely present (#449).

    ``CardQuerySerializerFieldParityTests`` asserts the field *name* is in step
    with CardSerializer. It cannot catch a wiring mistake: this endpoint keeps
    its own queryset, so a lost prefetch or a wrong direction would leave the
    field present and silently always zero, and parity would still pass.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="bc_owner", password="x")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.blocker = _make_card(
            self.board, self.col, self.swim, self.owner, title="Blocker",
        )
        self.blocked = _make_card(
            self.board, self.col, self.swim, self.owner, title="Blocked", position=1,
        )
        CardRelation.objects.create(
            from_card=self.blocker, to_card=self.blocked,
            relation_type=CardRelation.Type.BLOCKS, created_by=self.owner,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _row(self, card):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return next(c for c in r.data["results"] if c["id"] == card.id)

    def test_blocked_card_reports_its_blocker(self):
        self.assertEqual(self._row(self.blocked)["blocker_count"], 1)

    def test_blocking_card_is_not_itself_reported_as_blocked(self):
        self.assertEqual(self._row(self.blocker)["blocker_count"], 0)

    def test_archived_blocker_does_not_count(self):
        self.blocker.archived_at = timezone.now()
        self.blocker.save(update_fields=["archived_at"])
        self.assertEqual(self._row(self.blocked)["blocker_count"], 0)


class CardQueryLastMoveIsCreationValueTests(TestCase):
    """`last_move_is_creation` must be correct here, not merely present (#1576).

    Same reasoning as CardQueryBlockerCountValueTests: parity checks only the
    field name, and this endpoint keeps its own queryset.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="lmc_owner", password="x")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _row(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return next(c for c in r.data["results"] if c["id"] == self.card.id)

    def test_false_when_card_has_no_movements(self):
        self.assertFalse(self._row()["last_move_is_creation"])

    def test_true_when_only_movement_is_creation(self):
        _make_movement(self.card, self.col, self.swim, self.owner)
        self.assertTrue(self._row()["last_move_is_creation"])

    def test_false_after_a_real_move_follows_creation(self):
        _make_movement(self.card, self.col, self.swim, self.owner, days_ago=1)
        CardMovement.objects.create(
            card=self.card,
            from_column=self.col, from_column_name=self.col.name,
            to_column=self.col, to_column_name=self.col.name,
            from_swimlane=self.swim, from_swimlane_name=self.swim.name,
            to_swimlane=self.swim, to_swimlane_name=self.swim.name,
            moved_by=self.owner,
        )
        self.assertFalse(self._row()["last_move_is_creation"])


class CardQuerySchemaTypeTests(TestCase):
    """Guards SerializerMethodField return-type hints against schema drift.

    drf-spectacular infers a method field's OpenAPI type from its Python
    return-type hint and silently falls back to "string" when the hint is
    missing (same class of bug get_last_moved_at's docstring above already
    documents for this file). A missing hint on an int-returning method
    mismatches the real response but breaks nothing any test hitting the live
    endpoint would catch — only the schema-fuzz job's response-vs-schema
    conformance check did (#1120), against blocker_count specifically.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from drf_spectacular.generators import SchemaGenerator
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def test_blocker_count_schema_type_is_integer(self):
        card_query_schema = self.schema["components"]["schemas"]["CardQuery"]
        self.assertEqual(
            card_query_schema["properties"]["blocker_count"]["type"], "integer",
        )


class CardQueryMethodFieldValueTests(TestCase):
    """Value assertions for CardQuerySerializer's other hand-rolled method
    fields (#1249) — CardQueryBlockerCountValueTests above is the pattern:
    CardQuerySerializerFieldParityTests only guards field *names*, so a lost
    prefetch or wrong direction on last_moved_at/attachment_count/
    checklist_total/checklist_done would leave the field present and always
    zero/null while every existing test (which never asserts a real value on
    these) kept passing.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="mf_owner", password="x")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = _make_card(self.board, self.col, self.swim, self.owner, title="Card")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _row(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return next(c for c in r.data["results"] if c["id"] == self.card.id)

    def test_last_moved_at_is_null_with_no_movements(self):
        self.assertIsNone(self._row()["last_moved_at"])

    def test_last_moved_at_reports_most_recent_movement(self):
        _make_movement(self.card, self.col, self.swim, self.owner, days_ago=5)
        newest = _make_movement(self.card, self.col, self.swim, self.owner, days_ago=1)
        row = self._row()
        # r.data holds the pre-render serializer output (real datetime
        # objects), not JSON strings — compare directly against the
        # DB-stored value rather than parsing a rendered string.
        newest.refresh_from_db()
        self.assertEqual(row["last_moved_at"], newest.moved_at)

    def test_attachment_count(self):
        self.assertEqual(self._row()["attachment_count"], 0)
        CardAttachment.objects.create(
            card=self.card, uploaded_by=self.owner,
            filename="a.txt", file="attachments/a.txt", size=1,
        )
        CardAttachment.objects.create(
            card=self.card, uploaded_by=self.owner,
            filename="b.txt", file="attachments/b.txt", size=1,
        )
        self.assertEqual(self._row()["attachment_count"], 2)

    def test_checklist_total_and_done_count_separately(self):
        CardChecklist.objects.create(card=self.card, text="done", is_checked=True, position=0)
        CardChecklist.objects.create(card=self.card, text="done too", is_checked=True, position=1)
        CardChecklist.objects.create(card=self.card, text="not done", is_checked=False, position=2)
        row = self._row()
        self.assertEqual(row["checklist_total"], 3)
        self.assertEqual(row["checklist_done"], 2)

    def test_checklist_done_is_zero_with_no_checked_items(self):
        CardChecklist.objects.create(card=self.card, text="a", is_checked=False, position=0)
        row = self._row()
        self.assertEqual(row["checklist_total"], 1)
        self.assertEqual(row["checklist_done"], 0)


class CardQueryIsStaleCrossBoardThresholdTests(TestCase):
    """get_is_stale() deliberately re-derives staleness in Python per-row
    instead of reusing _annotate_is_stale()'s single SQL-level cutoff,
    specifically because a cross-board page can mix boards with different
    staleness_threshold_days (see the method's own comment in card_query.py).
    That mixed-threshold scenario had zero test coverage anywhere in the repo
    (#1249) — every other is_stale test (test_serializers.py,
    test_query_counts.py) exercises a single board.

    These tests are constructed so that using any ONE shared threshold for
    both cards (whichever board's, or the global default) gets at least one
    of the two rows wrong — see the inline math in each test.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="stale_owner", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _rows(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return {row["id"]: row for row in r.data["results"]}

    def test_is_stale_uses_each_cards_own_board_threshold(self):
        # Board A: threshold=2 days. Board B: threshold=20 days. Both cards'
        # last movement is 5 days ago.
        #   - card_a (threshold 2): 5 >= 2  -> stale (True)
        #   - card_b (threshold 20): 5 < 20 -> NOT stale (False)
        # A single shared threshold gets one of these wrong no matter which
        # board's threshold (or the model default of 7) is used instead:
        #   - shared=2  -> card_b wrongly True
        #   - shared=20 -> card_a wrongly False
        #   - shared=7  -> card_a wrongly False (5 < 7)
        board_a, col_a, swim_a = _make_board(
            self.owner, name="Board A", staleness_threshold_days=2,
        )
        board_b, col_b, swim_b = _make_board(
            self.owner, name="Board B", staleness_threshold_days=20,
        )
        card_a = _make_card(board_a, col_a, swim_a, self.owner, title="Card A")
        card_b = _make_card(board_b, col_b, swim_b, self.owner, title="Card B")
        _make_movement(card_a, col_a, swim_a, self.owner, days_ago=5)
        _make_movement(card_b, col_b, swim_b, self.owner, days_ago=5)

        rows = self._rows()
        self.assertTrue(rows[card_a.id]["is_stale"], "card on the low-threshold board should be stale")
        self.assertFalse(rows[card_b.id]["is_stale"], "card on the high-threshold board should NOT be stale")

    def test_is_stale_uses_each_cards_own_board_threshold_no_movements(self):
        """Same discrimination, but through the no-movements/created_at branch."""
        board_a, col_a, swim_a = _make_board(
            self.owner, name="Board A", staleness_threshold_days=2,
        )
        board_b, col_b, swim_b = _make_board(
            self.owner, name="Board B", staleness_threshold_days=20,
        )
        card_a = _make_card(board_a, col_a, swim_a, self.owner, title="Card A")
        card_b = _make_card(board_b, col_b, swim_b, self.owner, title="Card B")
        old_time = timezone.now() - datetime.timedelta(days=5)
        Card.objects.filter(pk=card_a.pk).update(created_at=old_time)
        Card.objects.filter(pk=card_b.pk).update(created_at=old_time)

        rows = self._rows()
        self.assertTrue(rows[card_a.id]["is_stale"], "card on the low-threshold board should be stale")
        self.assertFalse(rows[card_b.id]["is_stale"], "card on the high-threshold board should NOT be stale")

    def test_is_stale_true_immediately_with_zero_threshold(self):
        """staleness_threshold_days is a PositiveIntegerField (0 is a valid
        value, unlike the other boards in this file which are all >=1) — a
        board that sets it to 0 must treat every card as stale immediately,
        since (now - created_at).days >= 0 is always true. Covers the edge
        the method's own branch logic allows but no test exercised."""
        board, col, swim = _make_board(
            self.owner, name="Board Zero", staleness_threshold_days=0,
        )
        card = _make_card(board, col, swim, self.owner, title="Card Zero")

        rows = self._rows()
        self.assertTrue(rows[card.id]["is_stale"])
