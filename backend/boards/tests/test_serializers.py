"""Unit tests for CardSerializer and PublicCardSerializer computed fields (#590, #591).

Tests call the serializers directly with minimal ORM fixtures and prefetched
querysets, matching the setup that the viewset builds in production.

Covers CardSerializer (#590):
- is_stale: True when last movement is threshold+1 days ago
- is_stale: False when last movement is threshold-1 days ago
- is_stale: True when card has no movements and created_at is beyond threshold
- last_moved_at returns the timestamp of the most recent movement
- last_moved_at returns None for a card with no movements
- last_moved_at returns the most recent when multiple movements exist
- checklist_done returns count of checked items only (not total)
- checklist_done returns 0 for a card with no checklist items

Covers PublicCardSerializer (#591):
- Stale card returns is_stale: True
- Fresh card returns is_stale: False
- Card with assignee returns correct display_name
- Card with no assignee returns null
- Checklist counts match actual checked/total items
- Sensitive fields (id, created_by PK) are absent from public payload
"""

import datetime

from django.db.models import Prefetch
from django.test import TestCase
from django.utils import timezone

from accounts.models import User
from boards.models import Board, BoardMembership, Card, CardChecklist, CardMovement, Column, Swimlane
from boards.serializers import CardSerializer, PublicCardSerializer


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _make_board(owner, threshold_days=7):
    board = Board.objects.create(
        name="Serializer Test Board", owner=owner,
        staleness_threshold_days=threshold_days,
    )
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


def _make_infrastructure(board, owner):
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return col, swim


def _make_card(board, col, swim, owner, title="Test Card"):
    return Card.objects.create(
        board=board, column=col, swimlane=swim,
        title=title, created_by=owner, position=0,
    )


def _make_movement(card, col, swim, user, days_ago=0):
    """Create a CardMovement and backdate moved_at (auto_now_add prevents direct set)."""
    mv = CardMovement.objects.create(
        card=card,
        from_column=None, from_column_name="",
        to_column=col, to_column_name=col.name,
        from_swimlane=None, from_swimlane_name="",
        to_swimlane=swim, to_swimlane_name=swim.name,
        moved_by=user,
    )
    if days_ago:
        backdated = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=backdated)
        mv.refresh_from_db()
    return mv


def _fresh_card_qs(card):
    """Return a single-card queryset with the same prefetches used by the viewset."""
    return (
        Card.objects.filter(pk=card.pk)
        .select_related("board", "column", "swimlane", "assignee", "created_by")
        .prefetch_related(
            "labels",
            "attachments",
            "checklist_items",
            Prefetch(
                "movements",
                queryset=CardMovement.objects.order_by("-moved_at"),
            ),
        )
    )


def _serialize_card(card, extra_context=None):
    """Serialize a single card via CardSerializer, mirroring viewset context."""
    obj = _fresh_card_qs(card).get()
    ctx = {"board": obj.board}
    if extra_context:
        ctx.update(extra_context)
    return CardSerializer(obj, context=ctx).data


def _serialize_public_card(card):
    """Serialize a single card via PublicCardSerializer, mirroring PublicBoardSerializer.get_cards()."""
    obj = (
        Card.objects.filter(pk=card.pk)
        .select_related("assignee", "board")
        .prefetch_related(
            "labels",
            "checklist_items",
            Prefetch("movements", queryset=CardMovement.objects.order_by("-moved_at")),
        )
        .get()
    )
    return PublicCardSerializer(obj).data


# ---------------------------------------------------------------------------
# CardSerializer — is_stale (#590)
# ---------------------------------------------------------------------------

class CardSerializerIsStaleTests(TestCase):

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board = _make_board(self.owner, threshold_days=7)
        self.col, self.swim = _make_infrastructure(self.board, self.owner)

    def test_is_stale_true_when_last_movement_beyond_threshold(self):
        """is_stale is True when the most recent movement is threshold+1 days old."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        _make_movement(card, self.col, self.swim, self.owner, days_ago=8)  # threshold+1

        data = _serialize_card(card)
        self.assertTrue(data["is_stale"])

    def test_is_stale_false_when_last_movement_within_threshold(self):
        """is_stale is False when the most recent movement is threshold-1 days old."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        _make_movement(card, self.col, self.swim, self.owner, days_ago=6)  # threshold-1

        data = _serialize_card(card)
        self.assertFalse(data["is_stale"])

    def test_is_stale_true_when_no_movements_and_created_beyond_threshold(self):
        """is_stale is True for a never-moved card whose created_at predates the cutoff."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        # Backdate created_at beyond the staleness threshold
        old_time = timezone.now() - datetime.timedelta(days=8)
        Card.objects.filter(pk=card.pk).update(created_at=old_time)

        data = _serialize_card(card)
        self.assertTrue(data["is_stale"])

    def test_is_stale_false_when_no_movements_and_created_within_threshold(self):
        """is_stale is False for a never-moved card created recently."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        # created_at is auto_now_add (i.e. just now) — well within 7 days

        data = _serialize_card(card)
        self.assertFalse(data["is_stale"])


# ---------------------------------------------------------------------------
# CardSerializer — last_moved_at (#590)
# ---------------------------------------------------------------------------

class CardSerializerLastMovedAtTests(TestCase):

    def setUp(self):
        self.owner = User.objects.create_user(username="owner2", password="pass")
        self.board = _make_board(self.owner)
        self.col, self.swim = _make_infrastructure(self.board, self.owner)

    def test_last_moved_at_returns_none_when_no_movements(self):
        """last_moved_at is null for a card that has never been moved."""
        card = _make_card(self.board, self.col, self.swim, self.owner)

        data = _serialize_card(card)
        self.assertIsNone(data["last_moved_at"])

    def test_last_moved_at_returns_correct_timestamp(self):
        """last_moved_at equals moved_at of the single movement.

        The serializer is called directly (not through the HTTP renderer) so
        data["last_moved_at"] is a datetime object, not a string.
        """
        card = _make_card(self.board, self.col, self.swim, self.owner)
        mv = _make_movement(card, self.col, self.swim, self.owner, days_ago=3)

        data = _serialize_card(card)
        self.assertIsNotNone(data["last_moved_at"])
        # The serializer returns a datetime directly (not rendered to JSON string)
        self.assertEqual(data["last_moved_at"], mv.moved_at)

    def test_last_moved_at_returns_most_recent_when_multiple_movements(self):
        """last_moved_at returns the newest movement's timestamp when multiple exist.

        The older movement is 10 days ago; the recent one is 2 days ago.
        last_moved_at must return the 2-day-old timestamp, not the 10-day-old one.
        """
        card = _make_card(self.board, self.col, self.swim, self.owner)
        older = _make_movement(card, self.col, self.swim, self.owner, days_ago=10)
        recent = _make_movement(card, self.col, self.swim, self.owner, days_ago=2)

        data = _serialize_card(card)
        self.assertIsNotNone(data["last_moved_at"])
        # Must return the recent movement's timestamp, not the older one
        self.assertEqual(data["last_moved_at"], recent.moved_at)
        self.assertNotEqual(data["last_moved_at"], older.moved_at)


# ---------------------------------------------------------------------------
# CardSerializer — checklist_done (#590)
# ---------------------------------------------------------------------------

class CardSerializerChecklistTests(TestCase):

    def setUp(self):
        self.owner = User.objects.create_user(username="owner3", password="pass")
        self.board = _make_board(self.owner)
        self.col, self.swim = _make_infrastructure(self.board, self.owner)

    def test_checklist_done_returns_zero_when_no_items(self):
        """checklist_done is 0 for a card with no checklist items."""
        card = _make_card(self.board, self.col, self.swim, self.owner)

        data = _serialize_card(card)
        self.assertEqual(data["checklist_done"], 0)
        self.assertEqual(data["checklist_total"], 0)

    def test_checklist_done_counts_only_checked_items(self):
        """checklist_done counts is_checked=True items only; total includes all items."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        CardChecklist.objects.create(card=card, text="done", is_checked=True, position=0)
        CardChecklist.objects.create(card=card, text="done too", is_checked=True, position=1)
        CardChecklist.objects.create(card=card, text="not done", is_checked=False, position=2)

        data = _serialize_card(card)
        self.assertEqual(data["checklist_done"], 2)
        self.assertEqual(data["checklist_total"], 3)

    def test_checklist_done_all_unchecked_returns_zero(self):
        """checklist_done is 0 when all items are unchecked."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        CardChecklist.objects.create(card=card, text="a", is_checked=False, position=0)
        CardChecklist.objects.create(card=card, text="b", is_checked=False, position=1)

        data = _serialize_card(card)
        self.assertEqual(data["checklist_done"], 0)
        self.assertEqual(data["checklist_total"], 2)


# ---------------------------------------------------------------------------
# PublicCardSerializer (#591)
# ---------------------------------------------------------------------------

class PublicCardSerializerTests(TestCase):

    def setUp(self):
        self.owner = User.objects.create_user(
            username="pub_owner", password="pass", display_name="Pub Owner",
        )
        self.board = _make_board(self.owner, threshold_days=7)
        self.col, self.swim = _make_infrastructure(self.board, self.owner)

    def test_stale_card_returns_is_stale_true(self):
        """PublicCardSerializer returns is_stale=True when last movement exceeds threshold."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        _make_movement(card, self.col, self.swim, self.owner, days_ago=8)

        data = _serialize_public_card(card)
        self.assertTrue(data["is_stale"])

    def test_fresh_card_returns_is_stale_false(self):
        """PublicCardSerializer returns is_stale=False when card moved recently."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        _make_movement(card, self.col, self.swim, self.owner, days_ago=2)

        data = _serialize_public_card(card)
        self.assertFalse(data["is_stale"])

    def test_card_with_assignee_returns_display_name(self):
        """PublicCardSerializer returns assignee.display_name when an assignee is set."""
        assignee = User.objects.create_user(
            username="assigned_user", password="pass", display_name="Alex Designer",
        )
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        card = _make_card(self.board, self.col, self.swim, self.owner)
        card.assignee = assignee
        card.save(update_fields=["assignee"])

        data = _serialize_public_card(card)
        self.assertIsNotNone(data["assignee"])
        self.assertEqual(data["assignee"]["display_name"], "Alex Designer")

    def test_card_with_no_assignee_returns_null(self):
        """PublicCardSerializer returns null for assignee when the card has no assignee."""
        card = _make_card(self.board, self.col, self.swim, self.owner)

        data = _serialize_public_card(card)
        self.assertIsNone(data["assignee"])

    def test_checklist_counts_match_actual_items(self):
        """checklist_done and checklist_total reflect the real state of checklist items."""
        card = _make_card(self.board, self.col, self.swim, self.owner)
        CardChecklist.objects.create(card=card, text="item 1", is_checked=True, position=0)
        CardChecklist.objects.create(card=card, text="item 2", is_checked=True, position=1)
        CardChecklist.objects.create(card=card, text="item 3", is_checked=False, position=2)
        CardChecklist.objects.create(card=card, text="item 4", is_checked=False, position=3)

        data = _serialize_public_card(card)
        self.assertEqual(data["checklist_done"], 2)
        self.assertEqual(data["checklist_total"], 4)

    def test_sensitive_fields_absent_from_public_payload(self):
        """PublicCardSerializer must not expose id, created_by, or version."""
        card = _make_card(self.board, self.col, self.swim, self.owner)

        data = _serialize_public_card(card)
        # Internal primary key must not be present
        self.assertNotIn("id", data)
        # The user who created the card must not be exposed
        self.assertNotIn("created_by", data)
        # Internal version counter must not be exposed
        self.assertNotIn("version", data)
        # Archived timestamp is an internal field
        self.assertNotIn("archived_at", data)

    def test_assignee_does_not_expose_email_or_pk(self):
        """The public assignee representation must not include email or numeric PK."""
        assignee = User.objects.create_user(
            username="priv_user", password="pass",
            email="private@example.com", display_name="Private Person",
        )
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        card = _make_card(self.board, self.col, self.swim, self.owner)
        card.assignee = assignee
        card.save(update_fields=["assignee"])

        data = _serialize_public_card(card)
        assignee_data = data["assignee"]
        self.assertNotIn("email", assignee_data)
        self.assertNotIn("id", assignee_data)
        self.assertNotIn("username", assignee_data)
        self.assertIn("display_name", assignee_data)
