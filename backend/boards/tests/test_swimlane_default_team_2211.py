"""Swimlane default team (#2211).

Covers the migration (a new join table only), the admin-only write and its
validation (assignable, active members of this board; fail closed without a
board), the broadcast payload, card create (the web app sends the assignee;
the API does not default it), Add child (the parent lane's first eligible
member is pre-assigned, #2206 decision G), the child-board access warning,
the ``is_active`` members payload, and member removal pruning the team.
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
    """POST cards/ does not default the assignee: the web app sends the team's first member."""

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

    def assigned(self, r):
        self.assertEqual(r.status_code, 201, r.content)
        return Card.objects.get(pk=r.json()["id"]).assignee_id

    def test_child_gets_the_first_member_who_can_be_assigned_there(self):
        # dan is first but has no access to Delivery: skipped, not refused.
        self.set_team(self.dan, self.mia)
        self.assertEqual(self.assigned(self.add_child()), self.mia.pk)

    def test_no_eligible_member_leaves_the_child_unassigned(self):
        self.set_team(self.dan)
        self.assertIsNone(self.assigned(self.add_child()))

    def test_lane_without_a_team_leaves_the_child_unassigned(self):
        self.assertIsNone(self.assigned(self.add_child()))

    def test_apply_default_team_false_leaves_the_child_unassigned(self):
        self.set_team(self.mia)
        self.assertIsNone(self.assigned(self.add_child(apply_default_team=False)))

    def test_apply_default_team_must_be_a_boolean(self):
        self.set_team(self.mia)
        for value in ("no", 1, None):
            r = self.add_child(apply_default_team=value)
            self.assertEqual(r.status_code, 400, (value, r.content))
            self.assertIn("apply_default_team", r.json())
        self.assertFalse(Card.objects.filter(board=self.child).exists())

    def test_deactivated_member_is_never_pre_assigned(self):
        kim = self.user_with("kim", parent=Role.MEMBER, child=Role.MEMBER)
        self.set_team(kim, self.mia)
        User.objects.filter(pk=kim.pk).update(is_active=False)
        self.assertEqual(self.assigned(self.add_child()), self.mia.pk)

    def test_options_carry_the_lane_team_and_each_boards_assignee(self):
        self.set_team(self.dan, self.mia)
        r = client_for(self.mia).get(
            f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["default_team"], {
            "swimlane": {"id": self.lane.pk, "name": "Acme Corp"}, "member_ids": [self.dan.pk, self.mia.pk],
        })
        self.assertEqual(
            [(b["id"], b["default_assignee_id"]) for b in body["boards"]], [(self.child.pk, self.mia.pk)]
        )

    def test_options_without_a_team_have_no_default_team(self):
        r = client_for(self.mia).get(
            f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
        )
        self.assertIsNone(r.json()["default_team"])
        self.assertNotIn("default_assignee_id", r.json()["boards"][0])


class DefaultAssigneeHelperTests(TeamFixture):
    """``default_assignee_id`` fails closed without its inputs (#1075)."""

    def test_absent_lane_or_board_gives_nobody(self):
        from boards.services.swimlane_team import default_assignee_id

        self.set_team(self.mia)
        self.assertIsNone(default_assignee_id(None, self.parent))
        self.assertIsNone(default_assignee_id(self.lane, None))
        self.assertEqual(default_assignee_id(self.lane, self.parent), self.mia.pk)


class MembersPayloadTests(TeamFixture):
    def test_payload_marks_a_deactivated_member(self):
        self.set_team(self.mia, self.dan)
        User.objects.filter(pk=self.dan.pk).update(is_active=False)
        lane = self.client_get_lane()
        self.assertEqual(lane["default_team"], [self.mia.pk, self.dan.pk])
        self.assertEqual(lane["default_team_members"], [
            {"id": self.mia.pk, "is_active": True}, {"id": self.dan.pk, "is_active": False},
        ])

    def client_get_lane(self):
        r = client_for(self.owner).get(f"/api/v1/boards/{self.parent.pk}/swimlanes/{self.lane.pk}/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_share_link_serializer_omits_the_members_payload(self):
        self.assertNotIn("default_team_members", PublicSwimlaneSerializer(self.lane).data)


class TeamAccessTests(TeamFixture):
    """The Edit swimlane warning (#2211): who is skipped on which child board."""

    def setUp(self):
        super().setUp()
        self.parent_card = Card.objects.create(
            board=self.parent, column=self.column, swimlane=self.lane, title="Opportunity",
        )
        child_card = Card.objects.create(
            board=self.child, column=self.child.columns.get(), swimlane=self.child.swimlanes.get(), title="Task",
        )
        from boards.models import CardParentLink

        CardParentLink.objects.create(parent=self.parent_card, child=child_card, created_by=self.owner)

    def url(self):
        return f"/api/v1/boards/{self.parent.pk}/swimlanes/{self.lane.pk}/default-team-access/"

    def test_admin_sees_who_is_skipped_on_which_board(self):
        self.set_team(self.mia, self.dan)
        r = client_for(self.owner).get(self.url())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"members": [
            {"id": self.dan.pk, "boards": [{"id": self.child.pk, "name": "Delivery"}], "hidden_count": 0},
        ]})

    def test_default_child_board_counts_and_a_hidden_board_is_not_named(self):
        other_owner = User.objects.create_user(username="dt_other", password="pass")
        onboarding = make_board(other_owner, "Onboarding")
        Board.objects.filter(pk=self.parent.pk).update(default_child_board=onboarding)
        BoardMembership.objects.create(board=self.parent, user=other_owner, role=Role.ADMIN)
        self.set_team(self.mia)
        body = client_for(self.owner).get(self.url()).json()
        # The owner can't open Onboarding: counted, not named.
        self.assertEqual(body, {"members": [{"id": self.mia.pk, "boards": [], "hidden_count": 1}]})

    def test_member_is_refused_and_outsider_gets_404(self):
        self.set_team(self.dan)
        self.assertEqual(client_for(self.mia).get(self.url()).status_code, 403)
        self.assertEqual(client_for(self.outsider).get(self.url()).status_code, 404)

    def test_helper_fails_closed_without_lane_or_viewer(self):
        from django.contrib.auth.models import AnonymousUser

        from boards.services.swimlane_team import team_access

        self.set_team(self.dan)
        self.assertEqual(team_access(None, self.owner), {"members": []})
        self.assertEqual(team_access(self.lane, None), {"members": []})
        self.assertEqual(team_access(self.lane, AnonymousUser()), {"members": []})
