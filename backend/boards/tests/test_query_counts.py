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
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User, get_maintenance_state
from boards.models import (
    Board, BoardMembership, Card, CardAttachment, CardChecklist, CardParentLink,
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


def _assert_flat(testcase, fetch, grow, label, check=None):
    """Grow one axis of a board and assert the endpoint's query count is flat (#1886).

    Both reads must be 200s: a 403/404 issues the same few queries every time
    and would make the equality vacuous. ``check(before, after)`` receives the
    two response payloads so a test can prove the axis really grew in the output.
    """
    before, r1 = _query_count_and_response(fetch)
    grow()
    after, r2 = _query_count_and_response(fetch)
    testcase.assertEqual((r1.status_code, r2.status_code), (200, 200))
    if check is not None:
        check(r1.data, r2.data)
    testcase.assertEqual(
        before, after,
        f"{label}: query count grew from {before} to {after} - per-row query regression (#1886).",
    )


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
    BUDGET = 22  # +1 #1104: the card-parent link lookup (constant; +2 more only when a card is linked); +1 #2211: swimlanes__team_members prefetch (constant); +1 #2446: the leftover-parent ids lookup on a flag-off board (constant; it gates children_rollup)

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
        # #1391 (MR C): a colored-choice dropdown at each level — choice_colors
        # is a plain column on the definition row, so the budget must not move.
        CustomFieldDefinition.objects.create(
            board=self.board, name="Severity", field_type="dropdown", position=91,
            choices_json=["Low", "High"], choice_colors={"High": "red"},
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", field_type="dropdown", position=91,
            choices_json=["Gold"], choice_colors={"Gold": "amber"},
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
        severity = next(d for d in r.data["custom_field_definitions"] if d["name"] == "Severity")
        self.assertEqual(severity["choice_colors"], {"High": "red"})
        tier = next(d for d in r.data["swimlane_custom_field_definitions"] if d["name"] == "Tier")
        self.assertEqual(tier["choice_colors"], {"Gold": "amber"})
        self.assertLessEqual(
            len(ctx), self.BUDGET,
            f"full/ used {len(ctx)} queries — budget is {self.BUDGET}.",
        )

    def test_full_query_count_is_flat_in_the_swimlane_field_count(self):
        """#2438: the cap went from 15 to 30; every lane x field value still
        rides one prefetch, so the count must not move with the field count."""
        counts = {}
        for n_fields in (15, 30):
            with self.subTest(n_fields=n_fields):
                board, _cols, lanes = _seed_board(
                    self.user, n_cols=3, n_lanes=5, cards_per_cell=1,
                )
                defs = [
                    SwimlaneCustomFieldDefinition.objects.create(
                        board=board, name=f"F{i}", field_type="text", position=i,
                    )
                    for i in range(n_fields)
                ]
                SwimlaneCustomFieldValue.objects.bulk_create([
                    SwimlaneCustomFieldValue(swimlane=lane, field_definition=d, value="v")
                    for lane in lanes for d in defs
                ])
                with CaptureQueriesContext(connection) as ctx:
                    r = self.client.get(f"/api/v1/boards/{board.id}/full/")
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(r.data["swimlane_custom_field_definitions"]), n_fields)
                self.assertEqual(sum(len(s["custom_field_values"]) for s in r.data["swimlanes"]), 5 * n_fields)
                counts[n_fields] = len(ctx)
                self.assertLessEqual(len(ctx), self.BUDGET)
        self.assertEqual(counts[15], counts[30], counts)

    # Measured for a site-admin reader on this fixture (#1714). Pinned at the
    # measured count, not 2x: the regression it guards is one constant extra
    # query, get_members() re-reading the all-content user list that
    # get_cards() already loaded.
    SITE_ADMIN_READER_QUERIES = 22  # +2 #1102/#1921: columns__sub_columns, columns__stage_tracks prefetches; +1 #1104 card-parent link lookup (constant); +1 #2211: swimlanes__team_members prefetch (constant); +1 #2446: the leftover-parent ids lookup on a flag-off board (constant; it gates children_rollup)

    def test_full_site_admin_reader_reuses_all_content_list(self):
        reader = User.objects.create_user(
            username="qc_site_admin", password="x", is_site_admin=True, can_access_all_content=True,
        )
        other = User.objects.create_user(
            username="qc_all_content", password="x", can_access_all_content=True,
        )
        client = APIClient()
        client.force_authenticate(reader)
        with CaptureQueriesContext(connection) as ctx:
            r = client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, 200)
        # The site-admin reader is listed the all-content rows...
        listed = {m["user"]["id"]: m["role"] for m in r.data["members"]}
        self.assertEqual(listed[other.pk], "site_admin")
        self.assertEqual(listed[reader.pk], "site_admin")
        # ...from the single all-content query get_cards() issues.
        all_content_queries = [
            q["sql"] for q in ctx.captured_queries
            if 'WHERE "users"."can_access_all_content"' in q["sql"]
        ]
        self.assertEqual(len(all_content_queries), 1, all_content_queries)
        self.assertLessEqual(
            len(ctx), self.SITE_ADMIN_READER_QUERIES,
            f"full/ (site-admin reader) used {len(ctx)} queries — pinned at "
            f"{self.SITE_ADMIN_READER_QUERIES}.",
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

    def test_full_budget_scales_with_columns(self):
        def grow():
            for i in range(10, 16):
                Column.objects.create(board=self.board, name=f"C{i}", position=i)

        _assert_flat(
            self, self._get_full, grow, "full/ (columns)",
            lambda a, b: self.assertEqual(len(b["columns"]), len(a["columns"]) + 6),
        )

    def test_full_budget_scales_with_board_labels(self):
        def grow():
            for i in range(6):
                Label.objects.create(board=self.board, name=f"extra{i}", color="#111")

        _assert_flat(
            self, self._get_full, grow, "full/ (labels)",
            lambda a, b: self.assertEqual(len(b["labels"]), len(a["labels"]) + 6),
        )

    def test_full_budget_scales_with_direct_members(self):
        def grow():
            for i in range(6):
                u = User.objects.create_user(username=f"dm{i}", password="x")
                BoardMembership.objects.create(board=self.board, user=u, role="member")

        _assert_flat(
            self, self._get_full, grow, "full/ (direct members)",
            lambda a, b: self.assertEqual(len(b["members"]), len(a["members"]) + 6),
        )

    def test_full_budget_scales_with_custom_field_definitions(self):
        """Board-level and swimlane-level definitions are separate relations."""
        def grow():
            for i in range(6):
                CustomFieldDefinition.objects.create(
                    board=self.board, name=f"Extra{i}", field_type="text", position=200 + i,
                )
                SwimlaneCustomFieldDefinition.objects.create(
                    board=self.board, name=f"LaneExtra{i}", field_type="text", position=200 + i,
                )

        def check(a, b):
            self.assertEqual(
                len(b["custom_field_definitions"]), len(a["custom_field_definitions"]) + 6
            )
            self.assertEqual(
                len(b["swimlane_custom_field_definitions"]),
                len(a["swimlane_custom_field_definitions"]) + 6,
            )

        _assert_flat(self, self._get_full, grow, "full/ (custom field definitions)", check)

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
    BUDGET = 25  # +1 #2211: swimlanes__team_members prefetch (constant); +1 #2446: the leftover-parent ids lookup on a flag-off board (constant; it gates children_rollup)

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
        # #1391 (MR C): a colored-choice dropdown at each level — choice_colors
        # is a plain column on the definition row, so the budget must not move.
        CustomFieldDefinition.objects.create(
            board=self.board, name="Severity", field_type="dropdown", position=91,
            choices_json=["Low", "High"], choice_colors={"High": "red"},
        )
        SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", field_type="dropdown", position=91,
            choices_json=["Gold"], choice_colors={"Gold": "amber"},
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

    def test_full_with_group_budget_scales_with_group_inherited_members(self):
        """Members inherited from the group and its ancestor must not add queries."""
        from groups.models import GroupMembership

        def grow():
            for i in range(4):
                u = User.objects.create_user(username=f"inh_c{i}", password="x")
                GroupMembership.objects.create(group=self.child_group, user=u, role="member")
                v = User.objects.create_user(username=f"inh_p{i}", password="x")
                GroupMembership.objects.create(group=self.parent_group, user=v, role="member")

        _assert_flat(
            self, self._get_full, grow, "full/ (group-inherited members)",
            lambda a, b: self.assertEqual(len(b["members"]), len(a["members"]) + 8),
        )

    def test_full_with_group_budget_scales_with_direct_members(self):
        def grow():
            for i in range(4):
                u = User.objects.create_user(username=f"gdm{i}", password="x")
                BoardMembership.objects.create(board=self.board, user=u, role="member")

        _assert_flat(
            self, self._get_full, grow, "full/ (group board, direct members)",
            lambda a, b: self.assertEqual(len(b["members"]), len(a["members"]) + 4),
        )

    def test_full_with_group_budget_scales_with_columns_and_labels(self):
        def grow():
            for i in range(10, 14):
                Column.objects.create(board=self.board, name=f"C{i}", position=i)
                Label.objects.create(board=self.board, name=f"extra{i}", color="#111")

        _assert_flat(
            self, self._get_full, grow, "full/ (group board, columns and labels)",
            lambda a, b: self.assertEqual(len(b["columns"]), len(a["columns"]) + 4),
        )

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


# Cache off: these count the queries of an uncached share build (#1965).
@override_settings(SHARE_BOARD_CACHE_TTL_SECONDS=0)
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

    FULL_QUERIES = 22  # +2 #1102/#1921: columns__sub_columns, columns__stage_tracks prefetches; +1 #1104 card-parent link lookup (constant); +1 #2211: swimlanes__team_members prefetch (constant); +1 #2446: the leftover-parent ids lookup on a flag-off board (constant; it gates children_rollup)

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

    def _get_public(self):
        return APIClient().get(f"/api/share/{self.share_token}/")

    def test_public_board_flat_across_columns_labels_and_swimlanes(self):
        """The anonymous endpoint must not grow with board structure (#1886)."""
        def grow():
            for i in range(10, 14):
                Column.objects.create(board=self.board, name=f"PC{i}", position=i)
                Label.objects.create(board=self.board, name=f"pl{i}", color="#222")
                Swimlane.objects.create(board=self.board, name=f"PL{i}", position=i)

        _assert_flat(self, self._get_public, grow, "public share (columns/labels/swimlanes)")

    # The constant-count tests above prove the conversion did not *regress*
    # anything, but they stay green if the to_attr= kwargs are removed: the
    # accessors' manager fallback still reads a plain prefetch cache, correctly
    # and query-free, just with the per-call queryset clone #1212 removed. These
    # two pin that the optimization is actually applied. (Asserting on CPU time
    # instead would be flaky.)

    PARKED_ATTRS = (
        "_prefetched_attachments",
        "_prefetched_checklist_items",
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
            # The public payload reads checklist items; movements are no
            # longer loaded at all (#1883) -- see test_last_move_annotation_1883.py.
            for attr in ("_prefetched_checklist_items",):
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

    def test_summary_budget_scales_with_columns(self):
        """Columns are an axis too: the summary reports per-column counts (#1886)."""
        def grow():
            for i in range(10, 16):
                Column.objects.create(board=self.board, name=f"C{i}", position=i)

        _assert_flat(self, self._get_summary, grow, "summary/ (columns)")

    def test_summary_budget_scales_with_cards(self):
        def grow():
            lane, col = self.lanes[0], Column.objects.filter(board=self.board).first()
            for i in range(30):
                Card.objects.create(
                    board=self.board, column=col, swimlane=lane,
                    title=f"extra{i}", created_by=self.user, position=100 + i,
                )

        _assert_flat(self, self._get_summary, grow, "summary/ (cards)")

    def test_benchmark_command_shares_these_budgets(self):
        """benchmark.py and this file once held different numbers for one guard (#1886)."""
        from boards.management.commands import benchmark

        self.assertEqual(benchmark.SUMMARY_BUDGET, self.BUDGET)
        self.assertEqual(benchmark.CARD_LIST_BUDGET, CardListQueryCountTests.BUDGET)
        self.assertEqual(benchmark.FULL_BUDGET, BoardFullQueryCountTests.BUDGET)


class IsStaleAnnotationQueryCountTests(TestCase):
    """GET /api/boards/{id}/full/ must not call timezone.now() per card.

    is_stale is annotated at the queryset level by _card_queryset(stale_cutoff=...)
    so get_is_stale() reads a pre-computed boolean rather than re-computing the
    cutoff and accessing obj.movements per row (#669).  This test verifies that
    the full/ query count does not grow when is_stale-affecting cards are added.
    """

    BUDGET = 22  # +1 #2211: swimlanes__team_members prefetch (constant); +1 #2446: the leftover-parent ids lookup on a flag-off board (constant; it gates children_rollup)

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

    def test_analytics_query_count_does_not_grow_with_columns(self):
        """Columns are the per-column dwell/throughput axis (#1886)."""
        def grow():
            for i in range(10, 16):
                Column.objects.create(board=self.board, name=f"Extra{i}", position=i)

        _assert_flat(self, self._get_analytics, grow, "analytics/ (columns)")

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
    # +2 on create and update (#1632): the board row FOR SHARE that every card
    # create/update now takes first, and the re-read of the labels the write
    # names, so a concurrent label delete answers 400, not 500.
    BUDGET_CREATE = 41              # measured 40 (41 pre-#1883, 38 stale; 36 pre-#1632, 33 pre-#449, 31 pre-#371)
    # +1 on update (#1587): update_card locks the card row before the write so
    # a concurrent hard delete cannot be undone by save()'s INSERT fallback.
    BUDGET_UPDATE = 35              # measured 32 (34 pre-#1883, 32 pre-#1632, 31 pre-#1587, 28 pre-#449, 26 pre-#371)
    # +1 on a column change (#2210): the one CardParentLink lookup that finds
    # the moved card's parent so its board gets the ids-only
    # card.children_changed ping. Constant: one query whatever the card.
    BUDGET_MOVE_COLUMN_CHANGE = 32  # measured 31 (30 pre-#2210, 29 pre-#1883; was 25 pre-#449, 24 pre-#371)
    BUDGET_MOVE_REORDER = 25        # measured 24 (25 pre-#1883; was 20 pre-#449, 19 pre-#371)
    # Archive, unarchive and destroy each carry one further query: the lookup
    # of the cards this one actively blocks, whose blocker_count moves when it
    # leaves the board and which therefore need their own `card.updated` frame
    # (#449). One query for the set, and the frames themselves are rendered in
    # a single batched pass, so the cost does not scale with how many cards
    # this one blocks — `CardRelationPeerBroadcastQueryCountTests` below pins
    # that separately.
    BUDGET_ARCHIVE = 23             # measured 20 (21 pre-#1883; was 19 pre-peer-broadcast, 17 pre-#449)
    BUDGET_UNARCHIVE = 24           # +1 #2563: column row lock + free-slot probe, constant (measured 24 with the pair); was 23, measured 20 (21 pre-#1883; was 19 pre-peer-broadcast, 17 pre-#449)
    BUDGET_DESTROY = 39             # measured 39 (+1 #1923: card_overrides SET_NULL, the collector's one UPDATE for the new append-only audit FK, as for card_gate_transitions; constant); was 38 (+1 #2447: one cascade DELETE of card_parent_unlinks, both FKs in one query; constant); was 37 (+1 #1799: set_null_keeping_board fills card_activities' board + card snapshot with one UPDATE before the SET_NULL, as for card_movements; constant); was 36 (+4 #2409, PostgreSQL only, constant: lock_card_and_link_peers' savepoint open + release, its pk-ordered card-and-peers lock, and the peer re-read under that lock that detects a link committed in between); was 32 (+1 #2383: the card's link peers read before the pk-ordered lock, PostgreSQL only; constant); was 31 (+2 #1104: one SELECT of the card's parent links to announce removal, one cascade DELETE of card_parent_links; neither scales with row count); was 29 (measured 28, +1 #1102: card_gate_transitions SET_NULL); was 27 (28 pre-#1883; was 24 pre-peer-broadcast, 21 pre-#449; FK cascade deletes)
    # two `card.updated` broadcasts, but in one batched `_card_queryset` pass —
    # these budgets are what stops that quietly becoming two passes again.
    BUDGET_RELATION_CREATE = 27     # measured 24 (25 pre-#1883)
    BUDGET_RELATION_DELETE = 22     # measured 19 (20 pre-#1883)

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
            # 34 = 31 + the card row lock update_card takes first (#1587)
            # + the board row FOR SHARE and the label_ids re-read (#1632)
            # - the two movements prefetches (card fetch + response re-fetch)
            # that last-move subquery annotations replaced (#1883).
            len(ctx), 33,  # +1 #2446: announce_parent_changed reads the card's child links on every board
            f"PATCH cards/{{id}}/ used {len(ctx)} queries — expected exactly 33. "
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


class CardChildrenQueryCountTests(TestCase):
    """``GET .../cards/{id}/children/`` at the 100-child cap (#2383, perf-bench case).

    The children read is the one place a parent's children are computed for
    every transport (``card_links.children_for_viewer``), and the UI polls it
    after every ``card.children_changed`` ping. It must cost the same at the
    cap (``CHILDREN_PER_PARENT_LIMIT``) as with one child, on both pages and
    for both answers: a reader who can open the child board (titles) and one
    who cannot (count only). Its scaling axis is the number of children; the
    child board is one board by rule, so there is no second axis.

    The rollup's own bench case landed with #2210: the ``(rollup)`` rows of
    ``manage.py benchmark`` (``FULL_ROLLUP_BUDGET``, ``CARD_LIST_ROLLUP_BUDGET``).
    """

    # 11 measured with titles, 10 count-only (auth, board role, parent card,
    # link reads, child board + role, the page), flat in the child count; 2x.
    BUDGET = 22

    def setUp(self):
        from boards.services.card_links import CHILDREN_PER_PARENT_LIMIT
        from boards.tests.test_card_parent_links import _LinkFixture

        fixture = _LinkFixture()
        fixture._setup_boards()
        self.fixture = fixture
        self.cap = CHILDREN_PER_PARENT_LIMIT
        self.url = f"/api/v1/boards/{fixture.pboard.pk}/cards/{fixture.parent.pk}/children/"
        CardParentLink.objects.create(parent=fixture.parent, child=fixture.child)
        self.full = fixture._user("qc_children_full", parent_role="viewer", child_role="viewer")
        self.count_only = fixture._user("qc_children_count", parent_role="viewer")

    def _fill_to_cap(self):
        from boards.tests.conftest import _make_card

        f = self.fixture
        for i in range(self.cap - 1):
            child = _make_card(f.col_c, f.lane_c, title=f"child {i}")
            CardParentLink.objects.create(parent=f.parent, child=child)
        self.assertEqual(CardParentLink.objects.filter(parent=f.parent).count(), self.cap)

    def _count(self, user, offset=0):
        client = APIClient()
        client.force_authenticate(user)
        with CaptureQueriesContext(connection) as ctx:
            r = client.get(f"{self.url}?offset={offset}")
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx), r.json()

    def test_children_read_is_flat_up_to_the_cap(self):
        baseline = {}
        for user, visible in ((self.full, True), (self.count_only, False)):
            baseline[visible], _ = self._count(user)
            with self.subTest(visible=visible):
                self.assertLessEqual(
                    baseline[visible], self.BUDGET,
                    f"children/ used {baseline[visible]} queries at one child",
                )
        self._fill_to_cap()
        for user, visible in ((self.full, True), (self.count_only, False)):
            for offset in (0, 50):
                with self.subTest(visible=visible, offset=offset):
                    n, body = self._count(user, offset)
                    self.assertEqual(body["count"], self.cap)
                    self.assertIs(body["visible"], visible)
                    self.assertEqual(len(body["results"]), 50 if visible else 0)
                    self.assertEqual(
                        n, baseline[visible],
                        f"children/ query count grew from {baseline[visible]} to {n} at "
                        f"the {self.cap}-child cap — N+1 regression detected.",
                    )
                    self.assertLessEqual(
                        n, self.BUDGET,
                        f"children/ used {n} queries at the {self.cap}-child cap "
                        f"(offset {offset}, visible={visible}) — budget is {self.BUDGET}. "
                        "An N+1 was introduced; fix the read in children_for_viewer.",
                    )


class CardParentQueryCountTests(TestCase):
    """``Card.parent``, the picker reads and the parent pings are flat (#1104).

    ``parents_for_viewer`` is one link query plus ``get_board_roles``'s fixed
    two, however many children are linked and however many parent boards their
    parents sit on. These reads pass the served board as ``known_boards``, so
    the child-board query a hint-less caller pays is never issued (#2536). A parent ping costs nothing on a board that cannot have
    children.
    """

    def setUp(self):
        from boards.models import BoardMembership, CardParentLink
        from boards.tests.test_card_parent_links import _LinkFixture

        self.Link = CardParentLink
        self.Role = BoardMembership.Role
        fx = _LinkFixture()
        fx._setup_boards()
        self.fx = fx
        # Not a site admin, so get_board_roles issues its two queries.
        self.user = fx._user("qc_parent", parent_role=self.Role.MEMBER, child_role=self.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.extra_parent_boards = []
        for i in range(2):
            b = Board.objects.create(name=f"QC portfolio {i}", owner=fx.owner, cards_can_have_children=True)
            BoardMembership.objects.create(board=b, user=self.user, role=self.Role.VIEWER)
            col = Column.objects.create(board=b, name="c", position=0)
            lane = Swimlane.objects.create(board=b, name="l", position=0)
            self.extra_parent_boards.append((col, lane))

    def _count(self, url, params=None):
        with CaptureQueriesContext(connection) as ctx:
            res = self.client.get(url, params or {})
        self.assertEqual(res.status_code, 200, res.content)
        return len(ctx)

    def _link_twenty(self):
        """19 more linked children whose parents span 3 parent boards."""
        fx = self.fx
        cells = [(fx.parent.column, fx.parent.swimlane), *self.extra_parent_boards]
        for i in range(19):
            col, lane = cells[i % 3]
            parent = Card.objects.create(board=col.board, column=col, swimlane=lane, title=f"P{i}", position=i + 1)
            child = Card.objects.create(board=fx.cboard, column=fx.col_c, swimlane=fx.lane_c, title=f"C{i}", position=i + 1)
            self.Link.objects.create(parent=parent, child=child)

    def _reads(self):
        base = f"/api/v1/boards/{self.fx.cboard.pk}"
        return {
            "full": lambda: self._count(f"{base}/full/"),
            "list": lambda: self._count(f"{base}/cards/"),
            "archived": lambda: self._count(f"{base}/cards/archived/"),
        }

    def test_reads_cost_three_more_with_links_and_stay_flat_at_twenty(self):
        reads = self._reads()
        no_links = {k: f() for k, f in reads.items()}
        self.Link.objects.create(parent=self.fx.parent, child=self.fx.child)
        one = {k: f() for k, f in reads.items()}
        for k in ("full", "list"):
            # get_board_roles's two, plus the one grouped sibling count (#2443).
            self.assertEqual(one[k] - no_links[k], 3, k)
        self._link_twenty()
        twenty = {k: f() for k, f in reads.items()}
        self.assertEqual(one, twenty)
        Card.objects.filter(board=self.fx.cboard).update(archived_at=timezone.now())
        archived_twenty = reads["archived"]()
        Card.objects.filter(board=self.fx.cboard).exclude(pk=self.fx.child.pk).update(archived_at=None)
        self.assertEqual(reads["archived"](), archived_twenty)

    def test_child_candidates_flat_in_results(self):
        from unittest import mock

        fx = self.fx
        url = f"/api/v1/boards/{fx.pboard.pk}/cards/{fx.parent.pk}/child-candidates/"
        params = {"board": fx.cboard.pk, "search": "Cand"}
        with mock.patch("boards.views.card_query.CardQueryRateThrottle.get_rate", return_value="1000/min"):
            Card.objects.create(
                board=fx.cboard, column=fx.child.column, swimlane=fx.child.swimlane, title="Cand 0", position=50,
            )
            one = self._count(url, params)
            for i in range(1, 20):
                c = Card.objects.create(
                    board=fx.cboard, column=fx.child.column, swimlane=fx.child.swimlane,
                    title=f"Cand {i}", position=50 + i,
                )
                if i % 2:
                    other = Card.objects.create(
                        board=fx.pboard, column=fx.parent.column, swimlane=fx.parent.swimlane,
                        title=f"Other parent {i}", position=50 + i,
                    )
                    self.Link.objects.create(parent=other, child=c)
            twenty = self._count(url, params)
        # Candidate rows add no per-row queries, including rows that already
        # have another parent.
        self.assertLessEqual(twenty - one, 3)

    def test_child_candidates_under_an_archived_parent_add_one_batched_read(self):
        """#2447: the previously-unlinked check is ONE query per page, flat in rows."""
        from unittest import mock

        from boards.models import CardParentUnlink

        fx = self.fx
        url = f"/api/v1/boards/{fx.pboard.pk}/cards/{fx.parent.pk}/child-candidates/"
        params = {"board": fx.cboard.pk, "search": "Cand"}
        with mock.patch("boards.views.card_query.CardQueryRateThrottle.get_rate", return_value="1000/min"):
            Card.objects.create(
                board=fx.cboard, column=fx.child.column, swimlane=fx.child.swimlane, title="Cand 0", position=50,
            )
            live = self._count(url, params)
            Card.objects.filter(pk=fx.parent.pk).update(archived_at=timezone.now())
            archived_one = self._count(url, params)
            for i in range(1, 20):
                c = Card.objects.create(
                    board=fx.cboard, column=fx.child.column, swimlane=fx.child.swimlane,
                    title=f"Cand {i}", position=50 + i,
                )
                if i % 2:
                    CardParentUnlink.objects.create(parent=fx.parent, child=c)
            archived_twenty = self._count(url, params)
        self.assertEqual(archived_one - live, 1)
        self.assertEqual(archived_twenty, archived_one)

    def test_parent_candidates_flat_in_results(self):
        from unittest import mock

        from boards.services import card_links

        fx = self.fx
        url = f"/api/v1/boards/{fx.cboard.pk}/cards/{fx.child.pk}/parent-candidates/"
        params = {"board": fx.pboard.pk, "search": "Init"}
        with mock.patch("boards.views.card_query.CardQueryRateThrottle.get_rate", return_value="1000/min"):
            one = self._count(url, params)
            other_board = Board.objects.create(name="QC other", owner=fx.owner)
            ocol = Column.objects.create(board=other_board, name="c", position=0)
            olane = Swimlane.objects.create(board=other_board, name="l", position=0)
            for i in range(19):
                p = Card.objects.create(
                    board=fx.pboard, column=fx.parent.column, swimlane=fx.parent.swimlane,
                    title=f"Initiative {i}", position=i + 1,
                )
                if i % 2:
                    c = Card.objects.create(board=other_board, column=ocol, swimlane=olane, title="x", position=i)
                    self.Link.objects.create(parent=p, child=c)
            with mock.patch.object(card_links, "CHILDREN_PER_PARENT_LIMIT", 0):
                twenty = self._count(url, params)
        # At most the other child boards' one Board load plus get_board_roles's
        # fixed two, whatever the row count.
        self.assertLessEqual(twenty - one, 3)

    def test_parent_boards_flat_in_boards(self):
        url = f"/api/v1/boards/{self.fx.cboard.pk}/parent-boards/"
        three = self._count(url)
        for i in range(7):
            b = Board.objects.create(name=f"QC more {i}", owner=self.fx.owner, cards_can_have_children=True)
            BoardMembership.objects.create(board=b, user=self.user, role=self.Role.MEMBER)
        self.assertEqual(self._count(url), three)

    def test_parent_ping_costs(self):
        from boards.services import card_links

        fx = self.fx
        # #2446: one query on a flag-off board too (it may hold leftover parents).
        with self.assertNumQueries(1):
            card_links.announce_parent_changed(fx.child.pk, fx.cboard, actor_id=None)
        with self.assertNumQueries(1):
            card_links.announce_parent_changed(fx.parent.pk, fx.pboard, actor_id=None)
        self.Link.objects.create(parent=fx.parent, child=fx.child)
        with CaptureQueriesContext(connection) as one:
            card_links.announce_parent_changed(fx.parent.pk, fx.pboard, actor_id=None)
        for i in range(19):
            c = Card.objects.create(board=fx.cboard, column=fx.col_c, swimlane=fx.lane_c, title=f"c{i}", position=i + 1)
            self.Link.objects.create(parent=fx.parent, child=c)
        with CaptureQueriesContext(connection) as twenty:
            card_links.announce_parent_changed(fx.parent.pk, fx.pboard, actor_id=None)
        self.assertEqual(len(one), len(twenty))


class ChildBoardReadsQueryCountTests(TestCase):
    """The four #2208 part 2 reads are flat in the number of boards (#2449).

    ``child-board-options`` and ``default-child-board-options`` list qualifying
    boards (for a site admin, every one on the instance), ``delete-impact``
    names the parent boards of this board's children, and
    ``children-setting-blockers`` the boards that default to this one. Each
    resolves roles once, in bulk (``get_board_roles``), never per board, so
    the count must not grow from one board to many, for a member and for a
    site admin (whose roles short-circuit), with some of the boards hidden
    from the member. The two options lists are also capped
    (``CHILD_BOARD_OPTIONS_LIMIT``) with a ``boards_total``.
    """

    # Measured 2026-11-22 (#2449), the same on SQLite and PostgreSQL 17, flat
    # from 1 to 13 boards of each kind. Owner / member / site admin:
    # child-board-options 17/17/10, default-child-board-options 8/9/2,
    # delete-impact 8/-/5 (owner or site admin only), children-setting-blockers
    # 7/8/4. Budgets are about 2x the largest.
    BUDGETS = {
        "child-board-options": 34,
        "default-child-board-options": 18,
        "delete-impact": 16,
        "children-setting-blockers": 16,
    }
    GROW = 12

    def setUp(self):
        from accounts.models import User
        from boards.tests.test_default_child_board_2208 import add_card, make_board

        self.make_board, self.add_card = make_board, add_card
        self.owner = User.objects.create_user(username="qc_cbr_owner", password="pass")
        self.site_admin = User.objects.create_superuser(username="qc_cbr_su", password="pass")
        self.parent = make_board(self.owner, "QC Pipeline", parent_tier=True)
        self.child = make_board(self.owner, "QC Delivery")
        self.parent_card = add_card(self.parent, "QC parent")
        CardParentLink.objects.create(parent=self.parent_card, child=add_card(self.child, "QC child"))
        self.member = User.objects.create_user(username="qc_cbr_member", password="pass")
        for b in (self.parent, self.child):
            BoardMembership.objects.create(board=b, user=self.member, role=BoardMembership.Role.ADMIN)
        self._grow(1)

    def _grow(self, n):
        """``n`` more of each kind of board the four reads list; every third hidden from the member."""
        for i in range(n):
            tag = f"{Board.objects.count()}-{i}"
            qualifying = self.make_board(self.owner, f"QC qual {tag}")
            other_parent = self.make_board(self.owner, f"QC par {tag}", parent_tier=True)
            if i % 3:
                for b in (qualifying, other_parent):
                    BoardMembership.objects.create(board=b, user=self.member, role=BoardMembership.Role.ADMIN)
            # A parent of one of this child board's cards (delete-impact) that
            # also names it as its default child board (blockers).
            Board.objects.filter(pk=other_parent.pk).update(default_child_board=self.child)
            CardParentLink.objects.create(
                parent=self.add_card(other_parent, "P"), child=self.add_card(self.child, "C"),
            )

    def _urls(self):
        return {
            "child-board-options": (
                f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
            ),
            "default-child-board-options": f"/api/v1/boards/{self.parent.pk}/default-child-board-options/",
            "delete-impact": f"/api/v1/boards/{self.child.pk}/delete-impact/",
            "children-setting-blockers": f"/api/v1/boards/{self.child.pk}/children-setting-blockers/",
        }

    def _counts(self, user):
        client = APIClient()
        client.force_authenticate(user)
        out = {}
        for name, url in self._urls().items():
            with CaptureQueriesContext(connection) as ctx:
                r = client.get(url)
            # delete-impact's gate is the board owner or a site admin.
            expected = 403 if (name == "delete-impact" and user == self.member) else 200
            self.assertEqual(r.status_code, expected, (name, r.content))
            if expected == 200:
                out[name] = len(ctx)
        return out

    def test_reads_are_flat_in_the_number_of_boards(self):
        users = {"owner": self.owner, "member": self.member, "site_admin": self.site_admin}
        before = {label: self._counts(u) for label, u in users.items()}
        self._grow(self.GROW)
        after = {label: self._counts(u) for label, u in users.items()}
        for label in users:
            for name, n in after[label].items():
                with self.subTest(user=label, read=name):
                    self.assertEqual(
                        n, before[label][name],
                        f"{name} grew from {before[label][name]} to {n} queries with "
                        f"{self.GROW} more boards ({label}): roles must be resolved in bulk.",
                    )
                    self.assertLessEqual(
                        n, self.BUDGETS[name], f"{name} used {n} queries ({label}), budget {self.BUDGETS[name]}",
                    )

    def test_options_lists_are_capped_with_a_total(self):
        from unittest import mock

        from boards.services import card_links

        self._grow(4)
        client = APIClient()
        client.force_authenticate(self.site_admin)
        urls = self._urls()
        with mock.patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 3):
            for name in ("child-board-options", "default-child-board-options"):
                with self.subTest(read=name):
                    body = client.get(urls[name]).json()
                    self.assertEqual(len(body["boards"]), 3)
                    self.assertGreater(body["boards_total"], 3)


class WsAudienceRoleQueryCountTests(TestCase):
    """Fan-out pin for the board consumer's audience lookup (#2443, #2449).

    ``consumers.audience_role`` runs once per subscribed socket per audience
    board per access window (the per-socket cache in
    ``BoardConsumer._may_open_audience``), and Channels runs every socket's DB
    work in a process on one shared thread, so every query added here is paid
    by every subscriber of a child board whenever its sibling counts change.
    Pinned exactly, for the two shapes the consumer uses: with the live user
    the access re-check already loaded in this window (the normal path), and
    without one (it loads the user and checks the handshake credential).
    """

    # Measured 2026-11-22 (#2449) on SQLite and PostgreSQL 17: a direct member
    # costs the board (with its group ancestors joined) and one membership
    # read; a non-member the same, answered None; loading the user adds the
    # user row and the session-credential check.
    WITH_USER = 2
    WITHOUT_USER = 4

    def setUp(self):
        from accounts.tests.ws_helpers import bound_scope

        owner = User.objects.create_user(username="aud_qc_owner", password="pass")
        self.board = Board.objects.create(name="Audience QC", owner=owner)
        self.member = User.objects.create_user(username="aud_qc_member", password="pass")
        self.outsider = User.objects.create_user(username="aud_qc_out", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.VIEWER)
        self.scopes = {u.pk: {"user": u, **bound_scope(u)} for u in (self.member, self.outsider)}

    def cost(self, user, *, pass_user):
        from boards import consumers

        scope = self.scopes[user.pk]
        with CaptureQueriesContext(connection) as ctx:
            role = consumers.audience_role(scope, self.board.pk, user=user if pass_user else None)
        return role, len(ctx.captured_queries)

    def test_audience_lookup_is_pinned(self):
        for user, expected_role in ((self.member, "viewer"), (self.outsider, None)):
            for pass_user, budget in ((True, self.WITH_USER), (False, self.WITHOUT_USER)):
                with self.subTest(user=user.username, pass_user=pass_user):
                    self.assertEqual(self.cost(user, pass_user=pass_user), (expected_role, budget))
