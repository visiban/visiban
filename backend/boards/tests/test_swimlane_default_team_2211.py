"""Swimlane default team (#2211): stored settings only; nothing is pre-assigned.

Covers the migration (a new join table only), the admin-only write and its
validation (assignable, active members of this board; fail closed without a
board), the broadcast payload, card create and Add child (a lane's team must
NOT pre-assign anyone), and member removal pruning the team (REST and admin).
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
        m = importlib.import_module("boards.migrations.0129_swimlane_default_team")
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

    def test_only_listed_members_are_accepted(self):
        # A user with the instance-wide access who is not listed on
        # the board gets the same refusal as an unknown id.
        wide = User.objects.create_user(username="dt_wide", password="pass", can_access_all_content=True)
        r = self.patch_team(self.owner, [wide.pk])
        self.assertEqual(r.status_code, 400, r.content)
        unknown = self.patch_team(self.owner, [999_999])
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual(
            r.json()["default_team"][0].replace(str(wide.pk), "N"),
            unknown.json()["default_team"][0].replace("999999", "N"),
        )
        self.assertFalse(SwimlaneTeamMember.objects.exists())
        # The same kind of user, once explicitly listed, is accepted.
        BoardMembership.objects.create(board=self.parent, user=wide, role=Role.MEMBER)
        r = self.patch_team(self.owner, [wide.pk])
        self.assertEqual(r.status_code, 200, r.content)

    def test_group_inherited_member_is_accepted_and_viewer_is_not(self):
        from groups.models import Group, GroupMembership

        group = Group.objects.create(name="Team group", owner=self.owner)
        self.parent.group = group
        self.parent.save(update_fields=["group"])
        inherited = User.objects.create_user(username="dt_inh", password="pass")
        inherited_viewer = User.objects.create_user(username="dt_inhv", password="pass")
        GroupMembership.objects.create(group=group, user=inherited, role=GroupMembership.Role.MEMBER)
        GroupMembership.objects.create(group=group, user=inherited_viewer, role=GroupMembership.Role.VIEWER)
        r = self.patch_team(self.owner, [inherited_viewer.pk])
        self.assertEqual(r.status_code, 400, r.content)
        r = self.patch_team(self.owner, [inherited.pk])
        self.assertEqual(r.status_code, 200, r.content)

    def test_too_many_ids_is_refused(self):
        # 51 REAL eligible members, so only the cap can cause the 400.
        ids = [
            self.user_with(f"bulk{i}", parent=Role.MEMBER).pk
            for i in range(51)  # the documented cap is 50
        ]
        r = self.patch_team(self.owner, ids)
        self.assertEqual(r.status_code, 400)
        self.assertIn("no more than 50", r.json()["default_team"][0])
        self.assertFalse(SwimlaneTeamMember.objects.exists())

    def test_exactly_the_cap_is_accepted(self):
        ids = [
            self.user_with(f"bulk{i}", parent=Role.MEMBER).pk
            for i in range(50)
        ]
        self.assertEqual(self.patch_team(self.owner, ids).status_code, 200)

    def test_empty_list_clears_the_team(self):
        self.set_team(self.mia, self.dan)
        r = self.patch_team(self.owner, [])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["default_team"], [])
        self.assertFalse(SwimlaneTeamMember.objects.exists())

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

    def test_admin_delete_takes_them_off_lane_teams(self):
        self.set_team(self.mia, self.dan)
        from boards.admin import BoardMembershipAdmin
        from django.contrib import admin as dj_admin
        from django.test import RequestFactory

        ma = BoardMembershipAdmin(BoardMembership, dj_admin.site)
        req = RequestFactory().post("/")
        req.user = self.owner
        with patch(PATCH_BROADCAST):
            ma.delete_model(req, BoardMembership.objects.get(board=self.parent, user=self.mia))
        self.assertEqual(list(self.lane.team_members.values_list("user_id", flat=True)), [self.dan.pk])

    def test_admin_bulk_delete_takes_them_off_lane_teams(self):
        self.set_team(self.mia, self.dan)
        from boards.admin import BoardMembershipAdmin
        from django.contrib import admin as dj_admin
        from django.test import RequestFactory

        ma = BoardMembershipAdmin(BoardMembership, dj_admin.site)
        req = RequestFactory().post("/")
        req.user = self.owner
        with patch(PATCH_BROADCAST):
            ma.delete_queryset(req, BoardMembership.objects.filter(board=self.parent, user=self.dan))
        self.assertEqual(list(self.lane.team_members.values_list("user_id", flat=True)), [self.mia.pk])


class CardCreateTests(TeamFixture):
    """Pre-assignment is not shipped (#2206 decision G): a team assigns nobody."""

    def create(self, user=None, **extra):
        body = {"title": "Renewal", "column": self.column.pk, "swimlane": self.lane.pk, **extra}
        with patch(PATCH_BROADCAST):
            r = client_for(user or self.owner).post(f"/api/v1/boards/{self.parent.pk}/cards/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        return Card.objects.get(pk=r.json()["id"])

    def test_omitted_assignee_stays_unassigned_in_a_lane_with_a_team(self):
        self.set_team(self.dan, self.mia)
        self.assertIsNone(self.create(self.mia).assignee_id)

    def test_explicit_assignee_is_kept(self):
        self.set_team(self.dan)
        self.assertEqual(self.create(assignee_id=self.mia.pk).assignee_id, self.mia.pk)


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

    def test_child_is_unassigned_in_a_lane_with_a_team(self):
        self.set_team(self.mia)
        r = self.add_child()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(Card.objects.get(pk=r.json()["id"]).assignee_id)

    def test_unknown_apply_default_team_key_is_ignored(self):
        # The removed field is not special: like any unknown key it is ignored.
        self.set_team(self.mia)
        for value in (True, False, "no"):
            r = self.add_child(apply_default_team=value)
            self.assertEqual(r.status_code, 201, r.content)
            self.assertIsNone(Card.objects.get(pk=r.json()["id"]).assignee_id)
