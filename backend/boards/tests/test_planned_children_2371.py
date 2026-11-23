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
import threading
from unittest import skipUnless
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.card_signals import not_planned_q, overdue_q
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardMovement, CardParentLink, Column, Swimlane,
)
from boards.serializers import CardSerializer
from boards.services import planned_children
from boards.tests.lock_wait import assert_blocked_on_lock

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


class AddChildDenialTests(PlannedFixture):
    def test_parent_viewer_cannot_create_a_planned_child(self):
        vera = self.member("vera", parent=Role.VIEWER, child=Role.MEMBER)
        r = self.add_child(vera, needed_at_column=self.proposal.pk)
        self.assertEqual(r.status_code, 403, r.content)
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
        self.assertIsNone(body["needed_now_reason"])

    def test_absent_context_omits_every_field_and_absent_viewer_hides_the_column(self):
        child = self.planned_child()
        data = CardSerializer(child, context={}).data
        for key in (
            "planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at",
            "needed_now_reason",
        ):
            self.assertNotIn(key, data)
        from boards.services.card_links import parents_for_viewer

        out = {}
        parents_for_viewer([child.pk], None, planned=out)
        anon = out[child.pk]
        self.assertEqual((anon["planned"], anon["needed_at_column"], anon["needed_at_column_name"]), (True, None, None))
        out = {}
        self.assertEqual(parents_for_viewer([], self.maya, planned=out), {})
        self.assertEqual(out, {})


class PlannedFieldSurfaceTests(PlannedFixture):
    """Rule 19: the share link and MCP take no planned context, so none of the
    six planned fields, ``needed_now_reason`` included, reaches them."""

    KEYS = {
        "planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at",
        "needed_now_reason",
    }

    def test_share_link_and_mcp_card_shapes_carry_no_planned_field(self):
        from boards.serializers import PublicCardSerializer
        from mcp_server.tools import _serialize_card

        child = self.planned_child()
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        self.assertEqual(self.read(child, self.sam)["needed_now_reason"], "parent")
        self.assertEqual(self.KEYS & set(PublicCardSerializer().fields), set())
        card = Card.objects.select_related("column", "swimlane").get(pk=child.pk)
        self.assertEqual(self.KEYS & set(_serialize_card(card)), set())


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
        # The cause goes to every reader of the child, including one who cannot
        # open the parent (column hidden): the face then says "the parent moved on".
        self.assertEqual((body["needed_now_reason"], body["needed_at_column_name"]), ("parent", "Proposal"))
        hidden = self.read(child, self.sam)
        self.assertEqual(
            (hidden["needed_now"], hidden["needed_now_reason"], hidden["needed_at_column"], hidden["needed_at_column_name"]),
            (True, "parent", None, None),
        )
        # Leaving To do ends "needed now"; it is an ordinary card from then on.
        self.move(child, self.cboard, self.doing, self.clane)
        after = self.read(child, self.maya)
        self.assertEqual((after["needed_now"], after["needed_now_reason"]), (False, None))

    def test_skipping_past_releases_and_moving_back_never_replans(self):
        child = self.planned_child(column=self.qualify)
        self.move(self.parent, self.pboard, self.won, self.plane)
        released = self.link(child).planned_released_at
        self.assertIsNotNone(released)
        self.move(self.parent, self.pboard, self.lead, self.plane)
        self.assertEqual(self.link(child).planned_released_at, released)
        self.assertEqual(len([e for e in self.events(child) if e[0] == EV.PLANNED_RELEASED]), 1)

    def test_parent_mover_with_no_child_board_role_still_releases(self):
        # Release is a system write caused by the link (Rule 19), not a write
        # on the child board by the mover.
        child = self.planned_child()
        pat = self.member("pat", parent=Role.MEMBER)
        self.assertEqual(self.move(self.parent, self.pboard, self.proposal, self.plane, user=pat).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual(self.events(child)[-1], (EV.PLANNED_RELEASED, "parent_reached", "", None))

    def test_django_admin_column_change_releases_like_a_move(self):
        from django.contrib.admin.sites import AdminSite
        from django.test import RequestFactory

        from boards.admin import CardAdmin

        child = self.planned_child()
        request = RequestFactory().post("/admin/")
        request.user = self.owner
        parent = Card.objects.get(pk=self.parent.pk)
        parent.column = self.won
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            CardAdmin(Card, AdminSite()).save_model(request, parent, None, change=True)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual(self.events(child)[-1][:2], (EV.PLANNED_RELEASED, "parent_reached"))

    def test_pulling_the_child_releases_it_once(self):
        child = self.planned_child()
        self.assertEqual(self.move(child, self.cboard, self.doing, self.clane).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        self.assertEqual(
            [e[:2] for e in self.events(child)],
            [(EV.NEEDED_CHANGED, "created"), (EV.PLANNED_RELEASED, "pulled")],
        )
        pulled = self.read(child, self.maya)
        self.assertEqual((pulled["needed_now"], pulled["needed_now_reason"]), (False, None))

    def test_planned_child_has_no_reason(self):
        child = self.planned_child()
        for user in (self.maya, self.sam):
            body = self.read(child, user)
            self.assertEqual((body["planned"], body["needed_now_reason"]), (True, None))

    def test_deleting_the_column_makes_it_needed_now_with_a_note(self):
        child = self.planned_child()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.owner).delete(f"/api/v1/boards/{self.pboard.pk}/columns/{self.proposal.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertIsNone(self.link(child).needed_at_column_id)
        # Actorless (Rule 19): the parent-board admin who deleted the column
        # may hold no role on the child board, whose readers see this row.
        self.assertEqual(self.events(child)[-1], (EV.NEEDED_CHANGED, "column_deleted", "now", None))
        # Released with no column to name, so the child reads needed now (the
        # card face then says a neutral "Needed now", not that the parent moved).
        # needed_now_reason tells the face the plan was cancelled, so it does not
        # claim the parent moved, for a reader on either side of the parent.
        for user in (self.maya, self.sam):
            body = self.read(child, user)
            self.assertEqual((body["planned"], body["needed_now"]), (False, True))
            self.assertEqual((body["needed_at_column"], body["needed_at_column_name"]), (None, None))
            self.assertEqual(body["needed_now_reason"], "cancelled")


class LeftoverParentReleaseTests(PlannedFixture):
    """B1 (#2446 merged under #2371): a flag-off board can hold a leftover
    parent, so release decides by the link rows, never by the board flag."""

    def turn_parent_board_off(self):
        Board.objects.filter(pk=self.pboard.pk).update(cards_can_have_children=False)
        self.pboard.refresh_from_db()
        self.assertFalse(self.pboard.cards_can_have_children)

    def released_rows(self, child):
        return [e for e in self.events(child) if e[0] == EV.PLANNED_RELEASED]

    def test_leftover_parent_moving_past_needed_releases_its_child_once(self):
        child = self.planned_child(column=self.qualify, due=datetime.date(2026, 12, 4))
        self.turn_parent_board_off()
        self.assertEqual(self.move(self.parent, self.pboard, self.proposal, self.plane).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual(self.released_rows(child), [(EV.PLANNED_RELEASED, "parent_reached", "2026-12-04", None)])
        self.assertEqual(self.read(child, self.maya)["needed_now"], True)

    def test_leftover_parent_django_admin_column_change_releases(self):
        from django.contrib.admin.sites import AdminSite
        from django.test import RequestFactory

        from boards.admin import CardAdmin

        child = self.planned_child()
        self.turn_parent_board_off()
        request = RequestFactory().post("/admin/")
        request.user = self.owner
        parent = Card.objects.select_related("board").get(pk=self.parent.pk)
        parent.column = self.won
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            CardAdmin(Card, AdminSite()).save_model(request, parent, None, change=True)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual([e[:2] for e in self.released_rows(child)], [(EV.PLANNED_RELEASED, "parent_reached")])

    def test_pulled_child_with_both_boards_off_releases_once(self):
        child = self.planned_child()
        self.turn_parent_board_off()
        self.assertFalse(self.cboard.cards_can_have_children)
        self.assertEqual(self.move(child, self.cboard, self.doing, self.clane).status_code, 200)
        self.assertIsNotNone(self.link(child).planned_released_at)
        self.assertEqual(self.released_rows(child), [(EV.PLANNED_RELEASED, "pulled", "", self.maya.pk)])
        # The parent reaching the column afterwards releases nothing more.
        self.move(self.parent, self.pboard, self.won, self.plane)
        self.assertEqual(len(self.released_rows(child)), 1)

    def test_parent_on_a_flag_on_board_still_releases_and_an_ordinary_move_costs_one_query(self):
        child = self.planned_child()
        self.assertEqual(self.move(self.parent, self.pboard, self.won, self.plane).status_code, 200)
        self.assertEqual(len(self.released_rows(child)), 1)
        loose = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Loose")
        with self.assertNumQueries(1):
            planned_children.release_on_move(loose, to_column=self.doing, actor=self.maya)
        with self.assertNumQueries(1):
            planned_children.release_on_move(self.parent, to_column=self.won, actor=self.maya)
        # move_card passes what its pings already read: a side found empty
        # is skipped, and a card with neither children nor a parent pays none.
        with self.assertNumQueries(0):
            planned_children.release_on_move(
                loose, to_column=self.doing, actor=self.maya, may_be_parent=False, may_be_child=False,
            )

    def test_move_hints_never_skip_a_side_that_has_links(self):
        from boards.services.card_links import announce_children_changed, announce_parent_changed

        child = self.planned_child()
        loose = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Loose")
        with patch(PATCH_BROADCAST):
            self.assertEqual(announce_parent_changed(self.parent.pk, self.pboard, actor_id=None), [child.pk])
            self.assertEqual(announce_parent_changed(loose.pk, self.cboard, actor_id=None), [])
            self.assertEqual(announce_children_changed([child.pk], board=self.cboard, actor_id=None), {child.pk})
            self.assertEqual(announce_children_changed([loose.pk], board=self.cboard, actor_id=None), set())
            # Did not look (a parent-tier board, or no ids): None, never "no parent".
            self.assertIsNone(announce_children_changed([self.parent.pk], board=self.pboard, actor_id=None))
            self.assertIsNone(announce_children_changed([], board=self.cboard, actor_id=None))


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

    def test_set_now_reads_cancelled_for_every_reader(self):
        child = self.planned_child()
        self.assertEqual(self.post(self.maya, child, None).status_code, 200)
        for user in (self.maya, self.sam):
            body = self.read(child, user)
            self.assertEqual((body["needed_now"], body["needed_now_reason"]), (True, "cancelled"))

    def test_set_now_after_the_parent_released_it_reads_cancelled(self):
        # Needed: Now on an already released link clears its column, so the
        # face no longer claims the parent's move (the release time stays).
        child = self.planned_child()
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        self.assertEqual(self.read(child, self.maya)["needed_now_reason"], "parent")
        self.assertEqual(self.post(self.maya, child, None).status_code, 200)
        self.assertEqual(self.read(child, self.maya)["needed_now_reason"], "cancelled")

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

    def test_parent_board_viewer_may_only_set_now(self):
        # A column needs a WRITE role on the parent (the create_child rule),
        # not just any role: a parent-board viewer gets the same 400.
        pam = self.member("pam", parent=Role.VIEWER, child=Role.MEMBER)
        child = self.planned_child()
        r = self.post(pam, child, self.won.pk)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.post(pam, child, None).status_code, 200)

    def test_parent_board_missing_from_the_role_lookup_denies_instead_of_500(self):
        child = self.planned_child()
        with patch("boards.services.planned_children.get_board_roles", return_value={}):
            r = self.post(self.maya, child, self.won.pk)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertTrue(self.link(child).planned_released_at is None)
        self.assertEqual(self.link(child).needed_at_column_id, self.proposal.pk)

    def test_caller_with_no_child_board_access_gets_404(self):
        child = self.planned_child()
        stranger = self.member("stranger", parent=Role.MEMBER)
        self.assertEqual(self.post(stranger, child, None).status_code, 404)
        self.assertEqual(self.link(child).needed_at_column_id, self.proposal.pk)

    def test_card_from_another_board_in_the_url_is_404(self):
        child = self.planned_child()
        # Maya is a member of both boards; the card is not on the URL's board.
        with patch(PATCH_BROADCAST):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.pboard.pk}/cards/{child.pk}/needed/", {"needed_at_column": None}, format="json",
            )
        self.assertEqual(r.status_code, 404, r.content)
        self.assertEqual(self.link(child).needed_at_column_id, self.proposal.pk)

    def test_column_from_an_unrelated_board_is_refused(self):
        child = self.planned_child()
        other_board = Board.objects.create(name="Other", owner=self.owner)
        foreign = Column.objects.create(board=other_board, name="Elsewhere", position=9)
        r = self.post(self.maya, child, foreign.pk)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertNotIn("Elsewhere", r.content.decode())
        self.assertEqual(self.link(child).needed_at_column_id, self.proposal.pk)

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

    def _released_old_child(self):
        """A child created 400 days ago and released by the parent just now."""
        child = self.planned_child()
        old = timezone.now() - datetime.timedelta(days=400)
        Card.objects.filter(pk=child.pk).update(created_at=old)
        CardMovement.objects.filter(card_id=child.pk).update(moved_at=old)
        self.assertEqual(self.move(self.parent, self.pboard, self.proposal, self.plane).status_code, 200)
        released = self.link(child).planned_released_at
        self.assertIsNotNone(released)
        return child, released

    def _assert_still_restarted(self, child, released):
        from boards.serializers import _row_is_stale

        body = self.read(child, self.maya)
        self.assertEqual((body["is_stale"], body["planned"], body["needed_now"]), (False, False, True))
        self.assertEqual(body["planned_released_at"], released.isoformat())
        # The unannotated fallback agrees.
        self.assertFalse(_row_is_stale(Card.objects.select_related("board").get(pk=child.pk)))

    def test_release_survives_its_column_being_deleted(self):
        child, released = self._released_old_child()
        # The parent moves on first, so deleting the column does not take the parent with it.
        self.assertEqual(self.move(self.parent, self.pboard, self.won, self.plane).status_code, 200)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.owner).delete(f"/api/v1/boards/{self.pboard.pk}/columns/{self.proposal.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        link = self.link(child)
        self.assertEqual((link.needed_at_column_id, link.planned_released_at), (None, released))
        self._assert_still_restarted(child, released)

    def test_release_survives_needed_being_set_to_now(self):
        child, released = self._released_old_child()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/needed/", {"needed_at_column": None}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        link = self.link(child)
        self.assertEqual((link.needed_at_column_id, link.planned_released_at), (None, released))
        self._assert_still_restarted(child, released)

    def _old_planned_child(self):
        """A child planned 400 days ago (created and last moved then)."""
        child = self.planned_child()
        old = timezone.now() - datetime.timedelta(days=400)
        Card.objects.filter(pk=child.pk).update(created_at=old)
        CardMovement.objects.filter(card_id=child.pk).update(moved_at=old)
        return child

    def _assert_clock_restarted_now(self, child, before):
        from boards.serializers import _row_is_stale

        link = self.link(child)
        self.assertIsNone(link.needed_at_column_id)
        self.assertIsNotNone(link.planned_released_at)
        self.assertGreaterEqual(link.planned_released_at, before)
        body = self.read(child, self.maya)
        self.assertEqual((body["is_stale"], body["planned"], body["needed_now"]), (False, False, True))
        self.assertFalse(_row_is_stale(Card.objects.select_related("board").get(pk=child.pk)))

    def test_planned_child_whose_column_is_deleted_restarts_its_clock(self):
        # Owner decision (#2371): a child planned for weeks does not turn
        # Stale the moment its column is deleted.
        child = self._old_planned_child()
        before = timezone.now()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.owner).delete(f"/api/v1/boards/{self.pboard.pk}/columns/{self.proposal.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self._assert_clock_restarted_now(child, before)
        self.assertEqual(
            [e for e in self.events(child) if e[1] != "created"], [(EV.NEEDED_CHANGED, "column_deleted", "now", None)],
        )

    def test_planned_child_set_to_now_by_hand_restarts_its_clock(self):
        child = self._old_planned_child()
        before = timezone.now()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/needed/", {"needed_at_column": None}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_clock_restarted_now(child, before)
        self.assertEqual(self.events(child)[-1], (EV.NEEDED_CHANGED, "manual", "now", self.maya.pk))
        # Leaving To do ends "needed now"; Stale then runs from that move.
        self.move(child, self.cboard, self.doing, self.clane)
        body = self.read(child, self.maya)
        self.assertEqual((body["needed_now"], body["is_stale"]), (False, False))

    def test_stale_fallback_without_the_annotation_reads_the_link(self):
        # A card serialized outside an annotated queryset (after a write) still
        # applies the planned rule, with one link read, rather than skipping it.
        from boards.serializers import _row_is_stale

        child = self.planned_child()
        old = timezone.now() - datetime.timedelta(days=400)
        Card.objects.filter(pk=child.pk).update(created_at=old)
        CardMovement.objects.filter(card_id=child.pk).update(moved_at=old)
        bare = Card.objects.select_related("board").get(pk=child.pk)
        self.assertFalse(hasattr(bare, "_planned_active"))
        self.assertFalse(_row_is_stale(bare))
        CardParentLink.objects.filter(child=child).update(planned_released_at=old)
        self.assertTrue(_row_is_stale(Card.objects.select_related("board").get(pk=child.pk)))


class StaleOverdueParityTests(PlannedFixture):
    """Rule 10 parity (#2371, owner decision): the same planned and released
    children read the same Stale and Overdue on every surface, with and
    without the viewer-named planned context."""

    def setUp(self):
        super().setUp()
        self.maya.notif_stale = True
        self.maya.notif_due_soon = True
        self.maya.save(update_fields=["notif_stale", "notif_due_soon"])
        old = timezone.now() - datetime.timedelta(days=400)
        self.planned = self.planned_child()
        self.fresh = self.planned_child()     # released inside the window
        self.expired = self.planned_child()   # released long ago
        self.plain = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Plain")
        CardParentLink.objects.filter(child=self.fresh).update(planned_released_at=timezone.now())
        CardParentLink.objects.filter(child=self.expired).update(planned_released_at=old)
        cards = [self.planned, self.fresh, self.expired, self.plain]
        Card.objects.filter(pk__in=[c.pk for c in cards]).update(created_at=old, assignee=self.maya)
        CardMovement.objects.filter(card_id__in=[c.pk for c in cards]).update(moved_at=old)
        self.expected = {self.planned.pk: False, self.fresh.pk: False, self.expired.pk: True, self.plain.pk: True}

    def stale_by(self, rows):
        # The share link has no ids, only uids.
        by_uid = dict(Card.objects.filter(pk__in=list(self.expected)).values_list("uid", "pk"))
        out = {}
        for r in rows:
            pk = r["id"] if "id" in r else by_uid.get(r.get("uid"))
            if pk in self.expected:
                out[pk] = r["is_stale"]
        return out

    def test_stale_is_the_same_on_every_surface(self):
        from django.core.management import call_command

        from boards.models import Notification
        from boards.serializers import _card_queryset
        from boards.services.health_compute import lane_counts

        ids = list(self.expected)
        # REST card read (planned context set) and the board read (SQL annotation).
        self.assertEqual({pk: self.read(Card.objects.get(pk=pk), self.maya)["is_stale"] for pk in ids}, self.expected)
        full = client_for(self.maya).get(f"/api/v1/boards/{self.cboard.pk}/full/").json()
        self.assertEqual(self.stale_by(full["cards"]), self.expected)
        # No planned context: an annotated queryset and a bare instance (fallback).
        annotated = {c.pk: CardSerializer(c, context={}).data["is_stale"] for c in _card_queryset(Card.objects.filter(pk__in=ids))}
        self.assertEqual(annotated, self.expected)
        bare = {pk: CardSerializer(Card.objects.select_related("board").get(pk=pk), context={}).data["is_stale"] for pk in ids}
        self.assertEqual(bare, self.expected)
        # Cross-board card query (per-row rule).
        query = client_for(self.maya).get("/api/v1/cards/", {"board": self.cboard.pk}).json()
        self.assertEqual(self.stale_by(query["results"]), self.expected)
        # Share link (anonymous; takes no planned context).
        token = client_for(self.owner).post(f"/api/v1/boards/{self.cboard.pk}/share/").data["share_token"]
        public = APIClient().get(f"/api/share/{token}/").json()
        self.assertEqual(self.stale_by(public["cards"]), self.expected)
        for card in public["cards"]:
            for key in ("planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at"):
                self.assertNotIn(key, card)
        # Stale digest and lane health counts.
        with patch(PATCH_BROADCAST):
            call_command("notify_stale_cards", verbosity=0)
        notified = set(Notification.objects.filter(card_id__in=ids).values_list("card_id", flat=True))
        self.assertEqual(notified, {pk for pk, stale in self.expected.items() if stale})
        self.assertEqual(lane_counts(self.cboard)[self.clane.pk]["stale"], 2)

    def test_overdue_and_due_soon_are_the_same_on_every_surface(self):
        from django.core.management import call_command

        from boards.models import Notification
        from boards.services.health_compute import lane_counts

        past = datetime.date(2020, 1, 1)
        soon = timezone.localdate() + datetime.timedelta(days=1)
        Card.objects.filter(pk__in=[self.planned.pk, self.fresh.pk]).update(due_date=past)
        late_planned = self.planned_child()
        late_released = self.planned_child()
        CardParentLink.objects.filter(child=late_released).update(planned_released_at=timezone.now())
        Card.objects.filter(pk__in=[late_planned.pk, late_released.pk]).update(due_date=soon, assignee=self.maya)
        # Overdue: the released child counts, the planned one does not.
        self.assertEqual(lane_counts(self.cboard)[self.clane.pk]["overdue"], 1)
        with patch(PATCH_BROADCAST):
            call_command("notify_due_soon", verbosity=0)
        notified = set(Notification.objects.filter(card_id__in=[late_planned.pk, late_released.pk]).values_list("card_id", flat=True))
        self.assertEqual(notified, {late_released.pk})


WAIT = 10


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class PlannedRaceTests(TransactionTestCase):
    """Lock-order and consume-once races (#2371). Patches are taken once in
    the main thread (a ``patch`` inside a worker leaks process-wide)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="pr_owner", password="pass")
        self.maya = User.objects.create_user(username="pr_maya", password="pass")
        self.pboard = Board.objects.create(name="Pipeline", owner=self.owner, cards_can_have_children=True)
        self.lead = Column.objects.create(board=self.pboard, name="Lead", position=0)
        self.proposal = Column.objects.create(board=self.pboard, name="Proposal", position=1)
        self.won = Column.objects.create(board=self.pboard, name="Won", position=2)
        plane = Swimlane.objects.create(board=self.pboard, name="Hooli", position=0)
        self.cboard = Board.objects.create(name="Delivery", owner=self.owner)
        self.todo = Column.objects.create(board=self.cboard, name="To do", position=0)
        self.doing = Column.objects.create(board=self.cboard, name="Doing", position=1)
        clane = Swimlane.objects.create(board=self.cboard, name="Team", position=0)
        for board in (self.pboard, self.cboard):
            BoardMembership.objects.create(board=board, user=self.maya, role=Role.MEMBER)
        self.parent = Card.objects.create(board=self.pboard, column=self.lead, swimlane=plane, title="Parent")
        self.child = Card.objects.create(board=self.cboard, column=self.todo, swimlane=clane, title="Child")

    def link(self, **fields):
        return CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.maya, **fields)

    def run_pair(self, holder_work, waiter_work, msg):
        """``holder_work`` runs in a transaction that stays open until the
        waiter is proven blocked on a row lock; returns the waiter's result."""
        holding, release = threading.Event(), threading.Event()
        errors, results = [], {}

        def holder():
            try:
                with transaction.atomic():
                    holder_work()
                    holding.set()
                    if not release.wait(WAIT):
                        raise RuntimeError("never released")
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                holding.set()
                connections.close_all()

        def waiter():
            try:
                if not holding.wait(WAIT):
                    raise RuntimeError("holder never took its lock")
                with transaction.atomic():
                    results["value"] = waiter_work()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                results["error"] = exc
            finally:
                connections.close_all()

        t_holder = threading.Thread(target=holder, name="holder-2371")
        t_waiter = threading.Thread(target=waiter, name="waiter-2371")
        with patch(PATCH_BROADCAST):
            t_holder.start()
            t_waiter.start()
            try:
                assert_blocked_on_lock(self, t_waiter, msg)
            finally:
                release.set()
                t_holder.join(WAIT * 3)
                t_waiter.join(WAIT * 3)
        self.assertFalse(t_holder.is_alive() or t_waiter.is_alive(), "a thread hung")
        self.assertEqual(errors, [])
        return results

    def test_set_needed_waits_on_a_parent_move_and_judges_the_moved_parent(self):
        """A parent moving past the chosen column while Needed is set: the
        write queues on the parent's row and then refuses the column the
        parent has passed, instead of planning a child no move will release."""
        link = self.link()

        def parent_move():
            # The move's shape: the parent's row lock, the column change, then
            # its release query (finds nothing planned yet), committed later.
            Card.objects.select_for_update().get(pk=self.parent.pk)
            Card.objects.filter(pk=self.parent.pk).update(column=self.won)
            self.parent.column = self.won
            planned_children.release_on_move(self.parent, to_column=self.won, actor=self.maya)

        def plan():
            return planned_children.set_needed(
                self.child, user=self.maya, child_role=Role.MEMBER, value=self.proposal.pk,
            )

        results = self.run_pair(parent_move, plan, "set_needed should queue on the parent card's row")
        self.assertIsInstance(results.get("error"), planned_children.ValidationError)
        link.refresh_from_db()
        self.assertIsNone(link.needed_at_column_id)
        self.assertFalse(CardActivity.objects.filter(card=self.child, event_type=EV.NEEDED_CHANGED).exists())

    def _column_delete(self):
        """The column delete's shape: the column row held, then its DELETE (SET_NULL on links)."""
        Column.objects.select_for_update(no_key=True).get(pk=self.proposal.pk)
        Column.objects.filter(pk=self.proposal.pk).delete()

    def test_set_needed_racing_a_column_delete_answers_400_not_500(self):
        link = self.link(needed_at_column=self.won)

        def plan():
            return planned_children.set_needed(
                self.child, user=self.maya, child_role=Role.MEMBER, value=self.proposal.pk,
            )

        results = self.run_pair(self._column_delete, plan, "set_needed should queue on the column the delete holds")
        self.assertIsInstance(results.get("error"), planned_children.ValidationError)
        link.refresh_from_db()
        self.assertEqual(link.needed_at_column_id, self.won.pk)

    def test_add_child_racing_a_column_delete_answers_400_not_500(self):
        from types import SimpleNamespace

        from boards.services import card_links

        def make_card(*, board, role, column, swimlane):
            card = Card.objects.create(board=board, column=column, swimlane=swimlane, title="Workshop")
            return SimpleNamespace(card=card)

        Column.objects.filter(pk=self.todo.pk).update(allow_card_creation=True)

        def add():
            return card_links.create_child(
                user=self.maya, parent=self.parent, parent_role=Role.MEMBER, board_id=self.cboard.pk,
                make_card=make_card, needed_at_column=self.proposal.pk,
            )

        results = self.run_pair(self._column_delete, add, "Add child should queue on the column the delete holds")
        self.assertIsInstance(results.get("error"), planned_children.ValidationError)
        self.assertFalse(Card.objects.filter(board=self.cboard, title="Workshop").exists())

    def test_column_delete_racing_a_parent_release_writes_one_history_row(self):
        """The parent reaching the column while the column is deleted: the
        delete's locked read skips the row the release claimed, so the child
        gets one row (the release), not a release and a "Needed: Now"."""
        link = self.link(needed_at_column=self.proposal)

        def parent_reaches():
            planned_children.release_on_move(self.parent, to_column=self.proposal, actor=None)

        def delete_column():
            planned_children.clear_for_deleted_column(self.proposal, actor=self.owner)

        results = self.run_pair(parent_reaches, delete_column, "the column delete should queue on the link row")
        self.assertNotIn("error", results)
        link.refresh_from_db()
        self.assertIsNotNone(link.planned_released_at)
        rows = list(
            CardActivity.objects.filter(card=self.child, event_type__in=[EV.PLANNED_RELEASED, EV.NEEDED_CHANGED])
            .values_list("event_type", "from_value")
        )
        self.assertEqual(rows, [(EV.PLANNED_RELEASED, "parent_reached")])

    def test_two_simultaneous_releases_write_one_history_row(self):
        """A parent reaching the column and the child's own pull, at once:
        the link is claimed once, so exactly one ``planned_released`` row."""
        link = self.link(needed_at_column=self.proposal)

        def parent_reaches():
            planned_children.release_on_move(self.parent, to_column=self.proposal, actor=None)

        def pull():
            planned_children.release_on_move(self.child, to_column=self.doing, actor=self.maya)

        results = self.run_pair(parent_reaches, pull, "the pull should queue on the link row the release holds")
        self.assertNotIn("error", results)
        link.refresh_from_db()
        self.assertIsNotNone(link.planned_released_at)
        rows = list(
            CardActivity.objects.filter(card=self.child, event_type=EV.PLANNED_RELEASED)
            .values_list("from_value", flat=True)
        )
        self.assertEqual(rows, ["parent_reached"])


class PlannedSchemaTests(TestCase):
    """The OpenAPI schema documents each planned field with its own type, and
    as optional: write responses (move, PATCH) omit them like ``parent``."""

    def test_each_planned_field_has_its_own_type_and_none_is_required(self):
        from drf_spectacular.generators import SchemaGenerator

        schemas = SchemaGenerator().get_schema(request=None, public=True)["components"]["schemas"]
        card = schemas["Card"]
        props = card["properties"]
        self.assertEqual(props["planned"]["type"], "boolean")
        self.assertEqual(props["needed_now"]["type"], "boolean")
        self.assertEqual((props["needed_at_column"]["type"], props["needed_at_column"]["nullable"]), ("integer", True))
        self.assertEqual(props["needed_at_column_name"]["type"], "string")
        self.assertEqual(props["planned_released_at"]["format"], "date-time")
        # Never null, so never nullable: tightening it after release is a type change.
        for key in ("planned", "needed_now"):
            self.assertFalse(props[key].get("nullable", False), key)
        for key in ("needed_at_column", "needed_at_column_name", "planned_released_at", "needed_now_reason"):
            self.assertTrue(props[key]["nullable"], key)
        # An enum is published as a named component, with NullEnum for null.
        refs = [b["$ref"].rsplit("/", 1)[-1] for b in props["needed_now_reason"]["oneOf"]]
        self.assertEqual(refs, ["NeededNowReasonEnum", "NullEnum"])
        self.assertEqual(schemas["NeededNowReasonEnum"], {"type": "string", "enum": ["parent", "cancelled"]})
        for key in (
            "planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at",
            "needed_now_reason",
        ):
            self.assertTrue(props[key]["readOnly"], key)
            self.assertNotIn(key, card.get("required", []), key)
