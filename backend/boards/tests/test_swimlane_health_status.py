"""Lane health status (#2243): the manual pin on a swimlane.

* board admins (and site admins) set and clear it through the existing
  swimlane PATCH; member, collaborator and viewer get 403, a non-member 404;
* only the HealthStatus values or null are accepted;
* a lane's value and its board's value are independent in both directions
  (no cascade down, no rollup up);
* every member reads it, and the ``swimlane.updated`` broadcast, which fires
  after commit in the ``{event, data}`` envelope, carries it.
"""

import contextlib
import json
import types
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import BoardMembership, Swimlane
from boards.tests.conftest import _make_board

Role = BoardMembership.Role


@contextlib.contextmanager
def _capture_frames():
    """Collect every ``{event, data}`` envelope sent to the channel layer."""
    sent = []

    async def _group_send(group, message):
        sent.append(message)

    layer = types.SimpleNamespace(group_send=_group_send)
    frames = []
    with patch("boards.broadcast.get_channel_layer", return_value=layer):
        yield frames
    for message in sent:
        for value in message.values():
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    continue
            if isinstance(value, dict) and {"event", "data"} <= set(value):
                frames.append(value)


class SwimlaneHealthStatusTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="hs_admin", password="pass")
        self.board = _make_board(self.admin)
        self.lane = Swimlane.objects.create(board=self.board, name="Acme", position=0)
        self.client = APIClient()

    def _url(self, lane=None):
        return f"/api/v1/boards/{self.board.id}/swimlanes/{(lane or self.lane).id}/"

    def _as(self, user):
        self.client.force_authenticate(user)
        return self.client

    def _member(self, role, name=None):
        user = User.objects.create_user(username=name or f"hs_{role}", password="pass")
        BoardMembership.objects.create(board=self.board, user=user, role=role)
        return user

    # writes -------------------------------------------------------------

    def test_admin_sets_and_clears(self):
        c = self._as(self.admin)
        r = c.patch(self._url(), {"health_status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["health_status"], "at_risk")
        self.lane.refresh_from_db()
        self.assertEqual(self.lane.health_status, "at_risk")

        r = c.patch(self._url(), {"health_status": None}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIsNone(r.data["health_status"])
        self.lane.refresh_from_db()
        self.assertIsNone(self.lane.health_status)

    def test_site_admin_can_set(self):
        staff = User.objects.create_user(username="hs_staff", password="pass", can_access_all_content=True)
        r = self._as(staff).patch(self._url(), {"health_status": "on_track"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["health_status"], "on_track")

    def test_non_admin_roles_get_403_and_nothing_is_written(self):
        for role in (Role.MEMBER, Role.COLLABORATOR, Role.VIEWER):
            with self.subTest(role=role):
                user = self._member(role)
                r = self._as(user).patch(self._url(), {"health_status": "off_track"}, format="json")
                self.assertEqual(r.status_code, 403)
                self.lane.refresh_from_db()
                self.assertIsNone(self.lane.health_status)

    def test_non_admin_with_invalid_value_still_gets_403(self):
        # #2009: the role check runs before the body is validated.
        user = self._member(Role.MEMBER)
        r = self._as(user).patch(self._url(), {"health_status": "bogus"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_non_member_gets_404(self):
        outsider = User.objects.create_user(username="hs_outsider", password="pass")
        r = self._as(outsider).patch(self._url(), {"health_status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 404)

    def test_invalid_value_is_400_on_the_field(self):
        for value in ("bogus", "inherit", "", 3):
            with self.subTest(value=value):
                r = self._as(self.admin).patch(self._url(), {"health_status": value}, format="json")
                self.assertEqual(r.status_code, 400)
                self.assertIn("health_status", r.data)
        self.lane.refresh_from_db()
        self.assertIsNone(self.lane.health_status)

    # reads --------------------------------------------------------------

    def test_every_member_reads_it_in_the_board_payload(self):
        self.lane.health_status = "at_risk"
        self.lane.save(update_fields=["health_status"])
        for role in (Role.ADMIN, Role.MEMBER, Role.COLLABORATOR, Role.VIEWER):
            with self.subTest(role=role):
                user = self.admin if role == Role.ADMIN else self._member(role, f"hs_read_{role}")
                r = self._as(user).get(f"/api/v1/boards/{self.board.id}/full/")
                self.assertEqual(r.status_code, 200)
                lane = next(s for s in r.data["swimlanes"] if s["id"] == self.lane.id)
                self.assertEqual(lane["health_status"], "at_risk")

    def test_new_lane_has_no_status(self):
        r = self._as(self.admin).post(
            f"/api/v1/boards/{self.board.id}/swimlanes/", {"name": "Fresh"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertIsNone(r.data["health_status"])

    # independence -------------------------------------------------------

    def test_board_status_change_does_not_touch_the_lane(self):
        c = self._as(self.admin)
        r = c.patch(f"/api/v1/boards/{self.board.id}/", {"health_status": "off_track"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.lane.refresh_from_db()
        self.assertIsNone(self.lane.health_status)

        self.lane.health_status = "on_track"
        self.lane.save(update_fields=["health_status"])
        c.patch(f"/api/v1/boards/{self.board.id}/", {"health_status": None}, format="json")
        self.lane.refresh_from_db()
        self.assertEqual(self.lane.health_status, "on_track")

    def test_lane_status_change_does_not_touch_the_board(self):
        c = self._as(self.admin)
        c.patch(self._url(), {"health_status": "off_track"}, format="json")
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status)
        r = c.get(f"/api/v1/boards/{self.board.id}/")
        self.assertIsNone(r.data["effective_health_status"])

        self.board.health_status = "on_track"
        self.board.save(update_fields=["health_status"])
        c.patch(self._url(), {"health_status": None}, format="json")
        self.board.refresh_from_db()
        self.assertEqual(self.board.health_status, "on_track")

    # broadcast ----------------------------------------------------------

    def test_update_broadcasts_after_commit_with_the_field(self):
        with _capture_frames() as frames:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                r = self._as(self.admin).patch(self._url(), {"health_status": "at_risk"}, format="json")
                self.assertEqual(r.status_code, 200, r.data)
            # Nothing is published until the transaction commits.
            self.assertTrue(callbacks)
            for callback in callbacks:
                callback()
        updates = [f for f in frames if f["event"] == "swimlane.updated"]
        self.assertEqual(len(updates), 1, frames)
        # The frozen {event, data} envelope, never the flat {type, ...} shape.
        self.assertLessEqual({"event", "data"}, set(updates[0]))
        self.assertNotIn("health_status", updates[0])
        self.assertEqual(updates[0]["data"]["id"], self.lane.id)
        self.assertEqual(updates[0]["data"]["health_status"], "at_risk")
        # The broadcast is built from the public serializer: no PII.
        self.assertNotIn("contact_email", updates[0]["data"])


class BoardFullQueryCountWithLaneStatusTests(TestCase):
    """Lane health_status is a plain column: it must not add /full/ queries (#2243)."""

    def test_full_query_count_unchanged_when_lanes_have_a_status(self):
        admin = User.objects.create_user(username="hs_qc_admin", password="pass")
        board = _make_board(admin)
        lanes = [Swimlane.objects.create(board=board, name=f"L{i}", position=i) for i in range(3)]
        client = APIClient()
        client.force_authenticate(user=admin)

        def count():
            with CaptureQueriesContext(connection) as ctx:
                r = client.get(f"/api/v1/boards/{board.id}/full/")
            self.assertEqual(r.status_code, 200)
            return len(ctx)

        baseline = count()
        for lane, value in zip(lanes, ("on_track", "at_risk", "off_track")):
            lane.health_status = value
            lane.save(update_fields=["health_status"])
        self.assertEqual(count(), baseline)
