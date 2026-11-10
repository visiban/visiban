"""Direct tests for ``ContainerChangedAdminMixin`` (#1991).

The mixin is otherwise covered only through the cascade-lock race tests, which
force the failure by making the real lock retry loop lose. These tests raise
``ContainerChanged`` straight from the delete hook, so each branch of
``delete_view`` and ``response_action`` is pinned without any locking setup.
"""

from unittest.mock import patch

from django.contrib.admin.models import DELETION, LogEntry
from django.contrib.messages import get_messages
from django.test import Client, TestCase
from django.urls import reverse

from accounts.models import User
from boards.admin import ColumnAdmin
from boards.models import Board, Column
from boards.services.errors import ContainerChanged


class ContainerChangedAdminMixinTests(TestCase):
    def setUp(self):
        staff = User.objects.create_superuser(
            username="staff1991", password="pass", email="s1991@example.com"
        )
        self.client = Client()
        self.client.force_login(staff)
        self.board = Board.objects.create(name="B1991", owner=staff)
        self.column = Column.objects.create(board=self.board, name="C1991", position=0)
        self.change_url = reverse("admin:boards_column_change", args=[self.column.pk])
        self.delete_url = reverse("admin:boards_column_delete", args=[self.column.pk])
        self.changelist_url = reverse("admin:boards_column_changelist")

    def _messages(self, response):
        return [str(m) for m in get_messages(response.wsgi_request)]

    def _fail(self, hook):
        return patch.object(ColumnAdmin, hook, side_effect=ContainerChanged())

    # -- delete_view --------------------------------------------------------

    def test_delete_view_success_deletes_and_does_not_error(self):
        response = self.client.post(self.delete_url, {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], self.changelist_url)
        self.assertFalse(Column.objects.filter(pk=self.column.pk).exists())
        self.assertNotIn(ContainerChanged.detail, self._messages(response))

    def test_delete_view_container_changed_redirects_to_change_page(self):
        with self._fail("delete_model"):
            response = self.client.post(self.delete_url, {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], self.change_url)
        self.assertEqual(self._messages(response), [ContainerChanged.detail])
        self.assertTrue(Column.objects.filter(pk=self.column.pk).exists())

    def test_delete_view_container_changed_leaves_no_deletion_log_entry(self):
        # delete_view runs in transaction.atomic(), so the log entry written
        # before the failed delete rolls back with it.
        with self._fail("delete_model"):
            self.client.post(self.delete_url, {"post": "yes"})
        self.assertFalse(LogEntry.objects.filter(action_flag=DELETION).exists())

    # -- response_action (bulk) ---------------------------------------------

    def _bulk(self, action="delete_selected"):
        return self.client.post(
            self.changelist_url,
            {"action": action, "_selected_action": [self.column.pk], "post": "yes"},
        )

    def test_bulk_delete_success_deletes_and_logs(self):
        response = self._bulk()
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Column.objects.filter(pk=self.column.pk).exists())
        self.assertTrue(LogEntry.objects.filter(action_flag=DELETION).exists())
        self.assertNotIn(ContainerChanged.detail, self._messages(response))

    def test_bulk_delete_container_changed_rolls_back_and_redirects(self):
        with self._fail("delete_queryset"):
            response = self._bulk()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], self.changelist_url)
        self.assertEqual(self._messages(response), [ContainerChanged.detail])
        self.assertTrue(Column.objects.filter(pk=self.column.pk).exists())
        # Django writes the log entries before delete_queryset; the mixin's
        # atomic() block must roll them back.
        self.assertFalse(LogEntry.objects.filter(action_flag=DELETION).exists())

    def test_other_actions_are_delegated_without_the_catch(self):
        # Only delete_selected is wrapped. Any other action goes straight to
        # ModelAdmin.response_action, so a ContainerChanged there is not
        # swallowed into an admin message.
        with patch(
            "django.contrib.admin.ModelAdmin.response_action",
            side_effect=ContainerChanged(),
        ) as delegated:
            with self.assertRaises(ContainerChanged):
                self._bulk(action="some_other_action")
        delegated.assert_called_once()
