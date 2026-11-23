"""Planned children (#2371): known child work for a later parent stage.

Covers the migration shape, Add child with ``needed_at_column`` and its
validation, the per-viewer card fields (column name hidden from a viewer who
cannot open the parent; absent context omits every field), release when the
parent reaches or skips past the column (never re-planned on a move back),
release on pull, the column-deleted "Needed: Now" note, the manual Needed
write and its role rules, and the inactive date: Overdue, Due soon and Stale
leave a planned child out while every other To do card keeps its date.
"""
import datetime
import importlib
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.card_signals import not_planned_q, overdue_q
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardMovement, CardParentLink, Column, Swimlane,
)
from boards.serializers import CardSerializer
from boards.services import planned_children

Role = BoardMembership.Role
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
EV = CardActivity.EventType


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


class MigrationTests(TestCase):
    def test_nullable_fields_then_a_concurrent_index_alone(self):
        m = importlib.import_module("boards.migrations.0131_card_parent_link_planned")
        kinds = [op.__class__.__name__ for op in m.Migration.operations]
        self.assertEqual(kinds, ["AddField", "AddField", "AlterField"])
        for op in m.Migration.operations[:2]:
            self.assertTrue(op.field.null)
        self.assertFalse(m.Migration.operations[0].field.db_index)
        idx = importlib.import_module("boards.migrations.0132_card_parent_link_needed_col_idx")
        self.assertFalse(idx.Migration.atomic)
        self.assertEqual([op.__class__.__name__ for op in idx.Migration.operations], ["AddIndexConcurrently"])


class PlannedFixture(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="pc_owner", password="pass")
        self.pboard = Board.objects.create(name="Pipeline", owner=self.owner, cards_can_have_children=True)
        self.lead = Column.objects.create(board=self.pboard, name="Lead", position=0, allow_card_creation=True)
        self.qualify = Column.objects.create(board=self.pboard, name="Qualify", position=1)
        self.proposal = Column.objects.create(board=self.pboard, name="Proposal", position=2)
        self.won = Column.objects.create(board=self.pboard, name="Won", position=3)
        self.plane = Swimlane.objects.create(board=self.pboard, name="Hooli", position=0)
        self.cboard = Board.objects.create(name="Delivery", owner=self.owner)
        self.todo = Column.objects.create(board=self.cboard, name="To do", position=0, allow_card_creation=True)
        self.doing = Column.objects.create(board=self.cboard, name="Doing", position=1)
        self.clane = Swimlane.objects.create(board=self.cboard, name="Team", position=0)
        self.maya = self.member("maya", parent=Role.MEMBER, child=Role.MEMBER)
        self.sam = self.member("sam", child=Role.MEMBER)  # cannot open the parent
        self.vic = self.member("vic", parent=Role.MEMBER, child=Role.VIEWER)
        self.parent = Card.objects.create(
            board=self.pboard, column=self.lead, swimlane=self.plane, title="Hooli: pilot rollout",
        )

    def member(self, name, *, parent=None, child=None):
        user = User.objects.create_user(username=f"pc_{name}", password="pass")
        if parent:
            BoardMembership.objects.create(board=self.pboard, user=user, role=parent)
        if child:
            BoardMembership.objects.create(board=self.cboard, user=user, role=child)
        return user

    def add_child(self, user=None, **extra):
        body = {"board_id": self.cboard.pk, "title": "Proposal workshop", **extra}
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user or self.maya).post(
                f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/", body, format="json",
            )

    def planned_child(self, column=None, due=None):
        r = self.add_child(needed_at_column=(column or self.proposal).pk)
        self.assertEqual(r.status_code, 201, r.content)
        child = Card.objects.get(pk=r.json()["id"])
        if due:
            child.due_date = due
            child.save(update_fields=["due_date"])
        return child

    def move(self, card, board, column, lane, user=None):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user or self.maya).post(
                f"/api/v1/boards/{board.pk}/cards/{card.pk}/move/",
                {"column_id": column.pk, "swimlane_id": lane.pk, "position": 0}, format="json",
            )

    def link(self, child):
        return CardParentLink.objects.get(child=child)

    def read(self, child, user):
        r = client_for(user).get(f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def events(self, child):
        return list(
            CardActivity.objects.filter(card=child, event_type__in=[EV.PLANNED_RELEASED, EV.NEEDED_CHANGED])
            .order_by("pk").values_list("event_type", "from_value", "to_value", "actor_id")
        )


class AddChildNeededTests(PlannedFixture):
    def test_omitted_is_needed_now_as_before(self):
        r = self.add_child()
        self.assertEqual(r.status_code, 201, r.content)
        link = self.link(Card.objects.get(pk=r.json()["id"]))
        self.assertIsNone(link.needed_at_column_id)
        self.assertEqual(self.events(link.child), [])

    def test_later_column_plans_the_child_in_to_do_with_a_history_row(self):
        child = self.planned_child()
        self.assertEqual(child.column_id, self.todo.pk)
        link = self.link(child)
        self.assertEqual(link.needed_at_column_id, self.proposal.pk)
        self.assertIsNone(link.planned_released_at)
        self.assertEqual(self.events(child), [(EV.NEEDED_CHANGED, "created", "planned", self.maya.pk)])

    def test_rejects_current_earlier_foreign_and_non_integer_columns_and_creates_nothing(self):
        other = Column.objects.create(board=self.cboard, name="Elsewhere", position=5)
        for value in (self.lead.pk, other.pk, True, "3", 999999):
            r = self.add_child(needed_at_column=value)
            self.assertEqual(r.status_code, 400, (value, r.content))
            self.assertIn("needed_at_column", r.json())
        self.assertFalse(Card.objects.filter(board=self.cboard).exists())


class ViewerFieldTests(PlannedFixture):
    def test_visible_parent_gets_the_column_and_hidden_parent_only_the_state(self):
        child = self.planned_child()
        seen = self.read(child, self.maya)
        self.assertEqual(
            (seen["planned"], seen["needed_now"], seen["needed_at_column"], seen["needed_at_column_name"]),
            (True, False, self.proposal.pk, "Proposal"),
        )
        hidden = self.read(child, self.sam)
        self.assertEqual(
            (hidden["planned"], hidden["needed_at_column"], hidden["needed_at_column_name"]),
            (True, None, None),
        )

    def test_unlinked_card_reads_not_planned(self):
        loose = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Loose")
        body = self.read(loose, self.maya)
        self.assertEqual((body["planned"], body["needed_now"], body["needed_at_column"]), (False, False, None))

    def test_absent_context_omits_every_field_and_absent_viewer_hides_the_column(self):
        child = self.planned_child()
        data = CardSerializer(child, context={}).data
        for key in ("planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at"):
            self.assertNotIn(key, data)
        from boards.services.card_links import parents_for_viewer

        out = {}
        parents_for_viewer([child.pk], None, planned=out)
        anon = out[child.pk]
        self.assertEqual((anon["planned"], anon["needed_at_column"], anon["needed_at_column_name"]), (True, None, None))
        out = {}
        self.assertEqual(parents_for_viewer([], self.maya, planned=out), {})
        self.assertEqual(out, {})


class ReleaseTests(PlannedFixture):
    def test_parent_reaching_the_column_releases_with_an_actorless_row_and_needed_now(self):
        child = self.planned_child(due=datetime.date(2026, 12, 4))
        self.assertEqual(self.move(self.parent, self.pboard, self.qualify, self.plane).status_code, 200)
        self.assertIsNone(self.link(child).planned_released_at)
        self.assertEqual(self.move(self.parent, self.pboard, self.proposal, self.plane).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual(self.events(child)[-1], (EV.PLANNED_RELEASED, "parent_reached", "2026-12-04", None))
        body = self.read(child, self.maya)
        self.assertEqual((body["planned"], body["needed_now"]), (False, True))
        # Leaving To do ends "needed now"; it is an ordinary card from then on.
        self.move(child, self.cboard, self.doing, self.clane)
        self.assertFalse(self.read(child, self.maya)["needed_now"])

    def test_skipping_past_releases_and_moving_back_never_replans(self):
        child = self.planned_child(column=self.qualify)
        self.move(self.parent, self.pboard, self.won, self.plane)
        released = self.link(child).planned_released_at
        self.assertIsNotNone(released)
        self.move(self.parent, self.pboard, self.lead, self.plane)
        self.assertEqual(self.link(child).planned_released_at, released)
        self.assertEqual(len([e for e in self.events(child) if e[0] == EV.PLANNED_RELEASED]), 1)

    def test_pulling_the_child_releases_it_once(self):
        child = self.planned_child()
        self.assertEqual(self.move(child, self.cboard, self.doing, self.clane).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        self.assertEqual(
            [e[:2] for e in self.events(child)],
            [(EV.NEEDED_CHANGED, "created"), (EV.PLANNED_RELEASED, "pulled")],
        )
        self.assertFalse(self.read(child, self.maya)["needed_now"])

    def test_deleting_the_column_makes_it_needed_now_with_a_note(self):
        child = self.planned_child()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.owner).delete(f"/api/v1/boards/{self.pboard.pk}/columns/{self.proposal.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertIsNone(self.link(child).needed_at_column_id)
        self.assertEqual(self.events(child)[-1], (EV.NEEDED_CHANGED, "column_deleted", "now", self.owner.pk))


class ManualNeededTests(PlannedFixture):
    def post(self, user, child, value):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/needed/", {"needed_at_column": value}, format="json",
            )

    def test_set_now_then_replan_keeps_the_date_and_records_each_change(self):
        child = self.planned_child(due=datetime.date(2026, 12, 4))
        r = self.post(self.maya, child, None)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["planned"], False)
        r = self.post(self.maya, child, self.won.pk)
        self.assertEqual((r.status_code, r.json()["planned"]), (200, True))
        child.refresh_from_db()
        self.assertEqual(child.due_date, datetime.date(2026, 12, 4))
        self.assertEqual(
            [e[1:3] for e in self.events(child)],
            [("created", "planned"), ("manual", "now"), ("manual", "planned")],
        )
        # A no-op writes nothing.
        self.post(self.maya, child, self.won.pk)
        self.assertEqual(len(self.events(child)), 3)

    def test_hidden_parent_viewer_may_only_set_now(self):
        child = self.planned_child()
        r = self.post(self.sam, child, self.won.pk)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("Won", r.content.decode())
        self.assertEqual(self.post(self.sam, child, None).status_code, 200)

    def test_viewer_role_and_absent_body_and_unlinked_card_are_refused(self):
        child = self.planned_child()
        self.assertEqual(self.post(self.vic, child, None).status_code, 403)
        with patch(PATCH_BROADCAST):
            r = client_for(self.maya).post(f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/needed/", {}, format="json")
        self.assertEqual(r.status_code, 400)
        loose = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Loose")
        self.assertEqual(self.post(self.maya, loose, None).status_code, 400)

    def test_only_a_card_in_the_first_column_can_be_planned(self):
        r = self.add_child()
        child = Card.objects.get(pk=r.json()["id"])
        self.move(child, self.cboard, self.doing, self.clane)
        self.assertEqual(self.post(self.maya, child, self.won.pk).status_code, 400)


class InactiveDateTests(PlannedFixture):
    def test_overdue_and_due_soon_leave_out_only_planned_children(self):
        past = datetime.date(2020, 1, 1)
        child = self.planned_child(due=past)
        plain = Card.objects.create(
            board=self.cboard, column=self.todo, swimlane=self.clane, title="Plain", due_date=past,
        )
        today = datetime.date(2026, 11, 22)
        overdue = set(Card.objects.filter(board=self.cboard).filter(overdue_q(today)).values_list("pk", flat=True))
        self.assertEqual(overdue, {plain.pk})
        counted = set(Card.objects.filter(board=self.cboard).filter(not_planned_q()).values_list("pk", flat=True))
        self.assertEqual(counted, {plain.pk})
        # Released, the date is live again.
        CardParentLink.objects.filter(child=child).update(planned_released_at=timezone.now())
        overdue = set(Card.objects.filter(board=self.cboard).filter(overdue_q(today)).values_list("pk", flat=True))
        self.assertEqual(overdue, {plain.pk, child.pk})

    def test_stale_is_off_while_planned_and_restarts_at_release(self):
        child = self.planned_child()
        old = timezone.now() - datetime.timedelta(days=400)
        Card.objects.filter(pk=child.pk).update(created_at=old)
        CardMovement.objects.filter(card_id=child.pk).update(moved_at=old)
        self.assertFalse(self.read(child, self.maya)["is_stale"])
        CardParentLink.objects.filter(child=child).update(planned_released_at=timezone.now())
        self.assertFalse(self.read(child, self.maya)["is_stale"])
        CardParentLink.objects.filter(child=child).update(planned_released_at=old)
        self.assertTrue(self.read(child, self.maya)["is_stale"])

    def test_stale_exempt_helper_fails_closed_on_a_missing_entry(self):
        self.assertFalse(planned_children.planned_stale_exempt(None, 7))
        self.assertFalse(planned_children.planned_stale_exempt({"planned": False, "planned_released_at": None}, 7))
