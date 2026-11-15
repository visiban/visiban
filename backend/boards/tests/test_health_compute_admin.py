"""Auto health status through the Django admin (#2245).

The admin bypasses the REST viewsets, so it must take the same service paths
(``apply_auto_health_change``, ``rollup_board_health``): unticking auto clears
every computed value, ticking it or changing a rule input computes, a lane pin
change or delete re-derives the roll-up, a lane moved to another board drops
the computed values of the board it left, and the computed columns themselves
are read-only.
"""

import datetime

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardHealthChange, BoardMembership, Swimlane
from boards.services.health_compute import compute_board_health
from boards.tests.conftest import _make_board, _make_card, _make_column
from boards.tests.test_admin_board_concurrent_edits import _PLAIN_STATIC, page_data

YESTERDAY = lambda: timezone.localdate() - datetime.timedelta(days=1)  # noqa: E731
COMPUTED = ("computed_health_status", "health_computed_at", "health_computed_counts")


@_PLAIN_STATIC
class AutoHealthAdminTests(TestCase):
    def setUp(self):
        self.staff = User.objects.create_superuser(username="ah_staff", password="p", email="ah@x")
        self.board = _make_board(self.staff, health_auto_enabled=True, allowed_priorities=["low"])
        BoardMembership.objects.get_or_create(
            board=self.board, user=self.staff, defaults={"role": BoardMembership.Role.ADMIN},
        )
        self.todo = _make_column(self.board, "Todo", 0)
        self.acme = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.beta = Swimlane.objects.create(board=self.board, name="Beta", position=1)
        _make_card(self.todo, self.acme, title="late", due_date=YESTERDAY())
        _make_card(self.todo, self.beta, title="fine")
        compute_board_health(self.board.pk)
        self.client.force_login(self.staff)

    def _board_url(self):
        return reverse("admin:boards_board_change", args=[self.board.pk])

    def _lane_url(self, lane):
        return reverse("admin:boards_swimlane_change", args=[lane.pk])

    def _post(self, url, **overrides):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(url, page_data(response, **overrides))
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context.get("errors"))
        self.board.refresh_from_db()

    def test_computed_columns_are_read_only(self):
        for url in (self._board_url(), self._lane_url(self.acme)):
            form = self.client.get(url).context["adminform"].form
            for name in COMPUTED:
                self.assertNotIn(name, form.fields, (url, name))
        self._post(self._board_url(), computed_health_status="off_track", name="Renamed")
        self.assertEqual((self.board.name, self.board.computed_health_status), ("Renamed", "at_risk"))

    def test_unticking_auto_clears_board_and_lanes(self):
        self._post(self._board_url(), health_auto_enabled=False)
        self.assertEqual([getattr(self.board, f) for f in COMPUTED], [None, None, None])
        for lane in (self.acme, self.beta):
            lane.refresh_from_db()
            self.assertEqual([getattr(lane, f) for f in COMPUTED], [None, None, None])
        row = BoardHealthChange.objects.filter(board=self.board).latest("id")
        self.assertEqual((row.kind, row.from_status, row.to_status, row.changed_by), ("computed", "at_risk", None, self.staff))

    def test_ticking_auto_computes(self):
        Board.objects.filter(pk=self.board.pk).update(health_auto_enabled=False)
        Swimlane.objects.filter(board=self.board).update(computed_health_status=None, health_computed_at=None)
        Board.objects.filter(pk=self.board.pk).update(computed_health_status=None, health_computed_at=None)
        self._post(self._board_url(), health_auto_enabled=True)
        self.assertEqual(self.board.computed_health_status, "at_risk")
        self.assertIsNotNone(self.board.health_computed_at)

    def test_rule_input_change_recomputes(self):
        self._post(self._board_url(), health_off_track_cards="1")
        self.assertEqual(self.board.computed_health_status, "off_track")

    def test_lane_pin_change_and_delete_roll_up(self):
        self._post(self._lane_url(self.beta), health_status="off_track")
        self.assertEqual(self.board.computed_health_status, "off_track")
        url = reverse("admin:boards_swimlane_delete", args=[self.beta.pk])
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(url, {"post": "yes"}).status_code, 302)
        self.board.refresh_from_db()
        self.assertEqual(self.board.computed_health_status, "at_risk")

    def test_lane_moved_to_auto_off_board_drops_computed_values(self):
        other = _make_board(self.staff, name="Other")
        self._post(self._lane_url(self.acme), board=str(other.pk))
        self.acme.refresh_from_db()
        self.assertEqual(self.acme.board_id, other.pk)
        self.assertEqual([getattr(self.acme, f) for f in COMPUTED], [None, None, None])
        # The board it left re-derives its roll-up without it.
        self.assertEqual(self.board.computed_health_status, "on_track")
