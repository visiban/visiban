"""Boards that cannot take a child are listed as unavailable, with why (#2719).

A board the viewer may add cards to used to vanish from the Add child chooser
(and the Rules page's default child board select) when it failed the
child-board rule: no lane, a first column that refuses new cards, or no
column at all. The options reads now return those boards in ``unavailable``
with a reason, scoped exactly like ``boards``: the viewer's own role, never a
parent-tier board, never the parent's own board.
"""
from unittest import mock

from django.test import TestCase

from accounts.models import User
from boards.models import Board, BoardMembership, CardParentLink, Column, Swimlane
from boards.services import card_links
from boards.tests.test_default_child_board_2208 import (
    AddChildFixture,
    DefaultChildBoardFixture,
    add_card,
    client_for,
    make_board,
)

Role = BoardMembership.Role


def lane_less_board(owner, name):
    """A board made with "First Swimlane (optional)" left blank: columns, no lane."""
    board = Board.objects.create(name=name, owner=owner)
    Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    return board


def column_less_board(owner, name):
    board = Board.objects.create(name=name, owner=owner)
    Swimlane.objects.create(board=board, name="Lane", position=0)
    return board


class ChildBoardOptionsUnavailableTests(AddChildFixture):
    def options(self, user):
        url = f"/api/v1/boards/{self.parent.pk}/cards/{self.parent_card.pk}/child-board-options/"
        r = client_for(user).get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def grant(self, board, user=None, role=Role.MEMBER):
        BoardMembership.objects.create(board=board, user=user or self.member, role=role)
        return board

    def test_each_failing_rule_is_listed_with_its_reason_by_name(self):
        no_lane = self.grant(lane_less_board(self.admin, "Child Board test"))
        closed = self.grant(make_board(self.admin, "Archive", first_column_creates=False))
        no_column = self.grant(column_less_board(self.admin, "Blank"))
        out = self.options(self.member)
        self.assertEqual(out["unavailable"], [
            {"id": closed.pk, "name": "Archive", "reason": "first_column_closed"},
            {"id": no_column.pk, "name": "Blank", "reason": "no_column"},
            {"id": no_lane.pk, "name": "Child Board test", "reason": "no_swimlane"},
        ])
        # The qualifying list is unchanged.
        self.assertEqual([b["id"] for b in out["boards"]], [self.child.pk])
        self.assertEqual(out["boards_total"], 1)

    def test_no_column_wins_over_no_lane(self):
        empty = self.grant(Board.objects.create(name="Empty", owner=self.admin))
        self.assertEqual(self.options(self.member)["unavailable"], [{"id": empty.pk, "name": "Empty", "reason": "no_column"}])

    def test_a_board_the_viewer_only_views_is_not_listed(self):
        self.grant(lane_less_board(self.admin, "Viewer only"), role=Role.VIEWER)
        self.assertEqual(self.options(self.member)["unavailable"], [])

    def test_a_board_the_viewer_cannot_open_is_not_listed(self):
        lane_less_board(self.admin, "Someone else's")
        self.assertEqual(self.options(self.member)["unavailable"], [])

    def test_parent_tier_boards_are_never_listed(self):
        other_parent = Board.objects.create(name="Parent 2", owner=self.admin, cards_can_have_children=True)
        self.grant(other_parent)
        self.assertEqual(self.options(self.member)["unavailable"], [])
        self.assertEqual(self.options(self.admin)["unavailable"], [])

    def test_the_parent_board_itself_is_never_listed(self):
        """A leftover parent on a flag-off board (#2446) keeps Add child; its own board is still no target."""
        CardParentLink.objects.create(parent=self.parent_card, child=add_card(self.child), created_by=self.admin)
        Board.objects.filter(pk=self.parent.pk).update(cards_can_have_children=False)
        # Fail the rule on the parent's own board, so only the exclusion keeps it out.
        Column.objects.filter(board=self.parent, position=0).update(allow_card_creation=False)
        self.parent_card.refresh_from_db()
        self.assertEqual(self.options(self.admin)["unavailable"], [])

    def test_a_default_that_stopped_qualifying_moves_to_unavailable(self):
        self.set_default()
        Column.objects.filter(board=self.child, position=0).update(allow_card_creation=False)
        out = self.options(self.admin)
        self.assertIsNone(out["default"])
        self.assertEqual(out["boards"], [])
        self.assertEqual(out["unavailable"], [{"id": self.child.pk, "name": "Delivery", "reason": "first_column_closed"}])

    def test_the_post_refuses_every_board_listed_unavailable(self):
        """Unavailable is exactly the write's refusal, so a disabled option is never a working target."""
        boards = [
            self.grant(lane_less_board(self.admin, "No lane")),
            self.grant(make_board(self.admin, "Closed", first_column_creates=False)),
            self.grant(column_less_board(self.admin, "No column")),
        ]
        listed = {b["id"] for b in self.options(self.member)["unavailable"]}
        self.assertEqual(listed, {b.pk for b in boards})
        for b in boards:
            with self.subTest(board=b.name):
                self.assertFalse(card_links.board_qualifies_as_child(b))
                self.assertEqual(self.add_child(self.member, board_id=b.pk).status_code, 404)

    def test_the_list_is_capped(self):
        for i in range(4):
            self.grant(lane_less_board(self.admin, f"Lane-less {i}"))
        with mock.patch.object(card_links, "CHILD_BOARD_OPTIONS_LIMIT", 3):
            out = self.options(self.member)
        self.assertEqual([b["name"] for b in out["unavailable"]], ["Lane-less 0", "Lane-less 1", "Lane-less 2"])

    def test_absent_user_fails_closed_with_an_empty_list(self):
        lane_less_board(self.admin, "Hidden")
        out = card_links.child_board_options_for_viewer(self.parent_card, None)
        self.assertEqual(out["boards"], [])
        self.assertEqual(out["unavailable"], [])

    def test_a_non_parent_card_gets_an_empty_list(self):
        self.grant(lane_less_board(self.admin, "No lane"))
        Board.objects.filter(pk=self.parent.pk).update(cards_can_have_children=False)
        self.parent_card.refresh_from_db()
        self.assertEqual(card_links.child_board_options_for_viewer(self.parent_card, self.member)["unavailable"], [])


class DefaultChildBoardOptionsUnavailableTests(DefaultChildBoardFixture):
    """The Rules page's select gets the same list, at its own role (ADMIN)."""

    def options(self, user):
        r = client_for(user).get(f"/api/v1/boards/{self.parent.pk}/default-child-board-options/")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_lists_failing_boards_the_viewer_administers_only(self):
        no_lane = lane_less_board(self.admin, "No lane")
        BoardMembership.objects.create(board=no_lane, user=self.admin, role=Role.ADMIN)
        other = User.objects.create_user(username="u2719_other", password="pass")
        member_only = lane_less_board(other, "Member only")
        BoardMembership.objects.create(board=member_only, user=self.admin, role=Role.MEMBER)
        parent_tier = Board.objects.create(name="Parent tier", owner=self.admin, cards_can_have_children=True)
        BoardMembership.objects.create(board=parent_tier, user=self.admin, role=Role.ADMIN)
        out = self.options(self.admin)
        self.assertEqual(out["unavailable"], [{"id": no_lane.pk, "name": "No lane", "reason": "no_swimlane"}])
        self.assertEqual([b["name"] for b in out["boards"]], ["Delivery"])

    def test_no_viewer_fails_closed(self):
        self.assertEqual(
            card_links.default_child_board_options_for_admin(self.parent, None),
            {"boards": [], "boards_total": 0, "unavailable": []},
        )


class ChildRuleFailureTests(TestCase):
    """The reason helper agrees with ``board_qualifies_as_child`` on every shape."""

    def test_reason_is_none_exactly_when_the_board_qualifies(self):
        owner = User.objects.create_user(username="u2719_owner", password="pass")
        shapes = {
            "ok": make_board(owner, "ok"),
            "closed": make_board(owner, "closed", first_column_creates=False),
            "no lane": lane_less_board(owner, "no lane"),
            "no column": column_less_board(owner, "no column"),
            "empty": Board.objects.create(name="empty", owner=owner),
        }
        annotated = {b.pk: b for b in card_links._with_child_rule(Board.objects.all())}
        for label, board in shapes.items():
            with self.subTest(shape=label):
                self.assertEqual(
                    card_links._child_rule_failure(annotated[board.pk]) is None,
                    card_links.board_qualifies_as_child(board),
                )
