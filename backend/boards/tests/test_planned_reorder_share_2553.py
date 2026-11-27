"""#2553: a column reorder releases planned children (left open by #2371).

A reorder that puts a planned child's Needed column at or before its parent's
current column releases the child at once (release used to happen only on a
parent move). Same actorless system write as a parent move (Rule 19).
"""
import datetime
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from boards import broadcast as _broadcast
from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardParentLink, Column, Swimlane
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.services import planned_children
from boards.tests.test_planned_children_2371 import PATCH_BROADCAST, PlannedFixture, client_for

EV = CardActivity.EventType
Role = BoardMembership.Role
WAIT = 10


class ReorderReleaseTests(PlannedFixture):
    def reorder(self, order, user=None):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user or self.owner).post(
                f"/api/v1/boards/{self.pboard.pk}/columns/reorder/", {"order": [c.pk for c in order]}, format="json",
            )

    def test_reorder_that_puts_the_needed_column_before_the_parent_releases(self):
        child = self.planned_child(column=self.proposal, due=datetime.date(2026, 12, 4))
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        self.assertIsNone(self.link(child).planned_released_at)
        # Proposal now sits before Qualify, where the parent is.
        r = self.reorder([self.lead, self.proposal, self.qualify, self.won])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(self.link(child).planned_released_at)
        # Actorless, names no parent/board/column (Rule 19).
        self.assertEqual(self.events(child)[-1], (EV.PLANNED_RELEASED, "parent_reached", "2026-12-04", None))
        body = self.read(child, self.maya)
        self.assertEqual((body["planned"], body["needed_now"], body["needed_now_reason"]), (False, True, "parent"))

    def test_reorder_to_the_same_column_as_the_parent_releases(self):
        child = self.planned_child(column=self.qualify)
        self.move(self.parent, self.pboard, self.lead, self.plane)
        # Qualify moves to the front: position 0, the parent's column (Lead) is now 1.
        self.reorder([self.qualify, self.lead, self.proposal, self.won])
        self.assertIsNotNone(self.link(child).planned_released_at)

    def test_reorder_that_does_not_cross_leaves_it_planned(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        self.assertEqual(self.reorder([self.lead, self.qualify, self.won, self.proposal]).status_code, 200)
        self.assertIsNone(self.link(child).planned_released_at)
        self.assertEqual([e[0] for e in self.events(child)], [EV.NEEDED_CHANGED])

    def test_release_pings_the_child_board_with_ids_only(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        with patch.object(planned_children._broadcast, "record_board_event") as rec:
            with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
                client_for(self.owner).post(
                    f"/api/v1/boards/{self.pboard.pk}/columns/reorder/",
                    {"order": [c.pk for c in [self.lead, self.proposal, self.qualify, self.won]]}, format="json",
                )
        pings = [c for c in rec.call_args_list if c.args[1] == _broadcast.EVT_CARD_PARENT_CHANGED]
        self.assertEqual(len(pings), 1)
        self.assertEqual(pings[0].args[0], self.cboard.pk)
        self.assertEqual(pings[0].args[2], {"card_ids": [child.pk]})

    def test_already_released_link_is_not_released_twice(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        released = self.link(child).planned_released_at
        self.reorder([self.proposal, self.lead, self.qualify, self.won])
        self.assertEqual(self.link(child).planned_released_at, released)
        self.assertEqual(len([e for e in self.events(child) if e[0] == EV.PLANNED_RELEASED]), 1)

    def test_other_boards_links_are_untouched(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        # Reordering the CHILD board's columns scans no planned link.
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            client_for(self.owner).post(
                f"/api/v1/boards/{self.cboard.pk}/columns/reorder/",
                {"order": [self.doing.pk, self.todo.pk]}, format="json",
            )
        self.assertIsNone(self.link(child).planned_released_at)

    def test_absent_board_releases_nothing(self):
        # #1075 absent-input guard: no board, no scope, no release (and no query).
        child = self.planned_child(column=self.qualify)
        with CaptureQueriesContext(connection) as ctx:
            planned_children.release_on_reorder(None, actor=self.owner)
        self.assertEqual(len(ctx), 0)
        self.assertIsNone(self.link(child).planned_released_at)

    def test_non_admin_cannot_reorder_so_cannot_release(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        r = self.reorder([self.lead, self.proposal, self.qualify, self.won], user=self.maya)
        self.assertEqual(r.status_code, 403)
        self.assertIsNone(self.link(child).planned_released_at)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ReorderVsParentMoveRaceTests(TransactionTestCase):
    """A reorder racing a parent move that releases the same link (#2553).

    The move takes the parent from Lead to Proposal, which is still BEFORE the
    link's Needed column (Won), so the move releases nothing. The reorder
    queues behind the move's column locks, then (once it has them) puts Won
    first, which is at or before the parent's resulting column. So the only
    thing that can release the link is ``release_on_reorder`` after its wait;
    remove that call and this test fails. One ``planned_released`` row, no
    deadlock. Patches are taken once in the main thread (a ``patch`` inside a
    worker leaks process-wide).
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="rr_owner", password="pass")
        self.pboard = Board.objects.create(name="Pipeline", owner=self.owner, cards_can_have_children=True)
        BoardMembership.objects.create(board=self.pboard, user=self.owner, role=Role.ADMIN)
        self.lead = Column.objects.create(board=self.pboard, name="Lead", position=0)
        self.proposal = Column.objects.create(board=self.pboard, name="Proposal", position=1)
        self.won = Column.objects.create(board=self.pboard, name="Won", position=2)
        plane = Swimlane.objects.create(board=self.pboard, name="Hooli", position=0)
        self.cboard = Board.objects.create(name="Delivery", owner=self.owner)
        todo = Column.objects.create(board=self.cboard, name="To do", position=0)
        clane = Swimlane.objects.create(board=self.cboard, name="Team", position=0)
        self.parent = Card.objects.create(board=self.pboard, column=self.lead, swimlane=plane, title="Parent")
        self.child = Card.objects.create(board=self.cboard, column=todo, swimlane=clane, title="Child")
        self.link = CardParentLink.objects.create(
            parent=self.parent, child=self.child, created_by=self.owner, needed_at_column=self.won,
        )

    def test_reorder_queues_on_a_releasing_parent_move_and_releases_once(self):
        holding, release = threading.Event(), threading.Event()
        errors, results = [], {}

        def mover():
            try:
                with transaction.atomic():
                    # The move's shape (#1522 lock order): its source and
                    # target columns in pk order, the parent's row, the column
                    # change, then its release query (claims the link row).
                    list(Column.objects.filter(pk__in=[self.lead.pk, self.proposal.pk]).order_by("pk").select_for_update(no_key=True))
                    Card.objects.select_for_update().get(pk=self.parent.pk)
                    Card.objects.filter(pk=self.parent.pk).update(column=self.proposal)
                    self.parent.column = self.proposal
                    planned_children.release_on_move(self.parent, to_column=self.proposal, actor=self.owner)
                    # Won is ahead of the parent: the move must not release.
                    # An explicit raise, not `assert`: this body is wrapped in a
                    # catch-all (python:S5779) and must survive `python -O`.
                    if CardParentLink.objects.get(pk=self.link.pk).planned_released_at is not None:
                        raise RuntimeError("move released the link while Won is ahead")
                    holding.set()
                    if not release.wait(WAIT):
                        raise RuntimeError("never released")
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                holding.set()
                connections.close_all()

        def reorderer():
            try:
                if not holding.wait(WAIT):
                    raise RuntimeError("the move never took its lock")
                # Won moves to the front, ahead of the parent's column
                # (Proposal once the move commits): only the reorder releases.
                client = APIClient()
                client.force_authenticate(self.owner)
                results["response"] = client.post(
                    f"/api/v1/boards/{self.pboard.pk}/columns/reorder/",
                    {"order": [self.won.pk, self.lead.pk, self.proposal.pk]}, format="json",
                )
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()

        t_mover = threading.Thread(target=mover, name="mover-2553")
        t_reorder = threading.Thread(target=reorderer, name="reorder-2553")
        with patch(PATCH_BROADCAST):
            t_mover.start()
            t_reorder.start()
            try:
                assert_blocked_on_lock(self, t_reorder, "the reorder should queue behind the move's locks")
            finally:
                release.set()
                t_mover.join(WAIT * 3)
                t_reorder.join(WAIT * 3)
        self.assertFalse(t_mover.is_alive() or t_reorder.is_alive(), "a thread hung (possible deadlock)")
        self.assertEqual(errors, [])
        self.assertEqual(results["response"].status_code, 200)
        self.assertIsNotNone(CardParentLink.objects.get(pk=self.link.pk).planned_released_at)
        self.assertEqual(
            CardActivity.objects.filter(card=self.child, event_type=EV.PLANNED_RELEASED).count(), 1,
        )
