"""#1226: dotted-source ``CharField(default=None)`` fields converted to
``SerializerMethodField`` so DRF's ``SkipField``-under-``partial=True`` trap
(#1166/#1225) cannot silently drop them. None of these serializers is bound
``partial=True`` by a live call site today, so each test binds one directly
and asserts the key survives for both the null and non-null related object.
"""
from django.test import TestCase

from accounts.models import User
from boards.models import Board, Card, Column, Notification, Swimlane
from boards.views.notifications import NotificationSerializer
from groups.models import Group, GroupInviteLink
from groups.serializers import GroupBriefSerializer, GroupInviteLinkSerializer


class DottedSourcePartialBindTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u1226", password="pass")

    def test_group_brief_parent_name_partial(self):
        root = Group.objects.create(name="Root", owner=self.user)
        child = Group.objects.create(name="Child", owner=self.user, parent=root)
        for group, expected in ((root, None), (child, "Root")):
            data = GroupBriefSerializer(group, partial=True).data
            self.assertIn("parent_name", data)
            self.assertEqual(data["parent_name"], expected)

    def test_invite_link_created_by_username_partial(self):
        group = Group.objects.create(name="G", owner=self.user)
        for i, (fields, expected) in enumerate(
            (({"created_by": self.user}, "u1226"), ({}, None))
        ):
            link = GroupInviteLink.objects.create(
                group=group, name="n", token_hash=f"h{i}", **fields
            )
            data = GroupInviteLinkSerializer(link, partial=True).data
            self.assertIn("created_by_username", data)
            self.assertEqual(data["created_by_username"], expected)

    def test_notification_card_title_board_name_partial(self):
        board = Board.objects.create(name="B", owner=self.user)
        col = Column.objects.create(board=board, name="C", position=0)
        swim = Swimlane.objects.create(board=board, name="S", position=0)
        card = Card.objects.create(board=board, column=col, swimlane=swim, title="T")
        full = Notification.objects.create(
            recipient=self.user, verb="v", card=card, board=board,
        )
        bare = Notification.objects.create(recipient=self.user, verb="v")
        data = NotificationSerializer(full, partial=True).data
        self.assertEqual((data["card_title"], data["board_name"]), ("T", "B"))
        data = NotificationSerializer(bare, partial=True).data
        self.assertIn("card_title", data)
        self.assertIn("board_name", data)
        self.assertIsNone(data["card_title"])
        self.assertIsNone(data["board_name"])
