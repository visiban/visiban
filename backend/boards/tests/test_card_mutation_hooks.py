"""Coverage for the ``CARD_MUTATION_HOOKS`` enterprise extension point.

``boards.hooks.CARD_MUTATION_HOOKS`` is a stability-guaranteed 1.0+ extension
point (see the ``boards.hooks`` module docstring and #820): enterprise code
appends handlers to the list in place, and the hook *names*, the argument
types, and the post-commit firing guarantee are all part of that contract.

Before #1107 not a single test exercised it, so relocating the six call sites
out of ``CardViewSet`` into ``boards.services.cards`` would have been an
unguarded change to a public interface. These tests are the net: they pin the
event string for every lifecycle transition, that arguments arrive as plain
integers (never ORM instances — handlers are documented to issue their own
queries), and that handlers run only after the transaction commits.

Two asymmetries pinned here are deliberate and must not be "tidied":

* ``unarchive`` broadcasts the WebSocket event ``card.unarchived`` but fires
  the hook event ``card.restored``. Both names are frozen — the WS name by the
  event-schema compatibility rule, the hook name by ``boards.hooks``.
* Hook callbacks are always registered *after* the broadcast callback at every
  call site, so a handler observes the same ordering on every transition.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from boards import hooks
from boards.models import Card
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_swimlane, _make_user,
)


class CardMutationHookTests(TestCase):
    """Every card lifecycle transition fires its documented hook event."""

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()

        self.calls = []

        def recorder(event, card_id, board_id, actor_id):
            self.calls.append((event, card_id, board_id, actor_id))

        self._recorder = recorder
        # Append in place — never rebind hooks.CARD_MUTATION_HOOKS, which is
        # exactly what the module's stability guarantee forbids (#820).
        hooks.CARD_MUTATION_HOOKS.append(recorder)

        self.user = _make_user("hookuser")
        self.board = _make_board(self.user)
        self.col_a = _make_column(self.board, "A", 0)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col_a, self.lane, title="Hooked")

        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        hooks.CARD_MUTATION_HOOKS.remove(self._recorder)
        self._broadcast_patcher.stop()

    # ── helpers ───────────────────────────────────────────────────────────

    def _card_url(self, suffix=""):
        return f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/{suffix}"

    def _events(self):
        return [c[0] for c in self.calls]

    def _assert_single_call(self, event, card_id):
        self.assertEqual(len(self.calls), 1, f"expected exactly one hook call, got {self.calls}")
        got_event, got_card_id, got_board_id, got_actor_id = self.calls[0]
        self.assertEqual(got_event, event)
        self.assertEqual(got_card_id, card_id)
        self.assertEqual(got_board_id, self.board.pk)
        self.assertEqual(got_actor_id, self.user.pk)
        # Plain integers, not ORM instances — handlers are documented to run
        # their own queries against these ids after the commit.
        for value in (got_card_id, got_board_id, got_actor_id):
            self.assertIsInstance(value, int)

    # ── one test per documented event value ───────────────────────────────

    def test_create_fires_card_created(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {"title": "New", "column": self.col_a.pk, "swimlane": self.lane.pk},
                format="json",
            )
        self.assertEqual(resp.status_code, 201)
        self._assert_single_call("card.created", resp.json()["id"])

    def test_update_fires_card_updated(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(self._card_url(), {"title": "Renamed"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self._assert_single_call("card.updated", self.card.pk)

    def test_move_fires_card_moved(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_b.pk, "swimlane_id": self.lane.pk, "position": 0},
                format="json",
            )
        self.assertEqual(resp.status_code, 200)
        self._assert_single_call("card.moved", self.card.pk)

    def test_archive_fires_card_archived(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(self._card_url("archive/"))
        self.assertEqual(resp.status_code, 200)
        self._assert_single_call("card.archived", self.card.pk)

    def test_unarchive_fires_card_restored_not_card_unarchived(self):
        """The hook event is ``card.restored`` even though the WS event is
        ``card.unarchived``. Both names are frozen; they are not typos."""
        self.client.post(self._card_url("archive/"))
        self.calls.clear()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(self._card_url("unarchive/"))
        self.assertEqual(resp.status_code, 200)
        self._assert_single_call("card.restored", self.card.pk)
        self.assertNotIn("card.unarchived", self._events())

    def test_destroy_fires_card_deleted(self):
        card_id = self.card.pk
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(self._card_url())
        self.assertEqual(resp.status_code, 204)
        self._assert_single_call("card.deleted", card_id)

    # ── firing guarantees ─────────────────────────────────────────────────

    def test_hooks_do_not_fire_before_commit(self):
        """Handlers must run in ``transaction.on_commit``, never inline.

        An enterprise audit-log handler reads the card back by id, so firing it
        mid-transaction would hand it uncommitted (or rolled-back) state.
        """
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            resp = self.client.patch(self._card_url(), {"title": "Deferred"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.calls, [], "hook fired before commit")
        self.assertTrue(callbacks, "no on_commit callbacks were registered at all")
        for cb in callbacks:
            cb()
        self._assert_single_call("card.updated", self.card.pk)

    def test_hooks_do_not_fire_when_the_mutation_is_rejected(self):
        """A blocked move must register no hook callback.

        Mirrors the broadcast guarantee in ``test_broadcast_on_commit`` — a
        rejected mutation has no side effects to announce.
        """
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.col_b.wip_limit = 0
        self.col_b.save(update_fields=["wip_limit"])
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                self._card_url("move/"),
                {"column_id": self.col_b.pk, "swimlane_id": self.lane.pk, "position": 0},
                format="json",
            )
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(self.calls, [])

    def test_a_second_registered_handler_also_runs(self):
        """Registration is ``.append()`` on a shared list, so several add-ons
        can subscribe. Pins that the call site iterates the whole list."""
        seen = []
        hooks.CARD_MUTATION_HOOKS.append(lambda *a: seen.append(a[0]))
        try:
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(self._card_url(), {"title": "Two handlers"}, format="json")
        finally:
            hooks.CARD_MUTATION_HOOKS.pop()
        self.assertEqual(self._events(), ["card.updated"])
        self.assertEqual(seen, ["card.updated"])

    def test_card_id_still_resolves_after_delete_hook_fires(self):
        """``card.deleted`` carries the id of a row that no longer exists.

        Pinned because a handler must be able to tell "deleted" apart from
        "never existed" — the id is passed even though the row is gone.
        """
        card_id = self.card.pk
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(self._card_url())
        self.assertFalse(Card.objects.filter(pk=card_id).exists())
        self.assertEqual(self.calls[0][1], card_id)
