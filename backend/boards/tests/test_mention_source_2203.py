"""``Notification.mention_source`` records where a mention lives (#2203).

A comment mention and a description mention used to create identical
MENTIONED rows, so a link could not name the tab that holds the mention. Both
paths now stamp the source; only a comment mention's link adds
``&tab=comments``, and a row with no source (written before 1.3) stays
tab-less.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Notification, Swimlane
from boards.notifications_email import card_link

MENTIONED = Notification.ActionType.MENTIONED


def _make_board(owner):
    board = Board.objects.create(name="Source Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class MentionSourceRecordedTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="src_owner", password="pass")
        self.alice = User.objects.create_user(username="alice", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        BoardMembership.objects.create(board=self.board, user=self.alice, role=BoardMembership.Role.MEMBER)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Source card", created_by=self.owner, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _alice_mention(self):
        return Notification.objects.get(recipient=self.alice, action_type=MENTIONED)

    @patch("boards.broadcast.broadcast_board_event")
    def test_comment_mention_is_recorded_as_comment(self, _):
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": "@alice can you look?"},
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(self._alice_mention().mention_source, Notification.MentionSource.COMMENT)

    def test_description_edit_mention_is_recorded_as_description(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"description": "@alice please review"}, format="json",
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(self._alice_mention().mention_source, Notification.MentionSource.DESCRIPTION)

    def test_new_card_description_mention_is_recorded_as_description(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {
                    "title": "New", "description": "Hey @alice", "column": self.col.pk,
                    "swimlane": self.swim.pk, "priority": "medium",
                },
                format="json",
            )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(self._alice_mention().mention_source, Notification.MentionSource.DESCRIPTION)

    def test_other_action_types_have_no_source(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"assignee_id": self.alice.pk}, format="json",
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        assigned = Notification.objects.filter(recipient=self.alice).exclude(action_type=MENTIONED)
        self.assertTrue(assigned.exists())
        self.assertFalse(assigned.exclude(mention_source=None).exists())

    def test_serializer_exposes_mention_source(self):
        Notification.objects.create(
            recipient=self.alice, actor=self.owner, action_type=MENTIONED, verb="c",
            card=self.card, board=self.board, mention_source=Notification.MentionSource.COMMENT,
        )
        Notification.objects.create(
            recipient=self.alice, actor=self.owner, action_type=MENTIONED, verb="legacy",
            card=self.card, board=self.board,
        )
        self.client.force_authenticate(self.alice)
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        by_verb = {row["verb"]: row for row in resp.data}
        self.assertEqual(by_verb["c"]["mention_source"], "comment")
        # Key present (not omitted) and null for a pre-1.3 row.
        self.assertIn("mention_source", by_verb["legacy"])
        self.assertIsNone(by_verb["legacy"]["mention_source"])


class MentionSourceLinkTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="link2203_owner", password="pass")
        self.recipient = User.objects.create_user(username="link2203_recipient", password="pass")
        self.board, self.col, self.swim = _make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Link card", created_by=self.owner, position=0,
        )
        self.base = f"/boards/{self.board.pk}?card={self.card.pk}"

    def _notification(self, action_type=MENTIONED, source=None):
        return Notification(
            recipient=self.recipient, actor=self.owner, action_type=action_type,
            verb="Link card", card=self.card, board=self.board, mention_source=source,
        )

    def test_comment_mention_opens_comments_tab(self):
        link = card_link(self._notification(source=Notification.MentionSource.COMMENT))
        self.assertTrue(link.endswith(self.base + "&tab=comments"), link)

    def test_description_mention_stays_tab_less(self):
        link = card_link(self._notification(source=Notification.MentionSource.DESCRIPTION))
        self.assertTrue(link.endswith(self.base), link)
        self.assertNotIn("tab=", link)

    def test_legacy_mention_without_source_stays_tab_less(self):
        """Absent input: a pre-1.3 row has no source, and gets no tab."""
        link = card_link(self._notification(source=None))
        self.assertTrue(link.endswith(self.base), link)
        self.assertNotIn("tab=", link)

    def test_source_on_another_action_type_adds_no_tab(self):
        """Only MENTIONED rows read the source, whatever else a row carries."""
        link = card_link(self._notification(
            action_type=Notification.ActionType.COMMENT_ADDED, source=Notification.MentionSource.COMMENT,
        ))
        self.assertNotIn("tab=", link)
