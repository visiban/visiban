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
