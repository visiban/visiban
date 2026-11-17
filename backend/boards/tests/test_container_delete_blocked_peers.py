"""A cascading delete tells the surviving cards it unblocked (#1634).

Deleting a column, swimlane or board cascades its cards, and the Django admin
can delete cards singly or in bulk. A card *outside* the deleted set that one
of the deleted cards was blocking keeps its row, but its ``blocker_count``
drops. ``delete_card`` publishes ``card.updated`` for such peers (#449); these
tests pin the same for every cascading path: the REST destroy views and the
admin ``delete_model`` / ``delete_queryset`` for columns, swimlanes, boards and
cards.

Each test pins:

* the peer's frame is deferred until commit and carries the **post-delete**
  ``blocker_count``;
* a peer deleted by the same cascade gets no ``card.updated``;
* an archived blocker moves no count, so deleting it publishes nothing extra;
* a peer on another board (reachable only through the admin's cross-board
  card move) is published to *its* board, never the deleted one's;
* the render cost does not grow with the number of peers.

The no-relations case (exactly one container frame) is pinned by
``test_container_delete_cascade_events.py``.
"""

from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.db import connection
from django.test import RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import BoardAdmin, CardAdmin, ColumnAdmin, SwimlaneAdmin
from boards.models import (
    Board, BoardEvent, BoardMembership, Card, CardRelation, Column, Swimlane,
)

BROADCAST = "boards.broadcast.broadcast_board_event"


def _request(user):
    request = RequestFactory().post("/admin/")
    request.user = user
    return request


def _blocks(blocker, blocked):
    return CardRelation.objects.create(
        from_card=blocker, to_card=blocked, relation_type=CardRelation.Type.BLOCKS,
    )


class _PeerFixture(TestCase):
    """Board with columns A/B and swimlanes 1/2, one card per cell::

                  lane 1   lane 2
        col A       a1       a2
        col B       b1       b2

    a1 blocks a2, b1 and b2; b1 also blocks b2. So deleting column A removes
    a1 (and a2, which a1 blocks) and leaves b1 at 0 and b2 at 1; deleting
    lane 1 removes a1 and b1 (which a1 blocks) and leaves a2 and b2 at 0.

    ``other`` is a second board whose card ``x`` a1 also blocks — the shape
    the admin's cross-board card move leaves behind.
    """

    def setUp(self):
        self.owner = User.objects.create_superuser(
            username="owner1634", password="p", email="o1634@example.com"
        )
        self.board = Board.objects.create(name="Peers", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.col_a = Column.objects.create(board=self.board, name="A", position=0)
        self.col_b = Column.objects.create(board=self.board, name="B", position=1)
        self.lane_1 = Swimlane.objects.create(board=self.board, name="L1", position=0)
        self.lane_2 = Swimlane.objects.create(board=self.board, name="L2", position=1)
        self.a1 = self._card(self.col_a, self.lane_1, "a1")
        self.a2 = self._card(self.col_a, self.lane_2, "a2")
        self.b1 = self._card(self.col_b, self.lane_1, "b1")
        self.b2 = self._card(self.col_b, self.lane_2, "b2")
        _blocks(self.a1, self.a2)
        _blocks(self.a1, self.b1)
        _blocks(self.a1, self.b2)
        _blocks(self.b1, self.b2)

        self.other = Board.objects.create(name="Other", owner=self.owner)
        BoardMembership.objects.create(
            board=self.other, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.other_col = Column.objects.create(board=self.other, name="X", position=0)
        self.other_lane = Swimlane.objects.create(board=self.other, name="Y", position=0)
        self.x = Card.objects.create(
            board=self.other, column=self.other_col, swimlane=self.other_lane,
            title="x", created_by=self.owner,
        )
        _blocks(self.a1, self.x)

    def _card(self, column, lane, title, **extra):
        return Card.objects.create(
            board=self.board, column=column, swimlane=lane, title=title,
            created_by=self.owner, **extra,
        )

    def _run(self, fn):
        """Run ``fn`` with broadcasts captured; assert nothing is published
        before commit; return the mock after running the on_commit callbacks."""
        with patch(BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                fn()
                mock_broadcast.assert_not_called()
            for callback in callbacks:
                callback()
        return mock_broadcast

    @staticmethod
    def _updates(mock_broadcast):
        """``{card_id: (board_id, blocker_count)}`` of every card.updated."""
        out = {}
        for call in mock_broadcast.call_args_list:
            board_id, event, payload = call.args[:3]
            if event == "card.updated":
                assert payload["id"] not in out, f"two frames for card {payload['id']}"
                out[payload["id"]] = (board_id, payload["blocker_count"])
        return out

    def assert_peer_frames(self, mock_broadcast, expected, container_event):
        self.assertEqual(self._updates(mock_broadcast), expected)
        events = [c.args[1] for c in mock_broadcast.call_args_list]
        # The container's (or card's) own delete frame goes out first.
        self.assertEqual(events[0], container_event)
        # Each peer frame has its change-feed row, on the peer's board.
        for card_id, (board_id, _) in expected.items():
            self.assertTrue(
                BoardEvent.objects.filter(
                    board_id=board_id, event="card.updated", data__id=card_id,
                ).exists(),
                f"no feed row for card {card_id} on board {board_id}",
            )


# Expected frames, shared by the REST and admin paths.
def _column_a_peers(t):
    # a2 went with column A. b1 lost its only blocker; b2 is still blocked by b1.
    return {
        t.b1.pk: (t.board.pk, 0),
        t.b2.pk: (t.board.pk, 1),
        t.x.pk: (t.other.pk, 0),
    }


def _lane_1_peers(t):
    # b1 went with lane 1, so b2 lost both blockers.
    return {
        t.a2.pk: (t.board.pk, 0),
        t.b2.pk: (t.board.pk, 0),
        t.x.pk: (t.other.pk, 0),
    }


class RestContainerDeletePeerTests(_PeerFixture):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _delete(self, url):
        responses = []
        mock_broadcast = self._run(lambda: responses.append(self.client.delete(url)))
        self.assertEqual(responses[0].status_code, 204)
        return mock_broadcast

    def test_column_delete_tells_surviving_blocked_cards(self):
        mock_broadcast = self._delete(
            f"/api/v1/boards/{self.board.pk}/columns/{self.col_a.pk}/"
        )
        self.assert_peer_frames(mock_broadcast, _column_a_peers(self), "column.deleted")

    def test_swimlane_delete_tells_surviving_blocked_cards(self):
        mock_broadcast = self._delete(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.lane_1.pk}/"
        )
        self.assert_peer_frames(mock_broadcast, _lane_1_peers(self), "swimlane.deleted")

    def test_board_delete_tells_blocked_cards_on_other_boards_only(self):
        board_id = self.board.pk
        mock_broadcast = self._delete(f"/api/v1/boards/{board_id}/")
        # Every same-board peer went with the board; only x survives, and its
        # frame goes to its own board.
        self.assert_peer_frames(
            mock_broadcast, {self.x.pk: (self.other.pk, 0)}, "board.deleted",
        )
        self.assertFalse(
            BoardEvent.objects.filter(board_id=board_id, event="card.updated").exists()
        )

    def test_deleting_only_an_archived_blocker_publishes_no_peer_frame(self):
        """An archived blocker never counted, so its delete moves nothing."""
        CardRelation.objects.all().delete()
        col_c = Column.objects.create(board=self.board, name="C", position=2)
        archived = self._card(col_c, self.lane_1, "archived", archived_at=timezone.now())
        _blocks(archived, self.b2)
        mock_broadcast = self._delete(
            f"/api/v1/boards/{self.board.pk}/columns/{col_c.pk}/"
        )
        self.assertEqual(self._updates(mock_broadcast), {})
        self.assertEqual(
            [c.args[1] for c in mock_broadcast.call_args_list], ["column.deleted"]
        )

    def test_peer_render_cost_does_not_grow_with_peer_count(self):
        """One collect query and one render pass per board, not per peer."""
        CardRelation.objects.all().delete()

        def column_blocking(n, name, position):
            col = Column.objects.create(board=self.board, name=name, position=position)
            blocker = self._card(col, self.lane_1, f"{name}-blocker")
            for i in range(n):
                _blocks(blocker, self._card(self.col_b, self.lane_2, f"{name}-peer{i}"))
            return col

        one = column_blocking(1, "One", 2)
        many = column_blocking(6, "Many", 3)

        def queries(col, expected_peers):
            with CaptureQueriesContext(connection) as ctx:
                mock_broadcast = self._delete(
                    f"/api/v1/boards/{self.board.pk}/columns/{col.pk}/"
                )
            self.assertEqual(len(self._updates(mock_broadcast)), expected_peers)
            return len(ctx.captured_queries)

        few = queries(one, 1)
        # Each peer's change-feed row is one INSERT; everything else is flat.
        lots = queries(many, 6)
        self.assertLessEqual(lots - few, 5, f"{few} queries for 1 peer, {lots} for 6")


class AdminContainerDeletePeerTests(_PeerFixture):
    def setUp(self):
        super().setUp()
        self.request = _request(self.owner)

    def test_column_delete_model(self):
        mock_broadcast = self._run(
            lambda: ColumnAdmin(Column, AdminSite()).delete_model(self.request, self.col_a)
        )
        self.assert_peer_frames(mock_broadcast, _column_a_peers(self), "column.deleted")

    def test_column_delete_queryset(self):
        mock_broadcast = self._run(
            lambda: ColumnAdmin(Column, AdminSite()).delete_queryset(
                self.request, Column.objects.filter(pk=self.col_a.pk)
            )
        )
        self.assert_peer_frames(mock_broadcast, _column_a_peers(self), "column.deleted")

    def test_column_delete_queryset_excludes_peers_in_other_selected_columns(self):
        """Both columns go: only the other board's card survives to be told."""
        mock_broadcast = self._run(
            lambda: ColumnAdmin(Column, AdminSite()).delete_queryset(
                self.request, Column.objects.filter(pk__in=[self.col_a.pk, self.col_b.pk])
            )
        )
        self.assert_peer_frames(
            mock_broadcast, {self.x.pk: (self.other.pk, 0)}, "column.deleted",
        )

    def test_swimlane_delete_model(self):
        mock_broadcast = self._run(
            lambda: SwimlaneAdmin(Swimlane, AdminSite()).delete_model(self.request, self.lane_1)
        )
        self.assert_peer_frames(mock_broadcast, _lane_1_peers(self), "swimlane.deleted")

    def test_swimlane_delete_queryset(self):
        mock_broadcast = self._run(
            lambda: SwimlaneAdmin(Swimlane, AdminSite()).delete_queryset(
                self.request, Swimlane.objects.filter(pk=self.lane_1.pk)
            )
        )
        self.assert_peer_frames(mock_broadcast, _lane_1_peers(self), "swimlane.deleted")

    def test_board_delete_model(self):
        mock_broadcast = self._run(
            lambda: BoardAdmin(Board, AdminSite()).delete_model(self.request, self.board)
        )
        self.assert_peer_frames(
            mock_broadcast, {self.x.pk: (self.other.pk, 0)}, "board.deleted",
        )

    def test_board_delete_queryset(self):
        mock_broadcast = self._run(
            lambda: BoardAdmin(Board, AdminSite()).delete_queryset(
                self.request, Board.objects.filter(pk=self.board.pk)
            )
        )
        self.assert_peer_frames(
            mock_broadcast, {self.x.pk: (self.other.pk, 0)}, "board.deleted",
        )

    def test_board_delete_queryset_excludes_peers_on_other_selected_boards(self):
        mock_broadcast = self._run(
            lambda: BoardAdmin(Board, AdminSite()).delete_queryset(
                self.request, Board.objects.filter(pk__in=[self.board.pk, self.other.pk])
            )
        )
        self.assertEqual(self._updates(mock_broadcast), {})

    def test_card_delete_model(self):
        mock_broadcast = self._run(
            lambda: CardAdmin(Card, AdminSite()).delete_model(self.request, self.a1)
        )
        self.assert_peer_frames(
            mock_broadcast,
            {
                self.a2.pk: (self.board.pk, 0),
                self.b1.pk: (self.board.pk, 0),
                self.b2.pk: (self.board.pk, 1),
                self.x.pk: (self.other.pk, 0),
            },
            "card.deleted",
        )

    def test_card_delete_queryset_excludes_peers_deleted_in_the_same_action(self):
        mock_broadcast = self._run(
            lambda: CardAdmin(Card, AdminSite()).delete_queryset(
                self.request, Card.objects.filter(pk__in=[self.a1.pk, self.b1.pk])
            )
        )
        # b1 is deleted too: it gets card.deleted, not card.updated.
        self.assert_peer_frames(
            mock_broadcast,
            {
                self.a2.pk: (self.board.pk, 0),
                self.b2.pk: (self.board.pk, 0),
                self.x.pk: (self.other.pk, 0),
            },
            "card.deleted",
        )

    def test_card_delete_of_an_archived_blocker_publishes_no_peer_frame(self):
        self.a1.archived_at = timezone.now()
        self.a1.save(update_fields=["archived_at"])
        mock_broadcast = self._run(
            lambda: CardAdmin(Card, AdminSite()).delete_model(self.request, self.a1)
        )
        self.assertEqual(self._updates(mock_broadcast), {})


class AdminCardArchiveFlipPeerTests(_PeerFixture):
    """The admin card form edits ``archived_at``, so a save can archive or
    restore a card; its peers move as they do on the REST archive/restore."""

    def setUp(self):
        super().setUp()
        self.request = _request(self.owner)
        self.card_admin = CardAdmin(Card, AdminSite())

    def _save(self, card):
        return self._run(
            lambda: self.card_admin.save_model(self.request, card, None, True)
        )

    def test_archiving_in_the_admin_tells_the_blocked_cards(self):
        self.a1.archived_at = timezone.now()
        mock_broadcast = self._save(self.a1)
        updates = self._updates(mock_broadcast)
        # The card's own frame, then one per peer with the lowered count.
        self.assertEqual(
            [c.args[2]["id"] for c in mock_broadcast.call_args_list][0], self.a1.pk,
        )
        self.assertEqual(
            {k: v for k, v in updates.items() if k != self.a1.pk},
            {
                self.a2.pk: (self.board.pk, 0),
                self.b1.pk: (self.board.pk, 0),
                self.b2.pk: (self.board.pk, 1),
                self.x.pk: (self.other.pk, 0),
            },
        )

    def test_restoring_in_the_admin_tells_the_blocked_cards(self):
        Card.objects.filter(pk=self.a1.pk).update(archived_at=timezone.now())
        self.a1.refresh_from_db()
        self.a1.archived_at = None
        mock_broadcast = self._save(self.a1)
        updates = self._updates(mock_broadcast)
        self.assertEqual(
            {k: v for k, v in updates.items() if k != self.a1.pk},
            {
                self.a2.pk: (self.board.pk, 1),
                self.b1.pk: (self.board.pk, 1),
                self.b2.pk: (self.board.pk, 2),
                # x's relation row is not same-board, so it no longer counts (#2229).
                self.x.pk: (self.other.pk, 0),
            },
        )

    def test_a_board_change_updates_old_board_peers(self):
        self.a1.board = self.other
        self.a1.column = self.other_col
        self.a1.swimlane = self.other_lane
        mock_broadcast = self._save(self.a1)
        updates = self._updates(mock_broadcast)
        # Relations are same-board, so a1 no longer counts for the cards it
        # blocked on the board it left (#2229); b2 keeps b1.
        self.assertEqual(
            {k: v for k, v in updates.items() if k in (self.a2.pk, self.b1.pk, self.b2.pk)},
            {
                self.a2.pk: (self.board.pk, 0),
                self.b1.pk: (self.board.pk, 0),
                self.b2.pk: (self.board.pk, 1),
            },
        )

    def test_an_edit_that_keeps_the_archived_state_sends_no_peer_frame(self):
        self.a1.title = "renamed"
        mock_broadcast = self._save(self.a1)
        self.assertEqual(
            [(c.args[1], c.args[2]["id"]) for c in mock_broadcast.call_args_list],
            [("card.updated", self.a1.pk)],
        )

    def test_an_edit_of_an_archived_card_that_keeps_it_archived_sends_no_peer_frame(self):
        Card.objects.filter(pk=self.a1.pk).update(archived_at=timezone.now())
        self.a1.refresh_from_db()
        self.a1.title = "still archived"
        mock_broadcast = self._save(self.a1)
        self.assertEqual(
            [(c.args[1], c.args[2]["id"]) for c in mock_broadcast.call_args_list],
            [("card.updated", self.a1.pk)],
        )
