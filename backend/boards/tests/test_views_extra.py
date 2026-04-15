"""Extra coverage tests: card move, card activities, attachments, move-group, analytics with movements."""
import datetime
import io
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardMovement,
    Column, Swimlane, Label,
)
from groups.models import Group, GroupMembership


PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"


def _make_board(owner):
    board = Board.objects.create(name="B", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col2 = Column.objects.create(board=board, name="Done", position=1, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, col2, swim


def _make_card(board, col, swim, user, title="Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=user, position=0,
    )


# ---------------------------------------------------------------------------
# Card move
# ---------------------------------------------------------------------------

class CardMoveTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_move_card_creates_movement(self, _):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col2.id, "swimlane_id": self.swim.id, "position": 0},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 1)

    def test_collaborator_cannot_move_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR
        )
        self.client.force_authenticate(collab)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/move/",
            {"column_id": self.col2.id, "swimlane_id": self.swim.id, "position": 0},
            format="json",
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


# ---------------------------------------------------------------------------
# Card update — extra activity types
# ---------------------------------------------------------------------------

class CardUpdateExtraTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    @patch(PATCH_BROADCAST)
    def test_update_weight_logs_activity(self, _):
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"weight": 5},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.WEIGHT_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_description_logs_activity(self, _):
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"description": "New description"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.DESCRIPTION_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_remove_label_logs_activity(self, _):
        label = Label.objects.create(board=self.board, name="Bug", color="#F00")
        self.card.labels.add(label)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"label_ids": []},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.LABEL_CHANGE
            ).exists()
        )

    @patch(PATCH_BROADCAST)
    def test_update_priority_logs_activity(self, _):
        """Changing card priority creates a PRIORITY_CHANGE activity row (#708)."""
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"priority": "high"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.PRIORITY_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.to_value, "high")
        self.assertEqual(act.actor, self.user)

    @patch(PATCH_BROADCAST)
    def test_update_title_logs_activity(self, _):
        """Changing card title creates a TITLE_CHANGE activity row (#708)."""
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"title": "New title"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.TITLE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.to_value, "New title")
        self.assertEqual(act.actor, self.user)

    @patch(PATCH_BROADCAST)
    def test_update_assignee_logs_activity(self, _):
        """Changing card assignee creates an ASSIGNEE_CHANGE activity row (#708)."""
        assignee = User.objects.create_user(username="assignee_user", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": assignee.id},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.ASSIGNEE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.to_value, assignee.username)
        self.assertEqual(act.actor, self.user)

    @patch(PATCH_BROADCAST)
    def test_clear_assignee_logs_activity_with_unassigned(self, _):
        """Removing an assignee records 'Unassigned' as to_value (#708)."""
        assignee = User.objects.create_user(username="assignee_user2", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        self.card.assignee = assignee
        self.card.save(update_fields=["assignee"])
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"assignee_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.ASSIGNEE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.to_value, "Unassigned")

    @patch(PATCH_BROADCAST)
    def test_update_due_date_logs_activity(self, _):
        """Setting a due date creates a DUE_DATE_CHANGE activity row (#708)."""
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"due_date": "2026-12-31"},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        act = CardActivity.objects.filter(
            card=self.card, event_type=CardActivity.EventType.DUE_DATE_CHANGE
        ).first()
        self.assertIsNotNone(act)
        self.assertEqual(act.to_value, "2026-12-31")
        self.assertEqual(act.actor, self.user)

    @patch(PATCH_BROADCAST)
    def test_no_activity_when_field_unchanged(self, _):
        """Patching a field with the same value must not create a spurious activity row."""
        original_priority = self.card.priority
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"priority": original_priority},
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertFalse(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.PRIORITY_CHANGE
            ).exists()
        )

    def test_collaborator_cannot_update_card(self):
        collab = User.objects.create_user(username="collab", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=collab, role=BoardMembership.Role.COLLABORATOR
        )
        self.client.force_authenticate(collab)
        r = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"title": "Hacked"},
        )
        self.assertIn(r.status_code, [status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND])


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

class CardAttachmentTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, _, self.swim = _make_board(self.user)
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        # Enable uploads — default is False; without this the upload endpoint returns 403
        s = SiteSetting.get()
        s.uploads_enabled = True
        s.save(update_fields=["uploads_enabled"])

    def test_list_attachments_empty(self):
        r = self.client.get(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/"
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json(), [])

    def test_upload_attachment(self):
        content = b"hello file content"
        upload = io.BytesIO(content)
        upload.name = "test.txt"
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {"file": upload},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.json()["filename"], "test.txt")

    def test_upload_filename_path_traversal_is_sanitized(self):
        """Path-separator characters in filenames must be stripped at upload time (#682).

        os.path.basename() is applied to the uploaded filename before storing, so a
        path-traversal attempt like `../../etc/evil.pdf` is stored as just `evil.pdf`.

        Note: a bare double-quote cannot be tested via HTTP because it breaks the
        multipart Content-Disposition encoding in Django's test client before reaching
        the view.  The serve-time double-quote defense is covered in
        test_serve_media_access.py::ServeMediaContentDispositionTests.
        """
        # Use real PDF magic bytes so the MIME allowlist check passes.
        content = b"%PDF-1.4 minimal"
        upload = io.BytesIO(content)
        upload.name = "../../etc/evil.pdf"
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {"file": upload},
            format="multipart",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        stored_filename = r.json()["filename"]
        self.assertNotIn("/", stored_filename,
            "Path separators must be stripped by os.path.basename before storing")
        self.assertNotIn("..", stored_filename,
            "Path traversal sequences must not survive in the stored filename")

    def test_upload_missing_file_rejected(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {},
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_delete_attachment(self):
        # Upload first
        upload = io.BytesIO(b"data")
        upload.name = "del.txt"
        r_up = self.client.post(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/",
            {"file": upload},
            format="multipart",
        )
        self.assertEqual(r_up.status_code, status.HTTP_201_CREATED)
        att_id = r_up.json()["id"]
        r = self.client.delete(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/attachments/{att_id}/"
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Board move-group action
# ---------------------------------------------------------------------------

class BoardMoveGroupTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.other = User.objects.create_user(username="other", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        self.group = Group.objects.create(name="MyGroup", owner=self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    @patch(PATCH_BROADCAST)
    def test_owner_can_move_board_to_group(self, _):
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/move-group/",
            {"group_id": self.group.id},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertEqual(self.board.group_id, self.group.id)

    @patch(PATCH_BROADCAST)
    def test_owner_can_move_board_to_personal(self, _):
        self.board.group = self.group
        self.board.save()
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/move-group/",
            {"group_id": None},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.group_id)

    @patch(PATCH_BROADCAST)
    def test_non_group_member_cannot_move_to_group(self, _):
        # other has no group membership
        BoardMembership.objects.create(
            board=self.board, user=self.other, role=BoardMembership.Role.ADMIN
        )
        self.client.force_authenticate(self.other)
        r = self.client.post(
            f"/api/v1/boards/{self.board.id}/move-group/",
            {"group_id": self.group.id},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# Analytics with actual card movements
# ---------------------------------------------------------------------------

class BoardAnalyticsWithMovementsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        # Create a card and add movements so the analytics loop executes
        self.card = _make_card(self.board, self.col, self.swim, self.user)
        CardMovement.objects.create(
            card=self.card, to_column=self.col, to_swimlane=self.swim, moved_by=self.user
        )
        CardMovement.objects.create(
            card=self.card, to_column=self.col2, to_swimlane=self.swim, moved_by=self.user
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_analytics_with_movements_returns_ok(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        self.assertIn("swimlanes", data)
        self.assertIn("columns", data)


# ---------------------------------------------------------------------------
# Analytics dwell-time and stall-threshold tests
# ---------------------------------------------------------------------------

class AnalyticsDwellTimeTests(TestCase):
    """Verify that the heatmap includes cards whose column entry predates the
    analysis window (they should contribute in-window dwell time, not be
    excluded entirely)."""

    def setUp(self):
        self.user = User.objects.create_user(username="u2", password="pass")
        self.board, self.col, self.col2, self.swim = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _movement(self, card, col, swim, moved_at):
        mv = CardMovement.objects.create(
            card=card, to_column=col, to_swimlane=swim, moved_by=self.user
        )
        mv.moved_at = moved_at
        mv.save(update_fields=["moved_at"])
        # Keep card.column in sync with the movement destination so the
        # long-dwelling cards block (which reads card.column_id) sees the
        # correct current column, matching what the production move endpoint does.
        card.column = col
        card.save(update_fields=["column"])
        return mv

    def test_card_entered_before_window_still_shows_dwell_time(self):
        """A card placed in a column 45 days ago should appear in the 30d heatmap
        with ~30 days of dwell time (capped at the window start)."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=45))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        # Should be ~30 days, not null — the card is still in col right now
        avg = sw["avg_days_per_column"].get(self.col.name)
        self.assertIsNotNone(avg)
        self.assertAlmostEqual(avg, 30.0, delta=0.5)

    def test_card_fully_before_window_excluded(self):
        """A card that entered and exited a column entirely before the window
        must not contribute dwell time to the 7d heatmap."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Moved into col1 60 days ago, then to col2 40 days ago — both before 7d window
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=60))
        self._movement(card, self.col2, self.swim, now - datetime.timedelta(days=40))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=7")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        # col was fully in-and-out before the 7d window — should be null
        self.assertIsNone(sw["avg_days_per_column"].get(self.col.name))

    def test_stall_threshold_uses_board_setting_not_period(self):
        """The stall threshold must use board.staleness_threshold_days, not the
        period query param, so 7d heatmap does not flag everything as stalled."""
        self.board.staleness_threshold_days = 14
        self.board.save(update_fields=["staleness_threshold_days"])

        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Last movement 10 days ago — stalled under default 7d but not under 14d
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        self.assertEqual(len(sw["stalled_cards"]), 0)
        self.assertEqual(data["stalled_threshold_days"], 14)

    def test_stall_threshold_query_param_overrides_board_setting(self):
        """Explicit stalled_days query param overrides the board setting."""
        self.board.staleness_threshold_days = 30
        self.board.save(update_fields=["staleness_threshold_days"])

        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Last movement 10 days ago — not stalled under 30d board setting,
        # but stalled under explicit stalled_days=5 override
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30&stalled_days=5")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        self.assertEqual(len(sw["stalled_cards"]), 1)
        self.assertEqual(data["stalled_threshold_days"], 5)

    def test_is_outlier_uses_board_staleness_threshold_not_stalled_days_param(self):
        """is_outlier cell coloring must always use board.staleness_threshold_days,
        not the stalled_days query param.  A caller using stalled_days=5 for
        investigation should not see the heatmap colors shift — only
        stalled_cards changes."""
        self.board.staleness_threshold_days = 20
        self.board.save(update_fields=["staleness_threshold_days"])
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Last moved 10 days ago — outlier under 5-day threshold but NOT under 20-day board setting.
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))

        # stalled_days=5 override — stalled_cards should flag the card but is_outlier should not.
        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30&stalled_days=5")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        self.assertEqual(len(sw["stalled_cards"]), 1, "stalled_days param should flag the card")
        self.assertFalse(
            sw["is_outlier"].get(self.col.name, False),
            "is_outlier must use board threshold (20d), not stalled_days param (5d)",
        )

    def test_dwell_falls_back_to_column_name_when_fk_broken(self):
        """If a column is deleted and recreated (new PK, same name), movements
        that reference the old FK still contribute dwell time via the
        denormalized to_column_name field."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        mv = self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))
        # Simulate a broken FK: point to_column_id to a non-existent column
        # while keeping to_column_name intact.
        CardMovement.objects.filter(pk=mv.pk).update(
            to_column_id=None, to_column_name=self.col.name
        )

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        # Dwell should be non-null because to_column_name resolves the column
        self.assertIsNotNone(sw["avg_days_per_column"].get(self.col.name))

    # ── Age mode tests ────────────────────────────────────────────────────────

    def test_age_avg_days_per_column_reflects_current_dwell(self):
        """age_avg_days_per_column shows how long a card has been in its current
        column regardless of the period window."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=20))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=7")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        age = sw["age_avg_days_per_column"].get(self.col.name)
        # Card has been in col for ~20 days — age should reflect that, not the 7d window.
        self.assertIsNotNone(age)
        self.assertAlmostEqual(age, 20.0, delta=0.5)

    def test_age_excludes_cards_in_done_columns(self):
        """Cards in done columns must not appear in age_avg_days_per_column."""
        # Mark col2 as done
        self.col2.is_done = True
        self.col2.save(update_fields=["is_done"])
        card = _make_card(self.board, self.col2, self.swim, self.user)
        now = timezone.now()
        # Move card into col (non-done) first, then done col
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=30))
        self._movement(card, self.col2, self.swim, now - datetime.timedelta(days=5))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=90")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        # col2 is done — excluded from age tracking
        self.assertNotIn(self.col2.name, sw.get("age_avg_days_per_column", {}))

    def test_age_excludes_archived_cards(self):
        """Archived cards must not contribute to age_avg_days_per_column."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))
        card.archived_at = now - datetime.timedelta(days=2)
        card.save(update_fields=["archived_at"])

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        self.assertIsNone(sw["age_avg_days_per_column"].get(self.col.name))

    # ── Throughput mode tests ─────────────────────────────────────────────────

    def test_throughput_avg_days_reflects_cards_that_exited_in_window(self):
        """throughput_avg_days_per_column includes cards that moved out of col
        within the period, using actual entry timestamps."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Card entered col 20 days ago, exited 5 days ago → throughput dwell = ~15d
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=20))
        self._movement(card, self.col2, self.swim, now - datetime.timedelta(days=5))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        t_avg = sw["throughput_avg_days_per_column"].get(self.col.name)
        self.assertIsNotNone(t_avg)
        self.assertAlmostEqual(t_avg, 15.0, delta=0.5)

    def test_throughput_card_count_matches_transitions(self):
        """throughput_card_count_per_column reflects the number of cards that
        exited the column within the window."""
        now = timezone.now()
        for _ in range(3):
            card = _make_card(self.board, self.col, self.swim, self.user)
            self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))
            self._movement(card, self.col2, self.swim, now - datetime.timedelta(days=3))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        count = sw["throughput_card_count_per_column"].get(self.col.name, 0)
        self.assertEqual(count, 3)

    def test_throughput_null_when_no_exits_in_window(self):
        """throughput_avg_days_per_column is null for a column where no cards
        exited within the period, and card count is 0."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        # Card entered col 10 days ago and is still there (no exit within window)
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=10))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        # col2 had no exits — throughput should be null, count 0
        self.assertIsNone(sw["throughput_avg_days_per_column"].get(self.col2.name))
        self.assertEqual(sw["throughput_card_count_per_column"].get(self.col2.name, 0), 0)

    def test_backward_compat_avg_days_per_column_still_present(self):
        """avg_days_per_column must remain in the response for backward compat."""
        card = _make_card(self.board, self.col, self.swim, self.user)
        now = timezone.now()
        self._movement(card, self.col, self.swim, now - datetime.timedelta(days=5))

        r = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/?days=30")
        data = r.json()
        sw = next(s for s in data["swimlanes"] if s["id"] == self.swim.id)
        self.assertIn("avg_days_per_column", sw)
        self.assertIn("is_outlier", sw)
        self.assertIn("age_avg_days_per_column", sw)
        self.assertIn("throughput_avg_days_per_column", sw)
        self.assertIn("throughput_card_count_per_column", sw)
        self.assertIn("age_is_outlier", sw)
        self.assertIn("throughput_is_outlier", sw)


# ---------------------------------------------------------------------------
# Site admin board queryset
# ---------------------------------------------------------------------------

class SiteAdminBoardListTests(TestCase):
    def setUp(self):
        self.site_admin = User.objects.create_user(
            username="sa", password="pass", is_site_admin=True
        )
        self.site_admin.can_access_all_content = True
        self.site_admin.save()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, _, _, _ = _make_board(self.owner)
        self.client = APIClient()
        self.client.force_authenticate(self.site_admin)

    def test_site_admin_sees_all_boards(self):
        r = self.client.get("/api/v1/boards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = [b["id"] for b in r.json()["results"]]
        self.assertIn(self.board.id, ids)
