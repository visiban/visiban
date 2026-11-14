"""A checklist item's new assignee is notified (#2196).

Same event, same preferences as a card assignment: ``action_type`` ``assigned``,
gated on ``notif_card_assigned`` in-app and ``email_notif_card_assigned`` for
mail. Self-assignment, unchanged assignees and unassigning send nothing.
"""
from unittest.mock import patch

from django.core import mail
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardChecklist, Column, Notification, Swimlane,
)
from boards.services.notifications import notify_checklist_item_assigned
from boards.signals import post_notification_created

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
@patch(PATCH_BROADCAST)
class ChecklistAssignNotificationTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(
            username="member", password="pass", email="member@example.test",
        )
        self.other = User.objects.create_user(username="other", password="pass")
        self.board = Board.objects.create(name="Sprint", owner=self.owner)
        for user, role in (
            (self.owner, BoardMembership.Role.ADMIN),
            (self.member, BoardMembership.Role.MEMBER),
            (self.other, BoardMembership.Role.MEMBER),
        ):
            BoardMembership.objects.create(board=self.board, user=user, role=role)
        col = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Release", created_by=self.owner, position=0,
        )
        self.item = CardChecklist.objects.create(card=self.card, text="Tag the build", position=0, created_by=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.list_url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/"
        self.item_url = f"{self.list_url}{self.item.id}/"
        mail.outbox = []

    def _patch(self, body):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.patch(self.item_url, body, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        return r

    def _notes(self, user):
        return list(Notification.objects.filter(recipient=user))

    def test_assigning_notifies_the_new_assignee(self, _):
        self._patch({"assignee_id": self.member.id})
        [note] = self._notes(self.member)
        self.assertEqual(note.action_type, Notification.ActionType.ASSIGNED)
        self.assertEqual(note.actor, self.owner)
        self.assertEqual(note.card, self.card)
        self.assertEqual(note.board, self.board)
        self.assertEqual(note.verb, 'You were assigned a checklist item on "Release": "Tag the build"')

    def test_create_with_an_assignee_notifies(self, _):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.post(self.list_url, {"text": "Write notes", "assignee_id": self.member.id}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        [note] = self._notes(self.member)
        self.assertIn('"Write notes"', note.verb)

    def test_reassigning_notifies_only_the_new_assignee(self, _):
        self._patch({"assignee_id": self.member.id})
        self._patch({"assignee_id": self.other.id})
        self.assertEqual(len(self._notes(self.member)), 1)
        self.assertEqual(len(self._notes(self.other)), 1)

    def test_self_assignment_sends_nothing(self, _):
        self._patch({"assignee_id": self.owner.id})
        self.assertEqual(self._notes(self.owner), [])

    def test_unchanged_assignee_and_unrelated_edits_send_nothing_new(self, _):
        self._patch({"assignee_id": self.member.id})
        self._patch({"assignee_id": self.member.id})
        self._patch({"due_date": "2026-12-01", "is_checked": True, "text": "Tag it"})
        self.assertEqual(len(self._notes(self.member)), 1)

    def test_unassigning_sends_nothing(self, _):
        self.item.assignee = self.member
        self.item.save()
        self._patch({"assignee_id": None})
        self.assertEqual(self._notes(self.member), [])

    def test_in_app_opt_out_is_respected(self, _):
        User.objects.filter(pk=self.member.pk).update(notif_card_assigned=False, email_notif_card_assigned=True)
        self._patch({"assignee_id": self.member.id})
        self.assertEqual(self._notes(self.member), [])
        self.assertEqual(mail.outbox, [])

    def test_inactive_assignee_gets_nothing(self, _):
        # Called directly: the REST assignable pool may already refuse an
        # inactive user, and the funnel's own filter is what is pinned here.
        User.objects.filter(pk=self.member.pk).update(is_active=False)
        self.item.assignee = User.objects.get(pk=self.member.pk)
        with self.captureOnCommitCallbacks(execute=True):
            created = notify_checklist_item_assigned(
                item=self.item, card=self.card, board=self.board, actor=self.owner, previous_assignee=None,
            )
        self.assertEqual(created, [])
        self.assertEqual(self._notes(self.member), [])

    def test_email_is_sent_only_when_opted_in(self, _):
        self._patch({"assignee_id": self.member.id})
        self.assertEqual(mail.outbox, [])  # email_notif_card_assigned defaults to False
        User.objects.filter(pk=self.member.pk).update(email_notif_card_assigned=True)
        self._patch({"assignee_id": None})
        self._patch({"assignee_id": self.member.id})
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ["member@example.test"])
        self.assertIn("Tag the build", mail.outbox[0].body)

    def test_extension_signal_carries_checklist_context(self, _):
        seen = []

        def receiver(sender, **kwargs):
            seen.append(kwargs["context"])

        post_notification_created.connect(receiver)
        try:
            self._patch({"assignee_id": self.member.id})
        finally:
            post_notification_created.disconnect(receiver)
        self.assertEqual(seen, [{
            "previous_assignee_name": "",
            "checklist_item_id": self.item.id,
            "checklist_item_text": "Tag the build",
        }])

    def test_long_item_text_and_title_fit_the_verb_column(self, _):
        Card.objects.filter(pk=self.card.pk).update(title="T" * 500)
        CardChecklist.objects.filter(pk=self.item.pk).update(text="x" * 500)
        self._patch({"assignee_id": self.member.id})
        [note] = self._notes(self.member)
        self.assertLessEqual(len(note.verb), Notification._meta.get_field("verb").max_length)
        self.assertTrue(note.verb.endswith('…"'))


@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
@patch(PATCH_BROADCAST)
class ChecklistOldValuesReadUnderLockTests(TestCase):
    """The old assignee / due date come from after the card lock (#2196)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = Board.objects.create(name="Sprint", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        col = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Release", created_by=self.owner, position=0,
        )
        self.item = CardChecklist.objects.create(card=self.card, text="Tag", position=0, created_by=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.item_url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/{self.item.id}/"

    def _patch_with_racing_write(self, body, racing_update):
        """PATCH while a 'concurrent' request commits `racing_update` just as the lock is taken."""
        from boards.services import cards as card_services

        real_lock = card_services.lock_card_for_write

        def lock_then_race(card_id):
            real_lock(card_id)
            CardChecklist.objects.filter(pk=self.item.pk).update(**racing_update)

        with patch("boards.views.cards.card_services.lock_card_for_write", side_effect=lock_then_race):
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.patch(self.item_url, body, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)

    def test_assignee_already_set_by_a_racing_request_adds_no_history_or_notification(self, _):
        from boards.models import CardActivity

        self._patch_with_racing_write({"assignee_id": self.member.id}, {"assignee_id": self.member.id})
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED).exists(),
        )
        self.assertFalse(Notification.objects.filter(recipient=self.member).exists())

    def test_due_date_already_set_by_a_racing_request_adds_no_history(self, _):
        import datetime

        from boards.models import CardActivity

        due = datetime.date(2026, 12, 1)
        self._patch_with_racing_write({"due_date": due.isoformat()}, {"due_date": due})
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_DUE_CHANGED).exists(),
        )

    def test_text_only_patch_keeps_a_concurrently_cleared_assignee(self, _):
        # The item's assignee leaves the board, and a concurrent write clears
        # the assignee; a text-only PATCH must not write the old assignee back.
        from boards.models import CardActivity

        CardChecklist.objects.filter(pk=self.item.pk).update(assignee=self.member)
        BoardMembership.objects.filter(board=self.board, user=self.member).delete()
        self._patch_with_racing_write({"text": "Tag v2"}, {"assignee_id": None})
        self.item.refresh_from_db()
        self.assertIsNone(self.item.assignee_id)
        self.assertEqual(self.item.text, "Tag v2")
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED).exists(),
        )
        self.assertFalse(Notification.objects.filter(recipient=self.member).exists())

    def test_check_only_patch_keeps_a_concurrent_assignment(self, _):
        from boards.models import CardActivity

        self._patch_with_racing_write({"is_checked": True}, {"assignee_id": self.member.id})
        self.item.refresh_from_db()
        self.assertEqual(self.item.assignee_id, self.member.id)
        self.assertTrue(self.item.is_checked)
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED).exists(),
        )
        self.assertTrue(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_CHECKED).exists(),
        )

    def test_check_toggle_compares_against_the_locked_row(self, _):
        # A racing request already checked the item: checking it again is no change.
        from boards.models import CardActivity

        self._patch_with_racing_write({"is_checked": True}, {"is_checked": True})
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_CHECKED).exists(),
        )


@patch(PATCH_BROADCAST)
class ChecklistDeleteUnderLockTests(TestCase):
    """DELETE works from the row as it is under the card lock (#2196)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board = Board.objects.create(name="Sprint", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=self.board, name="Todo", position=0, allow_card_creation=True)
        swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=swim, title="Release", created_by=self.owner, position=0,
        )
        self.item = CardChecklist.objects.create(card=self.card, text="Tag", position=0, created_by=self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.item_url = f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/checklist/{self.item.id}/"

    def _delete_with_racing_write(self, racing):
        from boards.services import cards as card_services

        real_lock = card_services.lock_card_for_write

        def lock_then_race(card_id):
            real_lock(card_id)
            racing()

        with patch("boards.views.cards.card_services.lock_card_for_write", side_effect=lock_then_race):
            with self.captureOnCommitCallbacks(execute=True):
                return self.client.delete(self.item_url)

    def test_history_records_the_text_as_it_is_under_the_lock(self, _):
        from boards.models import CardActivity

        r = self._delete_with_racing_write(
            lambda: CardChecklist.objects.filter(pk=self.item.pk).update(text="Tag v2"),
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        [row] = CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_DELETED)
        self.assertEqual(row.from_value, "Tag v2")

    def test_an_item_deleted_concurrently_answers_404_and_records_nothing(self, _):
        from boards.models import CardActivity

        r = self._delete_with_racing_write(lambda: CardChecklist.objects.filter(pk=self.item.pk).delete())
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(
            CardActivity.objects.filter(event_type=CardActivity.EventType.CHECKLIST_ITEM_DELETED).exists(),
        )


@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
class ChecklistNotificationMembershipTests(TestCase):
    """The checklist producer notifies only current board members (#2196)."""

    def test_a_recipient_who_is_not_a_board_member_is_dropped(self):
        owner = User.objects.create_user(username="owner", password="pass")
        outsider = User.objects.create_user(username="outsider", password="pass")
        board = Board.objects.create(name="Sprint", owner=owner)
        BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=board, name="Todo", position=0)
        swim = Swimlane.objects.create(board=board, name="General", position=0)
        card = Card.objects.create(board=board, column=col, swimlane=swim, title="R", created_by=owner, position=0)
        item = CardChecklist.objects.create(
            card=card, text="Tag", position=0, created_by=owner, assignee=outsider,
        )
        with self.captureOnCommitCallbacks(execute=True):
            created = notify_checklist_item_assigned(
                item=item, card=card, board=board, actor=owner, previous_assignee=None,
            )
        self.assertEqual(created, [])
        self.assertFalse(Notification.objects.filter(recipient=outsider).exists())

    def test_a_current_member_is_still_notified(self):
        owner = User.objects.create_user(username="owner", password="pass")
        member = User.objects.create_user(username="member", password="pass")
        board = Board.objects.create(name="Sprint", owner=owner)
        BoardMembership.objects.create(board=board, user=member, role=BoardMembership.Role.MEMBER)
        col = Column.objects.create(board=board, name="Todo", position=0)
        swim = Swimlane.objects.create(board=board, name="General", position=0)
        card = Card.objects.create(board=board, column=col, swimlane=swim, title="R", created_by=owner, position=0)
        item = CardChecklist.objects.create(card=card, text="Tag", position=0, created_by=owner, assignee=member)
        with self.captureOnCommitCallbacks(execute=True):
            created = notify_checklist_item_assigned(
                item=item, card=card, board=board, actor=owner, previous_assignee=None,
            )
        self.assertEqual(len(created), 1)
