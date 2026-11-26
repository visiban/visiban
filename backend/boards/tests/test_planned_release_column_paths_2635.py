"""#2635 and #2637: every column write follows the planned-children release rules.

#2635: a parent move that queues behind a column reorder judges "reached or
skipped past" by the order the reorder committed, not the one ``move_card``
read before its column lock.

#2637: the Django admin column paths (position change, delete, ``board``
re-point) release or clear planned children the way the REST reorder and
delete do (Rule 19: actorless, no parent, board, column or person named).
"""
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.contrib import admin as django_admin
from django.db import connection, connections, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import ColumnAdmin
from boards.models import Board, BoardMembership, Card, CardActivity, CardParentLink, Column, Swimlane
from boards.services import planned_children
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.tests.test_planned_children_2371 import PATCH_BROADCAST

EV = CardActivity.EventType
Role = BoardMembership.Role
WAIT = 10


def _pipeline(test, prefix):
    """A parent board (Lead, Qualify, Proposal, Won) with a parent in Lead, a child board."""
    test.owner = User.objects.create_user(username=f"{prefix}_owner", password="pass", is_staff=True, is_superuser=True)
    test.pboard = Board.objects.create(name="Pipeline", owner=test.owner, cards_can_have_children=True)
    BoardMembership.objects.create(board=test.pboard, user=test.owner, role=Role.ADMIN)
    test.lead = Column.objects.create(board=test.pboard, name="Lead", position=0)
    test.qualify = Column.objects.create(board=test.pboard, name="Qualify", position=1)
    test.proposal = Column.objects.create(board=test.pboard, name="Proposal", position=2)
    test.won = Column.objects.create(board=test.pboard, name="Won", position=3)
    test.plane = Swimlane.objects.create(board=test.pboard, name="Hooli", position=0)
    test.cboard = Board.objects.create(name="Delivery", owner=test.owner)
    test.todo = Column.objects.create(board=test.cboard, name="To do", position=0)
    test.clane = Swimlane.objects.create(board=test.cboard, name="Team", position=0)
    test.parent = Card.objects.create(board=test.pboard, column=test.lead, swimlane=test.plane, title="Parent")


def _planned(test, needed_at, title="Child"):
    child = Card.objects.create(board=test.cboard, column=test.todo, swimlane=test.clane, title=title)
    link = CardParentLink.objects.create(
        parent=test.parent, child=child, created_by=test.owner, needed_at_column=needed_at,
    )
    return child, link


def _history(child):
    return list(
        CardActivity.objects.filter(card=child, event_type__in=[EV.PLANNED_RELEASED, EV.NEEDED_CHANGED])
        .order_by("pk").values_list("event_type", "from_value", "to_value", "actor_id")
    )


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ParentMoveQueuedBehindReorderTests(TransactionTestCase):
    """#2635: the move reads Qualify before the reorder commits, then waits on its lock.

    The reorder is the real endpoint, held open after its release scan (the
    parent is still in Lead then, so the reorder releases nothing itself). The
    move is the real endpoint too: it reads its target column, then queues in
    ``_lock_move_columns`` behind the reorder's ``FOR UPDATE`` on every
    column. Only the move can release, and only by the committed order.
    The patch is taken once in the main thread (a ``patch`` inside a worker
    leaks process-wide).
    """

    def setUp(self):
        _pipeline(self, "mr2635")

    def _race(self, *, target, needed_at, new_order=None, admin_edit=None):
        """Hold a reorder open, then queue a parent move behind it.

        The reorder is the REST endpoint (``new_order``) or, with
        ``admin_edit=(column, position)``, ``ColumnAdmin.save_model`` (#2637).
        """
        child, link = _planned(self, needed_at)
        holding, release = threading.Event(), threading.Event()
        errors, results = [], {}
        real_release_on_reorder = planned_children.release_on_reorder

        def held_release_on_reorder(board, *, actor):
            real_release_on_reorder(board, actor=actor)
            holding.set()
            if not release.wait(WAIT):
                raise RuntimeError("never released")

        def client():
            c = APIClient()
            c.force_authenticate(self.owner)
            return c

        def admin_reorder():
            column, position = admin_edit
            request = RequestFactory().post("/")
            request.user = self.owner
            obj = Column.objects.get(pk=column.pk)
            obj.position = position
            # changeform_view wraps save_model in one transaction; so do we.
            with transaction.atomic():
                ColumnAdmin(Column, django_admin.site).save_model(request, obj, None, True)
            return type("Resp", (), {"status_code": 200, "content": b""})()

        def reorderer():
            try:
                if admin_edit is not None:
                    results["reorder"] = admin_reorder()
                else:
                    results["reorder"] = client().post(
                        f"/api/v1/boards/{self.pboard.pk}/columns/reorder/",
                        {"order": [c.pk for c in new_order]}, format="json",
                    )
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                holding.set()
                connections.close_all()

        def mover():
            try:
                if not holding.wait(WAIT):
                    raise RuntimeError("the reorder never took its locks")
                results["move"] = client().post(
                    f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/move/",
                    {"column_id": target.pk, "swimlane_id": self.plane.pk, "position": 0}, format="json",
                )
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()

        t_reorder = threading.Thread(target=reorderer, name="reorder-2635")
        t_move = threading.Thread(target=mover, name="move-2635")
        with patch(PATCH_BROADCAST), patch.object(planned_children, "release_on_reorder", held_release_on_reorder):
            t_reorder.start()
            t_move.start()
            try:
                assert_blocked_on_lock(self, t_move, "the move should queue behind the reorder's column locks")
            finally:
                release.set()
                t_reorder.join(WAIT * 3)
                t_move.join(WAIT * 3)
        self.assertFalse(t_reorder.is_alive() or t_move.is_alive(), "a thread hung (possible deadlock)")
        self.assertEqual(errors, [])
        self.assertEqual(results["reorder"].status_code, 200, results["reorder"].content)
        self.assertEqual(results["move"].status_code, 200, results["move"].content)
        link.refresh_from_db()
        return child, link

    def test_move_releases_a_child_the_committed_order_puts_behind_the_target(self):
        # Read before the lock: Proposal (2) after Qualify (1), not reached.
        # Committed: Lead, Won, Proposal (2), Qualify (3): skipped past.
        child, link = self._race(
            target=self.qualify, needed_at=self.proposal,
            new_order=[self.lead, self.won, self.proposal, self.qualify],
        )
        self.assertIsNotNone(link.planned_released_at)
        self.assertEqual(
            CardActivity.objects.filter(card=child, event_type=EV.PLANNED_RELEASED).count(), 1,
        )
        self.assertEqual(_history(child), [(EV.PLANNED_RELEASED, "parent_reached", "", None)])

    def test_move_keeps_a_child_the_committed_order_puts_ahead_of_the_target(self):
        # Read before the lock: Won (3) after Proposal (2), and after the
        # reorder Won sits at 2, which the stale Proposal position would call
        # reached. Committed: Lead, Proposal (1), Won (2), Qualify: not reached.
        child, link = self._race(
            target=self.proposal, needed_at=self.won,
            new_order=[self.lead, self.proposal, self.won, self.qualify],
        )
        self.assertIsNone(link.planned_released_at)
        self.assertEqual(_history(child), [])

    def test_admin_position_change_holds_every_column_against_a_parent_move(self):
        # #2637: ColumnAdmin.save_model locks the board's columns, not just the
        # edited one. The move (Lead -> Won) never touches Proposal, so a
        # single-column lock on Proposal would not queue it. Read before the
        # lock: Proposal (2) before Won (3), so reached and released. Committed:
        # Proposal at 10, after Won, so the child stays planned.
        child, link = self._race(
            target=self.won, needed_at=self.proposal, admin_edit=(self.proposal, 10),
        )
        self.assertEqual(Column.objects.get(pk=self.proposal.pk).position, 10)
        self.assertIsNone(link.planned_released_at)
        self.assertEqual(
            CardActivity.objects.filter(card=child, event_type=EV.PLANNED_RELEASED).count(), 0,
        )
        self.assertEqual(_history(child), [])


class AdminColumnWritesReleasePlannedTests(TestCase):
    """#2637: the Django admin column paths follow the REST release rules."""

    def setUp(self):
        _pipeline(self, "ad2637")
        self.request = RequestFactory().post("/")
        self.request.user = self.owner
        # The parent sits in Proposal (2); the child is needed at Won (3).
        Card.objects.filter(pk=self.parent.pk).update(column=self.proposal)
        self.child, self.link = _planned(self, self.won)

    def _admin(self):
        return ColumnAdmin(Column, django_admin.site)

    def _save(self, column, **fields):
        for name, value in fields.items():
            setattr(column, name, value)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True), transaction.atomic():
            self._admin().save_model(self.request, column, None, True)

    def _cleared(self):
        """The REST delete's outcome: released, no column, one actorless "Needed: Now" row."""
        self.link.refresh_from_db()
        self.assertIsNotNone(self.link.planned_released_at)
        self.assertIsNone(self.link.needed_at_column_id)
        self.assertEqual(_history(self.child), [(EV.NEEDED_CHANGED, "column_deleted", "now", None)])

    def test_position_change_that_puts_the_needed_column_at_or_before_the_parent_releases(self):
        # Proposal moves past Won: the parent has now skipped past it.
        self._save(Column.objects.get(pk=self.proposal.pk), position=10)
        self.link.refresh_from_db()
        self.assertIsNotNone(self.link.planned_released_at)
        self.assertEqual(self.link.needed_at_column_id, self.won.pk)
        self.assertEqual(_history(self.child), [(EV.PLANNED_RELEASED, "parent_reached", "", None)])

    def test_position_change_that_does_not_cross_leaves_it_planned(self):
        self._save(Column.objects.get(pk=self.lead.pk), position=10)
        self.link.refresh_from_db()
        self.assertIsNone(self.link.planned_released_at)
        self.assertEqual(_history(self.child), [])

    def test_rename_runs_no_release_scan(self):
        with patch.object(planned_children, "release_on_reorder") as scan:
            self._save(Column.objects.get(pk=self.proposal.pk), name="Proposal 2")
        scan.assert_not_called()
        self.link.refresh_from_db()
        self.assertIsNone(self.link.planned_released_at)

    def test_delete_calls_the_plan_off_like_the_rest_delete(self):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin().delete_model(self.request, Column.objects.get(pk=self.won.pk))
        self._cleared()

    def test_bulk_delete_calls_off_every_selected_columns_plans_once(self):
        other_child, other_link = _planned(self, self.proposal, title="Other")
        # Proposal is the parent's column: a planned link cannot name it
        # through the API, but a row written around it is still cleared.
        Card.objects.filter(pk=self.parent.pk).update(column=self.lead)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin().delete_queryset(self.request, Column.objects.filter(pk__in=[self.proposal.pk, self.won.pk]))
        self._cleared()
        other_link.refresh_from_db()
        self.assertIsNotNone(other_link.planned_released_at)
        self.assertEqual(_history(other_child), [(EV.NEEDED_CHANGED, "column_deleted", "now", None)])

    def test_board_re_point_calls_the_plan_off_like_a_delete(self):
        elsewhere = Board.objects.create(name="Elsewhere", owner=self.owner)
        with patch.object(planned_children._broadcast, "record_board_event") as rec:
            self._save(Column.objects.get(pk=self.won.pk), board=elsewhere)
        self._cleared()
        self.assertEqual(Column.objects.get(pk=self.won.pk).board_id, elsewhere.pk)
        # The child board is pinged with ids only, as on the REST delete.
        pings = [c for c in rec.call_args_list if c.args[0] == self.cboard.pk]
        self.assertEqual([c.args[2] for c in pings], [{"card_ids": [self.child.pk]}])

    def test_released_link_is_left_alone_by_a_delete(self):
        CardParentLink.objects.filter(pk=self.link.pk).update(planned_released_at=self.link.created_at)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin().delete_model(self.request, Column.objects.get(pk=self.won.pk))
        self.assertEqual(_history(self.child), [])

    def test_no_column_ids_runs_no_query(self):
        # #1075 absent-input guard: nothing to scope the scan to, so no query.
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            planned_children.clear_for_deleted_columns([], actor=self.owner)
            planned_children.clear_for_deleted_columns([None], actor=self.owner)
        self.assertEqual(len(ctx), 0)
