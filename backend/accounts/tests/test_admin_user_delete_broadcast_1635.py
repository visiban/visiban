"""Django admin user delete announces what it changed to connected clients (#1635).

Deleting a user clears ``Card.created_by`` / ``Card.assignee`` (SET_NULL) and
cascades the user's board and group memberships. The delete view and the
``delete_selected`` action must publish, after commit:

- ``card.updated`` for each card whose creator or assignee was cleared, on the
  card's board, rendered after the clear;
- ``member.removed`` on every board the user was a member of, directly or
  through a group (or one of its ancestors);
- ``member.removed`` on the group channel of each group the user belonged to.

A refused delete announces nothing.
"""
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.urls import reverse

from accounts.models import User
from django.core.files.base import ContentFile

from boards.models import (
    Board,
    BoardEvent,
    BoardMembership,
    Card,
    CardAttachment,
    CardBlock,
    CardChecklist,
    CardComment,
    CardRelation,
    Column,
    Swimlane,
)
from groups.models import Group, GroupMembership

PW = "pw123456!x"

_PLAIN_STATIC = override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)


@_PLAIN_STATIC
class UserDeleteBroadcastTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_superuser(
            username="actor_1635", password=PW, email="actor_1635@example.com"
        )
        self.client.force_login(self.actor)
        self.owner = User.objects.create_user(username="owner_1635", password=PW)
        self.victim = User.objects.create_user(username="victim_1635", password=PW)
        self.other = User.objects.create_user(username="other_1635", password=PW)

        # A personal board the victim is a direct member of.
        self.board = Board.objects.create(name="Direct", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role="admin")
        BoardMembership.objects.create(board=self.board, user=self.victim, role="member")
        column = Column.objects.create(board=self.board, name="To do", position=0)
        swimlane = Swimlane.objects.create(board=self.board, name="Lane", position=0)

        def card(title, **kw):
            return Card.objects.create(
                board=self.board, column=column, swimlane=swimlane, title=title,
                position=Card.objects.filter(board=self.board).count(), **kw,
            )

        self.assigned = card("Assigned", created_by=self.owner, assignee=self.victim)
        self.created = card("Created", created_by=self.victim)
        self.unrelated = card("Unrelated", created_by=self.owner, assignee=self.other)

        # Group access: the victim belongs to the parent group, so it sees the
        # parent's board and the subgroup's board without a board membership.
        self.group = Group.objects.create(name="Parent", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.owner, role="admin")
        GroupMembership.objects.create(group=self.group, user=self.victim, role="member")
        self.subgroup = Group.objects.create(name="Child", owner=self.owner, parent=self.group)
        self.group_board = Board.objects.create(name="In parent", owner=self.owner, group=self.group)
        self.sub_board = Board.objects.create(name="In child", owner=self.owner, group=self.subgroup)
        # A board in an unrelated group gets nothing.
        unrelated_group = Group.objects.create(name="Unrelated", owner=self.owner)
        self.unrelated_board = Board.objects.create(
            name="Elsewhere", owner=self.owner, group=unrelated_group
        )

        self.changelist = reverse("admin:accounts_user_changelist")

    def _delete(self, post):
        with patch("boards.broadcast.broadcast_board_event") as board_send, \
             patch("groups.broadcast.broadcast_group_event") as group_send:
            with self.captureOnCommitCallbacks(execute=True):
                post()
        board_frames = [(c.args[0], c.args[1], c.args[2]) for c in board_send.call_args_list]
        group_frames = [(c.args[0], c.args[1], c.args[2]) for c in group_send.call_args_list]
        for call in board_send.call_args_list + group_send.call_args_list:
            self.assertEqual(call.kwargs.get("actor_id"), self.actor.pk)
        return board_frames, group_frames

    def _delete_one(self, user):
        url = reverse("admin:accounts_user_delete", args=[user.pk])
        return self._delete(lambda: self.client.post(url, {"post": "yes"}))

    def _delete_bulk(self, users):
        data = {
            "action": "delete_selected",
            "_selected_action": [u.pk for u in users],
            "post": "yes",
        }
        return self._delete(lambda: self.client.post(self.changelist, data))

    def _assert_victim_frames(self, board_frames, group_frames, uid):
        card_frames = {
            payload["id"]: (board_id, payload)
            for board_id, event, payload in board_frames if event == "card.updated"
        }
        self.assertEqual(set(card_frames), {self.assigned.pk, self.created.pk})
        for board_id, payload in card_frames.values():
            self.assertEqual(board_id, self.board.pk)
        # Rendered after the clear, not from the pre-delete rows.
        self.assertIsNone(card_frames[self.assigned.pk][1]["assignee"])
        self.assertEqual(card_frames[self.assigned.pk][1]["created_by"]["id"], self.owner.pk)
        self.assertIsNone(card_frames[self.created.pk][1]["created_by"])

        removed = {
            board_id for board_id, event, payload in board_frames
            if event == "member.removed" and payload == {"user_id": uid}
        }
        self.assertEqual(removed, {self.board.pk, self.group_board.pk, self.sub_board.pk})
        self.assertIn((self.group.pk, "member.removed", {"user_id": uid}), group_frames)

    def test_single_delete_announces_cleared_cards_and_removed_memberships(self):
        board_frames, group_frames = self._delete_one(self.victim)
        self.assertFalse(User.objects.filter(pk=self.victim.pk).exists())
        self._assert_victim_frames(board_frames, group_frames, self.victim.pk)
        self.assertEqual(len(board_frames), 5)
        self.assertEqual(group_frames, [(self.group.pk, "member.removed", {"user_id": self.victim.pk})])
        # The board frames carry change-feed rows, committed with the delete.
        self.assertEqual(
            BoardEvent.objects.filter(board_id=self.board.pk, event="card.updated").count(), 2
        )
        self.assertEqual(
            BoardEvent.objects.filter(board_id=self.sub_board.pk, event="member.removed").count(), 1
        )

    def test_bulk_delete_announces_every_target(self):
        BoardMembership.objects.create(board=self.board, user=self.other, role="member")
        board_frames, group_frames = self._delete_bulk([self.victim, self.other])
        self.assertFalse(User.objects.filter(pk__in=[self.victim.pk, self.other.pk]).exists())
        # Unrelated is now announced too: its assignee (``other``) was cleared.
        card_ids = [p["id"] for _, e, p in board_frames if e == "card.updated"]
        self.assertEqual(sorted(card_ids), sorted([self.assigned.pk, self.created.pk, self.unrelated.pk]))
        unrelated_payload = next(p for _, e, p in board_frames if e == "card.updated" and p["id"] == self.unrelated.pk)
        self.assertIsNone(unrelated_payload["assignee"])
        self.assertIn((self.board.pk, "member.removed", {"user_id": self.other.pk}), board_frames)
        self.assertIn((self.board.pk, "member.removed", {"user_id": self.victim.pk}), board_frames)
        self.assertEqual(group_frames, [(self.group.pk, "member.removed", {"user_id": self.victim.pk})])

    def test_user_with_no_cards_or_memberships_announces_nothing(self):
        loner = User.objects.create_user(username="loner_1635", password=PW)
        board_frames, group_frames = self._delete_one(loner)
        self.assertFalse(User.objects.filter(pk=loner.pk).exists())
        self.assertEqual(board_frames, [])
        self.assertEqual(group_frames, [])

    def test_refused_delete_announces_nothing(self):
        # A board owner cannot be deleted; nothing is deleted and nothing sent.
        Board.objects.create(name="Victim's own", owner=self.victim)
        board_frames, group_frames = self._delete_one(self.victim)
        self.assertTrue(User.objects.filter(pk=self.victim.pk).exists())
        self.assertEqual(board_frames, [])
        self.assertEqual(group_frames, [])

    def test_refused_bulk_delete_announces_nothing(self):
        Board.objects.create(name="Other's own", owner=self.other)
        board_frames, group_frames = self._delete_bulk([self.victim, self.other])
        self.assertTrue(User.objects.filter(pk=self.victim.pk).exists())
        self.assertEqual(board_frames, [])
        self.assertEqual(group_frames, [])
        self.assertEqual(Card.objects.get(pk=self.assigned.pk).assignee_id, self.victim.pk)


    def _reference_only_cards(self):
        """Cards the victim neither created nor is assigned to, but is named on."""
        column = Column.objects.get(board=self.board)
        swimlane = Swimlane.objects.get(board=self.board)

        def card(title):
            return Card.objects.create(
                board=self.board, column=column, swimlane=swimlane, title=title,
                position=100 + Card.objects.filter(board=self.board).count(),
                created_by=self.owner,
            )

        commented = card("Commented")
        CardComment.objects.create(card=commented, author=self.victim, body="hi")
        uploaded = card("Uploaded")
        CardAttachment.objects.create(
            card=uploaded, file=ContentFile(b"x", name="f.txt"), filename="f.txt",
            size=1, uploaded_by=self.victim,
        )
        checklist = card("Checklist")
        CardChecklist.objects.create(card=checklist, text="item", created_by=self.victim)
        # A relation the victim made to a card already announced (``assigned``),
        # so only the relation's own card adds a frame.
        related = card("Related")
        CardRelation.objects.create(
            from_card=related, to_card=self.assigned,
            relation_type=CardRelation.Type.BLOCKS, created_by=self.victim,
        )
        blocked = card("Blocked")
        CardBlock.objects.create(card=blocked, board=self.board, blocked_by=self.victim, reason="wait")
        return commented, uploaded, checklist, related, blocked

    def _assert_reference_frames(self, board_frames, cards):
        for c in cards:
            frames = [p for b, e, p in board_frames if e == "card.updated" and p["id"] == c.pk]
            self.assertEqual(len(frames), 1, c.title)
        # The delete cleared the references the frames were sent for.
        self.assertEqual(CardComment.objects.get(card=cards[0]).author_id, None)
        self.assertIsNone(CardRelation.objects.get(from_card=cards[3]).created_by_id)
        self.assertIsNone(CardBlock.objects.get(card=cards[4]).blocked_by_id)

    def test_single_delete_announces_cards_only_referenced_by_a_comment_upload_checklist_relation_or_block(self):
        cards = self._reference_only_cards()
        # A card in both sets (created and commented on) still gets one frame.
        CardComment.objects.create(card=self.created, author=self.victim, body="also")
        board_frames, _ = self._delete_one(self.victim)
        self._assert_reference_frames(board_frames, cards)
        both = [p for b, e, p in board_frames if e == "card.updated" and p["id"] == self.created.pk]
        self.assertEqual(len(both), 1)
        self.assertIsNone(both[0]["created_by"])
        self.assertEqual(
            sorted(p["id"] for b, e, p in board_frames if e == "card.updated"),
            sorted([self.assigned.pk, self.created.pk] + [c.pk for c in cards]),
        )

    def test_bulk_delete_announces_cards_only_referenced_by_a_comment_upload_checklist_relation_or_block(self):
        cards = self._reference_only_cards()
        CardComment.objects.create(card=self.created, author=self.victim, body="also")
        board_frames, _ = self._delete_bulk([self.victim, self.other])
        self._assert_reference_frames(board_frames, cards)
        ids = [p["id"] for b, e, p in board_frames if e == "card.updated"]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn(self.created.pk, ids)
