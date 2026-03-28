from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import User
from boards.models import Board


class BoardDeletionLoggingTests(TestCase):
    """Verify that deleting a board emits a structured INFO log."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board = Board.objects.create(name="Test Board", owner=self.owner)
        self.client.force_authenticate(self.owner)

    def test_delete_board_emits_info_log(self):
        board_id = self.board.id
        board_name = self.board.name

        with self.assertLogs("boards.views", level="INFO") as cm:
            resp = self.client.delete(f"/api/boards/{board_id}/")

        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        # Exactly one log line should mention the deletion
        matching = [m for m in cm.output if "board.deleted" in m]
        self.assertEqual(len(matching), 1)
        log_line = matching[0]
        self.assertIn(f"board_id={board_id}", log_line)
        self.assertIn(f"board_name={board_name}", log_line)
        self.assertIn(f"deleted_by={self.owner.pk}", log_line)
        self.assertIn(f"deleted_by_username={self.owner.username}", log_line)
