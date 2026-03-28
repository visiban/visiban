from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardComment, Column, Swimlane
from boards.permissions import get_board_role, SITE_ADMIN


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class GetBoardRoleTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def test_owner_gets_admin_role(self):
        role = get_board_role(self.owner, self.board)
        self.assertEqual(role, BoardMembership.Role.ADMIN)

    def test_explicit_member_role(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        self.assertEqual(get_board_role(member, self.board), BoardMembership.Role.MEMBER)

    def test_explicit_viewer_role(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        self.assertEqual(get_board_role(viewer, self.board), BoardMembership.Role.VIEWER)

    def test_explicit_collaborator_role(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        self.assertEqual(get_board_role(collab, self.board), BoardMembership.Role.COLLABORATOR)

    def test_non_member_returns_none(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        self.assertIsNone(get_board_role(stranger, self.board))

    def test_site_admin_gets_site_admin_role(self):
        admin = User.objects.create_user(username="siteadmin", password="pass")
        admin.is_site_admin = True
        admin.can_access_all_content = True
        admin.save()
        self.assertEqual(get_board_role(admin, self.board), SITE_ADMIN)

    def test_can_access_all_content_gets_site_admin_role(self):
        """can_access_all_content=True grants SITE_ADMIN board role regardless of is_site_admin."""
        admin = User.objects.create_user(username="content_admin", password="pass")
        admin.can_access_all_content = True
        admin.save()
        self.assertEqual(get_board_role(admin, self.board), SITE_ADMIN)

    def test_both_flags_gets_site_admin_role(self):
        """is_site_admin=True and can_access_all_content=True together also return SITE_ADMIN."""
        admin = User.objects.create_user(username="full_admin", password="pass")
        admin.is_site_admin = True
        admin.can_access_all_content = True
        admin.save()
        self.assertEqual(get_board_role(admin, self.board), SITE_ADMIN)

    def test_is_site_admin_without_can_access_all_content_returns_none(self):
        """is_site_admin=True with can_access_all_content=False does NOT grant board access."""
        admin = User.objects.create_user(username="admin_no_content", password="pass")
        admin.is_site_admin = True
        admin.can_access_all_content = False
        admin.save()
        self.assertIsNone(get_board_role(admin, self.board))


class CanAccessAllContentBoardQuerysetTests(TestCase):
    """BoardViewSet.get_queryset() returns boards based on can_access_all_content, not is_site_admin."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def test_can_access_all_content_false_does_not_return_unjoined_boards(self):
        """A user with is_site_admin=True but can_access_all_content=False cannot list unjoined boards."""
        admin = User.objects.create_user(username="admin_only", password="pass")
        admin.is_site_admin = True
        admin.can_access_all_content = False
        admin.save()
        self.client.force_authenticate(admin)
        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, 200)
        # Normalise: API may return list or paginated dict
        results = resp.data.get("results", resp.data) if isinstance(resp.data, dict) else resp.data
        self.assertNotIn(self.board.id, [b["id"] for b in results])

    def test_can_access_all_content_true_returns_all_boards(self):
        """A user with can_access_all_content=True sees all boards even without membership."""
        admin = User.objects.create_user(username="content_admin2", password="pass")
        admin.can_access_all_content = True
        admin.save()
        self.client.force_authenticate(admin)
        resp = self.client.get("/api/boards/")
        self.assertEqual(resp.status_code, 200)
        results = resp.data.get("results", resp.data) if isinstance(resp.data, dict) else resp.data
        self.assertIn(self.board.id, [b["id"] for b in results])


class AdminCanAccessAllContentPatchTests(TestCase):
    """Admin API can toggle can_access_all_content."""

    def setUp(self):
        self.client = APIClient()
        self.site_admin = User.objects.create_user(username="siteadmin_patch", password="pass")
        self.site_admin.is_site_admin = True
        self.site_admin.save()
        self.target = User.objects.create_user(username="target_user", password="pass")

    def test_patch_can_access_all_content_true(self):
        self.client.force_authenticate(self.site_admin)
        resp = self.client.patch(
            f"/api/admin/users/{self.target.pk}/",
            {"can_access_all_content": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.target.refresh_from_db()
        self.assertTrue(self.target.can_access_all_content)

    def test_patch_can_access_all_content_false(self):
        self.target.can_access_all_content = True
        self.target.save()
        self.client.force_authenticate(self.site_admin)
        resp = self.client.patch(
            f"/api/admin/users/{self.target.pk}/",
            {"can_access_all_content": False},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.target.refresh_from_db()
        self.assertFalse(self.target.can_access_all_content)


class CardCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)

    def _create_card(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/cards/",
            {"title": "New Card", "column": self.col.pk, "swimlane": self.swim.pk},
        )

    @patch("boards.views.broadcast_board_event")
    def test_member_can_create_card(self, _mock_broadcast):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_card(member)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_viewer_cannot_create_card(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_card(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_create_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR)
        resp = self._create_card(collab)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_member_gets_403(self):
        stranger = User.objects.create_user(username="stranger", password="pass")
        resp = self._create_card(stranger)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class CardMutationRBACTests(TestCase):
    """Verify that collaborators cannot edit, move, or delete cards."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Test Card",
            created_by=self.owner,
            position=0,
        )
        self.collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR
        )

    def test_collaborator_cannot_edit_card(self):
        self.client.force_authenticate(self.collab)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"title": "Changed"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_move_card(self):
        self.client.force_authenticate(self.collab)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.col.pk, "swimlane_id": self.swim.pk, "position": 0},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_delete_card(self):
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ColumnCreationRBACTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _ = make_board(self.owner)

    def _create_column(self, user):
        self.client.force_authenticate(user)
        return self.client.post(
            f"/api/boards/{self.board.pk}/columns/",
            {"name": "New Column", "position": 99},
        )

    @patch("boards.views.broadcast_board_event")
    def test_admin_can_create_column(self, _mock_broadcast):
        resp = self._create_column(self.owner)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_member_cannot_create_column(self):
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role=BoardMembership.Role.MEMBER)
        resp = self._create_column(member)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_viewer_cannot_create_column(self):
        viewer = User.objects.create_user(username="viewer", password="pass")
        BoardMembership.objects.create(board=self.board, user=viewer, role=BoardMembership.Role.VIEWER)
        resp = self._create_column(viewer)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)


class ViewerCollaboratorBoundaryTests(TestCase):
    """Verify that viewer is strictly read-only and collaborator can comment/attach/checklist."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner2", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)
        # A card owned by the board owner for all sub-tests
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Test Card",
            created_by=self.owner,
            position=0,
        )
        self.viewer = User.objects.create_user(username="viewer2", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        self.collab = User.objects.create_user(username="collab2", password="pass")
        BoardMembership.objects.create(board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR)

    # ------------------------------------------------------------------
    # Comments
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_post_comment(self, _mock):
        self.client.force_authenticate(self.viewer)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": "hello"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_post_comment(self, _mock):
        self.client.force_authenticate(self.collab)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": "hello"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.owner, body="original")
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_delete_own_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.collab, body="my comment")
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_cannot_delete_other_users_comment(self, _mock):
        comment = CardComment.objects.create(card=self.card, author=self.owner, body="owner comment")
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/comments/{comment.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Attachments
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_upload_attachment(self, _mock):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_authenticate(self.viewer)
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/",
            {"file": f},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_upload_attachment(self, _mock):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_authenticate(self.collab)
        f = SimpleUploadedFile("test.txt", b"hello", content_type="text/plain")
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/",
            {"file": f},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_attachment(self, _mock):
        from boards.models import CardAttachment
        from django.core.files.uploadedfile import SimpleUploadedFile
        att = CardAttachment.objects.create(
            card=self.card,
            file=SimpleUploadedFile("f.txt", b"x", content_type="text/plain"),
            filename="f.txt",
            size=1,
            uploaded_by=self.owner,
        )
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/attachments/{att.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    # ------------------------------------------------------------------
    # Checklist
    # ------------------------------------------------------------------

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_add_checklist_item(self, _mock):
        self.client.force_authenticate(self.viewer)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/",
            {"text": "a task"},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_add_checklist_item(self, _mock):
        self.client.force_authenticate(self.collab)
        resp = self.client.post(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/",
            {"text": "a task"},
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_patch_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.viewer)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
            {"is_checked": True},
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_patch_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.collab)
        resp = self.client.patch(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
            {"is_checked": True},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    @patch("boards.views.broadcast_board_event")
    def test_viewer_cannot_delete_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.viewer)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    @patch("boards.views.broadcast_board_event")
    def test_collaborator_can_delete_checklist_item(self, _mock):
        from boards.models import CardChecklist
        item = CardChecklist.objects.create(card=self.card, text="task", position=0)
        self.client.force_authenticate(self.collab)
        resp = self.client.delete(
            f"/api/boards/{self.board.pk}/cards/{self.card.pk}/checklist/{item.pk}/",
        )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)


class GroupInheritedBoardAccessTests(TestCase):
    """Verify get_board_role resolves permissions through the group ancestor chain."""

    def setUp(self):
        from groups.models import Group, GroupMembership
        self.owner = User.objects.create_user(username="gowner", password="pass")
        self.user = User.objects.create_user(username="guser", password="pass")
        # A root group; owner is admin so they can own sub-groups and boards.
        self.root_group = Group.objects.create(name="Root", owner=self.owner)
        GroupMembership.objects.create(
            group=self.root_group, user=self.owner, role=GroupMembership.Role.ADMIN
        )

    def _make_group_board(self, group):
        """Create a board owned by self.owner and linked to *group*."""
        board = Board.objects.create(name="Group Board", owner=self.owner, group=group)
        BoardMembership.objects.create(board=board, user=self.owner, role=BoardMembership.Role.ADMIN)
        return board

    def test_direct_group_member_gets_role(self):
        """Member of the board's own group inherits the group role."""
        from groups.models import GroupMembership
        GroupMembership.objects.create(
            group=self.root_group, user=self.user, role=GroupMembership.Role.MEMBER
        )
        board = self._make_group_board(self.root_group)
        self.assertEqual(get_board_role(self.user, board), GroupMembership.Role.MEMBER)

    def test_group_member_inherits_via_parent(self):
        """Member of a grandparent group gets access to a board in a nested subgroup."""
        from groups.models import Group, GroupMembership
        child = Group.objects.create(name="Child", owner=self.owner, parent=self.root_group)
        grandchild = Group.objects.create(name="Grandchild", owner=self.owner, parent=child)
        GroupMembership.objects.create(
            group=self.root_group, user=self.user, role=GroupMembership.Role.VIEWER
        )
        board = self._make_group_board(grandchild)
        # Walking up: grandchild → child → root_group (found here)
        self.assertEqual(get_board_role(self.user, board), GroupMembership.Role.VIEWER)

    def test_group_traversal_depth_cap_excludes_distant_ancestor(self):
        """User in an ancestor 7 levels above board.group is NOT granted access (cap = 6)."""
        from groups.models import Group, GroupMembership
        # Build G1 (root) → G2 → G3 → G4 → G5 → G6 → G7
        # board.group = G7; user is only in G1 — requires 6 hops which exceeds the cap.
        node = self.root_group  # G1
        for i in range(2, 8):   # creates G2 … G7
            node = Group.objects.create(name=f"G{i}", owner=self.owner, parent=node)
        GroupMembership.objects.create(
            group=self.root_group, user=self.user, role=GroupMembership.Role.MEMBER
        )
        board = self._make_group_board(node)  # board.group = G7
        # The traversal cap (6) means G7→G6→G5→G4→G3→G2 are checked; G1 is NOT.
        self.assertIsNone(get_board_role(self.user, board))

    def test_subgroup_membership_does_not_grant_access(self):
        """Membership in a child of board.group does NOT grant access (traversal walks up only)."""
        from groups.models import Group, GroupMembership
        child = Group.objects.create(name="Child", owner=self.owner, parent=self.root_group)
        # User is only in the child group; board belongs to the parent group.
        GroupMembership.objects.create(
            group=child, user=self.user, role=GroupMembership.Role.MEMBER
        )
        board = self._make_group_board(self.root_group)
        self.assertIsNone(get_board_role(self.user, board))

    def test_explicit_board_role_overrides_group_role(self):
        """Explicit BoardMembership takes precedence over an inherited group role."""
        from groups.models import GroupMembership
        GroupMembership.objects.create(
            group=self.root_group, user=self.user, role=GroupMembership.Role.ADMIN
        )
        board = self._make_group_board(self.root_group)
        # Override: explicit viewer beats group admin
        BoardMembership.objects.create(board=board, user=self.user, role=BoardMembership.Role.VIEWER)
        self.assertEqual(get_board_role(self.user, board), BoardMembership.Role.VIEWER)
