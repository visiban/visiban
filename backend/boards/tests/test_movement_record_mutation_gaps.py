"""Assertions added from the #1443 manual mutation baseline (movement record).

Each test here kills a mutant of ``boards/services/cards.py`` that the existing
suites let survive: the audit-trail row written on create, the
column/swimlane/position bypass guard that protects the movement record, the
weight-limit boundary on an empty column, the role-hint rejection warning, and
the restore ownership message. See ``docs/development/mutation-testing.md`` for
how the baseline is produced and which survivors were judged equivalent.
"""
from unittest.mock import patch

from django.test import TestCase

from boards.models import BoardMembership, CardMovement
from boards.services import cards as svc
from boards.services.errors import NotPermitted, UseMoveEndpoint
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)


def _render(card, movement=None):
    return {"id": card.pk, "position": card.position}


class MovementGapBase(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("gap_owner")
        self.board = _make_board(self.owner)
        self.col_a = _make_column(self.board, "A", 0)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col_a, self.lane, title="Subject")


class CreateMovementRecordTests(MovementGapBase):
    def test_created_card_gets_a_genesis_movement_with_empty_origin(self):
        """Creation is the first row of the audit trail: no origin, real target."""
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])

        def save(position):
            return _make_card(self.col_a, self.lane, title="New", position=position)

        result = svc.create_card(
            actor=self.owner, board=self.board, column_id=self.col_a.pk,
            swimlane_id=self.lane.pk, save=save, render=_render,
        )
        movement = CardMovement.objects.get(card=result.card)
        self.assertIsNone(movement.from_column)
        self.assertIsNone(movement.from_swimlane)
        self.assertEqual(movement.from_column_name, "")
        self.assertEqual(movement.from_column_uid, "")
        self.assertEqual(movement.from_swimlane_name, "")
        self.assertEqual(movement.from_swimlane_uid, "")
        self.assertEqual(movement.to_column_name, "A")
        self.assertEqual(movement.to_column_uid, self.col_a.uid)
        self.assertEqual(movement.to_swimlane_name, "L")
        self.assertEqual(movement.to_swimlane_uid, self.lane.uid)
        self.assertEqual(movement.notes, "Card created")
        self.assertEqual(movement.moved_by_id, self.owner.pk)
        # Create/archive results carry no movement for the caller.
        self.assertIsNone(result.movement)

    def test_result_defaults_are_none(self):
        result = svc.CardMutationResult(card=self.card)
        self.assertIsNone(result.payload)
        self.assertIsNone(result.movement)


class MoveGuardTests(MovementGapBase):
    """``update_card`` must not become a back door around the movement record."""

    def _update(self, submitted):
        return svc.update_card(
            actor=self.owner, board=self.board, card=self.card,
            submitted=submitted, apply=lambda: None, render=_render,
        )

    def test_changing_position_is_rejected(self):
        with self.assertRaises(UseMoveEndpoint) as ctx:
            self._update({"position": self.card.position + 3})
        self.assertEqual(ctx.exception.field_name, "position")

    def test_null_column_does_not_hide_a_position_change(self):
        """A ``None`` is left to field validation, but must not short-circuit
        the checks on the fields after it."""
        with self.assertRaises(UseMoveEndpoint) as ctx:
            self._update({"column": None, "position": self.card.position + 1})
        self.assertEqual(ctx.exception.field_name, "position")

    def test_non_numeric_column_does_not_hide_a_position_change(self):
        with self.assertRaises(UseMoveEndpoint) as ctx:
            self._update({"column": "abc", "position": self.card.position + 1})
        self.assertEqual(ctx.exception.field_name, "position")

    def test_echoing_the_current_position_is_accepted(self):
        self._update({"position": self.card.position})


class EmptyColumnWeightLimitTests(MovementGapBase):
    def test_empty_target_column_counts_as_zero_weight(self):
        """With nothing in the target, a card whose weight equals the limit fits.

        Guards the ``or 0`` fallback on the aggregate: a non-zero fallback would
        phantom-fill an empty column and refuse a legal move.
        """
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.col_b.weight_limit = 3
        self.col_b.save(update_fields=["weight_limit"])
        self.card.weight = 3
        self.card.save(update_fields=["weight"])

        result = svc.move_card(
            actor=self.owner, board=self.board, render=_render,
            card_id=self.card.pk, target_column_id=self.col_b.pk,
            target_swimlane_id=self.lane.pk, position=0,
        )
        self.assertEqual(result.card.column_id, self.col_b.pk)
        self.assertEqual(result.movement.to_column_name, "B")
        self.assertEqual(result.movement.from_column_name, "A")


class RoleHintAndRestoreTests(MovementGapBase):
    def test_rejected_role_hint_is_logged_and_ignored(self):
        member = _make_user("gap_member")
        _make_membership(self.board, member, BoardMembership.Role.MEMBER)
        with self.assertLogs("boards.services.cards", level="WARNING") as logs:
            role = svc._resolve_role(member, self.board, BoardMembership.Role.ADMIN)
        self.assertEqual(role, BoardMembership.Role.MEMBER)
        message = logs.records[0].getMessage()
        self.assertTrue(message.startswith("card.service.role_hint_rejected board_id="))
        self.assertTrue(message.endswith("— deriving from the database instead"))

    def test_member_cannot_restore_anothers_archived_card(self):
        member = _make_user("gap_member2")
        _make_membership(self.board, member, BoardMembership.Role.MEMBER)
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        with self.assertRaises(NotPermitted) as ctx:
            svc.unarchive_card(
                actor=member, board=self.board, card_id=self.card.pk, render=_render,
            )
        self.assertEqual(ctx.exception.detail, "You can only restore cards you created.")


class CardMovementModelContractTests(MovementGapBase):
    """Behavioral contract of the audit-row model, not its schema constants."""

    def test_defaults_and_choice_values_are_the_wire_values(self):
        row = CardMovement.objects.create(card=self.card)
        self.assertEqual(row.movement_type, "move")
        self.assertEqual(CardMovement.MovementType.MOVE.value, "move")
        self.assertEqual(CardMovement.MovementType.ARCHIVED.value, "archived")
        self.assertEqual(CardMovement.MovementType.UNARCHIVED.value, "unarchived")
        self.assertEqual(CardMovement.MovementType.MOVE.label, "Move")
        self.assertEqual(CardMovement.MovementType.ARCHIVED.label, "Archived")
        self.assertEqual(CardMovement.MovementType.UNARCHIVED.label, "Unarchived")
        self.assertEqual(row.notes, "")
        for name in ("from_column_name", "to_column_name", "from_swimlane_name",
                     "to_swimlane_name", "from_column_uid", "to_column_uid",
                     "from_swimlane_uid", "to_swimlane_uid"):
            self.assertEqual(getattr(row, name), "", name)

    def test_default_ordering_is_newest_first(self):
        from datetime import timedelta
        from django.utils import timezone
        first = CardMovement.objects.create(card=self.card, notes="first")
        CardMovement.objects.create(card=self.card, notes="second")
        CardMovement.objects.filter(pk=first.pk).update(
            moved_at=timezone.now() - timedelta(days=1)
        )
        self.assertEqual(
            list(CardMovement.objects.filter(card=self.card).values_list("notes", flat=True)),
            ["second", "first"],
        )
        self.assertEqual(CardMovement._meta.ordering, ["-moved_at"])

    def test_history_survives_deleting_what_it_points_at(self):
        """SET_NULL, with the denormalized names kept, is what preserves history."""
        actor = _make_user("gap_actor")
        row = CardMovement.objects.create(
            card=self.card, from_column=self.col_a, to_column=self.col_b,
            from_swimlane=self.lane, to_swimlane=self.lane, moved_by=actor,
            from_column_name="A", to_column_name="B",
            from_swimlane_name="L", to_swimlane_name="L",
        )
        other_lane = _make_swimlane(self.board, "Other", 1)
        row2 = CardMovement.objects.create(
            card=self.card, from_swimlane=other_lane, to_swimlane=other_lane,
            from_swimlane_name="Other", to_swimlane_name="Other",
        )
        other_lane.delete()
        row2.refresh_from_db()
        self.assertIsNone(row2.from_swimlane)
        self.assertIsNone(row2.to_swimlane)
        self.assertEqual(row2.to_swimlane_name, "Other")

        self.col_b.delete()
        row.refresh_from_db()
        self.assertIsNone(row.to_column)
        self.assertEqual(row.to_column_name, "B")

        # Deleting the actor must not delete (or fail on) the rows they wrote.
        actor.delete()
        row.refresh_from_db()
        self.assertIsNone(row.moved_by)


class ExportedMovementHistoryTests(MovementGapBase):
    """The JSON export is the compliance-facing copy of the movement trail."""

    def test_json_export_orders_movements_chronologically_with_every_key(self):
        from datetime import timedelta
        from django.utils import timezone
        from rest_framework.test import APIClient

        now = timezone.now()
        # Created newest-first so a missing sort would be visible in the output.
        rows = [
            (CardMovement.MovementType.UNARCHIVED, now - timedelta(hours=1)),
            (CardMovement.MovementType.ARCHIVED, now - timedelta(hours=2)),
            (CardMovement.MovementType.MOVE, now - timedelta(hours=3)),
        ]
        for movement_type, when in rows:
            row = CardMovement.objects.create(
                card=self.card, from_column=self.col_a, to_column=self.col_b,
                from_swimlane=self.lane, to_swimlane=self.lane, moved_by=self.owner,
                notes=movement_type, movement_type=movement_type,
            )
            CardMovement.objects.filter(pk=row.pk).update(moved_at=when)

        client = APIClient()
        client.force_authenticate(self.owner)
        resp = client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        card_data = resp.json()["cards"][0]
        movements = card_data["movements"]
        self.assertEqual(
            [m["movement_type"] for m in movements], ["move", "archived", "unarchived"],
        )
        self.assertEqual(
            set(movements[0]),
            {"from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by",
             "moved_at", "notes", "movement_type"},
        )
        self.assertEqual(movements[0]["from_column"], "A")
        self.assertEqual(movements[0]["to_column"], "B")
        self.assertEqual(movements[0]["moved_by"], "gap_owner")


class DeleteAndCreateSideEffectTests(MovementGapBase):
    def test_delete_broadcasts_only_the_card_uid(self):
        uid = self.card.uid
        with patch("boards.broadcast.broadcast_board_event") as broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                svc.delete_card(actor=self.owner, board=self.board, card=self.card)
        board_id, event, payload = broadcast.call_args[0]
        self.assertEqual((board_id, event), (self.board.pk, "card.deleted"))
        self.assertEqual(payload, {"card_uid": uid})

    def test_create_with_a_description_notifies_mentions_from_an_empty_baseline(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])

        def save(position):
            return _make_card(
                self.col_a, self.lane, title="New", position=position,
                description="hello @someone",
            )

        with patch("boards.services.cards.notify_new_mentions") as notify:
            with self.captureOnCommitCallbacks(execute=True):
                result = svc.create_card(
                    actor=self.owner, board=self.board, column_id=self.col_a.pk,
                    swimlane_id=self.lane.pk, save=save, render=_render,
                )
        notify.assert_called_once_with(result.card, self.owner, "", "hello @someone")
