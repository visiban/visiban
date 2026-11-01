"""The Django admin can never lower a card's ``version`` (#1969).

The web client orders the copies of a card it receives by ``version`` and drops
one whose version is lower than the copy it holds. An admin save that wrote a
lower number (typed into an editable field, or carried by an instance loaded
before a concurrent update/move bumped it) would make every client drop that
edit's ``card.updated`` frame until the version caught up. So ``version`` is
read-only in ``CardAdmin`` and ``save_model`` keeps the value read under the
card lock.
"""

from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.test import Client, RequestFactory, TestCase
from django.urls import reverse

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

    def test_change_view_ignores_a_posted_lower_version(self):
        data = _admin_post_data(self.card, title="Edited in admin")
        data["version"] = "1"
        client = Client()
        client.force_login(self.user)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            response = client.post(reverse("admin:boards_card_change", args=[self.card.pk]), data)
        # 302 is the admin's redirect after a successful save; 200 would be the
        # form re-rendered with errors.
        self.assertEqual(response.status_code, 302)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited in admin")
        self.assertEqual(self.card.version, 5)

    def test_save_keeps_a_version_bumped_after_the_instance_was_loaded(self):
        # The admin loaded the card at version 5; an update or move committed
        # version 6 before the save took the card lock.
        loaded = Card.objects.get(pk=self.card.pk)
        Card.objects.filter(pk=self.card.pk).update(version=6)
        loaded.title = "Edited from a stale load"
        with patch(PATCH_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            self.admin.save_model(self._request(), loaded, None, change=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited from a stale load")
        self.assertEqual(self.card.version, 6)
        # The frame clients receive carries the kept version, not the stale one.
        _, event_type, payload = mock_broadcast.call_args_list[0][0]
        self.assertEqual(event_type, "card.updated")
        self.assertEqual(payload["version"], 6)

    def test_new_card_starts_at_version_one(self):
        card = Card(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Created in admin", created_by=self.user, position=1,
        )
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self.admin.save_model(self._request(), card, None, change=False)
        card.refresh_from_db()
        self.assertEqual(card.version, 1)
