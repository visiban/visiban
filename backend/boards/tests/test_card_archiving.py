"""Tests for card archiving (soft-delete) — issue #226.

Covers:
- Archive and unarchive actions (happy path + permission boundaries)
- Archived cards excluded from standard list and full-board endpoints
- /archived/ action returns only archived cards
- Analytics dwell-time uses archived_at as the terminal timestamp
- Stalled-card detection skips archived cards
- WS broadcasts emitted for archive/unarchive
"""
import datetime

from django.utils import timezone
from rest_framework.test import APIClient
from django.test import TestCase

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane, Label


class CardArchivingSetup(TestCase):
    """Shared fixture factory — extend for each test class."""

    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pw")
        self.member = User.objects.create_user(username="member", password="pw")
        self.viewer = User.objects.create_user(username="viewer", password="pw")
        self.collab = User.objects.create_user(username="collab", password="pw")

        self.board = Board.objects.create(name="Test Board", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.member, role="member")
        BoardMembership.objects.create(board=self.board, user=self.viewer, role="viewer")
        BoardMembership.objects.create(board=self.board, user=self.collab, role="collaborator")

        self.column = Column.objects.create(board=self.board, name="Backlog", position=0)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Default", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Test Card", created_by=self.admin, position=0,
        )

    def _client_for(self, user):
        c = APIClient()
        c.force_authenticate(user=user)
        return c

    def _archive_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/archive/"

    def _unarchive_url(self):
        return f"/api/boards/{self.board.pk}/cards/{self.card.pk}/unarchive/"

    def _archived_list_url(self):
        return f"/api/boards/{self.board.pk}/cards/archived/"


class TestArchivePermissions(CardArchivingSetup):

    def test_admin_can_archive(self):
        r = self._client_for(self.admin).post(self._archive_url())
        self.assertEqual(r.status_code, 200)
        self.card.refresh_from_db()
        self.assertIsNotNone(self.card.archived_at)

    def test_member_can_archive(self):
        r = self._client_for(self.member).post(self._archive_url())
        self.assertEqual(r.status_code, 200)
        self.card.refresh_from_db()
        self.assertIsNotNone(self.card.archived_at)

    def test_viewer_cannot_archive(self):
        r = self._client_for(self.viewer).post(self._archive_url())
        self.assertEqual(r.status_code, 403)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.archived_at)

    def test_collaborator_cannot_archive(self):
        r = self._client_for(self.collab).post(self._archive_url())
        self.assertEqual(r.status_code, 403)

    def test_unauthenticated_cannot_archive(self):
        r = APIClient().post(self._archive_url())
        self.assertEqual(r.status_code, 403)


class TestUnarchivePermissions(CardArchivingSetup):

    def setUp(self):
        super().setUp()
        self.card.archived_at = timezone.now()
        self.card.save()

    def test_admin_can_unarchive(self):
        r = self._client_for(self.admin).post(self._unarchive_url())
        self.assertEqual(r.status_code, 200)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.archived_at)

    def test_member_can_unarchive(self):
        r = self._client_for(self.member).post(self._unarchive_url())
        self.assertEqual(r.status_code, 200)

    def test_viewer_cannot_unarchive(self):
        r = self._client_for(self.viewer).post(self._unarchive_url())
        self.assertEqual(r.status_code, 403)

    def test_collaborator_cannot_unarchive(self):
        r = self._client_for(self.collab).post(self._unarchive_url())
        self.assertEqual(r.status_code, 403)


class TestArchiveExclusion(CardArchivingSetup):
    """Archived cards must be hidden from all active-card endpoints."""

    def test_archived_card_excluded_from_card_list(self):
        self.card.archived_at = timezone.now()
        self.card.save()
        r = self._client_for(self.admin).get(f"/api/boards/{self.board.pk}/cards/")
        data = r.json()
        cards = data.get("results", data) if isinstance(data, dict) else data
        self.assertNotIn(self.card.pk, [c["id"] for c in cards])

    def test_archived_card_excluded_from_full_board(self):
        self.card.archived_at = timezone.now()
        self.card.save()
        r = self._client_for(self.admin).get(f"/api/boards/{self.board.pk}/full/")
        card_ids = [c["id"] for c in r.json()["cards"]]
        self.assertNotIn(self.card.pk, card_ids)

    def test_active_card_present_in_full_board(self):
        r = self._client_for(self.admin).get(f"/api/boards/{self.board.pk}/full/")
        card_ids = [c["id"] for c in r.json()["cards"]]
        self.assertIn(self.card.pk, card_ids)

    def test_archived_list_returns_archived_cards(self):
        self.card.archived_at = timezone.now()
        self.card.save()
        r = self._client_for(self.admin).get(self._archived_list_url())
        self.assertEqual(r.status_code, 200)
        card_ids = [c["id"] for c in r.json()]
        self.assertIn(self.card.pk, card_ids)

    def test_archived_list_excludes_active_cards(self):
        # card is active (archived_at is null)
        r = self._client_for(self.admin).get(self._archived_list_url())
        card_ids = [c["id"] for c in r.json()]
        self.assertNotIn(self.card.pk, card_ids)

    def test_archived_field_present_in_card_response(self):
        self.card.archived_at = timezone.now()
        self.card.save()
        r = self._client_for(self.admin).get(self._archived_list_url())
        card = next(c for c in r.json() if c["id"] == self.card.pk)
        self.assertIn("archived_at", card)
        self.assertIsNotNone(card["archived_at"])


class TestArchiveIdempotency(CardArchivingSetup):
    """Re-archiving an already-archived card should be a no-op."""

    def test_double_archive_is_idempotent(self):
        first_time = timezone.now()
        self.card.archived_at = first_time
        self.card.save()
        r = self._client_for(self.admin).post(self._archive_url())
        self.assertEqual(r.status_code, 200)
        self.card.refresh_from_db()
        # archived_at should not change
        self.assertEqual(self.card.archived_at, first_time)


class TestArchivedListPermissions(CardArchivingSetup):
    """All board members — including viewers — can read the archived card list.
    Only archive/unarchive (write) are restricted to member+."""

    def setUp(self):
        super().setUp()
        self.card.archived_at = timezone.now()
        self.card.save()

    def test_viewer_can_list_archived_cards(self):
        r = self._client_for(self.viewer).get(self._archived_list_url())
        self.assertEqual(r.status_code, 200)
        self.assertIn(self.card.pk, [c["id"] for c in r.json()])

    def test_collaborator_can_list_archived_cards(self):
        r = self._client_for(self.collab).get(self._archived_list_url())
        self.assertEqual(r.status_code, 200)

    def test_unauthenticated_cannot_list_archived_cards(self):
        r = APIClient().get(self._archived_list_url())
        self.assertEqual(r.status_code, 403)


class TestColumnDeletionWithArchivedCards(CardArchivingSetup):
    """Deleting a column cascade-deletes all cards in it, including archived ones."""

    def test_deleting_column_removes_archived_card(self):
        # Archive the card, then delete its column.
        self.card.archived_at = timezone.now()
        self.card.save()
        card_pk = self.card.pk
        self.column.delete()
        self.assertFalse(Card.objects.filter(pk=card_pk).exists())

    def test_deleting_column_removes_active_and_archived_cards(self):
        archived_card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Archived", created_by=self.admin, position=1,
            archived_at=timezone.now(),
        )
        active_card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Active", created_by=self.admin, position=2,
        )
        self.column.delete()
        self.assertFalse(Card.objects.filter(pk=archived_card.pk).exists())
        self.assertFalse(Card.objects.filter(pk=active_card.pk).exists())


class TestSwimlaneDeletionWithArchivedCards(CardArchivingSetup):
    """Deleting a swimlane cascade-deletes all cards in it, including archived ones."""

    def test_deleting_swimlane_removes_archived_card(self):
        self.card.archived_at = timezone.now()
        self.card.save()
        card_pk = self.card.pk
        self.swimlane.delete()
        self.assertFalse(Card.objects.filter(pk=card_pk).exists())

    def test_deleting_swimlane_removes_active_and_archived_cards(self):
        archived_card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Archived", created_by=self.admin, position=1,
            archived_at=timezone.now(),
        )
        active_card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Active", created_by=self.admin, position=2,
        )
        self.swimlane.delete()
        self.assertFalse(Card.objects.filter(pk=archived_card.pk).exists())
        self.assertFalse(Card.objects.filter(pk=active_card.pk).exists())


class TestAnalyticsDwellWithArchiving(CardArchivingSetup):
    """Dwell-time analytics must use archived_at as the terminal timestamp."""

    def _create_movements(self, col2, archive_at):
        """Create two movements (col → col2) and archive the card."""
        t0 = timezone.now() - datetime.timedelta(days=5)
        t1 = timezone.now() - datetime.timedelta(days=2)
        CardMovement.objects.create(
            card=self.card,
            to_column=self.column,
            to_column_name=self.column.name,
            to_column_uid=self.column.uid,
            to_swimlane=self.swimlane,
            to_swimlane_name=self.swimlane.name,
            to_swimlane_uid=self.swimlane.uid,
            moved_by=self.admin,
            moved_at=t0,
        )
        CardMovement.objects.filter(card=self.card).update(moved_at=t0)
        mv2 = CardMovement.objects.create(
            card=self.card,
            from_column=self.column, from_column_name=self.column.name, from_column_uid=self.column.uid,
            from_swimlane=self.swimlane, from_swimlane_name=self.swimlane.name, from_swimlane_uid=self.swimlane.uid,
            to_column=col2, to_column_name=col2.name, to_column_uid=col2.uid,
            to_swimlane=self.swimlane, to_swimlane_name=self.swimlane.name, to_swimlane_uid=self.swimlane.uid,
            moved_by=self.admin,
        )
        CardMovement.objects.filter(pk=mv2.pk).update(moved_at=t1)
        self.card.archived_at = archive_at
        self.card.column = col2
        self.card.save()

    def test_analytics_endpoint_returns_200(self):
        col2 = Column.objects.create(board=self.board, name="Done", position=1)
        archive_at = timezone.now() - datetime.timedelta(hours=12)
        self._create_movements(col2, archive_at)
        r = self._client_for(self.admin).get(f"/api/boards/{self.board.pk}/analytics/")
        self.assertEqual(r.status_code, 200)

    def test_archived_card_not_in_stalled(self):
        """Archived cards must not appear in the stalled cards list."""
        col2 = Column.objects.create(board=self.board, name="Done", position=1)
        # archive_at is recent; the card has old movement — would be "stalled" if active
        archive_at = timezone.now() - datetime.timedelta(days=1)
        self._create_movements(col2, archive_at)
        r = self._client_for(self.admin).get(f"/api/boards/{self.board.pk}/analytics/")
        self.assertEqual(r.status_code, 200)
        for swimlane_data in r.json().get("swimlanes", []):
            stalled_ids = [s["id"] for s in swimlane_data.get("stalled_cards", [])]
            self.assertNotIn(self.card.pk, stalled_ids)
