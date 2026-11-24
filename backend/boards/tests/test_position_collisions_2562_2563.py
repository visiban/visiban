"""Exact repro sequences for two position collisions the #1424 machine found.

#2562: ``create_card`` used the cell's row count as the new slot, which lands on
a live card once a same-cell reorder has left a gap.
#2563: ``unarchive_card`` restored the slot held at archive time even when
``move_card``'s source-cell compaction had since given it to a live card.
"""
import threading

from django.db import connections
from unittest import skipUnless

from django.db import connection
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from boards.models import Card, CardMovement
from boards.tests.conftest import _make_board, _make_column, _make_swimlane, _make_user


class _Base:
    def _setup(self):
        self.user = _make_user("pos-2562")
        self.board = _make_board(self.user, name="Collisions")
        self.col = _make_column(self.board, "A", 0, allow_card_creation=True)
        self.other = _make_column(self.board, "B", 1, allow_card_creation=True)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.base = f"/api/v1/boards/{self.board.id}"

    def _create(self, title, col=None):
        resp = self.client.post(
            f"{self.base}/cards/",
            {"title": title, "column": (col or self.col).id, "swimlane": self.lane.id},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.json()["id"]

    def _move(self, card_id, col, position):
        resp = self.client.post(
            f"{self.base}/cards/{card_id}/move/",
            {"column_id": col.id, "swimlane_id": self.lane.id, "position": position},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)

    def _live_positions(self, col):
        return sorted(
            Card.objects.filter(
                board=self.board, column=col, archived_at__isnull=True
            ).values_list("position", flat=True)
        )


class CreateAfterSameCellReorderTests(_Base, TestCase):
    def setUp(self):
        self._setup()

    def test_repro_x0_y1_reorder_then_create_gets_a_free_slot(self):
        x = self._create("X")
        y = self._create("Y")
        self._move(x, self.col, 2)
        self._move(x, self.col, 0)
        self.assertEqual(Card.objects.get(pk=y).position, 2)  # the gap
        z = self._create("Z")
        positions = self._live_positions(self.col)
        self.assertEqual(len(positions), len(set(positions)), positions)
        self.assertEqual(Card.objects.get(pk=z).position, 3)

    def test_same_cell_reorder_writes_no_movement_record(self):
        x = self._create("X")
        self._create("Y")
        before = CardMovement.objects.filter(card_id=x, movement_type="move").count()
        self._move(x, self.col, 1)
        self.assertEqual(
            CardMovement.objects.filter(card_id=x, movement_type="move").count(), before
        )

    def test_create_in_an_empty_cell_starts_at_zero(self):
        z = self._create("Z")
        self.assertEqual(Card.objects.get(pk=z).position, 0)

    def test_create_does_not_reuse_an_archived_cards_slot(self):
        a = self._create("A")
        self._create("B")
        self.client.post(f"{self.base}/cards/{a}/archive/")
        z = self._create("Z")
        self.assertEqual(Card.objects.get(pk=z).position, 2)


class UnarchiveOntoTakenSlotTests(_Base, TestCase):
    def setUp(self):
        self._setup()
        self.a = self._create("A")
        self.b = self._create("B")
        self.c = self._create("C")

    def _unarchive(self, card_id):
        resp = self.client.post(f"{self.base}/cards/{card_id}/unarchive/")
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_repro_archive_b_move_a_away_unarchive_b(self):
        self.client.post(f"{self.base}/cards/{self.b}/archive/")
        self._move(self.a, self.other, 0)
        self.assertEqual(Card.objects.get(pk=self.c).position, 1)  # compacted
        body = self._unarchive(self.b)
        positions = self._live_positions(self.col)
        self.assertEqual(len(positions), len(set(positions)), positions)
        self.assertEqual(Card.objects.get(pk=self.c).position, 1)  # C untouched
        self.assertEqual(body["position"], 2)  # B appended
        self.assertEqual(Card.objects.get(pk=self.b).position, 2)

    def test_unarchive_keeps_its_slot_when_free(self):
        self.client.post(f"{self.base}/cards/{self.c}/archive/")
        self._unarchive(self.c)
        self.assertEqual(Card.objects.get(pk=self.c).position, 2)

    def test_unarchive_into_an_otherwise_empty_cell(self):
        self.client.post(f"{self.base}/cards/{self.a}/archive/")
        self.client.post(f"{self.base}/cards/{self.b}/archive/")
        self.client.post(f"{self.base}/cards/{self.c}/archive/")
        self._unarchive(self.b)
        self.assertEqual(Card.objects.get(pk=self.b).position, 1)


@skipUnless(connection.vendor == "postgresql", "row locks need PostgreSQL")
class ConcurrentUnarchiveCreateTests(_Base, TransactionTestCase):
    """Two writers into one cell never end on one slot (column row lock)."""

    def test_concurrent_unarchive_and_create_do_not_collide(self):
        self._setup()
        a = self._create("A")
        b = self._create("B")
        self._create("C")
        self.client.post(f"{self.base}/cards/{b}/archive/")
        self._move(a, self.other, 0)
        errors = []

        def unarchive():
            try:
                c = APIClient()
                c.force_authenticate(self.user)
                c.post(f"{self.base}/cards/{b}/unarchive/")
            except Exception as exc:  # pragma: no cover
                errors.append(exc)
            finally:
                connections.close_all()

        def create():
            try:
                c = APIClient()
                c.force_authenticate(self.user)
                c.post(
                    f"{self.base}/cards/",
                    {"title": "Z", "column": self.col.id, "swimlane": self.lane.id},
                    format="json",
                )
            except Exception as exc:  # pragma: no cover
                errors.append(exc)
            finally:
                connections.close_all()

        threads = [threading.Thread(target=unarchive), threading.Thread(target=create)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        positions = self._live_positions(self.col)
        self.assertEqual(len(positions), len(set(positions)), positions)
