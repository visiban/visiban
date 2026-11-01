"""The Django admin never lowers a card's ``version`` and bumps it on a change
save (#1969, #2040).

The web client orders the copies of a card it receives by ``version`` and drops
one whose version is lower than the copy it holds. An admin save that wrote a
lower number (typed into an editable field, or carried by an instance loaded
before a concurrent update/move bumped it) would make every client drop that
edit's ``card.updated`` frame until the version caught up. So ``version`` is
read-only in ``CardAdmin`` and ``save_model`` computes it from the value read
under the card lock.

An admin save that left the version unchanged could not be ordered against a
concurrent API save of the same card: both copies carried the same number, so
whichever arrived last won (#2040). So a change save sets it to the locked
value plus one, as ``update_card`` and ``move_card`` do, and a request that
sends the pre-edit version back gets ``409 version_conflict``. An add keeps
the model default.
"""

from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.test import Client, RequestFactory, TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import CardAdmin
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from boards.tests.test_admin_card_cell_entry_race import _admin_post_data

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


class CardAdminVersionTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_superuser(
            username="admin1969", password="p", email="admin1969@example.com",
        )
        self.board = Board.objects.create(name="Version Board", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN,
        )
        self.column = Column.objects.create(board=self.board, name="To Do", position=0)
        self.done = Column.objects.create(board=self.board, name="Done", position=1)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Card", created_by=self.user, position=0,
        )
        Card.objects.filter(pk=self.card.pk).update(version=5)
        self.card.refresh_from_db()
        self.admin = CardAdmin(Card, AdminSite())

    def _request(self):
        request = RequestFactory().post("/admin/")
        request.user = self.user
        return request

    def test_version_is_not_an_editable_form_field(self):
        self.assertIn("version", self.admin.get_readonly_fields(self._request(), self.card))
        form_class = self.admin.get_form(self._request(), obj=self.card)
        self.assertNotIn("version", form_class.base_fields)
        add_form_class = self.admin.get_form(self._request(), obj=None)
        self.assertNotIn("version", add_form_class.base_fields)

    def _admin_change(self, **overrides):
        """Save the card through the real admin change view."""
        data = _admin_post_data(self.card, **overrides)
        client = Client()
        client.force_login(self.user)
        response = client.post(reverse("admin:boards_card_change", args=[self.card.pk]), data)
        # 302 is the admin's redirect after a successful save; 200 would be the
        # form re-rendered with errors.
        self.assertEqual(response.status_code, 302)
        self.card.refresh_from_db()

    def test_change_view_ignores_a_posted_lower_version(self):
        data = _admin_post_data(self.card, title="Edited in admin")
        data["version"] = "1"
        client = Client()
        client.force_login(self.user)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            response = client.post(reverse("admin:boards_card_change", args=[self.card.pk]), data)
        self.assertEqual(response.status_code, 302)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited in admin")
        # The stored 5 plus this save's bump; the posted 1 is ignored.
        self.assertEqual(self.card.version, 6)

    def test_change_bumps_version_by_exactly_one_and_broadcasts_it_on_commit(self):
        with patch(PATCH_BROADCAST) as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                self._admin_change(title="Edited in admin")
                # Deferred to the commit: nothing is published while the
                # save's transaction is still open.
                mock_broadcast.assert_not_called()
        self.assertEqual(self.card.title, "Edited in admin")
        self.assertEqual(self.card.version, 6)
        _, event_type, payload = mock_broadcast.call_args_list[0][0]
        self.assertEqual(event_type, "card.updated")
        self.assertEqual(payload["version"], 6)

    def test_each_change_save_bumps_once(self):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin_change(title="First")
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin_change(title="Second")
        self.assertEqual(self.card.version, 7)

    def test_admin_move_bumps_version_by_exactly_one(self):
        with patch(PATCH_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            self._admin_change(column=self.done.pk)
        self.assertEqual(self.card.column_id, self.done.pk)
        self.assertEqual(self.card.version, 6)
        _, event_type, payload = mock_broadcast.call_args_list[0][0]
        self.assertEqual(event_type, "card.updated")
        self.assertEqual(payload["version"], 6)

    def test_save_bumps_a_version_bumped_after_the_instance_was_loaded(self):
        # The admin loaded the card at version 5; an update or move committed
        # version 6 before the save took the card lock.
        loaded = Card.objects.get(pk=self.card.pk)
        Card.objects.filter(pk=self.card.pk).update(version=6)
        loaded.title = "Edited from a stale load"
        with patch(PATCH_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            self.admin.save_model(self._request(), loaded, None, change=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited from a stale load")
        # Bumped from the locked 6, not from the stale-loaded 5 (which would
        # give the same 6 the concurrent write already committed).
        self.assertEqual(self.card.version, 7)
        # The frame clients receive carries the new version, not the stale one.
        _, event_type, payload = mock_broadcast.call_args_list[0][0]
        self.assertEqual(event_type, "card.updated")
        self.assertEqual(payload["version"], 7)

    def test_move_with_the_pre_admin_version_is_a_conflict(self):
        pre_admin = self.card.version
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin_change(title="Edited in admin")
        api = APIClient()
        api.force_authenticate(self.user)
        with patch(PATCH_BROADCAST):
            response = api.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
                {
                    "column_id": self.done.pk, "swimlane_id": self.swimlane.pk,
                    "position": 0, "version": pre_admin,
                },
                format="json",
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "version_conflict")
        self.assertEqual(response.data["current_version"], pre_admin + 1)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.column.pk)
        self.assertEqual(self.card.version, pre_admin + 1)

    def test_mcp_update_with_the_pre_admin_version_is_a_conflict(self):
        from mcp_server import tools

        pre_admin = self.card.version
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self._admin_change(title="Edited in admin")
        with patch("mcp_server.tools.get_current_user", return_value=self.user), \
                patch(PATCH_BROADCAST):
            result = tools.update_card(card_id=self.card.pk, title="From the agent", version=pre_admin)
        self.assertEqual(result["error"]["code"], "version_conflict")
        self.assertEqual(result["error"]["current_version"], pre_admin + 1)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited in admin")

    def test_new_card_starts_at_version_one(self):
        # An add is not bumped: there is no earlier copy to order it against.
        card = Card(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Created in admin", created_by=self.user, position=1,
        )
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self.admin.save_model(self._request(), card, None, change=False)
        card.refresh_from_db()
        self.assertEqual(card.version, 1)

    def test_add_view_creates_the_card_at_version_one(self):
        # The admin form refuses a create in a column with creation off (#1428).
        Column.objects.filter(pk=self.column.pk).update(allow_card_creation=True)
        self.column.refresh_from_db()
        draft = Card(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Added in admin", created_by=self.user, position=1,
        )
        data = _admin_post_data(draft)
        client = Client()
        client.force_login(self.user)
        with patch(PATCH_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            response = client.post(reverse("admin:boards_card_add"), data)
        self.assertEqual(response.status_code, 302)
        added = Card.objects.get(board=self.board, title="Added in admin")
        self.assertEqual(added.version, 1)
        _, event_type, payload = mock_broadcast.call_args_list[0][0]
        self.assertEqual(event_type, "card.created")
        self.assertEqual(payload["version"], 1)
