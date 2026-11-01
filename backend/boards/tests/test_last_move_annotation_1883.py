"""#1883: card reads take the newest movement from annotations, not a prefetch.

``_card_queryset`` and the public share-link queryset used to load every
lifetime ``CardMovement`` (with five joined FKs) for every card, though every
reader only indexed ``[0]``. These tests pin that the serialized values are
unchanged for a card with 0, 1 (creation) and several movements on the
authenticated, cross-board and public serializers, and that the movement rows
are no longer fetched.
"""
import datetime

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardMovement, Column, Swimlane,
)
from boards.serializers import (
    CardSerializer, PublicBoardSerializer, _card_queryset,
)


def _move(card, user, when, *, from_name="", mtype=CardMovement.MovementType.MOVE):
    col, lane = card.column, card.swimlane
    mv = CardMovement.objects.create(
        card=card, moved_by=user, movement_type=mtype,
        to_column=col, to_column_name=col.name, to_column_uid=col.uid,
        to_swimlane=lane, to_swimlane_name=lane.name, to_swimlane_uid=lane.uid,
        from_column=None, from_column_name=from_name, from_column_uid="",
        from_swimlane=None, from_swimlane_name="", from_swimlane_uid="",
    )
    CardMovement.objects.filter(pk=mv.pk).update(moved_at=when)
    return mv


class _Fixture:
    """Shared board/cards and helpers; a plain mixin so it is not collected."""

    def setUp(self):
        self.user = User.objects.create_user(username="lm1883", password="x")
        self.board = Board.objects.create(name="LM", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role="admin")
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.now = timezone.now()

        def mk(title, pos):
            return Card.objects.create(
                board=self.board, column=col, swimlane=lane, title=title,
                created_by=self.user, position=pos,
            )

        self.unmoved = mk("unmoved", 0)
        self.created_only = mk("created", 1)
        _move(self.created_only, self.user, self.now - datetime.timedelta(days=1))
        self.many = mk("many", 2)
        for i in range(12):
            _move(
                self.many, self.user, self.now - datetime.timedelta(days=30 - i),
                from_name="" if i == 0 else "Prev",
            )
        self.last_many = self.now - datetime.timedelta(days=19)
        self.archived_last = mk("arch", 3)
        _move(self.archived_last, self.user, self.now - datetime.timedelta(days=9))
        _move(
            self.archived_last, self.user, self.now - datetime.timedelta(days=8),
            mtype=CardMovement.MovementType.ARCHIVED,
        )
        # Creation row only counts when it is the *newest* row.
        self.created_then_moved = mk("ctm", 4)
        _move(self.created_then_moved, self.user, self.now - datetime.timedelta(days=6))
        _move(self.created_then_moved, self.user, self.now - datetime.timedelta(days=5), from_name="Doing")

    def _expected(self, card):
        latest = card.movements.order_by("-moved_at").first()
        if latest is None:
            return None, False
        creation = (
            latest.movement_type == CardMovement.MovementType.MOVE
            and latest.from_column_name == ""
        )
        return latest.moved_at, creation

    def _assert_row(self, card, row):
        moved_at, creation = self._expected(card)
        got = row["last_moved_at"]
        if moved_at is None:
            self.assertIsNone(got)
        else:
            self.assertEqual(
                datetime.datetime.fromisoformat(got.replace("Z", "+00:00")) if isinstance(got, str) else got,
                moved_at,
            )
        self.assertEqual(row["last_move_is_creation"], creation)


class LastMoveAnnotationTests(_Fixture, TestCase):
    def test_expected_fixture_shapes(self):
        # Guard the fixture itself so the equality tests below are not vacuous.
        self.assertEqual(self._expected(self.unmoved), (None, False))
        self.assertTrue(self._expected(self.created_only)[1])
        self.assertFalse(self._expected(self.archived_last)[1] is True)
        self.assertEqual(self.many.movements.count(), 12)

    def test_authenticated_serializer_values_unchanged(self):
        cutoff = self.now - datetime.timedelta(days=7)
        for stale in (cutoff, None):
            qs = _card_queryset(Card.objects.filter(board=self.board), stale_cutoff=stale)
            for card in qs:
                row = CardSerializer(card, context={"board": self.board}).data
                self._assert_row(card, row)
        # is_stale: fallback path (no cutoff) and annotated path must agree.
        annotated = {
            c.title: CardSerializer(c, context={"board": self.board}).data["is_stale"]
            for c in _card_queryset(Card.objects.filter(board=self.board), stale_cutoff=self.now - datetime.timedelta(days=7))
        }
        self.assertEqual(
            annotated,
            {"unmoved": False, "created": False, "many": True, "arch": True, "ctm": False},
        )

    def test_cold_card_fallback_matches(self):
        # A card that never went through an annotating queryset still serializes
        # identically (slower, never wrong).
        for card in Card.objects.filter(board=self.board):
            row = CardSerializer(card, context={"board": self.board}).data
            self._assert_row(card, row)

    def test_full_endpoint_values_unchanged(self):
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(resp.status_code, 200)
        rows = {r["title"]: r for r in resp.data["cards"]}
        for card in Card.objects.filter(board=self.board):
            self._assert_row(card, rows[card.title])

    def test_cross_board_query_values_unchanged(self):
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get("/api/v1/cards/")
        self.assertEqual(resp.status_code, 200)
        results = resp.data["results"] if "results" in resp.data else resp.data
        rows = {r["title"]: r for r in results}
        self.assertEqual(len(rows), 5)
        for card in Card.objects.filter(board=self.board):
            self._assert_row(card, rows[card.title])
            self.assertIn("is_stale", rows[card.title])

    def test_public_serializer_values_unchanged(self):
        data = PublicBoardSerializer(self.board).data
        rows = {}
        for r in data["cards"]:
            rows[r["uid"]] = r
        for card in Card.objects.filter(board=self.board):
            self._assert_row(card, rows[str(card.uid)] if str(card.uid) in rows else rows[card.uid])
        stale = {
            c.title: rows[next(k for k in rows if str(k) == str(c.uid))]["is_stale"]
            for c in Card.objects.filter(board=self.board)
        }
        self.assertEqual(stale["unmoved"], False)
        self.assertEqual(stale["many"], True)

    @staticmethod
    def _movement_row_selects(ctx):
        """Queries that read ``card_movements`` as their own row source.

        The last-move annotations are correlated subqueries *inside* the
        ``cards`` SELECT, so they mention the table but never lead a query;
        a prefetch (the old behavior) is a standalone SELECT FROM
        ``card_movements``.
        """
        return [
            q["sql"] for q in ctx.captured_queries
            if q["sql"].upper().startswith("SELECT")
            and ' FROM "card_movements"' in q["sql"]
            and ' FROM "cards"' not in q["sql"]
        ]

    def test_movement_rows_are_not_loaded(self):
        """No standalone movement SELECT and no card carries a movements list."""
        with CaptureQueriesContext(connection) as ctx:
            cards = list(_card_queryset(Card.objects.filter(board=self.board)))
            for card in cards:
                CardSerializer(card, context={"board": self.board}).data
        self.assertEqual(self._movement_row_selects(ctx), [])
        for card in cards:
            self.assertNotIn("_prefetched_movements", card.__dict__)
            self.assertNotIn("movements", getattr(card, "_prefetched_objects_cache", {}))

    def test_public_board_does_not_load_movement_rows(self):
        with CaptureQueriesContext(connection) as ctx:
            PublicBoardSerializer(self.board).data
        self.assertEqual(self._movement_row_selects(ctx), [])

    def test_unannotated_card_detects_the_old_behavior(self):
        """Sanity: the detector does fire for the cold fallback path, so the
        two tests above are not vacuous."""
        card = Card.objects.get(pk=self.many.pk)
        with CaptureQueriesContext(connection) as ctx:
            CardSerializer(card, context={"board": self.board}).data
        self.assertTrue(self._movement_row_selects(ctx))

    def test_full_query_count_independent_of_movement_history(self):
        client = APIClient()
        client.force_authenticate(self.user)
        url = f"/api/v1/boards/{self.board.id}/full/"
        with CaptureQueriesContext(connection) as before:
            client.get(url)
        for i in range(20):
            _move(self.unmoved, self.user, self.now - datetime.timedelta(hours=i), from_name="X")
        with CaptureQueriesContext(connection) as after:
            client.get(url)
        self.assertEqual(len(before), len(after))


class StaleAnnotationReuseTests(_Fixture, TestCase):
    """is_stale now reuses ``_last_moved_at`` instead of its own subquery."""

    def _cold_stale(self):
        return {
            c.title: CardSerializer(
                Card.objects.get(pk=c.pk), context={"board": self.board}
            ).data["is_stale"]
            for c in Card.objects.filter(board=self.board)
        }

    def test_annotation_order_is_irrelevant_and_values_match_cold_path(self):
        from boards.serializers import _annotate_is_stale, _annotate_last_move

        cutoff = self.now - datetime.timedelta(days=7)
        base = Card.objects.filter(board=self.board)
        orders = {
            "stale_then_last": _annotate_last_move(_annotate_is_stale(base, cutoff)),
            "last_then_stale": _annotate_is_stale(_annotate_last_move(base), cutoff),
            "stale_only": _annotate_is_stale(base, cutoff),
        }
        cold = self._cold_stale()
        for name, qs in orders.items():
            got = {c.title: c._is_stale_annotated for c in qs}
            self.assertEqual(got, cold, name)
            self.assertEqual(
                got["unmoved"], False, name
            )  # 0 moves: created_at fallback
        # One set of last-move subqueries, not two correlated ones for the same value.
        self.assertNotIn("_last_moved_at_for_stale", orders["last_then_stale"].query.annotations)
        self.assertEqual(
            len(orders["last_then_stale"].query.annotations),
            len(orders["stale_then_last"].query.annotations),
        )

    def test_public_is_stale_matches_cold_path(self):
        data = PublicBoardSerializer(self.board).data
        by_uid = {str(r["uid"]): r["is_stale"] for r in data["cards"]}
        cold = self._cold_stale()
        for c in Card.objects.filter(board=self.board):
            self.assertEqual(by_uid[str(c.uid)], cold[c.title], c.title)


class NewestRowSelectionTests(TestCase):
    """Which row counts as "newest" (#1883): max ``moved_at``, ties by higher id.

    Inserting rows in a different order from their ``moved_at`` values, or
    with equal timestamps, is what distinguishes ``-moved_at, -id`` from
    ``-id`` alone (or from insertion order).
    """

    def setUp(self):
        self.user = User.objects.create_user(username="newest1883", password="x")
        self.board = Board.objects.create(name="NR", owner=self.user)
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="c",
            created_by=self.user, position=0,
        )
        self.now = timezone.now()

    def _annotated(self):
        return _card_queryset(Card.objects.filter(pk=self.card.pk)).get()

    def test_out_of_order_insert_picks_max_moved_at(self):
        # Inserted last, but oldest: a creation row recorded after a later move
        # (e.g. an import with history). -id alone would pick it.
        _move(self.card, self.user, self.now - datetime.timedelta(days=1), from_name="Doing")
        newest_by_time = self.now - datetime.timedelta(hours=1)
        _move(self.card, self.user, newest_by_time, from_name="Review")
        _move(self.card, self.user, self.now - datetime.timedelta(days=30), from_name="")
        card = self._annotated()
        self.assertEqual(card._last_moved_at, newest_by_time)
        self.assertEqual(card._last_move_from_column_name, "Review")
        row = CardSerializer(card, context={"board": self.board}).data
        self.assertFalse(row["last_move_is_creation"])

    def test_moved_at_tie_picks_higher_id(self):
        when = self.now - datetime.timedelta(days=2)
        _move(self.card, self.user, when, from_name="")  # creation-shaped, lower id
        later = _move(self.card, self.user, when, from_name="Doing")  # higher id
        card = self._annotated()
        self.assertEqual(card._last_move_from_column_name, "Doing")
        self.assertEqual(card._last_moved_at, when)
        self.assertGreater(later.pk, 0)
        self.assertFalse(
            CardSerializer(card, context={"board": self.board}).data["last_move_is_creation"]
        )
