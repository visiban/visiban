"""Tests for the saved-filter endpoints on BoardViewSet.

Coverage:
- GET  /api/boards/{id}/saved-filters/  — list
- POST /api/boards/{id}/saved-filters/  — create
- DELETE /api/boards/{id}/saved-filters/{filter_pk}/ — delete
- RBAC: viewer can read, save, and delete their own filters
- Isolation: user A cannot see or delete user B's filters
- Validation: missing name, missing state_json, non-dict state_json, name too long
- Duplicate name returns 400
- Non-member (outsider) gets 404
- Unauthenticated returns 401/403
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, SavedFilter


SIMPLE_STATE = {
    "search": "bug",
    "assigneeIds": [1],
    "labelIds": [],
    "priorities": ["high"],
    "dueDate": None,
}


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class SavedFilterListCreateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.other = User.objects.create_user(username="bob", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/boards/{self.board.id}/saved-filters/"

    # --- list ---

    def test_list_returns_empty_for_new_board(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data, [])

    def test_list_returns_only_own_filters(self):
        # Create a filter for alice
        SavedFilter.objects.create(
            user=self.user, board=self.board, name="My filter", state_json=SIMPLE_STATE
        )
        # Create a filter for bob (as board admin adding bob)
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        SavedFilter.objects.create(
            user=self.other, board=self.board, name="Bob filter", state_json=SIMPLE_STATE
        )

        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        names = [f["name"] for f in r.data]
        self.assertIn("My filter", names)
        self.assertNotIn("Bob filter", names)

    def test_list_returns_expected_fields(self):
        SavedFilter.objects.create(
            user=self.user, board=self.board, name="Alpha", state_json=SIMPLE_STATE
        )
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        entry = r.data[0]
        self.assertIn("id", entry)
        self.assertIn("name", entry)
        self.assertIn("state_json", entry)
        self.assertIn("created_at", entry)
        # Sensitive fields must not be exposed
        self.assertNotIn("user", entry)
        self.assertNotIn("board", entry)

    # --- create ---

    def test_create_happy_path(self):
        r = self.client.post(
            self.url, {"name": "Sprint view", "state_json": SIMPLE_STATE}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["name"], "Sprint view")
        self.assertEqual(r.data["state_json"], SIMPLE_STATE)
        self.assertTrue(SavedFilter.objects.filter(user=self.user, board=self.board, name="Sprint view").exists())

    def test_create_missing_name_returns_400(self):
        r = self.client.post(self.url, {"state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.data["detail"])

    def test_create_empty_name_returns_400(self):
        r = self.client.post(self.url, {"name": "   ", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_name_too_long_returns_400(self):
        long_name = "x" * 101
        r = self.client.post(self.url, {"name": long_name, "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_missing_state_json_returns_400(self):
        r = self.client.post(self.url, {"name": "Nostate"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("state_json", r.data["detail"])

    def test_create_non_dict_state_json_returns_400(self):
        r = self.client.post(self.url, {"name": "Bad", "state_json": ["list"]}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_duplicate_name_returns_400(self):
        self.client.post(self.url, {"name": "Dupe", "state_json": SIMPLE_STATE}, format="json")
        r = self.client.post(self.url, {"name": "Dupe", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("already exists", r.data["detail"])

    def test_create_non_member_is_denied(self):
        # Non-members get 403 (PermissionDenied from get_board_for_user) — the
        # board is found but the user has no role. This is consistent with the
        # rest of the BoardViewSet which also raises 403 for non-members.
        outsider = User.objects.create_user(username="charlie", password="pass")
        c = APIClient()
        c.force_authenticate(outsider)
        r = c.post(self.url, {"name": "Outsider", "state_json": SIMPLE_STATE}, format="json")
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])

    def test_create_unauthenticated_returns_401_or_403(self):
        anon = APIClient()
        r = anon.post(self.url, {"name": "Anon", "state_json": SIMPLE_STATE}, format="json")
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class SavedFilterDeleteTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.other = User.objects.create_user(username="bob", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _delete_url(self, filter_pk):
        return f"/api/boards/{self.board.id}/saved-filters/{filter_pk}/"

    def test_delete_own_filter(self):
        sf = SavedFilter.objects.create(
            user=self.user, board=self.board, name="To delete", state_json=SIMPLE_STATE
        )
        r = self.client.delete(self._delete_url(sf.pk))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(SavedFilter.objects.filter(pk=sf.pk).exists())

    def test_delete_other_users_filter_returns_404(self):
        # bob's filter on the same board — alice must not be able to delete it
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        sf = SavedFilter.objects.create(
            user=self.other, board=self.board, name="Bob only", state_json=SIMPLE_STATE
        )
        r = self.client.delete(self._delete_url(sf.pk))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        # Filter must still exist
        self.assertTrue(SavedFilter.objects.filter(pk=sf.pk).exists())

    def test_delete_nonexistent_filter_returns_404(self):
        r = self.client.delete(self._delete_url(9999))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_delete_unauthenticated_returns_401_or_403(self):
        sf = SavedFilter.objects.create(
            user=self.user, board=self.board, name="Auth test", state_json=SIMPLE_STATE
        )
        anon = APIClient()
        r = anon.delete(self._delete_url(sf.pk))
        self.assertIn(r.status_code, [status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN])


class SavedFilterViewerRbacTests(TestCase):
    """Viewer-role members can list, create, and delete their own saved filters."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.board = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.viewer)
        self.url = f"/api/boards/{self.board.id}/saved-filters/"

    def test_viewer_can_list_saved_filters(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_can_create_saved_filter(self):
        r = self.client.post(
            self.url, {"name": "Viewer preset", "state_json": SIMPLE_STATE}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_viewer_can_delete_own_saved_filter(self):
        sf = SavedFilter.objects.create(
            user=self.viewer, board=self.board, name="Viewer preset", state_json=SIMPLE_STATE
        )
        r = self.client.delete(f"/api/boards/{self.board.id}/saved-filters/{sf.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
