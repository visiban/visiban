"""`stage_counts` on the board payloads, for the home stage bar (#2483).

A stage is a column. Each entry counts that column's live cards (archived ones
left out, like ``card_count``), in board order, with zero-card columns kept so
the bar can name the board's first and last stage. A list resolves every row
from one aggregate query (``BoardListSerializer``), so the list's query count
stays flat however many boards and columns it holds.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, SubColumn, Swimlane
from boards.serializers import BoardSerializer, stage_counts_for_boards
from groups.models import Group, GroupMembership


def _board(owner, name, columns, *, group=None, member=True):
    """A board whose columns hold ``(name, live, archived)`` cards, in order."""
    board = Board.objects.create(name=name, owner=owner, group=group)
    if member:
        BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    lane = Swimlane.objects.create(board=board, name="General", position=0)
    pos = 0
    cols = []
    for i, (col_name, live, archived) in enumerate(columns):
        col = Column.objects.create(board=board, name=col_name, position=i, color="#112233")
        cols.append(col)
        for _ in range(live):
            Card.objects.create(board=board, column=col, swimlane=lane, title="L", created_by=owner, position=pos)
            pos += 1
        for _ in range(archived):
            Card.objects.create(
                board=board, column=col, swimlane=lane, title="A", created_by=owner,
                position=pos, archived_at=timezone.now(),
            )
            pos += 1
    return board, cols


class StageCountsListTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="sc_owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _rows(self):
        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, 200)
        return {b["id"]: b for b in r.data["results"]}

    def test_counts_live_cards_per_column_in_board_order(self):
        board, cols = _board(self.owner, "B", [("Backlog", 2, 1), ("Doing", 0, 0), ("Done", 3, 2)])
        # Created out of order on purpose: the list follows position, not id.
        cols[0].position = 5
        cols[0].save(update_fields=["position"])
        row = self._rows()[board.id]
        self.assertEqual(
            row["stage_counts"],
            [
                {"uid": cols[1].uid, "name": "Doing", "color": "#112233", "card_count": 0},
                {"uid": cols[2].uid, "name": "Done", "color": "#112233", "card_count": 3},
                {"uid": cols[0].uid, "name": "Backlog", "color": "#112233", "card_count": 2},
            ],
        )
        self.assertEqual(sum(s["card_count"] for s in row["stage_counts"]), row["card_count"])

    def test_sub_column_cards_count_toward_their_column(self):
        board, cols = _board(self.owner, "Gated", [("Build", 0, 0)])
        SubColumn.objects.create(column=cols[0], position=0, name="Doing")
        SubColumn.objects.create(column=cols[0], position=1, name="Ready")
        lane = board.swimlanes.get()
        Card.objects.create(board=board, column=cols[0], swimlane=lane, title="g0", created_by=self.owner, position=0)
        Card.objects.create(
            board=board, column=cols[0], swimlane=lane, title="g1", created_by=self.owner, position=1, gates_passed=1,
        )
        row = self._rows()[board.id]
        self.assertEqual([(s["name"], s["card_count"]) for s in row["stage_counts"]], [("Build", 2)])

    def test_board_without_columns_has_empty_list(self):
        board = Board.objects.create(name="Bare", owner=self.owner)
        BoardMembership.objects.create(board=board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.assertEqual(self._rows()[board.id]["stage_counts"], [])

    def test_counts_stay_on_their_own_board(self):
        a, _ = _board(self.owner, "A", [("Todo", 1, 0)])
        b, _ = _board(self.owner, "B", [("Todo", 4, 0)])
        rows = self._rows()
        self.assertEqual(rows[a.id]["stage_counts"][0]["card_count"], 1)
        self.assertEqual(rows[b.id]["stage_counts"][0]["card_count"], 4)

    def test_inaccessible_board_is_not_listed(self):
        stranger = User.objects.create_user(username="sc_stranger", password="pass")
        hidden, _ = _board(stranger, "Hidden", [("Secret stage", 1, 0)])
        rows = self._rows()
        self.assertNotIn(hidden.id, rows)
        self.assertNotIn("Secret stage", str(rows))

    def test_group_inherited_board_lists_its_counts(self):
        other = User.objects.create_user(username="sc_other", password="pass")
        group = Group.objects.create(name="G", owner=other)
        GroupMembership.objects.create(group=group, user=self.owner, role=GroupMembership.Role.MEMBER)
        board, _ = _board(other, "Group board", [("Todo", 2, 0)], group=group, member=False)
        self.assertEqual(self._rows()[board.id]["stage_counts"][0]["card_count"], 2)

    def test_list_query_count_is_flat_across_boards_and_columns(self):
        _board(self.owner, "First", [("Todo", 1, 0), ("Done", 1, 0)])

        def count():
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get("/api/v1/boards/")
            self.assertEqual(r.status_code, 200)
            return len(ctx)

        baseline = count()
        for i in range(6):
            _board(self.owner, f"More {i}", [("Todo", 2, 1), ("Doing", 1, 0), ("Review", 0, 0), ("Done", 3, 0)])
        self.assertEqual(count(), baseline, "stage_counts must be one query per page, not one per board")

    def test_stage_counts_is_one_aggregate_query(self):
        a, _ = _board(self.owner, "A", [("Todo", 1, 0), ("Done", 2, 0)])
        b, _ = _board(self.owner, "B", [("Todo", 3, 0)])
        with CaptureQueriesContext(connection) as ctx:
            result = stage_counts_for_boards([a.pk, b.pk, a.pk])
        self.assertEqual(len(ctx), 1)
        self.assertEqual([s["card_count"] for s in result[a.pk]], [1, 2])
        self.assertEqual([s["card_count"] for s in result[b.pk]], [3])

    def test_empty_id_list_runs_no_query(self):
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(stage_counts_for_boards([]), {})
        self.assertEqual(len(ctx), 0)


class StageCountsSingleBoardTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="sc_single", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_retrieve_includes_stage_counts(self):
        board, _ = _board(self.owner, "R", [("Todo", 2, 1), ("Done", 0, 0)])
        r = self.client.get(f"/api/v1/boards/{board.id}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([(s["name"], s["card_count"]) for s in r.data["stage_counts"]], [("Todo", 2), ("Done", 0)])

    def test_unprimed_single_instance_falls_back_to_one_query(self):
        """A bare instance (no list priming) still answers, at one query."""
        board, _ = _board(self.owner, "Bare", [("Todo", 1, 0)])
        serializer = BoardSerializer()
        with CaptureQueriesContext(connection) as ctx:
            stages = serializer.get_stage_counts(board)
        self.assertEqual(len(ctx), 1)
        self.assertEqual(stages[0]["card_count"], 1)

    def test_unannotated_card_count_matches_stage_counts_sum(self):
        """A bare board with archived cards: card_count counts live cards only."""
        board, _ = _board(self.owner, "Sum", [("Todo", 2, 1), ("Done", 1, 2)])
        serializer = BoardSerializer()
        self.assertFalse(hasattr(board, "_card_count"))
        self.assertEqual(serializer.get_card_count(board), 3)
        self.assertEqual(
            serializer.get_card_count(board),
            sum(s["card_count"] for s in serializer.get_stage_counts(board)),
        )

    def test_primed_map_without_this_board_falls_back(self):
        """A primed map that lacks the row is not trusted as 'no columns'."""
        board, _ = _board(self.owner, "Missing", [("Todo", 1, 0)])
        serializer = BoardSerializer()
        serializer._stage_counts_map = {}
        self.assertEqual(serializer.get_stage_counts(board)[0]["card_count"], 1)


class StageCountsGroupBoardsTests(TestCase):
    """``GET /api/v1/groups/{id}/boards/`` renders many=True, so it is primed too."""

    def setUp(self):
        self.owner = User.objects.create_user(username="sc_group", password="pass")
        self.group = Group.objects.create(name="SC", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _get(self):
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(f"/api/v1/groups/{self.group.id}/boards/")
        self.assertEqual(r.status_code, 200)
        return r, len(ctx)

    def test_group_boards_carry_counts_at_a_flat_query_count(self):
        board, _ = _board(self.owner, "G0", [("Todo", 1, 1), ("Done", 2, 0)], group=self.group)
        r, baseline = self._get()
        rows = r.data["results"] if isinstance(r.data, dict) else r.data
        row = next(b for b in rows if b["id"] == board.id)
        self.assertEqual([s["card_count"] for s in row["stage_counts"]], [1, 2])
        for i in range(5):
            _board(self.owner, f"G{i + 1}", [("Todo", 2, 0), ("Done", 1, 0)], group=self.group)
        self.assertEqual(self._get()[1], baseline)
