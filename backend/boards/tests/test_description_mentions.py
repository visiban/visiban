"""Tests for @mention notifications in card descriptions.

Covers:
- extract_mentions utility
- notify_new_mentions utility (new mentions, re-notification guard, non-members skipped)
- Card create API: description mentions fire notifications
- Card update API: only newly added mentions fire; re-notification guard blocks duplicates
- Card update API: actor is never notified about their own mention
"""

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, Notification
from boards.utils import extract_mentions, notify_new_mentions


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


# ---------------------------------------------------------------------------
# Unit: extract_mentions
# ---------------------------------------------------------------------------

class ExtractMentionsTests(TestCase):
    def test_single_mention(self):
        self.assertEqual(extract_mentions("Hello @alice"), {"alice"})

    def test_multiple_mentions(self):
        self.assertEqual(extract_mentions("cc @alice and @bob"), {"alice", "bob"})

    def test_no_mentions(self):
        self.assertEqual(extract_mentions("No mentions here"), set())

    def test_duplicate_mentions_deduplicated(self):
        self.assertEqual(extract_mentions("@alice @alice again"), {"alice"})

    def test_ignores_email_style_at(self):
        # email@example.com should not contribute @example as a mention
        self.assertEqual(extract_mentions("email@example.com and @valid"), {"valid"})

    def test_empty_string(self):
        self.assertEqual(extract_mentions(""), set())


# ---------------------------------------------------------------------------
# Unit: notify_new_mentions
# ---------------------------------------------------------------------------

@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class NotifyNewMentionsTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.bob = User.objects.create_user(username="bob", password="pass")
        self.outsider = User.objects.create_user(username="outsider", password="pass")

        self.board, self.col, self.swim = make_board(self.owner)
        BoardMembership.objects.create(board=self.board, user=self.alice, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.bob, role=BoardMembership.Role.MEMBER)

        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="My Card",
            created_by=self.owner,
            position=0,
        )

    def test_new_mention_creates_notification(self):
        notify_new_mentions(self.card, self.owner, "", "@alice check this")
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.alice,
                action_type=Notification.ActionType.MENTIONED,
            ).count(),
            1,
        )

    def test_actor_does_not_receive_own_mention_notification(self):
        notify_new_mentions(self.card, self.alice, "", "@alice reminder for myself")
        self.assertEqual(
            Notification.objects.filter(recipient=self.alice, action_type=Notification.ActionType.MENTIONED).count(),
            0,
        )

    def test_non_member_not_notified(self):
        notify_new_mentions(self.card, self.owner, "", "@outsider hello")
        self.assertEqual(
            Notification.objects.filter(recipient=self.outsider, action_type=Notification.ActionType.MENTIONED).count(),
            0,
        )

    def test_no_notification_when_mention_not_new(self):
        """Mention already present in old text — not newly added — no notification."""
        notify_new_mentions(self.card, self.owner, "@alice existing", "@alice existing plus text")
        self.assertEqual(
            Notification.objects.filter(recipient=self.alice, action_type=Notification.ActionType.MENTIONED).count(),
            0,
        )

    def test_re_notification_guard_blocks_second_notification(self):
        """Once alice is in mentioned_user_ids, a second edit doesn't re-notify."""
        notify_new_mentions(self.card, self.owner, "", "@alice first mention")
        # Simulate description going blank then re-mentioning alice
        self.card.refresh_from_db()
        notify_new_mentions(self.card, self.owner, "", "@alice second mention")
        self.assertEqual(
            Notification.objects.filter(recipient=self.alice, action_type=Notification.ActionType.MENTIONED).count(),
            1,
        )

    def test_mentioned_user_ids_updated_after_notification(self):
        notify_new_mentions(self.card, self.owner, "", "@alice look here")
        self.card.refresh_from_db()
        self.assertIn(self.alice.pk, self.card.mentioned_user_ids)

    def test_multiple_recipients_in_one_call(self):
        notify_new_mentions(self.card, self.owner, "", "@alice and @bob review this")
        recipients = set(
            Notification.objects.filter(action_type=Notification.ActionType.MENTIONED)
            .values_list("recipient_id", flat=True)
        )
        self.assertIn(self.alice.pk, recipients)
        self.assertIn(self.bob.pk, recipients)

    def test_no_op_when_no_mentions(self):
        notify_new_mentions(self.card, self.owner, "", "no mentions here")
        self.assertEqual(Notification.objects.count(), 0)


# ---------------------------------------------------------------------------
# Integration: card create API fires description mention notifications
# ---------------------------------------------------------------------------

@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class CardCreateDescriptionMentionTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)
        BoardMembership.objects.create(board=self.board, user=self.alice, role=BoardMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_create_card_with_mention_notifies_member(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {
                    "title": "New Card",
                    "description": "Hey @alice please review",
                    "column": self.col.pk,
                    "swimlane": self.swim.pk,
                    "priority": "medium",
                },
                format="json",
            )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.alice,
                action_type=Notification.ActionType.MENTIONED,
            ).count(),
            1,
        )

    def test_create_card_no_description_no_notification(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {
                    "title": "Empty Description",
                    "column": self.col.pk,
                    "swimlane": self.swim.pk,
                    "priority": "medium",
                },
                format="json",
            )
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(Notification.objects.filter(action_type=Notification.ActionType.MENTIONED).count(), 0)


# ---------------------------------------------------------------------------
# Integration: card update API — description mention diff and guard
# ---------------------------------------------------------------------------

@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class CardUpdateDescriptionMentionTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.bob = User.objects.create_user(username="bob", password="pass")
        self.board, self.col, self.swim = make_board(self.owner)
        BoardMembership.objects.create(board=self.board, user=self.alice, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.bob, role=BoardMembership.Role.MEMBER)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col,
            swimlane=self.swim,
            title="Update Card",
            description="",
            created_by=self.owner,
            position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _patch(self, data):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                data,
                format="json",
            )
        return resp

    def test_adding_mention_notifies_member(self):
        resp = self._patch({"description": "@alice please review"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.alice,
                action_type=Notification.ActionType.MENTIONED,
            ).count(),
            1,
        )

    def test_re_notification_guard_via_api(self):
        """Updating description twice with same mention only fires one notification."""
        self._patch({"description": "@alice first"})
        self.card.refresh_from_db()
        self._patch({"description": "@alice second edit"})
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.alice,
                action_type=Notification.ActionType.MENTIONED,
            ).count(),
            1,
        )

    def test_adding_new_mention_after_existing_notifies_only_new(self):
        """After alice is already notified, adding @bob notifies bob but not alice again."""
        self._patch({"description": "@alice review"})
        self.card.refresh_from_db()
        self._patch({"description": "@alice review and @bob too"})
        alice_notifs = Notification.objects.filter(
            recipient=self.alice, action_type=Notification.ActionType.MENTIONED
        ).count()
        bob_notifs = Notification.objects.filter(
            recipient=self.bob, action_type=Notification.ActionType.MENTIONED
        ).count()
        self.assertEqual(alice_notifs, 1)
        self.assertEqual(bob_notifs, 1)

    def test_description_unchanged_no_notification(self):
        self.card.description = "@alice existing"
        self.card.save()
        # Patch something else — description not in payload
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"title": "New Title"},
                format="json",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(Notification.objects.filter(action_type=Notification.ActionType.MENTIONED).count(), 0)
