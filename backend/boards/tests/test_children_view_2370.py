"""``GET /api/v1/boards/{id}/children-view/``: Children mode on the Board tab (#2370).

Per viewer, like ``Card.children_rollup`` (#2210): lane totals count only
children the viewer can open; children on a board the viewer cannot open are a
count only (decision B, #1104) and never enter a state count, the fold or the
row order. Archived children are not counted. Share links get nothing.
"""

from datetime import timedelta

import jsonschema
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from drf_spectacular.generators import SchemaGenerator
from rest_framework.test import APIClient

from accounts.models import SCOPE_READ, SCOPE_WRITE, PersonalAccessToken
from boards.models import BoardMembership, Card, CardMovement, CardParentLink
from boards.serializers import PublicBoardSerializer
from boards.services import children_view
from boards.services.children_view import CHILDREN_VIEW_PAGE_SIZE, children_view_for_viewer
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from boards.tests.test_card_children_rollup_2210 import _RollupFixture
from boards.tests.test_card_parent_links import Role, _board_with_card
from boards.tests.test_move_schema_contract import _openapi3_nullable_to_jsonschema

LANE_KEYS = {
    "id", "name", "position", "parents", "child_boards", "total", "in_progress",
    "done", "doing", "todo", "blocked", "hidden", "folded", "last_moved_at",
    "planned", "planned_only",
}
ROW_KEYS = {
    "id", "title", "swimlane_id", "column_id", "column_name", "assignee", "rollup",
    "in_progress", "folded", "planned", "planned_only", "child_board_id", "children",
}
STATES = ("done", "doing", "todo", "blocked")


def _move_ago(card, board, column, user, ago):
    """A CardMovement stamped ``ago`` in the past (moved_at is auto-set on create)."""
    m = CardMovement.objects.create(card=card, board=board, to_column=column, moved_by=user)
    CardMovement.objects.filter(pk=m.pk).update(moved_at=timezone.now() - ago)


class _ViewFixture(_RollupFixture):
    """The #2210 fixture (parent P on Portfolio, five live children on Delivery,
    one per state, plus an archived one), a fully done parent in the same lane,
    and a second lane whose parent has children on a board few can open."""

    def _setup_view(self):
        self._setup_rollup()
        self.lane_p = self.parent.swimlane
        self.done_parent = _make_card(self.parent.column, self.lane_p, title="all done")
        CardParentLink.objects.create(
            parent=self.done_parent,
            child=_make_card(self.col_done, self.lane_c, title="finished SECRET-C"),
            created_by=self.owner,
        )
        self.lane2 = _make_swimlane(self.pboard, name="Globex", order=1)
        self.locked_parent = _make_card(self.parent.column, self.lane2, title="locked parent")
        self.hboard = _make_board(self.owner, name="Secret board SECRET-H")
        self.hcol = _make_column(self.hboard, name="H todo SECRET-H")
        self.hcol2 = _make_column(self.hboard, name="H doing SECRET-H", order=2)
        hlane = _make_swimlane(self.hboard, name="H lane SECRET-H")
        self.hidden_children = [
            _make_card(self.hcol, hlane, title="h1 SECRET-H"),
            _make_card(self.hcol2, hlane, title="h2 SECRET-H"),
        ]
        for c in self.hidden_children:
            CardParentLink.objects.create(parent=self.locked_parent, child=c, created_by=self.owner)

    def _get(self, user, query="", board=None):
        return self._client(user).get(f"/api/v1/boards/{(board or self.pboard).pk}/children-view/{query}")

    def _view(self, user, query=""):
        res = self._get(user, query)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


class ChildrenViewReadTests(_ViewFixture, TestCase):
    def setUp(self):
        self._setup_view()
        self.viewer = self._user("cv_viewer", parent_role=Role.VIEWER, child_role=Role.VIEWER)

    def test_lane_rollups_partition_the_children_the_viewer_can_open(self):
        body = self._view(self.viewer)
        lanes = {lane["id"]: lane for lane in body["lanes"]}
        self.assertEqual([lane["id"] for lane in body["lanes"]], [self.lane_p.pk, self.lane2.pk])
        for lane in body["lanes"]:
            self.assertEqual(set(lane), LANE_KEYS)
        acme = lanes[self.lane_p.pk]
        # P: blocked 2 (manual, relation in a done column), done 1, doing 1,
        # todo 1; archived out. The done parent adds one done child.
        self.assertEqual(
            {k: acme[k] for k in ("total", "in_progress", *STATES, "hidden", "parents", "child_boards", "folded")},
            {"total": 6, "in_progress": 4, "done": 2, "doing": 1, "todo": 1, "blocked": 2,
             "hidden": 0, "parents": 2, "child_boards": 1, "folded": 1},
        )
        globex = lanes[self.lane2.pk]
        # Hidden children never enter state counts: a count only.
        self.assertEqual(
            {k: globex[k] for k in ("total", "in_progress", *STATES, "hidden", "parents", "child_boards", "folded")},
            {"total": 0, "in_progress": 0, "done": 0, "doing": 0, "todo": 0, "blocked": 0,
             "hidden": 2, "parents": 1, "child_boards": 0, "folded": 0},
        )
        self.assertEqual(body["board_total"], {"in_progress": 4, "total": 6, "blocked": 2, "hidden": 2, "planned": 0})

    def test_lane_totals_equal_the_sum_of_the_visible_rows(self):
        body = self._view(self.viewer)
        for lane in body["lanes"]:
            rows = [r for r in body["rows"] if r["swimlane_id"] == lane["id"]]
            visible = [r["rollup"] for r in rows if r["rollup"]["visible"]]
            self.assertEqual(lane["parents"], len(rows))
            for k in ("total", *STATES):
                self.assertEqual(lane[k], sum(r[k] for r in visible), k)
            self.assertEqual(lane["hidden"], sum(r["rollup"]["total"] for r in rows if not r["rollup"]["visible"]))
            self.assertEqual(lane["in_progress"], sum(r["in_progress"] for r in rows if r["in_progress"] is not None))

    def _planned_parent(self):
        """A parent with a planned to-do child (recently moved), a blocked planned child and a done planned child."""
        later = _make_column(self.pboard, name="Later", order=9)
        parent = _make_card(self.parent.column, self.lane_p, title="planned parent")
        plain = _make_card(self.todo.column, self.lane_c, title="planned plain")
        blocked = _make_card(self.todo.column, self.lane_c, title="planned blocked", blocked_at=timezone.now())
        done = _make_card(self.col_done, self.lane_c, title="planned done")
        for kid in (plain, blocked, done):
            CardParentLink.objects.create(parent=parent, child=kid, created_by=self.owner, needed_at_column=later)
        _move_ago(plain, self.cboard, plain.column, self.owner, timedelta(hours=1))
        return parent

    def test_row_rollup_equals_the_cards_children_rollup(self):
        # Includes planned children: Children mode and the card footer must partition them identically
        # (blocked and done beat planned; planned leaves todo and last_moved_at).
        planned = self._planned_parent()
        body = self._view(self.viewer)
        full = self._cards(self.viewer)
        for row in body["rows"]:
            self.assertEqual(set(row), ROW_KEYS)
            # Row rollups carry the #2210 keys only; the card's #2551 planned keys are additive extras.
            card = {k: v for k, v in full[row["id"]]["children_rollup"].items() if k in row["rollup"]}
            self.assertEqual(row["rollup"], card)
        row = next(r for r in body["rows"] if r["id"] == planned.pk)["rollup"]
        self.assertEqual((row["total"], row["todo"], row["blocked"], row["done"]), (3, 0, 1, 1))
        self.assertIsNone(row["last_moved_at"])
        self.assertEqual(full[planned.pk]["children_rollup"]["planned"], 1)

    def test_planned_children_are_not_in_progress_and_totals_stay_sums(self):
        planned = self._planned_parent()
        body = self._view(self.viewer)
        for row in (r for r in body["rows"] if r["rollup"]["visible"]):
            roll = row["rollup"]
            self.assertEqual(row["in_progress"], roll["todo"] + roll["doing"] + roll["blocked"], row["id"])
        row = next(r for r in body["rows"] if r["id"] == planned.pk)
        # planned plain, blocked and done: only the blocked one is in progress (blocked beats planned).
        self.assertEqual(row["in_progress"], 1)
        for lane in body["lanes"]:
            rows = [r for r in body["rows"] if r["swimlane_id"] == lane["id"]]
            self.assertEqual(lane["in_progress"], sum(r["in_progress"] for r in rows if r["in_progress"] is not None))
        self.assertEqual(body["board_total"]["in_progress"], sum(lane["in_progress"] for lane in body["lanes"]))

    def test_a_parent_with_only_planned_work_folds(self):
        later = _make_column(self.pboard, name="Later", order=9)
        parent = _make_card(self.parent.column, self.lane_p, title="only planned")
        kid = _make_card(self.todo.column, self.lane_c, title="waiting")
        CardParentLink.objects.create(parent=parent, child=kid, created_by=self.owner, needed_at_column=later)
        row = next(r for r in self._view(self.viewer)["rows"] if r["id"] == parent.pk)
        self.assertEqual((row["in_progress"], row["folded"]), (0, True))

    def test_rows_order_blocked_first_then_most_recent_move_folded_last(self):
        # Unblocked parents, created oldest-first: A's child moved 1 day ago, B's
        # 5 days ago, C's never. Order must be most recent move first with
        # never-moved last among the unfolded, not creation or id order.
        made = {}
        for name, ago in (("A", timedelta(days=1)), ("B", timedelta(days=5)), ("C", None)):
            made[name] = _make_card(self.parent.column, self.lane_p, title=f"parent {name}")
            kid = _make_card(self.col_doing, self.lane_c, title=f"kid {name}")
            CardParentLink.objects.create(parent=made[name], child=kid, created_by=self.owner)
            if ago is not None:
                _move_ago(kid, self.cboard, self.col_doing, self.owner, ago)
        ids = [r["id"] for r in self._view(self.viewer)["rows"]]
        self.assertEqual(
            ids,
            [self.parent.pk, made["A"].pk, made["B"].pk, made["C"].pk, self.done_parent.pk, self.locked_parent.pk],
        )
        rows = {r["id"]: r for r in self._view(self.viewer)["rows"]}
        self.assertTrue(rows[self.done_parent.pk]["folded"])
        self.assertFalse(rows[self.parent.pk]["folded"])

    def test_visible_row_carries_its_children_and_board(self):
        body = self._view(self.viewer)
        row = next(r for r in body["rows"] if r["id"] == self.parent.pk)
        self.assertEqual(row["child_board_id"], self.cboard.pk)
        self.assertEqual(row["in_progress"], 4)
        # Done children are left out unless asked; archived ones always are.
        self.assertEqual(
            {c["id"]: c["state"] for c in row["children"]},
            {self.todo.pk: "todo", self.doing.pk: "doing", self.manual.pk: "blocked", self.by_rel.pk: "blocked"},
        )
        with_done = next(r for r in self._view(self.viewer, "?done=true")["rows"] if r["id"] == self.parent.pk)
        self.assertIn(self.done.pk, {c["id"] for c in with_done["children"]})
        self.assertNotIn(self.archived.pk, {c["id"] for c in with_done["children"]})
        self.assertEqual([b["id"] for b in body["child_boards"]], [self.cboard.pk])
        board = body["child_boards"][0]
        self.assertEqual(board["role"], "viewer")
        # Counts against the whole column, not only these children.
        _make_card(self.col_doing, self.lane_c, title="unlinked")
        cols = {c["id"]: c for c in self._view(self.viewer)["child_boards"][0]["columns"]}
        self.assertEqual(cols[self.col_doing.pk]["card_count"], 3)

    def test_locked_row_is_a_count_and_nothing_else(self):
        body = self._view(self.viewer)
        row = next(r for r in body["rows"] if r["id"] == self.locked_parent.pk)
        self.assertEqual(row["rollup"], {"visible": False, "total": 2})
        self.assertEqual((row["in_progress"], row["folded"], row["child_board_id"], row["children"]),
                         (None, False, None, []))
        self.assertNotIn("SECRET-H", self._get(self.viewer).content.decode())
        self.assertNotIn(self.hboard.pk, [b["id"] for b in body["child_boards"]])

    def test_hidden_child_state_never_changes_the_viewers_read(self):
        # A visible, unblocked, never-moved neighbor in the locked row's lane: an
        # order leak (hidden blocked state or move time reaching the sort key)
        # would lift the locked row ahead of it, which a lone row cannot show.
        vis = _make_card(self.parent.column, self.lane2, title="visible neighbor")
        CardParentLink.objects.create(
            parent=vis, child=_make_card(self.col_doing, self.lane_c, title="vis kid"), created_by=self.owner,
        )
        before = self._view(self.viewer)
        lane2_ids = [r["id"] for r in before["rows"] if r["swimlane_id"] == self.lane2.pk]
        self.assertEqual(lane2_ids, [vis.pk, self.locked_parent.pk])
        # Block one hidden child, move the other to done, move it recently.
        h1, h2 = self.hidden_children
        h1.blocked_at = timezone.now()
        h1.save(update_fields=["blocked_at"])
        hdone = _make_column(self.hboard, name="H done", order=3, is_done=True)
        h2.column = hdone
        h2.save(update_fields=["column"])
        CardMovement.objects.create(card=h2, board=self.hboard, to_column=hdone, moved_by=self.owner)
        after = self._view(self.viewer)
        self.assertEqual(after, before)
        self.assertEqual([r["id"] for r in after["rows"] if r["swimlane_id"] == self.lane2.pk],
                         [vis.pk, self.locked_parent.pk])

    def _move(self, card, board, column, ago):
        m = CardMovement.objects.create(card=card, board=board, to_column=column, moved_by=self.owner)
        stamp = timezone.now() - ago
        CardMovement.objects.filter(pk=m.pk).update(moved_at=stamp)
        return stamp

    def test_lane_last_moved_at_is_the_max_over_visible_rows(self):
        self._move(self.doing, self.cboard, self.col_doing, timedelta(days=9))
        newest = self._move(self.todo, self.cboard, self.todo.column, timedelta(days=2))
        body = self._view(self.viewer)
        lanes = {lane["id"]: lane for lane in body["lanes"]}
        visible = [r["rollup"]["last_moved_at"] for r in body["rows"]
                   if r["swimlane_id"] == self.lane_p.pk and r["rollup"]["last_moved_at"]]
        self.assertEqual(lanes[self.lane_p.pk]["last_moved_at"], max(visible))
        self.assertEqual(parse_datetime(lanes[self.lane_p.pk]["last_moved_at"]), newest)
        self.assertIsNone(lanes[self.lane2.pk]["last_moved_at"])

    def test_hidden_child_move_never_changes_the_lane_last_moved_at(self):
        before = {lane["id"]: lane["last_moved_at"] for lane in self._view(self.viewer)["lanes"]}
        self._move(self.hidden_children[0], self.hboard, self.hcol2, timedelta(minutes=1))
        after = {lane["id"]: lane["last_moved_at"] for lane in self._view(self.viewer)["lanes"]}
        self.assertEqual(after, before)
        self.assertIsNone(after[self.lane2.pk])

    def test_archived_children_are_not_counted(self):
        for c in self.hidden_children:
            c.archived_at = timezone.now()
            c.save(update_fields=["archived_at"])
        body = self._view(self.viewer)
        self.assertEqual({lane["id"]: lane["hidden"] for lane in body["lanes"]}[self.lane2.pk], 0)
        # A parent with no live children is not a row.
        self.assertNotIn(self.locked_parent.pk, [r["id"] for r in body["rows"]])

    def test_archived_parent_is_not_a_row(self):
        self.parent.archived_at = timezone.now()
        self.parent.save(update_fields=["archived_at"])
        body = self._view(self.viewer)
        self.assertNotIn(self.parent.pk, [r["id"] for r in body["rows"]])
        self.assertEqual(body["board_total"]["total"], 1)

    def test_child_board_access_reveals_the_states(self):
        BoardMembership.objects.create(board=self.hboard, user=self.viewer, role=Role.VIEWER)
        globex = {lane["id"]: lane for lane in self._view(self.viewer)["lanes"]}[self.lane2.pk]
        self.assertEqual((globex["total"], globex["todo"], globex["doing"], globex["hidden"]), (2, 1, 1, 0))

    def test_losing_the_child_board_hides_states_on_the_next_read(self):
        self._view(self.viewer)
        BoardMembership.objects.filter(board=self.cboard, user=self.viewer).delete()
        body = self._view(self.viewer)
        self.assertEqual(body["board_total"], {"in_progress": 0, "total": 0, "blocked": 0, "hidden": 8, "planned": 0})
        self.assertEqual(body["child_boards"], [])
        self.assertNotIn("SECRET-C", self._get(self.viewer).content.decode())

    def test_children_on_two_boards_read_only_the_first_links_board(self):
        other_board, stray = _board_with_card(self.owner, parent_tier=False, name="Other", title="stray SECRET-O")
        BoardMembership.objects.create(board=other_board, user=self.viewer, role=Role.VIEWER)
        CardParentLink.objects.create(parent=self.parent, child=stray, created_by=self.owner)
        body = self._view(self.viewer, "?done=true")
        row = next(r for r in body["rows"] if r["id"] == self.parent.pk)
        self.assertEqual(row["rollup"]["total"], 5)
        self.assertNotIn(stray.pk, {c["id"] for c in row["children"]})
        self.assertNotIn(other_board.pk, [b["id"] for b in body["child_boards"]])


class ChildrenViewPagingTests(_ViewFixture, TestCase):
    def setUp(self):
        self._setup_view()
        self.viewer = self._user("cv_pager", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        self.lane3 = _make_swimlane(self.pboard, name="Big", order=2)
        self.many = []
        for i in range(CHILDREN_VIEW_PAGE_SIZE + 5):
            p = _make_card(self.parent.column, self.lane3, title=f"p{i}")
            CardParentLink.objects.create(
                parent=p, child=_make_card(self.col_doing, self.lane_c, title=f"k{i}"), created_by=self.owner,
            )
            self.many.append(p.pk)

    def test_pages_of_twenty_without_gaps_or_repeats(self):
        first = self._view(self.viewer)
        self.assertEqual(len(first["rows"]), CHILDREN_VIEW_PAGE_SIZE)
        self.assertIsNotNone(first["next_cursor"])
        second = self._view(self.viewer, f"?cursor={first['next_cursor']}")
        self.assertIsNone(second["next_cursor"])
        ids = [r["id"] for r in first["rows"] + second["rows"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), len(self.many) + 3)
        # Every page carries every lane's rollup.
        self.assertEqual(second["lanes"], first["lanes"])

    def test_paging_a_lane_with_distinct_move_times_keeps_most_recent_first(self):
        # Real `moved` keys in the cursor: 22 of the 25 parents have a child
        # moved at a distinct time, 3 never moved. Expected order is computed
        # here, independent of the service: newest move first, never-moved last
        # (newest id first among them).
        moved_ago = {}
        for i, pid in enumerate(self.many[:22]):
            kid = CardParentLink.objects.get(parent_id=pid).child
            # Scrambled relative to id so id order cannot satisfy the assertion.
            moved_ago[pid] = (i * 7) % 22 + 1
            _move_ago(kid, self.cboard, self.col_doing, self.owner, timedelta(hours=moved_ago[pid]))
        never = sorted(self.many[22:], reverse=True)
        expected = sorted(moved_ago, key=moved_ago.get) + never
        first = self._view(self.viewer, f"?lane={self.lane3.pk}")
        self.assertEqual(len(first["rows"]), CHILDREN_VIEW_PAGE_SIZE)
        second = self._view(self.viewer, f"?lane={self.lane3.pk}&cursor={first['next_cursor']}")
        self.assertIsNone(second["next_cursor"])
        self.assertEqual([r["id"] for r in first["rows"] + second["rows"]], expected)

    def test_lane_filters_the_rows_not_the_rollups(self):
        body = self._view(self.viewer, f"?lane={self.lane2.pk}")
        self.assertEqual([r["id"] for r in body["rows"]], [self.locked_parent.pk])
        self.assertEqual(len(body["lanes"]), 3)
        big = self._view(self.viewer, f"?lane={self.lane3.pk}")
        rest = self._view(self.viewer, f"?lane={self.lane3.pk}&cursor={big['next_cursor']}")
        self.assertEqual(sorted(r["id"] for r in big["rows"] + rest["rows"]), sorted(self.many))

    def test_lane_of_another_board_is_404(self):
        res = self._get(self.viewer, f"?lane={self.lane_c.pk}")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self._get(self.viewer, "?lane=999999999").status_code, 404)

    def test_malformed_params_are_400_invalid_query_param(self):
        for query in ("?lane=abc", "?lane=-1", "?lane=1.5", "?lane=" + "9" * 19, "?lane=١",
                      "?done=maybe", "?cursor=", "?cursor=!!!", "?cursor=bnVsbA",
                      "?cursor=" + "A" * 300):
            res = self._get(self.viewer, query)
            self.assertEqual(res.status_code, 400, query)
            self.assertEqual(res.json()["code"], "invalid_query_param", query)
        # A well-formed list of the wrong types is refused too.
        for bad in ([1, 2, 3], [True] * 7, ["a"] * 7, [1.5] * 7, {"a": 1}):
            raw = children_view.encode_cursor(bad) if isinstance(bad, list) else "eyJhIjoxfQ"
            self.assertEqual(self._get(self.viewer, f"?cursor={raw}").status_code, 400, bad)

    def test_query_count_is_flat_in_parents_lanes_and_children(self):
        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._view(self.viewer, "?done=true")
            return len(ctx.captured_queries)

        before = count()
        lane4 = _make_swimlane(self.pboard, name="More", order=3)
        for i in range(10):
            p = _make_card(self.parent.column, lane4, title=f"q{i}")
            for j in range(3):
                CardParentLink.objects.create(
                    parent=p, child=_make_card(self.col_doing, self.lane_c, title=f"q{i}-{j}"),
                    created_by=self.owner,
                )
        self.assertEqual(count(), before)

    def test_service_cost_and_statement_shape(self):
        # Distinct assignees on every card so a missing select_related("assignee")
        # on the parents or children query shows up as a per-row query.
        people = [_make_user(f"cv_assignee_{i}") for i in range(8)]
        for i, card in enumerate(Card.objects.filter(board__in=[self.pboard, self.cboard])):
            Card.objects.filter(pk=card.pk).update(assignee=people[i % len(people)])
        with CaptureQueriesContext(connection) as ctx:
            children_view_for_viewer(self.pboard, self.viewer, include_done=True)
        sqls = [q["sql"] for q in ctx.captured_queries]
        # Lanes, the link rows, child boards, two role queries, then the page:
        # parents, children, their blockers, live cards per column, columns.
        self.assertEqual(len(sqls), 10, "\n".join(sqls))
        # Exactly one statement reads every link of the board (the only
        # unbounded read); the page's reads are keyed by the page's ids.
        self.assertEqual(sum('FROM "card_parent_links"' in s for s in sqls), 1)


class ChildrenViewAccessTests(_ViewFixture, TestCase):
    def setUp(self):
        self._setup_view()

    def test_no_access_is_404_and_anonymous_is_refused(self):
        stranger = _make_user("cv_stranger")
        self.assertEqual(self._get(stranger).status_code, 404)
        self.assertEqual(self._get(stranger, f"?lane={self.lane_p.pk}").status_code, 404)
        self.assertIn(APIClient().get(f"/api/v1/boards/{self.pboard.pk}/children-view/").status_code, (401, 403))

    def test_any_role_reads_it(self):
        for role in (Role.VIEWER, Role.COLLABORATOR, Role.MEMBER, Role.ADMIN):
            user = self._user(f"cv_{role}", parent_role=role)
            self.assertEqual(self._get(user).status_code, 200, role)

    def test_only_get_is_routed(self):
        user = self._user("cv_methods", parent_role=Role.ADMIN, child_role=Role.ADMIN)
        url = f"/api/v1/boards/{self.pboard.pk}/children-view/"
        client = self._client(user)
        for method in ("post", "put", "patch", "delete"):
            self.assertEqual(getattr(client, method)(url, {}, format="json").status_code, 405, method)

    def test_pending_password_change_is_refused(self):
        user = self._user("cv_pending", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        user.must_change_password = True
        user.save(update_fields=["must_change_password"])
        self.assertEqual(self._get(user).status_code, 403)

    def test_site_admin_and_owner_read_every_child_board(self):
        site_admin = _make_user("cv_site_admin")
        site_admin.can_access_all_content = True
        site_admin.save(update_fields=["can_access_all_content"])
        # The owner of both boards holds no membership row on the hidden board.
        BoardMembership.objects.filter(board=self.hboard, user=self.owner).delete()
        for user, role in ((site_admin, "site_admin"), (self.owner, "admin")):
            body = self._view(user)
            self.assertTrue(all(r["rollup"]["visible"] for r in body["rows"]), user)
            self.assertEqual(body["board_total"]["hidden"], 0)
            self.assertEqual({b["role"] for b in body["child_boards"]}, {role})

    def test_group_inherited_child_board_role_reveals_the_states(self):
        from groups.models import Group, GroupMembership

        user = self._user("cv_group", parent_role=Role.VIEWER)
        group = Group.objects.create(name="Delivery group", owner=self.owner)
        GroupMembership.objects.create(group=group, user=user, role=GroupMembership.Role.VIEWER)
        self.cboard.group = group
        self.cboard.save(update_fields=["group"])
        row = next(r for r in self._view(user)["rows"] if r["id"] == self.parent.pk)
        self.assertTrue(row["rollup"]["visible"])
        self.assertEqual(row["child_board_id"], self.cboard.pk)

    def test_board_without_children_is_400_children_not_enabled(self):
        user = self._user("cv_child_tier", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        res = self._get(user, board=self.cboard)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["code"], "children_not_enabled")

    def test_absent_viewer_fails_closed(self):
        from django.contrib.auth.models import AnonymousUser

        # A planned child must not reach an absent viewer either (#1075, #2550).
        CardParentLink.objects.filter(child=self.todo).update(needed_at_column=self.parent.column)
        for absent in (None, AnonymousUser()):
            body = children_view_for_viewer(self.pboard, absent, include_done=True)
            self.assertEqual(body["child_boards"], [])
            self.assertTrue(all(r["rollup"] == {"visible": False, "total": r["rollup"]["total"]} for r in body["rows"]))
            self.assertTrue(all(r["children"] == [] and r["child_board_id"] is None for r in body["rows"]))
            self.assertEqual(body["board_total"]["total"], 0)
            self.assertTrue(all(r["planned"] is None and r["planned_only"] is False for r in body["rows"]))
            self.assertTrue(all(lane["planned"] == 0 and lane["planned_only"] == 0 for lane in body["lanes"]))
            self.assertEqual(body["board_total"]["planned"], 0)

    def test_share_links_get_nothing(self):
        # PublicBoardSerializer gains no field for Children mode (Rule 11).
        fields = set(PublicBoardSerializer().fields)
        self.assertFalse({"lanes", "rows", "child_boards", "board_total", "children_view"} & fields)


class ChildrenViewPatScopeTests(_ViewFixture, TestCase):
    """PAT scopes on ``children-view`` (#2539).

    ``baseline_scopes_for`` maps a safe method to ``read`` by path and method, so
    this route needs no registration; these tests pin that. A scoped PAT is the
    intersection of its scopes and its owner's board access, so a ``read`` token
    still gets 404 on a board its user cannot open.
    """

    def setUp(self):
        self._setup_view()
        self.viewer = self._user("cv_pat_viewer", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        self.url = f"/api/v1/boards/{self.pboard.pk}/children-view/"

    def _pat_get(self, user, scopes):
        _, raw = PersonalAccessToken.generate(user, "agent", scopes=scopes)
        return APIClient().get(self.url, HTTP_AUTHORIZATION=f"Token {raw}")

    def test_read_scoped_pat_reads_a_board_the_user_can_open(self):
        res = self._pat_get(self.viewer, [SCOPE_READ])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIn("lanes", res.json())

    def test_pat_without_the_read_scope_is_refused(self):
        self.assertEqual(self._pat_get(self.viewer, [SCOPE_WRITE]).status_code, 403)

    def test_pat_with_an_empty_scope_grant_is_refused(self):
        # An explicit grant of nothing is denied everywhere; the absent-scope branch.
        self.assertEqual(self._pat_get(self.viewer, []).status_code, 403)

    def test_read_scoped_pat_for_a_user_without_board_access_is_refused(self):
        stranger = _make_user("cv_pat_stranger")
        self.assertEqual(self._pat_get(stranger, [SCOPE_READ]).status_code, 404)


class ChildrenViewSchemaTests(_ViewFixture, TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.schema = SchemaGenerator().get_schema(request=None, public=True)

    def setUp(self):
        self._setup_view()
        self.viewer = self._user("cv_schema", parent_role=Role.VIEWER, child_role=Role.VIEWER)

    def _validate(self, status_code, body):
        op = self.schema["paths"]["/api/v1/boards/{id}/children-view/"]["get"]
        fragment = op["responses"][str(status_code)]["content"]["application/json"]["schema"]
        jsonschema.validate(
            instance=body,
            schema=_openapi3_nullable_to_jsonschema({**fragment, "components": self.schema["components"]}),
        )

    def test_live_responses_match_the_published_schema(self):
        self.manual.assignee = self.viewer
        self.manual.save(update_fields=["assignee"])
        self.parent.assignee = self.viewer
        self.parent.save(update_fields=["assignee"])
        self._validate(200, self._view(self.viewer, "?done=true"))
        res = self._get(self.viewer, "?lane=abc")
        self._validate(400, res.json())
        child_tier = self._get(self.viewer, board=self.cboard)
        self._validate(400, child_tier.json())

    def test_last_moved_at_is_an_iso_datetime(self):
        m = CardMovement.objects.create(card=self.doing, board=self.cboard, to_column=self.col_doing, moved_by=self.owner)
        CardMovement.objects.filter(pk=m.pk).update(moved_at=timezone.now() - timedelta(days=1))
        row = next(r for r in self._view(self.viewer)["rows"] if r["id"] == self.parent.pk)
        self.assertRegex(row["rollup"]["last_moved_at"], r"^\d{4}-\d{2}-\d{2}T")


class ChildrenViewPlannedTests(_ViewFixture, TestCase):
    """Planned sections (#2550): a bucket of their own, never in progress (#2551 owner ruling)."""

    def setUp(self):
        self._setup_view()
        self.viewer = self._user("cv_planned", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        self.later = self.parent.column  # any parent-board column stands in for "Needed at"

    def _plan(self, child):
        CardParentLink.objects.filter(child=child).update(needed_at_column=self.later)

    def test_planned_is_its_own_bucket_and_flags_the_child(self):
        before = self._view(self.viewer)
        acme_before = next(lane for lane in before["lanes"] if lane["id"] == self.lane_p.pk)
        self._plan(self.todo)
        self._plan(self.done)  # a done child is never counted planned
        body = self._view(self.viewer, "?done=true")
        acme = next(lane for lane in body["lanes"] if lane["id"] == self.lane_p.pk)
        # The planned child leaves to do and in progress, and stays in total.
        self.assertEqual(
            (acme["planned"], acme["planned_only"], acme["in_progress"], acme["todo"], acme["total"]),
            (1, 0, acme_before["in_progress"] - 1, acme_before["todo"] - 1, acme_before["total"]),
        )
        for lane in body["lanes"]:
            self.assertEqual(lane["total"], sum(lane[k] for k in (*STATES, "planned")))
            self.assertEqual(lane["in_progress"], lane["todo"] + lane["doing"] + lane["blocked"])
        row = next(r for r in body["rows"] if r["id"] == self.parent.pk)
        self.assertEqual((row["planned"], row["planned_only"], row["folded"]), (1, False, False))
        self.assertEqual(row["in_progress"], row["rollup"]["todo"] + row["rollup"]["doing"] + row["rollup"]["blocked"])
        flags = {c["id"]: c["planned"] for c in row["children"]}
        self.assertTrue(flags[self.todo.pk])
        self.assertFalse(flags[self.done.pk])
        self.assertFalse(flags[self.doing.pk])
        self.assertEqual(body["board_total"]["planned"], 1)
        # The rollup stays the card's children_rollup: planned is not added to it.
        self.assertNotIn("planned", row["rollup"])

    def test_blocked_beats_planned(self):
        """The card rollup's order: blocked and done beat planned, which beats to do."""
        self._plan(self.manual)  # manually blocked child
        body = self._view(self.viewer)
        row = next(r for r in body["rows"] if r["id"] == self.parent.pk)
        self.assertEqual(row["planned"], 0)
        self.assertFalse(next(c for c in row["children"] if c["id"] == self.manual.pk)["planned"])

    def test_released_link_is_not_planned(self):
        CardParentLink.objects.filter(child=self.todo).update(
            needed_at_column=self.later, planned_released_at=timezone.now(),
        )
        body = self._view(self.viewer)
        row = next(r for r in body["rows"] if r["id"] == self.parent.pk)
        self.assertEqual(row["planned"], 0)
        self.assertFalse(next(c for c in row["children"] if c["id"] == self.todo.pk)["planned"])

    def test_row_with_only_planned_work_folds_last_in_its_lane(self):
        only = _make_card(self.parent.column, self.lane_p, title="only planned")
        kid = _make_card(self.col_doing, self.lane_c, title="planned kid SECRET-C")
        CardParentLink.objects.create(parent=only, child=kid, created_by=self.owner, needed_at_column=self.later)
        body = self._view(self.viewer)
        acme = next(lane for lane in body["lanes"] if lane["id"] == self.lane_p.pk)
        # planned_only is the subset of folded rows that hold planned work.
        self.assertEqual((acme["folded"], acme["planned_only"], acme["planned"]), (2, 1, 1))
        lane_rows = [r for r in body["rows"] if r["swimlane_id"] == self.lane_p.pk]
        row = next(r for r in lane_rows if r["id"] == only.pk)
        self.assertEqual((row["planned_only"], row["folded"], row["in_progress"]), (True, True, 0))
        # Unfolded rows first, then folded and planned-only together.
        self.assertEqual(lane_rows[0]["id"], self.parent.pk)
        self.assertEqual({r["id"] for r in lane_rows[1:]}, {only.pk, self.done_parent.pk})

    def test_planned_children_on_a_hidden_board_never_reach_any_count(self):
        """Rule 19: a planned count for a parent the viewer can't open must not leak."""
        before = self._view(self.viewer)
        for c in self.hidden_children:
            self._plan(c)
        after = self._view(self.viewer)
        self.assertEqual(before["lanes"], after["lanes"])
        self.assertEqual(before["board_total"], after["board_total"])
        locked = next(r for r in after["rows"] if r["id"] == self.locked_parent.pk)
        self.assertEqual((locked["planned"], locked["planned_only"]), (None, False))
        self.assertEqual(before["rows"], after["rows"])
        # Positive control: the planning did land, and a reader who can open the hidden board sees it.
        owner_row = next(r for r in self._view(self.owner)["rows"] if r["id"] == self.locked_parent.pk)
        self.assertEqual(owner_row["planned"], len(self.hidden_children))
