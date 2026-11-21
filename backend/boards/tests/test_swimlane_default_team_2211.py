"""Swimlane default team (#2211): store it, and pre-assign it at creation only.

Covers the migration (a new join table only), the admin-only write and its
validation (assignable, active members of this board; fail closed without a
board), the broadcast payload, card create in the lane (omitted vs explicit
assignee), the re-check at apply time, Add child (the parent lane's team,
members of the child board only), and member removal pruning the team.
"""
import importlib
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane, SwimlaneTeamMember
from boards.serializers import PublicSwimlaneSerializer, SwimlaneSerializer

Role = BoardMembership.Role
PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def make_board(owner, name, *, parent_tier=False):
    board = Board.objects.create(name=name, owner=owner, cards_can_have_children=parent_tier)
    Column.objects.create(board=board, name="To do", position=0, allow_card_creation=True)
    Swimlane.objects.create(board=board, name="Acme Corp", position=0)
    return board


class TeamFixture(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="dt_owner", password="pass")
        self.parent = make_board(self.owner, "Pipeline", parent_tier=True)
        self.child = make_board(self.owner, "Delivery")
        self.lane = self.parent.swimlanes.get()
        self.column = self.parent.columns.get()
        # mia works both boards; dan only the parent board; vic views the parent.
        self.mia = self.user_with("mia", parent=Role.MEMBER, child=Role.MEMBER)
        self.dan = self.user_with("dan", parent=Role.MEMBER)
        self.vic = self.user_with("vic", parent=Role.VIEWER)
        self.outsider = User.objects.create_user(username="dt_out", password="pass")

    def user_with(self, name, *, parent=None, child=None):
        user = User.objects.create_user(username=f"dt_{name}", password="pass")
        if parent:
            BoardMembership.objects.create(board=self.parent, user=user, role=parent)
        if child:
            BoardMembership.objects.create(board=self.child, user=user, role=child)
        return user

    def set_team(self, *users):
        for u in users:
            SwimlaneTeamMember.objects.create(swimlane=self.lane, user=u)

    def lane_url(self):
        return f"/api/v1/boards/{self.parent.pk}/swimlanes/{self.lane.pk}/"

    def patch_team(self, user, ids):
        with patch(PATCH_BROADCAST):
            return client_for(user).patch(self.lane_url(), {"default_team": ids}, format="json")


class MigrationTests(TestCase):
    def test_creates_a_new_table_and_alters_no_existing_one(self):
        m = importlib.import_module("boards.migrations.0128_swimlane_default_team")
        kinds = [op.__class__.__name__ for op in m.Migration.operations]
        self.assertEqual(kinds, ["CreateModel", "AddField", "AddConstraint"])
        # The AddField is the M2M declaration: no column on swimlanes.
        self.assertTrue(m.Migration.operations[1].field.many_to_many)


class TeamWriteTests(TeamFixture):
    def test_admin_sets_the_team_in_order_and_reads_it_back(self):
        r = self.patch_team(self.owner, [self.dan.pk, self.mia.pk, self.dan.pk])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["default_team"], [self.dan.pk, self.mia.pk])
        r = self.patch_team(self.owner, [self.mia.pk])
        self.assertEqual(r.json()["default_team"], [self.mia.pk])
        self.assertEqual(list(self.lane.team_members.values_list("user_id", flat=True)), [self.mia.pk])

    def test_keeps_existing_order_and_appends_new_people(self):
        self.set_team(self.dan)
        r = self.patch_team(self.owner, [self.mia.pk, self.dan.pk])
        self.assertEqual(r.json()["default_team"], [self.dan.pk, self.mia.pk])

    def test_broadcast_payload_carries_the_team_on_commit(self):
        with patch(PATCH_BROADCAST) as bc, self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.owner).patch(self.lane_url(), {"default_team": [self.mia.pk]}, format="json")
        self.assertEqual(r.status_code, 200)
        payloads = [c.args[2] for c in bc.call_args_list if c.args[1] == "swimlane.updated"]
        self.assertEqual(payloads[-1]["default_team"], [self.mia.pk])

    def test_viewer_outsider_inactive_and_unknown_ids_get_one_message(self):
        self.mia.is_active = False
        self.mia.save(update_fields=["is_active"])
        for bad in (self.vic.pk, self.outsider.pk, self.mia.pk, 999_999):
            r = self.patch_team(self.owner, [bad])
            self.assertEqual(r.status_code, 400, bad)
            self.assertEqual(
                r.json()["default_team"], [f"Not an assignable member of this board: {bad}."],
            )
        self.assertFalse(SwimlaneTeamMember.objects.exists())

    def test_too_many_ids_is_refused(self):
        r = self.patch_team(self.owner, list(range(1, 52)))
        self.assertEqual(r.status_code, 400)

    def test_member_cannot_write_the_team(self):
        r = self.patch_team(self.mia, [self.mia.pk])
        self.assertEqual(r.status_code, 403)
        self.assertFalse(SwimlaneTeamMember.objects.exists())

    def test_create_with_a_team(self):
        with patch(PATCH_BROADCAST):
            r = client_for(self.owner).post(
                f"/api/v1/boards/{self.parent.pk}/swimlanes/",
                {"name": "Globex", "default_team": [self.mia.pk]}, format="json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["default_team"], [self.mia.pk])

    def test_validator_fails_closed_without_a_board(self):
        # Absent-input guard (#1075): no board in context, no instance.
        s = SwimlaneSerializer(data={"name": "X", "default_team": [self.mia.pk]}, context={})
        self.assertFalse(s.is_valid())
        self.assertIn("default_team", s.errors)

    def test_share_link_serializer_omits_the_team(self):
        self.set_team(self.mia)
        self.assertNotIn("default_team", PublicSwimlaneSerializer(self.lane).data)

    def test_member_removal_takes_them_off_lane_teams(self):
        self.set_team(self.mia, self.dan)
        with patch(PATCH_BROADCAST):
            r = client_for(self.owner).delete(f"/api/v1/boards/{self.parent.pk}/members/{self.mia.pk}/")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(list(self.lane.team_members.values_list("user_id", flat=True)), [self.dan.pk])


class CardCreateTests(TeamFixture):
    def create(self, user=None, **extra):
        body = {"title": "Renewal", "column": self.column.pk, "swimlane": self.lane.pk, **extra}
        with patch(PATCH_BROADCAST):
            r = client_for(user or self.owner).post(f"/api/v1/boards/{self.parent.pk}/cards/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return Card.objects.get(pk=r.json()["id"])

    def test_omitted_assignee_gets_the_first_team_member(self):
        self.set_team(self.dan, self.mia)
        self.assertEqual(self.create(self.mia).assignee_id, self.dan.pk)

    def test_explicit_null_stays_unassigned(self):
        self.set_team(self.dan)
        self.assertIsNone(self.create(assignee_id=None).assignee_id)

    def test_explicit_assignee_wins(self):
        self.set_team(self.dan)
        self.assertEqual(self.create(assignee_id=self.mia.pk).assignee_id, self.mia.pk)

    def test_no_team_no_assignee(self):
        self.assertIsNone(self.create().assignee_id)

    def test_member_who_became_a_viewer_is_skipped_at_apply_time(self):
        self.set_team(self.dan, self.mia)
        BoardMembership.objects.filter(board=self.parent, user=self.dan).update(role=Role.VIEWER)
        self.assertEqual(self.create().assignee_id, self.mia.pk)

    def test_editing_the_team_does_not_rewrite_existing_cards(self):
        self.set_team(self.dan)
        card = self.create()
        self.patch_team(self.owner, [self.mia.pk])
        card.refresh_from_db()
        self.assertEqual(card.assignee_id, self.dan.pk)


class ApplyGuardTests(TeamFixture):
    """Absent-input guards (#1075): with no eligible set, nobody is assigned."""

    def test_no_eligible_set_assigns_nobody(self):
        from boards.services.swimlane_team import default_assignee_id

        self.set_team(self.mia)
        self.assertIsNone(default_assignee_id(self.lane, None))
        self.assertIsNone(default_assignee_id(self.lane, lambda: set()))
        self.assertIsNone(default_assignee_id(None, lambda: {self.mia.pk}))
        self.assertEqual(default_assignee_id(self.lane, lambda: {self.mia.pk}), self.mia.pk)


class AddChildTests(TeamFixture):
    def setUp(self):
        super().setUp()
        self.parent_card = Card.objects.create(
            board=self.parent, column=self.column, swimlane=self.lane, title="Opportunity",
        )

    def add_child(self, **extra):
        body = {"board_id": self.child.pk, "title": "Task", **extra}
        with patch(PATCH_BROADCAST):
            return client_for(self.mia).post(
                f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/children/", body, format="json",
            )

    def test_parent_lane_team_skips_a_non_member_of_the_child_board(self):
        self.set_team(self.dan, self.mia)  # dan cannot open Delivery
        r = self.add_child()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Card.objects.get(pk=r.json()["id"]).assignee_id, self.mia.pk)

    def test_only_non_members_on_the_team_creates_unassigned_and_grants_nothing(self):
        self.set_team(self.dan)
        r = self.add_child()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(Card.objects.get(pk=r.json()["id"]).assignee_id)
        self.assertFalse(BoardMembership.objects.filter(board=self.child, user=self.dan).exists())

    def test_child_board_lanes_are_not_consulted(self):
        child_lane = self.child.swimlanes.get()
        SwimlaneTeamMember.objects.create(swimlane=child_lane, user=self.owner)
        r = self.add_child()
        self.assertIsNone(Card.objects.get(pk=r.json()["id"]).assignee_id)

    def test_opt_out_creates_unassigned(self):
        self.set_team(self.mia)
        r = self.add_child(apply_default_team=False)
        self.assertIsNone(Card.objects.get(pk=r.json()["id"]).assignee_id)

    def test_non_boolean_opt_out_is_refused(self):
        r = self.add_child(apply_default_team="no")
        self.assertEqual(r.status_code, 400)
        self.assertIn("apply_default_team", r.json())
