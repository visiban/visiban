"""Turning "Child cards" off with live parent links keeps the leftover parents (#2446).

The two-tier rule becomes per card on a flag-off board: a card that already has
children keeps them and may get more; no other card there may; a leftover
parent can never become a child; and both ends of a link are never one board.
"""

import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from boards.models import BoardEvent, BoardMembership, CardParentLink, CardParentUnlink
from boards.services import card_links
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user
from visiban.exceptions import CodedValidationError

Role = BoardMembership.Role


class _Fixture:
    def _setup(self):
        self.owner = _make_user("lp_owner")
        self.pboard = _make_board(self.owner, name="Pipeline")
        self.pboard.cards_can_have_children = True
        self.pboard.save(update_fields=["cards_can_have_children"])
        self.cboard = _make_board(self.owner, name="Delivery")
        self.pcol, self.plane = _make_column(self.pboard), _make_swimlane(self.pboard)
        self.ccol, self.clane = _make_column(self.cboard), _make_swimlane(self.cboard)
        self.leftover = _make_card(self.pcol, self.plane, title="Leftover parent")
        self.plain = _make_card(self.pcol, self.plane, title="Plain card")
        self.child = _make_card(self.ccol, self.clane, title="Child")
        CardParentLink.objects.create(parent=self.leftover, child=self.child)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _turn_off(self):
        res = self.client.patch(
            f"/api/v1/boards/{self.pboard.pk}/", {"cards_can_have_children": False}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.pboard.refresh_from_db()

    def _check(self, parent, child_board, child=None):
        parent.refresh_from_db()
        with transaction.atomic():
            card_links._check_link_rules_under_lock(parent, child_board, child=child)


class TurnOffTests(_Fixture, TestCase):
    def setUp(self):
        self._setup()

    def test_turn_off_keeps_links_and_clears_the_default(self):
        self.pboard.default_child_board = self.cboard
        self.pboard.save(update_fields=["default_child_board"])
        self._turn_off()
        self.assertFalse(self.pboard.cards_can_have_children)
        self.assertIsNone(self.pboard.default_child_board_id)
        self.assertTrue(CardParentLink.objects.filter(parent=self.leftover, child=self.child).exists())

    def test_turning_back_on_is_refused_once_a_card_here_is_a_child(self):
        self._turn_off()
        other = _make_board(self.owner, name="Portfolio")
        other.cards_can_have_children = True
        other.save(update_fields=["cards_can_have_children"])
        CardParentLink.objects.create(parent=_make_card(_make_column(other), _make_swimlane(other)), child=self.plain)
        res = self.client.patch(
            f"/api/v1/boards/{self.pboard.pk}/", {"cards_can_have_children": True}, format="json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("cards_can_have_children", res.json())


class PerCardRuleTests(_Fixture, TestCase):
    def setUp(self):
        self._setup()
        self._turn_off()

    def test_predicate(self):
        self.assertTrue(card_links.card_can_have_children(self.leftover))
        self.assertFalse(card_links.card_can_have_children(self.plain))

    def test_predicate_absent_input_fails_closed(self):
        self.assertFalse(card_links.card_can_have_children(None))

    def test_leftover_parent_may_get_another_child(self):
        self._check(self.leftover, self.cboard, child=_make_card(self.ccol, self.clane))
        self._check(self.leftover, self.cboard)  # Add child: a new card

    def test_other_cards_on_the_board_may_not(self):
        for child in (_make_card(self.ccol, self.clane), None):
            with self.subTest(add_child=child is None), self.assertRaises(CodedValidationError) as ctx:
                self._check(self.plain, self.cboard, child=child)
            self.assertEqual(ctx.exception.detail["code"], "link_not_allowed")

    def test_leftover_parent_never_becomes_a_child(self):
        other = _make_board(self.owner, name="Portfolio")
        other.cards_can_have_children = True
        other.save(update_fields=["cards_can_have_children"])
        top = _make_card(_make_column(other), _make_swimlane(other))
        with self.assertRaises(CodedValidationError) as ctx:
            self._check(top, self.pboard, child=self.leftover)
        self.assertEqual(ctx.exception.detail["code"], "child_is_parent")
        # A plain card on the flag-off board may be a child (it has no children).
        self._check(top, self.pboard, child=self.plain)

    def test_both_ends_on_one_board_is_refused(self):
        with self.assertRaises(CodedValidationError) as ctx:
            self._check(self.leftover, self.pboard, child=self.plain)
        self.assertEqual(ctx.exception.detail["code"], "link_not_allowed")

    def test_losing_the_last_child_ends_it_except_for_undo(self):
        CardParentLink.objects.filter(parent=self.leftover).delete()
        CardParentUnlink.objects.create(parent=self.leftover, child=self.child)
        self.assertFalse(card_links.card_can_have_children(self.leftover))
        self._check(self.leftover, self.cboard, child=self.child)  # Undo: the pair it had
        with self.assertRaises(CodedValidationError):
            self._check(self.leftover, self.cboard, child=_make_card(self.ccol, self.clane))


class PickersAndReadsTests(_Fixture, TestCase):
    def setUp(self):
        self._setup()
        self._turn_off()

    def test_link_existing_picker(self):
        self._make_titled = _make_card(self.ccol, self.clane, title="Spare task")
        rows = card_links.child_candidates_for_viewer(self.owner, self.leftover, self.cboard, "Spare")
        self.assertEqual([r["disabled_reason"] for r in rows], [None])
        self.assertEqual(card_links.child_candidates_for_viewer(self.owner, self.plain, self.cboard, "Spare"), [])

    def test_link_existing_picker_marks_a_leftover_candidate(self):
        other = _make_board(self.owner, name="Portfolio")
        other.cards_can_have_children = True
        other.save(update_fields=["cards_can_have_children"])
        top = _make_card(_make_column(other), _make_swimlane(other))
        rows = card_links.child_candidates_for_viewer(self.owner, top, self.pboard, "parent")
        self.assertEqual([(r["id"], r["disabled_reason"]) for r in rows], [(self.leftover.pk, "child_is_parent")])

    def test_set_parent_picker_is_empty_for_a_leftover_parent(self):
        other = _make_board(self.owner, name="Portfolio")
        other.cards_can_have_children = True
        other.save(update_fields=["cards_can_have_children"])
        _make_card(_make_column(other), _make_swimlane(other), title="Top initiative")
        self.leftover.refresh_from_db()
        self.assertEqual(card_links.parent_candidates_for_viewer(self.owner, self.leftover, other, "Top"), [])

    def test_add_child_chooser_keeps_the_fixed_board_and_no_default(self):
        out = card_links.child_board_options_for_viewer(self.leftover, self.owner)
        self.assertEqual(out["fixed_board"]["id"], self.cboard.pk)
        self.assertFalse(out["can_set_default"])
        self.assertIsNone(out["default"])
        plain = card_links.child_board_options_for_viewer(self.plain, self.owner)
        self.assertIsNone(plain["fixed_board"])
        self.assertEqual(plain["boards"], [])

    def test_full_carries_a_rollup_on_leftover_parents_only(self):
        cards = {c["id"]: c for c in self.client.get(f"/api/v1/boards/{self.pboard.pk}/full/").json()["cards"]}
        self.assertEqual(cards[self.leftover.pk]["children_rollup"]["total"], 1)
        self.assertNotIn("children_rollup", cards[self.plain.pk])

    def test_rollup_helper_absent_board_fails_closed(self):
        self.assertIsNone(card_links.rollups_for_board_cards(None, [self.leftover.pk], self.owner))
        self.assertEqual(card_links.rollups_for_board_cards(self.pboard, [self.plain.pk], self.owner), {})

    def test_parent_change_still_pings_the_child_board(self):
        with self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            card_links.announce_parent_changed(self.leftover.pk, self.pboard, actor_id=self.owner.pk)
        self.assertTrue(
            BoardEvent.objects.filter(board_id=self.cboard.pk, event="card.parent_changed").exists()
        )


HOLD_TIMEOUT = 10


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class LastChildUnlinkRaceTests(_Fixture, TransactionTestCase):
    """The last child's unlink and a new link to the same leftover parent race (#2446).

    The per-card rule is read under the parent's card lock, so a link that
    arrives while the unlink of the parent's last child is uncommitted waits,
    then sees a card with no children on a flag-off board and is refused. Without
    the lock both could pass: the link would read "has a child" before the
    unlink committed and leave a parent on a board that may not have any.
    """

    def setUp(self):
        self._setup()
        self._turn_off()
        self.child2 = _make_card(self.ccol, self.clane, title="Second child")

    def _thread(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the status assertions
                results[name] = exc
            finally:
                connections.close_all()  # release this thread's DB connection (backend test conventions)

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _api(self):
        c = APIClient()
        c.force_authenticate(self.owner)
        return c

    def test_link_waits_for_the_last_child_unlink_then_is_refused(self):
        paused, release, results = threading.Event(), threading.Event(), {}
        real = card_links._announce

        def held(*args, **kwargs):
            if threading.current_thread().name == "unlinker" and not paused.is_set():
                paused.set()
                release.wait(HOLD_TIMEOUT)
            return real(*args, **kwargs)

        # Patched once, in the main thread: a patch inside a worker leaks process-wide.
        with patch.object(card_links, "_announce", side_effect=held):
            unlinker = self._thread(
                "unlinker",
                lambda: self._api().delete(f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/"),
                results,
            )
            self.assertTrue(paused.wait(HOLD_TIMEOUT), "unlink never reached its hold")
            linker = self._thread(
                "linker",
                lambda: self._api().post(
                    f"/api/v1/boards/{self.cboard.pk}/cards/{self.child2.pk}/parent/",
                    {"parent_id": self.leftover.pk}, format="json",
                ),
                results,
            )
            try:
                assert_blocked_on_lock(self, linker, "the link did not wait for the last child's unlink")
            finally:
                release.set()
                unlinker.join(HOLD_TIMEOUT)
                linker.join(HOLD_TIMEOUT)

        self.assertIn(results["unlinker"].status_code, (200, 204), results["unlinker"])
        res = results["linker"]
        self.assertEqual(res.status_code, 400, getattr(res, "content", res))
        self.assertIn(b"link_not_allowed", res.content)
        self.assertFalse(CardParentLink.objects.filter(parent=self.leftover).exists())
