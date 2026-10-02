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

The exception is `CardMutationQueryCountTests` (the write paths, added in
#1107), which uses `measured + 3` instead. Those tests have to catch a
*constant* regression rather than a row-scaling one, and a 2× budget would let
a doubling through — see that class's own docstring.
"""
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User, get_maintenance_state
from boards.models import (
    Board, BoardMembership, Card, CardAttachment, CardChecklist,
    CardMovement, Column, CustomFieldDefinition, Label, Swimlane,
    SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue,
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


def _add_lanes_with_cards_and_values(board, owner, cols, defs, start, count):
    """Add ``count`` swimlanes that each hold cards and custom field values.

    Unlike the empty lanes in ``SwimlaneParkedPrefetchQueryCountTests``, every
    lane here carries one card per column (so per-lane card grouping runs) and
    a value for each of ``defs``. Whether the per-value ``is_admin_only``
    definition lookup is exercised depends on the viewer: only the non-admin
    (public ``SwimlaneSerializer``) tests read it; an admin viewer never does.
    Pass a mix of ``is_admin_only`` True and False in ``defs`` for those (#1335).
    """
    for i in range(start, start + count):
        lane = Swimlane.objects.create(board=board, name=f"Extra {i}", position=i)
        for col in cols:
            Card.objects.create(
                board=board, column=col, swimlane=lane,
                title=f"lane-{i}", created_by=owner, position=0,
            )
        for d in defs:
            SwimlaneCustomFieldValue.objects.create(
                swimlane=lane, field_definition=d, value="v",
            )


def _query_count_and_response(fn):
    """Like ``_query_count`` but also returns the response, so a test can
    assert it is a 200 -- an unauthorized/404 response issues the same few
    queries on every call and would otherwise make an equality check vacuous."""
    with CaptureQueriesContext(connection) as ctx:
        response = fn()
    return len(ctx), response


# ── tests ─────────────────────────────────────────────────────────────────────

class CardListQueryCountTests(TestCase):
    """GET /api/boards/{id}/cards/ must not issue per-card queries."""

    # 6 fixed queries (auth, board, cards+prefetches) × 2 headroom = 12; round up to 14.
    #
    # Was 5 fixed / budget 12 before #449, which added the `active_blockers`
    # prefetch to `_card_queryset()`. That is one more query for the whole
    # page, not one per card — `test_card_list_budget_scales_with_cards` below
    # is what pins the difference, and it is unchanged.
    BUDGET = 14

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

    # 17 measured with one board-level + one swimlane-level custom field
    # definition in the fixture (#1334); 19 gives a little headroom for
    # middleware. Note: get_board_for_user()'s columns / custom_field_definitions /
    # swimlane_custom_field_definitions prefetch does NOT lower this number —
    # for a single-board fetch Django issues exactly one query per relation
    # whether it is prefetched or read lazily off the instance (prefetch only
    # saves queries across N>1 parent rows), and neither relation is read a
    # second time anywhere in this serialization. The budget here cannot
    # detect a regression of that prefetch being removed; BoardForUserPrefetchTests
    # below asserts the prefetch cache directly for that reason.
    BUDGET = 19

    def setUp(self):
        self.user = User.objects.create_user(username="u2", password="x")
        self.board, self.cols, self.lanes = _seed_board(self.user, n_cols=5, n_lanes=5, cards_per_cell=2)
        # One board-level and one swimlane-level custom field definition so
        # the /full/ response actually exercises both relations (#1334).
        CustomFieldDefinition.objects.create(
            board=self.board, name="Priority", field_type="text", position=0,
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text", position=0,
        )
        # #1391: a formatted number definition at each level, so the new
        # number_* columns ride the guarded /full/ response too.
        CustomFieldDefinition.objects.create(
            board=self.board, name="Budget", field_type="number", position=90,
            number_prefix="$", number_decimals=2,
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="ARR", field_type="number", position=90,
            number_prefix="$", number_decimals=2,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_full_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_full()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data["cards"]), 50)
        budget = next(d for d in r.data["custom_field_definitions"] if d["name"] == "Budget")
        self.assertEqual((budget["number_prefix"], budget["number_decimals"]), ("$", 2))
        arr = next(d for d in r.data["swimlane_custom_field_definitions"] if d["name"] == "ARR")
        self.assertEqual((arr["number_prefix"], arr["number_decimals"]), ("$", 2))
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

    def test_full_budget_scales_with_swimlanes(self):
        """Adding more swimlanes must not increase the query count (#1335).

        Viewed as the board admin (``SwimlaneAdminSerializer``). Differs from
        the #1223 test in SwimlaneParkedPrefetchQueryCountTests: the added
        lanes contain cards and carry values, so per-lane card grouping and
        the value prefetch are exercised. The ``is_admin_only`` definition
        lookup is NOT -- admins never read it; see the non-admin viewer
        variant below for that path.
        """
        defs = [
            SwimlaneCustomFieldDefinition.objects.get(board=self.board, name="Owner"),
            SwimlaneCustomFieldDefinition.objects.create(
                board=self.board, name="Public", field_type="text",
                position=1, is_admin_only=False,
            ),
        ]
        _add_lanes_with_cards_and_values(self.board, self.user, self.cols, defs, 5, 3)
        baseline, r1 = _query_count_and_response(self._get_full)

        _add_lanes_with_cards_and_values(self.board, self.user, self.cols, defs, 8, 7)
        more, r2 = _query_count_and_response(self._get_full)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(len(r2.data["swimlanes"]), len(r1.data["swimlanes"]) + 7)
        self.assertEqual(
            baseline, more,
            f"full/ query count grew from {baseline} to {more} when swimlanes "
            "(with cards and admin-only values) were added — per-swimlane "
            "query regression (#1335).",
        )

    def test_full_budget_scales_with_swimlanes_non_admin_viewer(self):
        """Same as above but viewed by a direct board ``viewer``, so the public
        ``SwimlaneSerializer`` path -- which reads each value's definition to
        filter ``is_admin_only`` -- is the one that must stay flat (#1335).
        """
        viewer = User.objects.create_user(username="u2_viewer", password="x")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        client = APIClient()
        client.force_authenticate(viewer)

        def get_full():
            return client.get(f"/api/v1/boards/{self.board.id}/full/")

        admin_def = SwimlaneCustomFieldDefinition.objects.get(board=self.board, name="Owner")
        public_def = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Public", field_type="text",
            position=1, is_admin_only=False,
        )
        defs = [admin_def, public_def]
        _add_lanes_with_cards_and_values(self.board, self.user, self.cols, defs, 5, 3)
        baseline, r1 = _query_count_and_response(get_full)

        _add_lanes_with_cards_and_values(self.board, self.user, self.cols, defs, 8, 7)
        more, r2 = _query_count_and_response(get_full)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(len(r2.data["swimlanes"]), len(r1.data["swimlanes"]) + 7)
        # Prove the non-admin path was taken: no admin-only values leak.
        seen = [
            v["field_definition"]
            for lane in r2.data["swimlanes"] for v in lane["custom_field_values"]
        ]
        self.assertTrue(seen)
        self.assertNotIn(admin_def.id, seen)
        self.assertIn(public_def.id, seen)
        self.assertEqual(
            baseline, more,
            f"full/ (non-admin viewer) query count grew from {baseline} to "
            f"{more} when swimlanes were added — per-swimlane query "
            "regression (#1335).",
        )


class BoardFullGroupInheritedQueryCountTests(TestCase):
    """GET /api/boards/{id}/full/ must not issue per-card queries even when
    the board belongs to a group with inherited memberships.

    This catches the N+1 in CardSerializer.__init__ where
    _get_effective_member_ids() was called once per card instance, each
    triggering 2-8 DB queries to walk the group ancestor chain (#490).
    """

    # 21 measured with one board-level + one swimlane-level custom field
    # definition in the fixture (#1334); 23 is generous headroom for
    # middleware and the group-inherited membership walk.
    BUDGET = 23

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
        # One board-level and one swimlane-level custom field definition —
        # same reasoning as BoardFullQueryCountTests above (#1334).
        CustomFieldDefinition.objects.create(
            board=self.board, name="Priority", field_type="text", position=0,
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text", position=0,
        )
        # #1391: a formatted number definition at each level, so the new
        # number_* columns ride the guarded /full/ response too.
        CustomFieldDefinition.objects.create(
            board=self.board, name="Budget", field_type="number", position=90,
            number_prefix="$", number_decimals=2,
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="ARR", field_type="number", position=90,
            number_prefix="$", number_decimals=2,
        )

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

    def _swimlane_defs(self):
        return [
            SwimlaneCustomFieldDefinition.objects.get(board=self.board, name="Owner"),
            SwimlaneCustomFieldDefinition.objects.create(
                board=self.board, name="Public", field_type="text",
                position=1, is_admin_only=False,
            ),
        ]

    def test_full_with_group_budget_scales_with_swimlanes(self):
        """Adding more swimlanes must not increase the query count (#1335).

        Group-inherited twin of ``BoardFullQueryCountTests``, viewed as the
        board admin (``SwimlaneAdminSerializer`` path). Lanes hold cards and
        values, unlike the empty lanes in the #1223 test, but the
        ``is_admin_only`` lookup is not exercised here -- see the non-admin
        viewer variant below.
        """
        defs = self._swimlane_defs()
        _add_lanes_with_cards_and_values(self.board, self.owner, self.cols, defs, 3, 3)
        baseline, r1 = _query_count_and_response(self._get_full)

        _add_lanes_with_cards_and_values(self.board, self.owner, self.cols, defs, 6, 7)
        more, r2 = _query_count_and_response(self._get_full)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(len(r2.data["swimlanes"]), len(r1.data["swimlanes"]) + 7)
        self.assertEqual(
            baseline, more,
            f"full/ (group board) query count grew from {baseline} to {more} "
            "when swimlanes (with cards and admin-only values) were added — "
            "per-swimlane query regression (#1335).",
        )

    def test_full_with_group_budget_scales_with_swimlanes_non_admin_viewer(self):
        """Same as above but viewed by a non-admin group-inherited member
        (``group_user1``, parent-group ``member``, no direct board membership),
        so the public ``SwimlaneSerializer`` path -- which filters
        ``is_admin_only`` values per row -- is the one that must stay flat (#1335).
        """
        client = APIClient()
        client.force_authenticate(self.group_user1)

        def get_full():
            return client.get(f"/api/v1/boards/{self.board.id}/full/")

        defs = self._swimlane_defs()
        admin_def = defs[0]
        _add_lanes_with_cards_and_values(self.board, self.owner, self.cols, defs, 3, 3)
        baseline, r1 = _query_count_and_response(get_full)

        _add_lanes_with_cards_and_values(self.board, self.owner, self.cols, defs, 6, 7)
        more, r2 = _query_count_and_response(get_full)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(len(r2.data["swimlanes"]), len(r1.data["swimlanes"]) + 7)
        # Prove the non-admin path was taken: lanes carry values, but none
        # for the admin-only definition; the public one is still present.
        seen = [
            v["field_definition"]
            for lane in r2.data["swimlanes"] for v in lane["custom_field_values"]
        ]
        self.assertTrue(seen)
        self.assertNotIn(admin_def.id, seen)
        self.assertIn(defs[1].id, seen)
        self.assertEqual(
            baseline, more,
            f"full/ (group board, non-admin viewer) query count grew from "
            f"{baseline} to {more} when swimlanes were added — per-swimlane "
            "query regression (#1335).",
        )


class BoardForUserPrefetchTests(TestCase):
    """get_board_for_user() must prefetch custom_field_definitions and
    swimlane_custom_field_definitions for the /full/ load, and must NOT
    prefetch them for any other caller (#1334).

    A query-count budget on /full/ cannot catch a regression of this specific
    prefetch: get_board_for_user() always returns exactly one board, and
    Django issues exactly one query per relation whether it is prefetched or
    read lazily off a single instance — the prefetch's savings only appear
    across N>1 parent rows. Assert directly on
    ``board._prefetched_objects_cache`` instead, which is what actually
    distinguishes "prefetched" from "will issue a live query on first
    access" for both relations.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="pf_user", password="x")
        self.board = _make_board(self.user)
        CustomFieldDefinition.objects.create(
            board=self.board, name="Priority", field_type="text", position=0,
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Owner", field_type="text", position=0,
        )

    def test_full_load_prefetches_both_definition_relations(self):
        from boards.views._helpers import get_board_for_user

        board, _role = get_board_for_user(
            self.board.id, self.user, with_archived_card_count=True,
        )
        cache = getattr(board, "_prefetched_objects_cache", {})
        self.assertIn(
            "custom_field_definitions", cache,
            "get_board_for_user(with_archived_card_count=True) no longer "
            "prefetches custom_field_definitions — BoardFullSerializer would "
            "fall back to a live query on every /full/ request (#1334).",
        )
        self.assertIn(
            "swimlane_custom_field_definitions", cache,
            "get_board_for_user(with_archived_card_count=True) no longer "
            "prefetches swimlane_custom_field_definitions (#1334).",
        )

    def test_full_load_prefetches_columns(self):
        from boards.views._helpers import get_board_for_user

        Column.objects.create(board=self.board, name="Todo", position=0)
        board, _role = get_board_for_user(
            self.board.id, self.user, with_archived_card_count=True,
        )
        cache = getattr(board, "_prefetched_objects_cache", {})
        self.assertIn(
            "columns", cache,
            "get_board_for_user(with_archived_card_count=True) no longer "
            "prefetches columns — BoardFullSerializer would fall back to a "
            "live query on every /full/ request (#1351).",
        )

    def test_non_full_caller_does_not_pay_for_the_prefetch(self):
        """The many RBAC-only callers (cards/columns/swimlanes/labels/
        custom-fields views) pass no with_archived_card_count kwarg and must
        not acquire these two prefetches — they never serialize either
        relation, so the extra queries would be pure waste (#1334)."""
        from boards.views._helpers import get_board_for_user

        board, _role = get_board_for_user(self.board.id, self.user)
        cache = getattr(board, "_prefetched_objects_cache", {})
        self.assertNotIn("custom_field_definitions", cache)
        self.assertNotIn("swimlane_custom_field_definitions", cache)
        self.assertNotIn("columns", cache)


class BoardFullColdCacheAncestorTests(TestCase):
    """BoardFullSerializer.get_members() must not issue per-level FK queries
    when the board's group ancestor chain was not pre-loaded via select_related.

    The guard in get_members() detects an unloaded parent FK and re-fetches
    the full chain in a single query before starting the traversal (#650).
    """

    def setUp(self):
        from groups.models import Group, GroupMembership

        self.owner = User.objects.create_user(username="cold_owner", password="x")
        # Three-level hierarchy — deep enough to show the N+1 if unguarded.
        self.grandparent = Group.objects.create(name="GrandParent", owner=self.owner)
        self.parent = Group.objects.create(name="Parent", owner=self.owner, parent=self.grandparent)
        self.child = Group.objects.create(name="Child", owner=self.owner, parent=self.parent)
        GroupMembership.objects.create(group=self.grandparent, user=self.owner, role="admin")

        # Fetch the board without the ancestor chain (cold-cache scenario).
        self.board = Board.objects.create(name="ColdBoard", owner=self.owner, group=self.child)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_full_endpoint_works_with_cold_cache_ancestor(self):
        """full/ must return 200 even when the board was fetched without ancestor chain."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, 200)
        members = r.data["members"]
        # Owner must appear in the member list.
        owner_ids = [m["user"]["id"] for m in members]
        self.assertIn(self.owner.id, owner_ids)


class ParkedPrefetchQueryCountTests(TestCase):
    """The ``to_attr``-parked card prefetches must stay query-free (#1212, labels #1223).

    ``_card_queryset`` (and ``PublicBoardSerializer.get_cards``) park
    attachments, checklist items, movements, custom field values, and (since
    #1223) labels on plain list attributes. Any reader that goes back to
    ``card.<relation>.all()`` misses that list and issues one query **per
    card** — so every read path that serializes those relations is checked
    here with cards that actually carry every relation, and grown with cards
    that carry them too (the ``*_budget_scales_with_cards`` tests above add
    bare cards).

    ``FULL_QUERIES`` is the exact count measured on ``/full/`` for this fixture
    (SQLite, force-authenticated) both before and after the #1212 conversion —
    the change must not add a query. It is lower than the 19 the load test
    reports on Postgres with PAT auth because this fixture has no swimlane
    custom fields and skips token lookup. If a legitimate new feature adds a
    query, raise it deliberately with a note.
    """

    FULL_QUERIES = 17

    def setUp(self):
        from boards.models import CustomFieldDefinition

        self.user = User.objects.create_user(username="parked", password="x")
        self.board, self.cols, self.lanes = _seed_board(
            self.user, n_cols=3, n_lanes=2, cards_per_cell=2,
        )
        # _seed_board() already puts this label on every card it creates
        # (#1223's labels coverage rides on that, same as attachments/
        # checklist/movements above).
        self.label = Label.objects.get(board=self.board)
        self.defs = [
            CustomFieldDefinition.objects.create(
                board=self.board, name=f"F{i}", field_type="text", position=i,
            )
            for i in range(2)
        ]
        for card in Card.objects.filter(board=self.board):
            self._add_custom_values(card)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.share_token = self.client.post(
            f"/api/v1/boards/{self.board.id}/share/"
        ).data["share_token"]

    def _add_custom_values(self, card):
        from boards.models import CustomFieldValue

        for d in self.defs:
            CustomFieldValue.objects.create(card=card, field_definition=d, value="v")

    def _add_rich_cards(self):
        """One more card per cell, each carrying every parked relation."""
        for col in self.cols:
            for lane in self.lanes:
                card = Card.objects.create(
                    board=self.board, column=col, swimlane=lane,
                    title="rich", created_by=self.user, position=99,
                )
                CardMovement.objects.create(
                    card=card,
                    to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                    to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
                    from_column=None, from_column_name="", from_column_uid="",
                    from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                    moved_by=self.user,
                )
                CardAttachment.objects.create(
                    card=card, uploaded_by=self.user,
                    filename="g.txt", file="attachments/g.txt", size=1,
                )
                CardChecklist.objects.create(card=card, text="x", is_checked=True, position=0)
                card.labels.add(self.label)
                self._add_custom_values(card)

    def _assert_constant(self, fn, label):
        before = _query_count(fn)
        self._add_rich_cards()
        after = _query_count(fn)
        self.assertEqual(
            before, after,
            f"{label} query count grew from {before} to {after} when cards with "
            "attachments/checklist/movements/custom fields/labels were added — "
            "a reader is bypassing the to_attr-parked prefetch (#1212, #1223).",
        )

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_full_query_count_not_increased(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_full()
        self.assertEqual(r.status_code, 200)
        card = r.data["cards"][0]
        # The fixture really exercises every parked relation.
        self.assertEqual(card["attachment_count"], 1)
        self.assertEqual((card["checklist_total"], card["checklist_done"]), (2, 1))
        self.assertIsNotNone(card["last_moved_at"])
        self.assertEqual(len(card["custom_field_values"]), 2)
        self.assertEqual([lb["id"] for lb in card["labels"]], [self.label.id])
        self.assertLessEqual(
            len(ctx), self.FULL_QUERIES,
            f"full/ used {len(ctx)} queries — expected at most {self.FULL_QUERIES}.",
        )

    def test_full_constant_across_rich_cards(self):
        self._assert_constant(self._get_full, "full/")

    def test_card_list_constant_across_rich_cards(self):
        self._assert_constant(
            lambda: self.client.get(f"/api/v1/boards/{self.board.id}/cards/"), "cards/",
        )

    def test_card_query_constant_across_rich_cards(self):
        # CardQuerySerializer reads the parked lists through the same accessors
        # and ParkedCustomFieldValueListSerializer.
        self._assert_constant(
            lambda: self.client.get("/api/v1/cards/", {"board": self.board.id}),
            "cards query",
        )

    def test_public_board_constant_across_rich_cards(self):
        anon = APIClient()
        self._assert_constant(
            lambda: anon.get(f"/api/share/{self.share_token}/"), "public share",
        )

    # The constant-count tests above prove the conversion did not *regress*
    # anything, but they stay green if the to_attr= kwargs are removed: the
    # accessors' manager fallback still reads a plain prefetch cache, correctly
    # and query-free, just with the per-call queryset clone #1212 removed. These
    # two pin that the optimization is actually applied. (Asserting on CPU time
    # instead would be flaky.)

    PARKED_ATTRS = (
        "_prefetched_attachments",
        "_prefetched_checklist_items",
        "_prefetched_movements",
        "_prefetched_custom_field_values",
        "_prefetched_labels",
    )

    def test_card_queryset_parks_relations_on_plain_lists(self):
        from boards.serializers import _card_queryset

        cards = list(_card_queryset(Card.objects.filter(board=self.board)))
        self.assertTrue(cards)
        for card in cards:
            for attr in self.PARKED_ATTRS:
                self.assertIsInstance(
                    card.__dict__.get(attr), list,
                    f"_card_queryset() no longer parks {attr} with to_attr — "
                    "readers fall back to the manager's per-call queryset "
                    "clone that #1212 removed from /full/.",
                )

    def test_public_get_cards_parks_relations_on_plain_lists(self):
        from boards import serializers as board_serializers

        captured = {}
        real = board_serializers.PublicCardSerializer

        def spy(qs, *args, **kwargs):
            captured["cards"] = list(qs)
            return real(captured["cards"], *args, **kwargs)

        with patch.object(board_serializers, "PublicCardSerializer", side_effect=spy):
            board_serializers.PublicBoardSerializer(self.board).data
        self.assertTrue(captured["cards"])
        for card in captured["cards"]:
            # The public payload reads only checklist items and movements.
            for attr in ("_prefetched_checklist_items", "_prefetched_movements"):
                self.assertIsInstance(
                    card.__dict__.get(attr), list,
                    f"PublicBoardSerializer.get_cards() no longer parks {attr} "
                    "with to_attr (#1212).",
                )

    def test_serializer_cold_path_falls_back_to_manager(self):
        """A card not built via ``_card_queryset`` has no parked lists; the
        accessors must fall back to the manager rather than raise or render
        empty values."""
        from boards.serializers import CardSerializer

        card = Card.objects.filter(board=self.board).first()
        data = CardSerializer(card, context={"board": self.board}).data
        self.assertEqual(data["attachment_count"], 1)
        self.assertEqual((data["checklist_total"], data["checklist_done"]), (2, 1))
        self.assertIsNotNone(data["last_moved_at"])
        self.assertEqual(
            [v["field_definition"] for v in data["custom_field_values"]],
            [d.id for d in self.defs],
        )
        self.assertEqual([lb["id"] for lb in data["labels"]], [self.label.id])

    def test_update_does_not_leave_a_stale_parked_labels_list(self):
        """A card read through ``_card_queryset`` (so it carries a parked
        labels list), then updated in place via the serializer, must not go
        on serving the pre-write list (#1223) — the same failure class
        ``CardSerializer._apply_custom_field_values`` guards against for
        custom field rows (#1212). In production every mutation response is
        re-fetched fresh through ``_refetch_card_data`` regardless, so this
        would not surface as a visible bug today, but it is exactly the trap
        the accessor pattern invites for the next caller that reads the same
        instance twice.
        """
        from boards.serializers import CardSerializer, _card_labels, _card_queryset

        new_label = Label.objects.create(board=self.board, name="New", color="#0F0")
        card = _card_queryset(Card.objects.filter(board=self.board)).first()
        # Sanity: the queryset really did park the pre-write labels.
        self.assertEqual([lb.id for lb in _card_labels(card)], [self.label.id])

        serializer = CardSerializer(
            card, data={"label_ids": [new_label.id]}, partial=True,
            context={"board": self.board},
        )
        self.assertTrue(serializer.is_valid(), serializer.errors)
        serializer.save()

        self.assertEqual([lb.id for lb in _card_labels(card)], [new_label.id])


class SwimlaneParkedPrefetchQueryCountTests(TestCase):
    """The ``to_attr``-parked swimlane custom field value prefetch must stay
    query-free (#1223, the swimlane twin of ``ParkedPrefetchQueryCountTests``
    above, #1212).

    ``_swimlane_custom_field_prefetch()`` (shared by ``BoardFullSerializer.
    get_swimlanes``, ``SwimlaneViewSet``, and the board export) parks each
    swimlane's row-field values on a plain list attribute. Any reader that
    goes back to ``swimlane.custom_field_values.all()`` misses that list and
    issues one query **per swimlane**.
    """

    def setUp(self):
        from boards.models import SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue

        self.SwimlaneCustomFieldValue = SwimlaneCustomFieldValue
        self.user = User.objects.create_user(username="swparked", password="x")
        self.board, self.cols, self.lanes = _seed_board(
            self.user, n_cols=2, n_lanes=3, cards_per_cell=1,
        )
        self.defs = [
            SwimlaneCustomFieldDefinition.objects.create(
                board=self.board, name=f"R{i}", field_type="text", position=i,
            )
            for i in range(2)
        ]
        for lane in self.lanes:
            for d in self.defs:
                SwimlaneCustomFieldValue.objects.create(
                    swimlane=lane, field_definition=d, value="v",
                )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_full_query_count_constant_across_more_swimlanes(self):
        """Adding swimlanes with row-field values must not add queries."""
        before = _query_count(self._get_full)
        for i in range(3):
            lane = Swimlane.objects.create(board=self.board, name=f"extra{i}", position=100 + i)
            for d in self.defs:
                self.SwimlaneCustomFieldValue.objects.create(
                    swimlane=lane, field_definition=d, value="v",
                )
        after = _query_count(self._get_full)
        self.assertEqual(
            before, after,
            f"full/ query count grew from {before} to {after} when swimlanes with "
            "row-field values were added — a reader is bypassing the "
            "to_attr-parked swimlane custom field prefetch (#1223).",
        )

    def test_full_response_carries_every_swimlane_value(self):
        r = self._get_full()
        self.assertEqual(r.status_code, 200)
        lane = r.data["swimlanes"][0]
        self.assertEqual(len(lane["custom_field_values"]), 2)

    def test_swimlane_queryset_parks_values_on_plain_list(self):
        from boards.serializers import _swimlane_custom_field_prefetch

        lanes = list(
            Swimlane.objects.filter(board=self.board)
            .prefetch_related(_swimlane_custom_field_prefetch())
        )
        self.assertTrue(lanes)
        for lane in lanes:
            self.assertIsInstance(
                lane.__dict__.get("_prefetched_swimlane_custom_field_values"), list,
                "_swimlane_custom_field_prefetch() no longer parks values with "
                "to_attr — readers fall back to the manager's per-call queryset "
                "clone (#1223).",
            )

    def test_swimlane_serializer_cold_path_falls_back_to_manager(self):
        """A swimlane not read through ``_swimlane_custom_field_prefetch()``
        has no parked list; the field must fall back to the manager rather
        than raise or render an empty list.

        ``SwimlaneAdminSerializer`` (not the public ``SwimlaneSerializer``)
        because the fixture's definitions default to ``is_admin_only=True``,
        which the public serializer filters out regardless of prefetch state.
        """
        from boards.serializers import SwimlaneAdminSerializer

        lane = Swimlane.objects.filter(board=self.board).first()
        data = SwimlaneAdminSerializer(lane).data
        self.assertEqual(len(data["custom_field_values"]), 2)


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


class IsStaleAnnotationQueryCountTests(TestCase):
    """GET /api/boards/{id}/full/ must not call timezone.now() per card.

    is_stale is annotated at the queryset level by _card_queryset(stale_cutoff=...)
    so get_is_stale() reads a pre-computed boolean rather than re-computing the
    cutoff and accessing obj.movements per row (#669).  This test verifies that
    the full/ query count does not grow when is_stale-affecting cards are added.
    """

    BUDGET = 20

    def setUp(self):
        self.user = User.objects.create_user(username="u_stale", password="x")
        self.board, self.cols, self.lanes = _seed_board(self.user, n_cols=3, n_lanes=3, cards_per_cell=2)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_full(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/full/")

    def test_is_stale_annotation_within_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_full()
        self.assertEqual(r.status_code, 200)
        cards = r.data["cards"]
        self.assertGreater(len(cards), 0)
        # All cards must have an is_stale field
        for card in cards:
            self.assertIn("is_stale", card)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"full/ with stale annotation used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_is_stale_query_count_constant_across_card_count(self):
        """Adding cards must not increase the query count (#669 regression guard)."""
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
            f"full/ query count grew from {baseline} to {doubled} — is_stale "
            "annotation is not being used (per-card timezone.now() regression).",
        )


class BoardMutationAnnotationTests(TestCase):
    """Mutation responses (PATCH, share, move_group) must include annotated fields.

    Re-fetching through get_queryset() ensures member_count, card_count, and
    is_starred come from annotations rather than per-field subqueries (#647).
    """

    def setUp(self):
        self.user = User.objects.create_user(username="u_mutation", password="x")
        self.board = Board.objects.create(name="Mut Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_patch_board_response_includes_member_count(self):
        """PATCH /boards/{id}/ response must include member_count."""
        from unittest.mock import patch as _patch
        with _patch("boards.broadcast.broadcast_board_event"):
            r = self.client.patch(
                f"/api/v1/boards/{self.board.id}/",
                {"name": "Renamed"},
                format="json",
            )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("member_count", data)
        self.assertIn("card_count", data)
        self.assertIn("is_starred", data)

    def test_move_group_response_includes_member_count(self):
        """POST /boards/{id}/move-group/ response must include member_count."""
        from unittest.mock import patch as _patch
        with _patch("boards.broadcast.broadcast_board_event"):
            r = self.client.post(
                f"/api/v1/boards/{self.board.id}/move-group/",
                {"group_id": None},
                format="json",
            )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("member_count", data)


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


class MovementsEndpointQueryCountTests(TestCase):
    """GET /api/boards/{id}/movements/ must collapse count + page into one
    query via Window(Count("id")) annotation (#798)."""

    def setUp(self):
        self.user = User.objects.create_user(username="mv_u", password="x")
        self.board, self.cols, self.lanes = _seed_board(
            self.user, n_cols=2, n_lanes=2, cards_per_cell=1
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_movements(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/movements/")

    def test_movements_count_does_not_grow_with_history(self):
        """Adding more movements must not change the query count: the Window
        annotation pulls the total from the page query itself."""
        baseline = _query_count(self._get_movements)

        # Add many more movements. With the old `count() + page` pattern the
        # count remains constant too — but if anyone reverts to per-row
        # COUNT() subqueries this guard will fire.
        col = self.cols[0]
        lane = self.lanes[0]
        card = Card.objects.filter(board=self.board).first()
        for _ in range(20):
            CardMovement.objects.create(
                card=card,
                to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
                from_column=None, from_column_name="", from_column_uid="",
                from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                moved_by=self.user,
            )

        scaled = _query_count(self._get_movements)
        self.assertEqual(
            baseline, scaled,
            f"movements/ query count grew from {baseline} to {scaled} when "
            "movements were added — N+1 regression detected.",
        )

    def test_movements_response_count_matches_total(self):
        """The Window-annotated total must equal the actual row count."""
        # Seeded board already has movements (one per card).
        resp = self._get_movements()
        self.assertEqual(resp.status_code, 200)
        actual_total = CardMovement.objects.filter(card__board=self.board).count()
        self.assertEqual(resp.data["count"], actual_total)


class AnalyticsQueryCountTests(TestCase):
    """GET /api/boards/{id}/analytics/ must not issue per-swimlane or per-card queries.

    The analytics endpoint uses SQL-level annotations and a single scoped
    movement prefetch, so query count must stay flat regardless of how many
    swimlanes or cards are on the board.
    """

    BUDGET = 15  # ~7 measured; 15 gives headroom for middleware

    def setUp(self):
        self.user = User.objects.create_user(username="an_u", password="x")
        self.board, self.cols, self.lanes = _seed_board(
            self.user, n_cols=3, n_lanes=3, cards_per_cell=2
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_analytics(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/analytics/")

    def test_analytics_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_analytics()
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(
            len(ctx),
            self.BUDGET,
            f"analytics/ issued {len(ctx)} queries, budget is {self.BUDGET}. "
            "A per-swimlane or per-card query was introduced — fix the annotation.",
        )

    def test_analytics_query_count_does_not_grow_with_swimlanes(self):
        """Adding more swimlanes must not change the query count."""
        baseline = _query_count(self._get_analytics)

        for i in range(5):
            Swimlane.objects.create(board=self.board, name=f"Extra{i}", position=100 + i)

        scaled = _query_count(self._get_analytics)
        self.assertEqual(
            baseline, scaled,
            f"analytics/ query count grew from {baseline} to {scaled} when "
            "swimlanes were added — per-swimlane N+1 regression detected.",
        )

    def test_analytics_query_count_does_not_grow_with_cards(self):
        """Adding more cards must not change the query count (#930).

        Mirrors ``test_analytics_query_count_does_not_grow_with_swimlanes`` on
        the card axis so a future regression — e.g. an unguarded
        ``SerializerMethodField`` iterating over movements per card — is
        caught here rather than only in production.  The endpoint relies on
        SQL-level aggregates over cards, so adding rows must not introduce
        any per-row queries.
        """
        baseline = _query_count(self._get_analytics)

        # Add 20 extra cards spread across existing (column, swimlane) cells
        # so the new rows participate in the same aggregations as the seed
        # cards.  Each gets a movement so the velocity / dwell calculations
        # must process them.
        col = self.cols[0]
        lane = self.lanes[0]
        for i in range(20):
            card = Card.objects.create(
                board=self.board, column=col, swimlane=lane,
                title=f"ExtraCard{i}", created_by=self.user, position=100 + i,
            )
            CardMovement.objects.create(
                card=card,
                to_column=col, to_column_name=col.name, to_column_uid=col.uid,
                to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
                from_column=None, from_column_name="", from_column_uid="",
                from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
                moved_by=self.user,
            )

        scaled = _query_count(self._get_analytics)
        self.assertEqual(
            baseline, scaled,
            f"analytics/ query count grew from {baseline} to {scaled} when "
            "cards were added — per-card N+1 regression detected.",
        )


# ---------------------------------------------------------------------------
# Archived cards endpoint scale test (#997)
# ---------------------------------------------------------------------------
from boards.models import Notification  # noqa: E402  -- below the fixtures intentionally


class ArchivedCardsQueryCountTests(TestCase):
    """GET /api/boards/{id}/cards/archived/ must not issue per-card queries."""

    BUDGET = 14  # Mirrors CardListQueryCountTests.BUDGET plus headroom for the archived flag.

    def setUp(self):
        self.user = User.objects.create_user(username="u_arch", password="x")
        self.board, self.cols, self.lanes = _seed_board(self.user, n_cols=3, n_lanes=3, cards_per_cell=1)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        # Archive every seeded card so the endpoint has rows to return.
        from django.utils import timezone
        Card.objects.filter(board=self.board).update(archived_at=timezone.now())

    def _get_archived(self):
        return self.client.get(f"/api/v1/boards/{self.board.id}/cards/archived/")

    def test_archived_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_archived()
        self.assertEqual(r.status_code, 200)
        self.assertGreater(len(r.data["results"]) if isinstance(r.data, dict) else len(r.data), 0)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"cards/archived/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "An N+1 was introduced; fix the prefetch.",
        )

    def test_archived_query_count_constant_across_card_count(self):
        """Adding more archived cards must not increase the query count."""
        baseline = _query_count(self._get_archived)

        # Double the archived card count.
        from django.utils import timezone
        col = self.cols[0]
        lane = self.lanes[0]
        for i in range(20):
            card = Card.objects.create(
                board=self.board, column=col, swimlane=lane,
                title=f"ExtraArch{i}", created_by=self.user, position=100 + i,
                archived_at=timezone.now(),
            )
            card.labels.add(Label.objects.filter(board=self.board).first())

        scaled = _query_count(self._get_archived)
        self.assertEqual(
            baseline, scaled,
            f"cards/archived/ query count grew from {baseline} to {scaled} when "
            "cards were added — per-card N+1 regression detected.",
        )


# ---------------------------------------------------------------------------
# Notification list endpoint scale test (#997)
# ---------------------------------------------------------------------------


class NotificationListQueryCountTests(TestCase):
    """GET /api/v1/notifications/ must scale O(unique boards), not O(notifications)."""

    BUDGET = 12

    def setUp(self):
        self.user = User.objects.create_user(username="u_notif", password="x")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        # Seed a card so notifications can reference it.
        col = Column.objects.create(board=self.board, name="C", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="C", created_by=self.user, position=0,
        )

    def _get_notifications(self):
        return self.client.get("/api/v1/notifications/")

    def _make_notifications(self, n):
        Notification.objects.bulk_create([
            Notification(
                recipient=self.user,
                actor=self.user,
                action_type=Notification.ActionType.CARD_MOVED,
                verb=f"moved card {i}",
                card=self.card,
                board=self.board,
                read=False,
            )
            for i in range(n)
        ])

    def test_notifications_within_query_budget(self):
        self._make_notifications(10)
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_notifications()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data), 10)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"notifications/ used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_notifications_query_count_constant_across_count(self):
        """Adding notifications for the same board must not grow the query count."""
        self._make_notifications(5)
        baseline = _query_count(self._get_notifications)
        self._make_notifications(20)
        scaled = _query_count(self._get_notifications)
        self.assertEqual(
            baseline, scaled,
            f"notifications/ query count grew from {baseline} to {scaled} as the "
            "notification count grew — regression vs O(unique boards) target.",
        )


# ---------------------------------------------------------------------------
# Notification unread-count endpoint scale test (#1015)
# ---------------------------------------------------------------------------


class ChecklistEndpointQueryCountTests(TestCase):
    """GET /api/boards/{id}/cards/{id}/checklist/ must not issue per-item queries.

    CardChecklistSerializer nests ``created_by`` (a user serializer), so the
    checklist_items prefetch must carry select_related("created_by") or each
    item resolves its creator with a separate query.
    """

    BUDGET = 8  # auth + board + card + checklist prefetch, × headroom

    def setUp(self):
        self.user = User.objects.create_user(username="u_checklist", password="x")
        self.board = _make_board(self.user)
        col = Column.objects.create(board=self.board, name="C", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane,
            title="Card", created_by=self.user, position=0,
        )
        for i in range(3):
            CardChecklist.objects.create(
                card=self.card, text=f"item {i}", is_checked=False,
                position=i, created_by=self.user,
            )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _get_checklist(self):
        return self.client.get(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/"
        )

    def test_checklist_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_checklist()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data), 3)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"checklist/ used {len(ctx)} queries — budget is {self.BUDGET}. "
            "An N+1 on created_by was introduced; fix the prefetch.",
        )

    def test_checklist_query_count_constant_across_item_count(self):
        """Adding checklist items must not increase the query count."""
        baseline = _query_count(self._get_checklist)
        for i in range(3, 23):
            CardChecklist.objects.create(
                card=self.card, text=f"item {i}", is_checked=False,
                position=i, created_by=self.user,
            )
        scaled = _query_count(self._get_checklist)
        self.assertEqual(
            baseline, scaled,
            f"checklist/ query count grew from {baseline} to {scaled} when items "
            "were added — per-item created_by N+1 regression detected.",
        )


class NotificationUnreadCountQueryCountTests(TestCase):
    """GET /api/notifications/unread-count/ must not issue per-board queries (#1015)."""

    BUDGET = 10

    def setUp(self):
        self.user = User.objects.create_user(username="u_notif_uc", password="x")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        col = Column.objects.create(board=self.board, name="C", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="C", created_by=self.user, position=0,
        )

    def _get_unread_count(self):
        return self.client.get("/api/v1/notifications/unread-count/")

    def _make_notifications(self, n):
        Notification.objects.bulk_create([
            Notification(
                recipient=self.user,
                actor=self.user,
                action_type=Notification.ActionType.CARD_MOVED,
                verb=f"moved card {i}",
                card=self.card,
                board=self.board,
                read=False,
            )
            for i in range(n)
        ])

    def test_unread_count_within_query_budget(self):
        self._make_notifications(10)
        with CaptureQueriesContext(connection) as ctx:
            r = self._get_unread_count()
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"notifications/unread-count/ used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_unread_count_query_count_constant_across_notification_count(self):
        """Adding unread notifications must not grow the unread-count query count (#1015)."""
        self._make_notifications(5)
        baseline = _query_count(self._get_unread_count)
        self._make_notifications(20)
        scaled = _query_count(self._get_unread_count)
        self.assertEqual(
            baseline, scaled,
            f"notifications/unread-count/ query count grew from {baseline} to {scaled} — "
            "regression vs constant target (#1015).",
        )


class CardMutationQueryCountTests(TestCase):
    """Query budgets for the card *write* paths (#1107).

    Every other class in this file budgets a read endpoint. Before #1107 no
    mutation path had a budget at all, which made that issue's "query-count
    guards on move/update do not regress" criterion unverifiable — there was
    nothing to regress against.

    These budgets are deliberately tighter than the 2x convention used for the
    read endpoints above. A read budget only has to catch an N+1 that scales
    with row count; these have to catch a *constant* regression — one extra
    `get_board_role()` walk, one re-serialization of the response payload, one
    lost prefetch — introduced while relocating the invariants into
    `boards.services.cards`. A doubling would sail through a 2x budget.

    Each budget is `measured + 3`. If a legitimate change moves one of these,
    re-measure and move the number in the same commit, with the reason — do
    not widen it to make a red test pass.

    The fixture is deliberately an **owner-owned** board (the convention used
    by `_make_board` throughout this file). On an owner-owned, explicitly-
    membered, or site-admin board `get_board_role()` resolves with zero
    queries — from the owner check or the `_prefetched_memberships` cache that
    `get_board_for_user()` populates. Only the group-inherited path costs a
    real `GroupMembership` query, so a *duplicated* role resolution would be
    invisible on this fixture — which is why the service accepts the role its
    adapter already resolved instead of re-deriving it (#1107).
    """

    # Measured on the fixture below, then +3 for framework headroom.
    #
    # Re-measured for #371 (custom fields). Every mutation that re-renders a
    # card through `_card_queryset()` gained the `custom_field_values` prefetch,
    # and the cascade delete gained the new table — a constant, row-independent
    # cost that does not scale with the number of cards or fields. The numbers
    # are moved here rather than absorbed into the existing headroom, so the
    # budgets keep catching the *next* regression at the same tightness.
    #
    # Re-measured again for #449 (card relations). Two sources, both constant
    # and both row-independent: every re-render of a card through
    # `_card_queryset()` gained the `active_blockers` prefetch (and these paths
    # render a card more than once — once for the response, once for the
    # deferred broadcast payload), and the cascade delete gained the
    # `card_relations` table. Moved here rather than absorbed into the existing
    # headroom so the budgets keep catching the *next* regression at the same
    # `measured + 3` tightness.
    BUDGET_CREATE = 39              # measured 36 (was 33 pre-#449, 31 pre-#371)
    BUDGET_UPDATE = 34              # measured 31 (was 28 pre-#449, 26 pre-#371)
    BUDGET_MOVE_COLUMN_CHANGE = 30  # measured 27 (was 25 pre-#449, 24 pre-#371)
    BUDGET_MOVE_REORDER = 25        # measured 22 (was 20 pre-#449, 19 pre-#371)
    # Archive, unarchive and destroy each carry one further query: the lookup
    # of the cards this one actively blocks, whose blocker_count moves when it
    # leaves the board and which therefore need their own `card.updated` frame
    # (#449). One query for the set, and the frames themselves are rendered in
    # a single batched pass, so the cost does not scale with how many cards
    # this one blocks — `CardRelationPeerBroadcastQueryCountTests` below pins
    # that separately.
    BUDGET_ARCHIVE = 23             # measured 20 (was 19 pre-peer-broadcast, 17 pre-#449)
    BUDGET_UNARCHIVE = 23           # measured 20 (was 19 pre-peer-broadcast, 17 pre-#449)
    BUDGET_DESTROY = 28             # measured 25 (was 24 pre-peer-broadcast, 21 pre-#449; FK cascade deletes)
    # Relation write paths (#449). Both re-render BOTH endpoint cards for the
    # two `card.updated` broadcasts, but in one batched `_card_queryset` pass —
    # these budgets are what stops that quietly becoming two passes again.
    BUDGET_RELATION_CREATE = 27     # measured 24
    BUDGET_RELATION_DELETE = 23     # measured 20

    def setUp(self):
        # MaintenanceModeMiddleware consults get_maintenance_state() on every
        # non-SAFE request; that read is cached, but nothing warms the cache
        # between test methods (Django's LocMemCache backend persists across
        # a whole test process). Whichever test here happened to run first
        # was paying one uncached SiteSetting query and blowing its budget,
        # while every later test in the same process rode the warm cache for
        # free — an order-dependent failure, not a real regression. Warming
        # it explicitly makes every test see the steady-state (cache warm)
        # cost the budgets are meant to measure.
        get_maintenance_state()

        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.user = User.objects.create_user(username="u_mutate", password="x")
        self.board = _make_board(self.user)
        self.col_a = Column.objects.create(
            board=self.board, name="A", position=0, allow_card_creation=True,
        )
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.label = Label.objects.create(board=self.board, name="l", color="#000")

        # Several cards per cell so a per-row regression in the source-cell
        # compaction or target-cell shift shows up as growth, not noise.
        self.cards = [
            Card.objects.create(
                board=self.board, column=self.col_a, swimlane=self.lane,
                title=f"a{i}", created_by=self.user, position=i,
            )
            for i in range(5)
        ]
        for i in range(5):
            Card.objects.create(
                board=self.board, column=self.col_b, swimlane=self.lane,
                title=f"b{i}", created_by=self.user, position=i,
            )
        self.card = self.cards[0]

        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        self._broadcast_patcher.stop()

    # ── helpers ───────────────────────────────────────────────────────────

    def _card_url(self, suffix=""):
        return f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/{suffix}"

    def _assert_budget(self, ctx, budget, label, expected_status, actual_status):
        self.assertEqual(
            actual_status, expected_status,
            f"{label} returned {actual_status}, expected {expected_status} — "
            "the budget below is meaningless unless the request succeeded.",
        )
        self.assertLessEqual(
            len(ctx), budget,
            f"{label} used {len(ctx)} queries — budget is {budget}. "
            "A constant query regression was introduced; find the duplicated "
            "role resolution, re-serialization, or lost prefetch rather than "
            "raising the budget.",
        )

    # ── one budget per write path ─────────────────────────────────────────

    def test_create_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/",
                {"title": "new", "column": self.col_a.id, "swimlane": self.lane.id,
                 "label_ids": [self.label.id]},
                format="json",
            )
        self._assert_budget(ctx, self.BUDGET_CREATE, "POST cards/", 201, r.status_code)

    def test_update_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.patch(
                self._card_url(),
                {"title": "renamed", "priority": "high", "label_ids": [self.label.id]},
                format="json",
            )
        self._assert_budget(ctx, self.BUDGET_UPDATE, "PATCH cards/{id}/", 200, r.status_code)

    def test_update_query_count_is_exact(self):
        """Pins the exact PATCH /cards/{id}/ query count (#1223), not just a
        budget with headroom.

        BUDGET_UPDATE's `measured + 3` slack exists to absorb framework noise,
        but that same slack means a *constant* +1 regression — like
        `boards.services.cards.update_card()` falling back from the
        to_attr-parked labels list to `card.labels.all()` — sails straight
        through it. It would also sail through
        `test_update_query_count_constant_across_label_count` below: that test
        only checks the count is stable *across* label counts, and a reader
        that always falls back to the manager costs the same one extra query
        regardless of how many labels the card has, so "constant" is true
        either way. Only an exact count, measured once and moved deliberately
        (matching this file's `measured + 3` convention above, just without
        the +3), catches this class of regression.
        """
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.patch(
                self._card_url(),
                {"title": "renamed", "priority": "high", "label_ids": [self.label.id]},
                format="json",
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            len(ctx), 31,
            f"PATCH cards/{{id}}/ used {len(ctx)} queries — expected exactly 31. "
            "If this grew by exactly one, check for a reader that fell back "
            "from a to_attr-parked list to the manager's .all() (#1223); if "
            "it is a legitimate change, re-measure and move this number in "
            "the same commit, with the reason.",
        )

    def test_move_column_change_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_b.id, "swimlane_id": self.lane.id, "position": 0},
                format="json",
            )
        self._assert_budget(
            ctx, self.BUDGET_MOVE_COLUMN_CHANGE, "POST move/ (column change)", 200, r.status_code,
        )

    def test_move_pure_reorder_within_query_budget(self):
        """A reorder inside one cell skips source compaction, the WIP/weight
        checks, and the CardMovement write — it must stay cheaper than a
        column change, not merely within the same budget."""
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_a.id, "swimlane_id": self.lane.id, "position": 3},
                format="json",
            )
        self._assert_budget(
            ctx, self.BUDGET_MOVE_REORDER, "POST move/ (pure reorder)", 200, r.status_code,
        )

    def test_archive_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(self._card_url("archive/"))
        self._assert_budget(ctx, self.BUDGET_ARCHIVE, "POST archive/", 200, r.status_code)

    def test_unarchive_within_query_budget(self):
        self.client.post(self._card_url("archive/"))
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(self._card_url("unarchive/"))
        self._assert_budget(ctx, self.BUDGET_UNARCHIVE, "POST unarchive/", 200, r.status_code)

    def test_destroy_within_query_budget(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.delete(self._card_url())
        self._assert_budget(ctx, self.BUDGET_DESTROY, "DELETE cards/{id}/", 204, r.status_code)

    def _relations_url(self, card, relation_id=None):
        base = f"/api/v1/boards/{self.board.id}/cards/{card.id}/relations/"
        return base if relation_id is None else f"{base}{relation_id}/"

    def test_relation_create_within_query_budget(self):
        """Both endpoint cards are re-rendered for the two broadcasts — in ONE
        batched `_card_queryset` pass. Two passes would sail past this."""
        other = self.cards[1]
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(
                self._relations_url(self.card),
                {"to_card": other.id, "direction": "blocked_by"},
                format="json",
            )
        self._assert_budget(
            ctx, self.BUDGET_RELATION_CREATE, "POST relations/", 201, r.status_code,
        )

    def test_relation_delete_within_query_budget(self):
        other = self.cards[1]
        relation_id = self.client.post(
            self._relations_url(self.card),
            {"to_card": other.id, "direction": "blocked_by"},
            format="json",
        ).data["id"]
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.delete(self._relations_url(self.card, relation_id))
        self._assert_budget(
            ctx, self.BUDGET_RELATION_DELETE, "DELETE relations/{id}/", 204, r.status_code,
        )

    # ── scaling guards ────────────────────────────────────────────────────

    def test_move_query_count_constant_across_cell_size(self):
        """Source compaction and target shift are single bulk UPDATEs.

        Adding cards to both the source and target cell must not change the
        query count — a per-row `save()` loop in either would show up here.
        """
        def _move_back_and_forth():
            self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_b.id, "swimlane_id": self.lane.id, "position": 0},
                format="json",
            )
            self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_a.id, "swimlane_id": self.lane.id, "position": 0},
                format="json",
            )

        baseline = _query_count(_move_back_and_forth)
        for i in range(20):
            Card.objects.create(
                board=self.board, column=self.col_a, swimlane=self.lane,
                title=f"extra_a{i}", created_by=self.user, position=100 + i,
            )
            Card.objects.create(
                board=self.board, column=self.col_b, swimlane=self.lane,
                title=f"extra_b{i}", created_by=self.user, position=100 + i,
            )
        scaled = _query_count(_move_back_and_forth)
        self.assertEqual(
            baseline, scaled,
            f"move/ query count grew from {baseline} to {scaled} when the source and "
            "target cells were filled — the position compaction or shift regressed "
            "from a bulk UPDATE to a per-row loop.",
        )

    def test_update_query_count_constant_across_label_count(self):
        """The label-change activity entry builds its name map from the
        already-prefetched labels, so more labels must not mean more queries."""
        def _patch_title():
            self.client.patch(self._card_url(), {"title": f"t{id(object())}"}, format="json")

        baseline = _query_count(_patch_title)
        extra = [Label.objects.create(board=self.board, name=f"l{i}", color="#111") for i in range(10)]
        self.card.labels.set(extra)
        scaled = _query_count(_patch_title)
        self.assertEqual(
            baseline, scaled,
            f"PATCH cards/{{id}}/ query count grew from {baseline} to {scaled} when the "
            "card gained labels — the activity-diff label lookup regressed to a live query.",
        )
