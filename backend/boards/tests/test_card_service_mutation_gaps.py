"""Assertions added from the #1443 mutation baseline for ``update_card`` (#1454).

``update_card`` writes one ``CardActivity`` row per changed field and creates the
assignment and mention notifications. The scoped card-service suites left 44
mutants in that code alive: they asserted that *an* activity row exists, not
what it says. Each test here pins exact values, read back from the database, and
the denied/no-op paths assert that nothing was written. All of it goes through
the service entry point, the same one the HTTP adapter calls.
"""

import datetime
from unittest.mock import patch

from django.test import TestCase

from boards.models import (
    BoardMembership,
    Card,
    CardActivity,
    Label,
    Notification,
)
from boards.services import cards as svc
from boards.services.errors import NotPermitted, WeightLimitExceeded
from boards.signals import post_notification_created
from boards.tests.conftest import (
    _make_board,
    _make_card,
    _make_column,
    _make_membership,
    _make_swimlane,
    _make_user,
)

ET = CardActivity.EventType


def _render(card, movement=None):
    return {"id": card.pk, "title": card.title}


class UpdateCardGapBase(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("upd_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, "A", 0)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col, self.lane, title="Original")

    def _update(self, submitted=None, actor=None, **changes):
        """Run ``update_card`` with an ``apply`` that sets ``changes`` and saves."""
        card = Card.objects.select_related("assignee", "board", "column").get(
            pk=self.card.pk
        )

        def apply():
            for name, value in changes.items():
                setattr(card, name, value)
            card.save()

        if submitted is None:
            submitted = {
                ("assignee_id" if k == "assignee" else k): v for k, v in changes.items()
            }
        with self.captureOnCommitCallbacks(execute=True):
            result = svc.update_card(
                actor=actor or self.owner,
                board=self.board,
                card=card,
                submitted=submitted,
                apply=apply,
                render=_render,
            )
        return result

    def _activities(self):
        return list(
            CardActivity.objects.filter(card=self.card)
            .order_by("id")
            .values_list("event_type", "from_value", "to_value", "actor_id")
        )


class FieldActivityTests(UpdateCardGapBase):
    def test_title_change_records_old_and_new_title(self):
        self._update(title="Renamed")
        self.assertEqual(
            self._activities(),
            [(ET.TITLE_CHANGE, "Original", "Renamed", self.owner.pk)],
        )

    def test_title_change_not_submitted_records_nothing(self):
        """The row follows what the caller *submitted*, not just a diff."""
        self._update(submitted={}, title="Renamed")
        self.assertEqual(self._activities(), [])

    def test_priority_change_records_old_and_new_value(self):
        self.card.priority = "low"
        self.card.save(update_fields=["priority"])
        self._update(priority="high")
        self.assertEqual(
            self._activities(), [(ET.PRIORITY_CHANGE, "low", "high", self.owner.pk)]
        )

    def test_weight_change_records_values_as_strings(self):
        self.card.weight = 2
        self.card.save(update_fields=["weight"])
        self._update(weight=5)
        self.assertEqual(
            self._activities(), [(ET.WEIGHT_CHANGE, "2", "5", self.owner.pk)]
        )

    def test_weight_decrease_is_recorded_too(self):
        self.card.weight = 5
        self.card.save(update_fields=["weight"])
        self._update(weight=3)
        self.assertEqual(
            self._activities(), [(ET.WEIGHT_CHANGE, "5", "3", self.owner.pk)]
        )

    def test_due_date_set_then_cleared(self):
        self._update(due_date=datetime.date(2026, 11, 3))
        self.assertEqual(
            self._activities(), [(ET.DUE_DATE_CHANGE, "", "2026-11-03", self.owner.pk)]
        )
        CardActivity.objects.all().delete()
        self._update(due_date=None)
        self.assertEqual(
            self._activities(), [(ET.DUE_DATE_CHANGE, "2026-11-03", "", self.owner.pk)]
        )

    def test_unchanged_card_writes_no_activity_and_still_bumps_version(self):
        before = Card.objects.get(pk=self.card.pk).version
        result = self._update(submitted={})
        self.assertEqual(CardActivity.objects.filter(card=self.card).count(), 0)
        self.assertEqual(Card.objects.get(pk=self.card.pk).version, before + 1)
        self.assertEqual(result.card.version, before + 1)
        self.assertEqual(result.payload, {"id": self.card.pk, "title": "Original"})

    def test_several_changes_yield_one_row_each_in_a_fixed_order(self):
        self._update(
            title="New", priority="high", weight=4, due_date=datetime.date(2026, 12, 1)
        )
        self.assertEqual(
            [row[0] for row in self._activities()],
            [ET.TITLE_CHANGE, ET.PRIORITY_CHANGE, ET.WEIGHT_CHANGE, ET.DUE_DATE_CHANGE],
        )


class DescriptionActivityTests(UpdateCardGapBase):
    def test_description_change_row_has_empty_values(self):
        """Descriptions are long; the row records *that* it changed, not the text."""
        self._update(description="Some new text")
        self.assertEqual(
            self._activities(), [(ET.DESCRIPTION_CHANGE, "", "", self.owner.pk)]
        )

    def test_description_not_submitted_records_nothing(self):
        self._update(submitted={}, description="Some new text")
        self.assertEqual(self._activities(), [])

    def test_new_mention_notifies_the_mentioned_member(self):
        bob = _make_user("bob")
        _make_membership(self.board, bob, BoardMembership.Role.MEMBER)
        self._update(description="please look, @bob")
        note = Notification.objects.get()
        self.assertEqual(note.recipient_id, bob.pk)
        self.assertEqual(note.actor_id, self.owner.pk)
        self.assertEqual(note.action_type, Notification.ActionType.MENTIONED)
        self.assertEqual(note.verb, 'upd_owner mentioned you in "Original"')
        self.assertEqual(note.card_id, self.card.pk)
        self.assertEqual(note.board_id, self.board.pk)
        self.card.refresh_from_db()
        self.assertEqual(self.card.mentioned_user_ids, [bob.pk])

    def test_mention_already_in_old_description_is_not_renotified(self):
        bob = _make_user("bob")
        _make_membership(self.board, bob, BoardMembership.Role.MEMBER)
        self.card.description = "hi @bob"
        self.card.save(update_fields=["description"])
        self._update(description="hi @bob, and more")
        self.assertEqual(Notification.objects.count(), 0)

    def test_mention_notification_failure_does_not_fail_the_update(self):
        with patch(
            "boards.services.cards.notify_new_mentions", side_effect=RuntimeError("x")
        ):
            with self.assertLogs("boards.services.cards", level="ERROR") as logs:
                self._update(description="hi @bob")
        self.assertEqual(
            logs.records[0].getMessage(),
            f"notify_new_mentions failed for card={self.card.pk}: RuntimeError",
        )
        self.assertEqual(Card.objects.get(pk=self.card.pk).description, "hi @bob")

    def test_mention_not_notified_when_description_not_submitted(self):
        bob = _make_user("bob")
        _make_membership(self.board, bob, BoardMembership.Role.MEMBER)
        self._update(submitted={}, description="hi @bob")
        self.assertEqual(Notification.objects.count(), 0)


class LabelActivityTests(UpdateCardGapBase):
    def setUp(self):
        super().setUp()
        self.bug = Label.objects.create(board=self.board, name="bug")
        self.ux = Label.objects.create(board=self.board, name="ux")
        self.api = Label.objects.create(board=self.board, name="api")

    def _set_labels(self, labels):
        card = Card.objects.select_related("assignee", "board", "column").get(
            pk=self.card.pk
        )
        with self.captureOnCommitCallbacks(execute=True):
            svc.update_card(
                actor=self.owner,
                board=self.board,
                card=card,
                submitted={},
                apply=lambda: card.labels.set(labels),
                render=_render,
            )

    def test_added_labels_are_listed_with_plus(self):
        self._set_labels([self.bug])
        self.assertEqual(
            self._activities(), [(ET.LABEL_CHANGE, "", "+bug", self.owner.pk)]
        )

    def test_removed_labels_are_listed_with_minus(self):
        self.card.labels.set([self.bug])
        self._set_labels([])
        # Current behavior: removed names are looked up in the post-write label
        # set, so none can be named and only the "-" marker is recorded. Pinned
        # as-is; if removed names are ever fixed to appear, update this expectation.
        self.assertEqual(
            self._activities(), [(ET.LABEL_CHANGE, "", "-", self.owner.pk)]
        )

    def test_add_and_remove_in_one_update(self):
        self.card.labels.set([self.bug])
        self._set_labels([self.ux])
        rows = self._activities()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], ET.LABEL_CHANGE)
        self.assertEqual(rows[0][1], "")
        self.assertEqual(rows[0][2], "+ux, -")

    def test_several_added_labels_join_with_comma_space(self):
        self._set_labels([self.bug, self.ux])
        (row,) = self._activities()
        self.assertIn(row[2], ("+bug, ux", "+ux, bug"))

    def test_unchanged_labels_write_no_activity(self):
        self.card.labels.set([self.bug])
        self._set_labels([self.bug])
        self.assertEqual(self._activities(), [])


class AssigneeActivityTests(UpdateCardGapBase):
    def setUp(self):
        super().setUp()
        self.alice = _make_user("alice")
        self.bob = _make_user("bob")
        _make_membership(self.board, self.alice, BoardMembership.Role.MEMBER)
        _make_membership(self.board, self.bob, BoardMembership.Role.MEMBER)
        self.received = []
        self.addCleanup(post_notification_created.disconnect, self._receiver)
        post_notification_created.connect(self._receiver, weak=False)

    def _receiver(self, sender, **kwargs):
        self.received.append(kwargs)

    def test_assigning_from_nobody_records_unassigned_to_name(self):
        self._update(assignee=self.alice)
        self.assertEqual(
            self._activities(),
            [(ET.ASSIGNEE_CHANGE, "Unassigned", "alice", self.owner.pk)],
        )

    def test_reassigning_records_both_names(self):
        self.card.assignee = self.alice
        self.card.save(update_fields=["assignee"])
        self._update(assignee=self.bob)
        self.assertEqual(
            self._activities(), [(ET.ASSIGNEE_CHANGE, "alice", "bob", self.owner.pk)]
        )

    def test_unassigning_records_name_to_unassigned_and_notifies_nobody(self):
        self.card.assignee = self.alice
        self.card.save(update_fields=["assignee"])
        self._update(assignee=None)
        self.assertEqual(
            self._activities(),
            [(ET.ASSIGNEE_CHANGE, "alice", "Unassigned", self.owner.pk)],
        )
        self.assertEqual(Notification.objects.count(), 0)

    def test_new_assignee_is_notified_with_exact_contents(self):
        self._update(assignee=self.alice)
        note = Notification.objects.get()
        self.assertEqual(note.recipient_id, self.alice.pk)
        self.assertEqual(note.actor_id, self.owner.pk)
        self.assertEqual(note.action_type, Notification.ActionType.ASSIGNED)
        self.assertEqual(note.verb, 'You were assigned to "Original"')
        self.assertEqual(note.card_id, self.card.pk)
        self.assertEqual(note.board_id, self.board.pk)
        self.assertFalse(note.read)

    def test_notification_verb_uses_the_title_after_the_update(self):
        self._update(assignee=self.alice, title="Renamed")
        self.assertEqual(
            Notification.objects.get().verb, 'You were assigned to "Renamed"'
        )

    def test_dispatch_context_carries_previous_assignee_name(self):
        self.card.assignee = self.alice
        self.card.save(update_fields=["assignee"])
        self._update(assignee=self.bob)
        (call,) = self.received
        self.assertEqual(call["context"], {"previous_assignee_name": "alice"})
        self.assertEqual(call["recipient"].pk, self.bob.pk)

    def test_dispatch_context_for_first_assignment_says_unassigned(self):
        self._update(assignee=self.alice)
        (call,) = self.received
        self.assertEqual(call["context"], {"previous_assignee_name": "Unassigned"})

    def test_self_assignment_is_not_notified(self):
        self._update(assignee=self.owner)
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(len(self._activities()), 1)

    def test_assignee_who_opted_out_is_not_notified(self):
        self.alice.notif_card_assigned = False
        self.alice.save(update_fields=["notif_card_assigned"])
        self._update(assignee=self.alice)
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(
            self._activities(),
            [(ET.ASSIGNEE_CHANGE, "Unassigned", "alice", self.owner.pk)],
        )
        self.assertEqual(self.received, [])

    def test_unchanged_assignee_is_not_renotified(self):
        self.card.assignee = self.alice
        self.card.save(update_fields=["assignee"])
        self._update(submitted={}, title="Renamed")
        self.assertEqual(Notification.objects.count(), 0)

    def test_notification_is_created_after_the_broadcast_is_registered(self):
        """Dispatch must follow the ``card.updated`` frame other clients wait on."""
        order = []
        with (
            patch(
                "boards.services.cards._broadcast_after_commit",
                side_effect=lambda *a, **k: order.append("broadcast"),
            ),
            patch(
                "boards.services.cards.create_notifications",
                side_effect=lambda *a, **k: order.append("notify"),
            ),
        ):
            self._update(assignee=self.alice)
        self.assertEqual(order, ["broadcast", "notify"])

    def test_member_cannot_assign_and_nothing_is_written(self):
        card = Card.objects.get(pk=self.card.pk)
        applied = []
        with self.assertRaises(NotPermitted) as ctx:
            svc.update_card(
                actor=self.alice,
                board=self.board,
                card=card,
                submitted={"assignee_id": self.bob.pk},
                apply=lambda: applied.append(1),
                render=_render,
            )
        self.assertEqual(
            str(ctx.exception.detail),
            "Assigning cards requires Moderator or Admin access — ask a board admin.",
        )
        self.assertEqual(applied, [])
        self.assertEqual(CardActivity.objects.count(), 0)
        self.assertEqual(Notification.objects.count(), 0)


class WeightIncreaseLimitTests(UpdateCardGapBase):
    """Only a weight *increase* is checked, and only against the weight limit."""

    def setUp(self):
        super().setUp()
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.col.weight_limit = 5
        self.col.save(update_fields=["weight_limit"])
        self.other = _make_card(
            self.col, self.lane, title="Other", position=1, weight=3
        )
        self.card.weight = 1
        self.card.save(update_fields=["weight"])

    def test_increase_past_the_limit_is_refused_and_rolled_back(self):
        before = Card.objects.get(pk=self.card.pk).version
        with self.assertRaises(WeightLimitExceeded):
            self._update(weight=4)
        card = Card.objects.get(pk=self.card.pk)
        self.assertEqual(card.weight, 1)
        self.assertEqual(card.version, before)
        self.assertEqual(CardActivity.objects.filter(card=self.card).count(), 0)

    def test_admin_must_pass_force_explicitly_to_override(self):
        """``force`` defaults to off even for an admin: overriding is opt-in."""
        with self.assertRaises(WeightLimitExceeded):
            self._update(weight=4, actor=self.owner)

    def test_admin_can_override_with_force(self):
        card = Card.objects.get(pk=self.card.pk)

        def apply():
            card.weight = 4
            card.save()

        svc.update_card(
            actor=self.owner,
            board=self.board,
            card=card,
            submitted={"weight": 4},
            apply=apply,
            render=_render,
            force=True,
        )
        self.assertEqual(Card.objects.get(pk=self.card.pk).weight, 4)

    def test_increase_that_fits_is_allowed(self):
        self._update(weight=2)
        self.assertEqual(Card.objects.get(pk=self.card.pk).weight, 2)

    def test_unchanged_weight_in_an_over_limit_column_is_allowed(self):
        """An edit that does not grow the card must not be trapped by the limit."""
        Card.objects.filter(pk=self.other.pk).update(weight=9)
        self._update(title="Renamed")
        self.assertEqual(Card.objects.get(pk=self.card.pk).title, "Renamed")

    def test_decrease_in_an_over_limit_column_is_allowed(self):
        Card.objects.filter(pk=self.other.pk).update(weight=9)
        Card.objects.filter(pk=self.card.pk).update(weight=4)
        self._update(weight=3)
        self.assertEqual(Card.objects.get(pk=self.card.pk).weight, 3)

    def test_weight_increase_ignores_a_full_wip_limit(self):
        """The column holds the same number of cards, so WIP is not re-checked."""
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.col.wip_limit = 1
        self.col.save(update_fields=["wip_limit"])
        self._update(weight=2)
        self.assertEqual(Card.objects.get(pk=self.card.pk).weight, 2)
