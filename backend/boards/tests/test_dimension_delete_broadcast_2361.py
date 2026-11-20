"""Deleting a dimension field tells other clients about its tracks and lane exceptions (#2361).

The delete CASCADEs to the field's ``StageTrack`` and ``SwimlaneTrackException``
rows. ``custom_field.deleted`` names only the field, so the view also sends the
``column.updated`` / ``swimlane.updated`` frames a stage save sends, on commit.
The board socket handler replaces the column (``useBoard.updateColumn``) and
merges the lane (``mergeSwimlaneFromBroadcast``) from those payloads, so a
second open client drops the track chip and the lane exception without a reload.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    BoardEvent, Column, CustomFieldDefinition, StageTrack, SubColumn, Swimlane, SwimlaneTrackException,
)
from boards.tests.conftest import _make_board


class DimensionDeleteBroadcastTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)
        self.user = User.objects.create_user(username="admin2361", password="pw")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board = _make_board(self.user)
        self.stage = Column.objects.create(board=self.board, name="Build", position=0)
        self.other_stage = Column.objects.create(board=self.board, name="Test", position=1)
        for i, name in enumerate(["Doing", "Ready"]):
            SubColumn.objects.create(column=self.stage, position=i, name=name)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.quiet_lane = Swimlane.objects.create(board=self.board, name="Quiet", position=1)
        self.docs = self._dimension("Docs", 0)
        self.security = self._dimension("Security", 1)
        StageTrack.objects.create(column=self.stage, field_definition=self.docs, position=0)
        StageTrack.objects.create(column=self.stage, field_definition=self.security, position=1)
        SwimlaneTrackException.objects.create(swimlane=self.lane, field_definition=self.docs)

    def _dimension(self, name, position):
        return CustomFieldDefinition.objects.create(
            board=self.board, name=name, field_type="dropdown", choices_json=["Done"], is_dimension=True,
            position=position,
        )

    def _delete(self, field):
        url = f"/api/v1/boards/{self.board.pk}/custom-fields/{field.pk}/"
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.delete(url)
        self.assertEqual(resp.status_code, 204, getattr(resp, "data", None))

    def _sent(self, event):
        return [c.args[2] for c in self.broadcast.call_args_list if c.args[1] == event]

    def test_delete_sends_the_stage_without_the_track_and_the_lane_without_the_exception(self):
        self._delete(self.docs)
        columns = self._sent("column.updated")
        self.assertEqual([c["id"] for c in columns], [self.stage.pk])
        self.assertEqual([t["field_id"] for t in columns[0]["tracks"]], [self.security.pk])
        # The full column payload, the same a stage save sends.
        self.assertEqual([s["name"] for s in columns[0]["sub_columns"]], ["Doing", "Ready"])
        lanes = self._sent("swimlane.updated")
        self.assertEqual([lane["id"] for lane in lanes], [self.lane.pk])
        self.assertEqual(lanes[0]["not_applicable_field_ids"], [])
        # custom_field.deleted still goes first, unchanged.
        events = [c.args[1] for c in self.broadcast.call_args_list]
        self.assertEqual(events[0], "custom_field.deleted")

    def test_frames_are_persisted_for_event_replay(self):
        self._delete(self.docs)
        persisted = list(BoardEvent.objects.filter(board_id=self.board.pk).values_list("event", flat=True))
        self.assertIn("column.updated", persisted)
        self.assertIn("swimlane.updated", persisted)

    def test_field_with_no_tracks_or_exceptions_sends_only_its_deletion(self):
        plain = CustomFieldDefinition.objects.create(board=self.board, name="Notes", field_type="text", position=2)
        self._delete(plain)
        self.assertEqual([c.args[1] for c in self.broadcast.call_args_list], ["custom_field.deleted"])

    def test_nothing_is_sent_before_commit(self):
        url = f"/api/v1/boards/{self.board.pk}/custom-fields/{self.docs.pk}/"
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self.client.delete(url)
        self.broadcast.assert_not_called()
        self.assertTrue(callbacks)
