"""Per-card caps on comments and checklist items (#2376).

``COMMENT_MAX_PER_CARD`` and ``CHECKLIST_MAX_ITEMS_PER_CARD`` bound the two
per-card collections #2007 left open. A create past a cap is a ``400`` with a
stable ``code`` and nothing is stored; ``0`` turns a cap off; the count is
read under the card row lock so two creates racing for the last slot cannot
both win.
"""

import threading
from unittest import mock, skipUnless

from django.conf import settings
from django.core.cache import cache
from django.db import connection, connections
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardChecklist, CardComment, Column, Swimlane
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.views.cards import CHECKLIST_QUOTA_EXCEEDED, COMMENT_QUOTA_EXCEEDED

HOLD_TIMEOUT = 10.0

# kind -> (url suffix, request body, model, code, setting)
KINDS = {
    "comment": ("comments", {"body": "hello"}, CardComment, COMMENT_QUOTA_EXCEEDED, "COMMENT_MAX_PER_CARD"),
    "checklist": (
        "checklist", {"text": "step"}, CardChecklist, CHECKLIST_QUOTA_EXCEEDED, "CHECKLIST_MAX_ITEMS_PER_CARD",
    ),
}


def _fixture(test, username):
    test.user = User.objects.create_user(username=username, password="pass")
    test.board = Board.objects.create(name="B", owner=test.user)
    BoardMembership.objects.create(board=test.board, user=test.user, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=test.board, name="A", position=0)
    swim = Swimlane.objects.create(board=test.board, name="G", position=0)
    test.card = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="C", created_by=test.user, position=0,
    )
    test.other = Card.objects.create(
        board=test.board, column=col, swimlane=swim, title="D", created_by=test.user, position=1,
    )


def _url(test, kind, card=None):
    return f"/api/v1/boards/{test.board.pk}/cards/{(card or test.card).pk}/{KINDS[kind][0]}/"


class CardChildCapTests(TestCase):
    def setUp(self):
        cache.clear()
        _fixture(self, "caps2376")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def create(self, kind, card=None):
        return self.client.post(_url(self, kind, card), KINDS[kind][1], format="json")

    def test_defaults_are_generous(self):
        self.assertEqual(settings.COMMENT_MAX_PER_CARD, 1000)
        self.assertEqual(settings.CHECKLIST_MAX_ITEMS_PER_CARD, 500)

    def test_create_past_the_cap_is_refused_and_stores_nothing(self):
        for kind, (_, _, model, code, setting) in KINDS.items():
            with self.subTest(kind=kind), override_settings(**{setting: 2}):
                model.objects.filter(card=self.card).delete()
                self.assertEqual(self.create(kind).status_code, 201)
                self.assertEqual(self.create(kind).status_code, 201)
                activities = CardActivity.objects.filter(card=self.card).count()
                res = self.create(kind)
                self.assertEqual(res.status_code, 400, res.content)
                self.assertEqual(res.data["code"], code)
                self.assertIn("maximum of 2", res.data["detail"])
                self.assertEqual(model.objects.filter(card=self.card).count(), 2)
                # No history row for a refused create.
                self.assertEqual(CardActivity.objects.filter(card=self.card).count(), activities)

    def test_cap_is_per_card(self):
        for kind, (_, _, _, _, setting) in KINDS.items():
            with self.subTest(kind=kind), override_settings(**{setting: 1}):
                self.assertEqual(self.create(kind).status_code, 201)
                self.assertEqual(self.create(kind, card=self.other).status_code, 201)

    def test_zero_turns_each_cap_off(self):
        for kind, (_, _, model, _, setting) in KINDS.items():
            with self.subTest(kind=kind), override_settings(**{setting: 0}):
                for _ in range(3):
                    self.assertEqual(self.create(kind).status_code, 201)
                self.assertEqual(model.objects.filter(card=self.card).count(), 3)

    def test_rows_over_a_lowered_cap_are_kept(self):
        for kind, (_, _, model, _, setting) in KINDS.items():
            with self.subTest(kind=kind):
                for _ in range(3):
                    self.assertEqual(self.create(kind).status_code, 201)
                with override_settings(**{setting: 2}):
                    self.assertEqual(self.create(kind).status_code, 400)
                self.assertEqual(model.objects.filter(card=self.card).count(), 3)

    def test_deleting_frees_a_slot(self):
        with override_settings(COMMENT_MAX_PER_CARD=1):
            self.assertEqual(self.create("comment").status_code, 201)
            CardComment.objects.filter(card=self.card).delete()
            self.assertEqual(self.create("comment").status_code, 201)

    def test_refusal_broadcasts_nothing(self):
        for kind, (_, _, _, _, setting) in KINDS.items():
            with self.subTest(kind=kind), override_settings(**{setting: 1}):
                self.assertEqual(self.create(kind).status_code, 201)
                with mock.patch("boards.broadcast.record_board_event") as record:
                    self.assertEqual(self.create(kind).status_code, 400)
                record.assert_not_called()

    def test_viewer_on_a_full_card_gets_403_not_the_cap_error(self):
        viewer = User.objects.create_user(username="caps2376_v", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        client = APIClient()
        client.force_authenticate(viewer)
        for kind, (_, body, _, _, setting) in KINDS.items():
            with self.subTest(kind=kind), override_settings(**{setting: 1}):
                self.assertEqual(self.create(kind).status_code, 201)
                self.assertEqual(client.post(_url(self, kind), body, format="json").status_code, 403)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class CardChildCapConcurrencyTests(TransactionTestCase):
    """Two creates racing for the last slot: exactly one wins.

    ``first`` passes the cap check and holds its transaction (and the card row
    lock) open; ``second`` must wait on that lock, then read the committed
    count and be refused. A count read outside the lock would let both in.
    """

    def setUp(self):
        cache.clear()
        _fixture(self, "race2376")
        patcher = mock.patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

    def _race(self, kind):
        from boards.views import cards

        _, body, model, code, setting = KINDS[kind]
        real = cards._per_card_cap_error
        paused, release, results = threading.Event(), threading.Event(), {}

        def holding_check(*args, **kwargs):
            outcome = real(*args, **kwargs)
            if threading.current_thread().name == "first" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return outcome

        def run(name):
            try:
                client = APIClient()
                client.force_authenticate(self.user)
                results[name] = client.post(_url(self, kind), body, format="json")
            except Exception as exc:  # surfaced by the assertions below
                results[name] = exc
            finally:
                connections.close_all()

        with override_settings(**{setting: 1}), mock.patch.object(
            cards, "_per_card_cap_error", side_effect=holding_check,
        ):
            first = threading.Thread(target=run, args=("first",), name="first")
            first.start()
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "first create never reached the cap check")
            second = threading.Thread(target=run, args=("second",), name="second")
            second.start()
            assert_blocked_on_lock(self, second, "second create did not wait for the card lock")
            release.set()
            first.join(HOLD_TIMEOUT)
            second.join(HOLD_TIMEOUT)

        for name in ("first", "second"):
            if isinstance(results.get(name), Exception):
                self.fail(f"{name} raised {type(results[name]).__name__}: {results[name]}")
        self.assertEqual(results["first"].status_code, 201)
        self.assertEqual(results["second"].status_code, 400)
        self.assertEqual(results["second"].data["code"], code)
        self.assertEqual(model.objects.filter(card=self.card).count(), 1)

    def test_two_concurrent_comments_for_the_last_slot(self):
        self._race("comment")

    def test_two_concurrent_checklist_items_for_the_last_slot(self):
        self._race("checklist")
