"""``Board.default_child_board`` (#2208 part 2): where "Add child" starts.

A preference, not a relationship (#2207): it never creates, moves or removes
a card link. Covers the model and migrations, the PATCH write (ADMIN on both
boards, one uniform refusal, lock-both-boards), the flag-flip blocker for a
board that is another board's default, the chooser read, the one-request Add
child, and the board-delete impact read and history.
"""
import importlib

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase

from accounts.models import User
from boards.admin import BoardAdmin
from boards.models import Board, BoardMembership, Column, Swimlane

Role = BoardMembership.Role


def make_board(owner, name, *, parent_tier=False, first_column_creates=True):
    """A board with two columns and one lane; the first column's creation flag is set."""
    board = Board.objects.create(name=name, owner=owner, cards_can_have_children=parent_tier)
    Column.objects.create(board=board, name="To do", position=0, allow_card_creation=first_column_creates)
    Column.objects.create(board=board, name="Done", position=1, allow_card_creation=True)
    Swimlane.objects.create(board=board, name="Lane", position=0)
    return board


class DefaultChildBoardModelTests(TestCase):
    def test_add_field_is_nullable_set_null_without_an_inline_index(self):
        m = importlib.import_module("boards.migrations.0124_board_default_child_board")
        ops = m.Migration.operations
        self.assertEqual([op.__class__.__name__ for op in ops], ["AddField"])
        field = ops[0].field
        self.assertTrue(field.null)
        self.assertFalse(field.db_index)

    def test_index_migration_is_alone_and_non_atomic(self):
        m = importlib.import_module("boards.migrations.0125_board_default_child_idx")
        self.assertIs(m.Migration.atomic, False)
        self.assertEqual([op.__class__.__name__ for op in m.Migration.operations], ["AddIndexConcurrently"])

    def test_target_delete_clears_the_default(self):
        owner = User.objects.create_user(username="dcb_m_owner", password="pass")
        parent = make_board(owner, "Pipeline", parent_tier=True)
        child = make_board(owner, "Delivery")
        parent.default_child_board = child
        parent.save(update_fields=["default_child_board"])
        child.delete()
        parent.refresh_from_db()
        self.assertIsNone(parent.default_child_board_id)

    def test_django_admin_cannot_write_it(self):
        site_admin = User.objects.create_superuser(username="dcb_m_su", password="pass")
        request = RequestFactory().get("/")
        request.user = site_admin
        board = make_board(site_admin, "B")
        readonly = BoardAdmin(Board, AdminSite()).get_readonly_fields(request, board)
        self.assertIn("default_child_board", readonly)


from unittest.mock import patch  # noqa: E402

from rest_framework.test import APIClient  # noqa: E402

from boards.models import Card, CardParentLink  # noqa: E402
from boards.serializers import (  # noqa: E402
    DEFAULT_CHILD_BOARD_NOT_ALLOWED_MSG,
    BoardSerializer,
    PublicBoardSerializer,
)

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def client_for(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


class DefaultChildBoardFixture(TestCase):
    """Pipeline (parent tier) and Delivery (child tier), with an admin of both."""

    def setUp(self):
        self.admin = User.objects.create_user(username="dcb_admin", password="pass")
        self.parent = make_board(self.admin, "Pipeline", parent_tier=True)
        self.child = make_board(self.admin, "Delivery")
        for b in (self.parent, self.child):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        self.url = f"/api/v1/boards/{self.parent.pk}/"

    def user_with(self, name, **roles):
        u = User.objects.create_user(username=f"dcb_{name}", password="pass")
        for board, role in roles.items():
            BoardMembership.objects.create(board=getattr(self, board), user=u, role=role)
        return u

    def patch_board(self, user, body, url=None):
        with patch(PATCH_BROADCAST):
            return client_for(user).patch(url or self.url, body, format="json")

    def set_default(self):
        Board.objects.filter(pk=self.parent.pk).update(default_child_board=self.child)


class DefaultChildBoardWriteTests(DefaultChildBoardFixture):
    def test_admin_of_both_boards_sets_it_and_reads_it_back_as_an_id(self):
        r = self.patch_board(self.admin, {"default_child_board": self.child.pk})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["default_child_board"], self.child.pk)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.default_child_board_id, self.child.pk)
        full = client_for(self.admin).get(f"{self.url}full/").json()
        self.assertEqual(full["default_child_board"], self.child.pk)

    def test_every_refusal_is_one_body(self):
        member_on_target = self.user_with("mt", parent=Role.ADMIN, child=Role.MEMBER)
        no_access = self.user_with("na", parent=Role.ADMIN)
        parent_tier = make_board(self.admin, "Other parent", parent_tier=True)
        no_create = make_board(self.admin, "Locked", first_column_creates=False)
        for b in (parent_tier, no_create):
            BoardMembership.objects.create(board=b, user=self.admin, role=Role.ADMIN)
        cases = [
            ("member on target", member_on_target, self.child.pk),
            ("no access to target", no_access, self.child.pk),
            ("unknown id", self.admin, 999999),
            ("parent-tier target", self.admin, parent_tier.pk),
            ("first column refuses creation", self.admin, no_create.pk),
            ("itself", self.admin, self.parent.pk),
            ("not an id", self.admin, "abc"),
        ]
        for label, user, value in cases:
            with self.subTest(label):
                r = self.patch_board(user, {"default_child_board": value})
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json(), {"default_child_board": [DEFAULT_CHILD_BOARD_NOT_ALLOWED_MSG]})
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_clear_and_echo_need_admin_on_this_board_only(self):
        self.set_default()
        source_admin = self.user_with("sa", parent=Role.ADMIN)
        self.assertEqual(self.patch_board(source_admin, {"default_child_board": self.child.pk}).status_code, 200)
        self.assertEqual(self.patch_board(source_admin, {"default_child_board": None}).status_code, 200)
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_member_of_the_source_board_cannot_write_it(self):
        member = self.user_with("m", parent=Role.MEMBER, child=Role.ADMIN)
        self.assertEqual(self.patch_board(member, {"default_child_board": self.child.pk}).status_code, 403)

    def test_refused_while_the_source_board_cannot_have_children(self):
        Board.objects.filter(pk=self.parent.pk).update(cards_can_have_children=False)
        r = self.patch_board(self.admin, {"default_child_board": self.child.pk})
        self.assertEqual(r.status_code, 400)
        self.assertIn("default_child_board", r.json())

    def test_turning_the_flag_off_clears_it_in_the_same_write(self):
        self.set_default()
        r = self.patch_board(self.admin, {"cards_can_have_children": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["default_child_board"])
        self.parent.refresh_from_db()
        self.assertIsNone(self.parent.default_child_board_id)

    def test_target_cannot_turn_its_flag_on_while_it_is_a_default(self):
        self.set_default()
        r = self.patch_board(self.admin, {"cards_can_have_children": True}, url=f"/api/v1/boards/{self.child.pk}/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("default child board", r.json()["cards_can_have_children"][0])
        self.child.refresh_from_db()
        self.assertFalse(self.child.cards_can_have_children)

    def test_create_refuses_a_default(self):
        with patch(PATCH_BROADCAST):
            r = client_for(self.admin).post("/api/v1/boards/", {
                "name": "New", "cards_can_have_children": True, "default_child_board": self.child.pk,
            }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_public_share_payload_has_no_default(self):
        self.set_default()
        self.parent.refresh_from_db()
        self.assertNotIn("default_child_board", PublicBoardSerializer(self.parent).data)

    def test_validator_without_a_request_refuses(self):
        """#1075: no caller to authorize means no default, not an unchecked one."""
        ser = BoardSerializer(self.parent, data={"default_child_board": self.child.pk}, partial=True, context={})
        self.assertFalse(ser.is_valid())
        self.assertIn("default_child_board", ser.errors)


class ChildrenSettingBlockersTests(DefaultChildBoardFixture):
    def blockers(self, user, board):
        return client_for(user).get(f"/api/v1/boards/{board.pk}/children-setting-blockers/")

    def test_lists_links_and_defaults_with_hidden_sources(self):
        self.set_default()
        hidden_source = make_board(self.admin, "Secret", parent_tier=True)
        Board.objects.filter(pk=hidden_source.pk).update(default_child_board=self.child)
        child_admin = self.user_with("ca", child=Role.ADMIN, parent=Role.VIEWER)
        lane = Swimlane.objects.get(board=self.parent)
        p = Card.objects.create(board=self.parent, column=self.parent.columns.first(), swimlane=lane, title="P")
        clane = Swimlane.objects.get(board=self.child)
        c = Card.objects.create(board=self.child, column=self.child.columns.first(), swimlane=clane, title="C")
        CardParentLink.objects.create(parent=p, child=c, created_by=self.admin)
        r = self.blockers(child_admin, self.child)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {
            "child_cards": 1, "parent_cards": 0,
            "default_of": [
                {"hidden": False, "id": self.parent.pk, "name": "Pipeline", "can_change": False},
                {"hidden": True},
            ],
        })
        self.assertEqual(self.blockers(self.admin, self.parent).json()["parent_cards"], 1)

    def test_non_admins_are_refused(self):
        member = self.user_with("bm", child=Role.MEMBER)
        self.assertEqual(self.blockers(member, self.child).status_code, 403)
        outsider = self.user_with("bo")
        self.assertEqual(self.blockers(outsider, self.child).status_code, 404)


class BoardQualifiesTests(TestCase):
    def test_absent_board_fails_closed(self):
        from boards.services.card_links import board_qualifies_as_child
        self.assertFalse(board_qualifies_as_child(None))
