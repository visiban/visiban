"""clear_viewer_assignees clears checklist item assignees too, records History,
and announces every touched card (#2200, #1744)."""

import io
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardActivity, CardChecklist, Column, Swimlane

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
ET = CardActivity.EventType


class ClearViewerChecklistAssigneesTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="cl_owner", password="pass")
        self.viewer = User.objects.create_user(username="cl_viewer", password="pass")
        self.member = User.objects.create_user(username="cl_member", password="pass")
        self.board = Board.objects.create(name="Board", owner=self.owner)
        for user, role in (
            (self.owner, BoardMembership.Role.ADMIN),
            (self.viewer, BoardMembership.Role.VIEWER),
            (self.member, BoardMembership.Role.MEMBER),
        ):
            BoardMembership.objects.create(board=self.board, user=user, role=role)
        self.col = Column.objects.create(board=self.board, name="Todo", position=0)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        # The card's own assignee is a member, so only its checklist is stale.
        self.card = self._card("Card", assignee=self.member)
        self.stale_item = CardChecklist.objects.create(
            card=self.card, text="viewer to-do", position=0, assignee=self.viewer
        )
        self.clean_item = CardChecklist.objects.create(
            card=self.card, text="member to-do", position=1, assignee=self.member
        )

    def _card(self, title, *, assignee=None, position=0, **kwargs):
        return Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim, title=title,
            created_by=self.owner, assignee=assignee, position=position, **kwargs,
        )

    def _call(self, *args):
        out = io.StringIO()
        with patch(PATCH_BROADCAST) as mock_bc, self.captureOnCommitCallbacks(execute=True):
            call_command("clear_viewer_assignees", *args, stdout=out)
        return out.getvalue(), mock_bc

    def test_clears_viewer_checklist_assignee_and_keeps_member(self):
        output, _ = self._call()
        self.stale_item.refresh_from_db()
        self.clean_item.refresh_from_db()
        self.card.refresh_from_db()
        self.assertIsNone(self.stale_item.assignee_id)
        self.assertEqual(self.clean_item.assignee_id, self.member.id)
        self.assertEqual(self.card.assignee_id, self.member.id)
        self.assertIn("Cleared assignee on 0 card(s) and 1 checklist item(s).", output)
        self.assertIn("viewer to-do", output)

    def test_records_history_for_cleared_checklist_and_card_assignees(self):
        stale_card = self._card("Stale card", assignee=self.viewer, position=1)
        self._call()
        item_rows = CardActivity.objects.filter(card=self.card, event_type=ET.CHECKLIST_ITEM_ASSIGNED)
        self.assertEqual(
            list(item_rows.values_list("from_value", "to_value", "actor", "item_text")),
            # #2199: the row names the item it cleared.
            [("cl_viewer", "", None, self.stale_item.text)],
        )
        card_rows = CardActivity.objects.filter(card=stale_card, event_type=ET.ASSIGNEE_CHANGE)
        self.assertEqual(
            list(card_rows.values_list("from_value", "to_value", "actor")),
            [("cl_viewer", "Unassigned", None)],
        )
        # The card whose assignee was kept gets no assignee_change row.
        self.assertFalse(
            CardActivity.objects.filter(card=self.card, event_type=ET.ASSIGNEE_CHANGE).exists()
        )

    def test_dry_run_reports_checklist_item_without_changes(self):
        output, mock_bc = self._call("--dry-run")
        self.assertIn("[DRY RUN]", output)
        self.assertIn(f"Checklist item {self.stale_item.pk}", output)
        self.stale_item.refresh_from_db()
        self.assertEqual(self.stale_item.assignee_id, self.viewer.id)
        self.assertFalse(CardActivity.objects.exists())
        mock_bc.assert_not_called()

    def test_emits_card_updated_once_per_touched_card_after_commit(self):
        stale_card = self._card("Stale card", assignee=self.viewer, position=1)
        # A card with both its assignee and a checklist item stale is one frame.
        CardChecklist.objects.create(card=stale_card, text="x", position=0, assignee=self.viewer)
        untouched = self._card("Clean card", assignee=self.member, position=2)
        _, mock_bc = self._call()
        frames = [c for c in mock_bc.call_args_list if c.args[1] == "card.updated"]
        self.assertEqual(sorted(c.args[2]["id"] for c in frames), sorted([self.card.pk, stale_card.pk]))
        for call in frames:
            self.assertEqual(call.args[0], self.board.pk)
            self.assertIsNotNone(call.kwargs.get("event_id"))
        by_id = {c.args[2]["id"]: c.args[2] for c in frames}
        self.assertIsNone(by_id[stale_card.pk]["assignee"])
        self.assertNotIn(untouched.pk, by_id)

    def test_no_frame_when_nothing_is_stale(self):
        self.stale_item.assignee = self.member
        self.stale_item.save()
        _, mock_bc = self._call()
        mock_bc.assert_not_called()

    def test_archived_card_checklist_left_alone(self):
        from django.utils import timezone

        archived = self._card("Archived", position=1, archived_at=timezone.now())
        item = CardChecklist.objects.create(card=archived, text="old", position=0, assignee=self.viewer)
        self._call()
        item.refresh_from_db()
        self.assertEqual(item.assignee_id, self.viewer.id)

    def test_checklist_only_stale_assignee_is_found(self):
        """A viewer assigned only to a checklist item (no card) is still a candidate."""
        self.card.assignee = None
        self.card.save()
        self._call()
        self.stale_item.refresh_from_db()
        self.assertIsNone(self.stale_item.assignee_id)

    def test_keeps_checklist_assignee_who_is_no_longer_a_member(self):
        former = User.objects.create_user(username="cl_former", password="pass")
        item = CardChecklist.objects.create(card=self.card, text="f", position=2, assignee=former)
        self._call()
        item.refresh_from_db()
        self.assertEqual(item.assignee_id, former.id)

    def test_assignment_landing_between_first_read_and_lock_is_not_cleared(self):
        """The re-read after the lock is limited to the locked cards (#2200).

        An item assigned to a viewer after the first read has its card unlocked,
        so clearing it (and writing History from an unlocked read) would break
        the lock's guarantee. It is left for the next run instead.
        """
        from django.db.models.query import QuerySet

        late_card = self._card("Late", assignee=self.member, position=1)
        late_item = CardChecklist.objects.create(card=late_card, text="late", position=0)
        original = QuerySet.select_for_update
        injected = []

        def inject_then_lock(qs, *a, **kw):
            if not injected:
                injected.append(True)
                CardChecklist.objects.filter(pk=late_item.pk).update(assignee=self.viewer)
            return original(qs, *a, **kw)

        with patch.object(QuerySet, "select_for_update", inject_then_lock):
            output, _ = self._call()
        self.assertTrue(injected)
        late_item.refresh_from_db()
        self.stale_item.refresh_from_db()
        self.assertEqual(late_item.assignee_id, self.viewer.id)
        self.assertIsNone(self.stale_item.assignee_id)
        self.assertIn("and 1 checklist item(s).", output)
        self.assertFalse(CardActivity.objects.filter(card=late_card).exists())
