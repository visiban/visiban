import datetime
from unittest.mock import patch

from django.core import mail
from django.core.management import call_command
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardMovement, Notification
from boards.services.notifications import card_watcher_ids, quoted_card_verb
from boards.signals import post_notification_created


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col_a = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col_b = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col_a, col_b, swim


class StaleCardNotificationTests(TestCase):
    def setUp(self):
        # notif_stale=True — stale-card notifications respect this preference.
        # (It was notif_due_soon before #356 split the two events apart.)
        self.owner = User.objects.create_user(username="owner", password="pass", notif_stale=True)
        self.board, self.col_a, self.col_b, self.swim = make_board(self.owner)
        self.threshold = self.board.staleness_threshold_days

    def _make_card(self, title="Stale Card", assignee=None):
        return Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title=title,
            created_by=self.owner,
            position=0,
            assignee=assignee,
        )

    def _make_stale_movement(self, card, days_ago):
        """Create a movement then backdate moved_at since it's auto_now_add."""
        mv = CardMovement.objects.create(
            card=card,
            from_column=None,
            from_swimlane=None,
            to_column=self.col_a,
            to_swimlane=self.swim,
            moved_by=self.owner,
        )
        stale_time = timezone.now() - datetime.timedelta(days=days_ago)
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=stale_time)
        return mv

    def test_stale_card_creates_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_fresh_card_does_not_create_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(Notification.objects.filter(card=card).count(), 0)

    def test_stale_card_notifies_assignee(self):
        assignee = User.objects.create_user(username="assignee", password="pass", notif_stale=True)
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        card = self._make_card(assignee=assignee)
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)

        self.assertTrue(
            Notification.objects.filter(card=card, recipient=assignee).exists()
        )

    def test_idempotency_run_twice_creates_one_notification(self):
        card = self._make_card()
        self._make_stale_movement(card, days_ago=self.threshold + 1)

        call_command("notify_stale_cards", verbosity=0)
        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )

    def test_no_movement_stale_card_creates_notification(self):
        """Card created beyond threshold with no movements should trigger notification."""
        card = self._make_card()
        stale_time = timezone.now() - datetime.timedelta(days=self.threshold + 2)
        Card.objects.filter(pk=card.pk).update(created_at=stale_time)

        call_command("notify_stale_cards", verbosity=0)

        self.assertEqual(
            Notification.objects.filter(card=card, recipient=self.owner).count(), 1
        )


class NotificationListViewTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="viewer", password="pass")
        self.client.force_authenticate(self.user)
        self.board, self.col_a, _, self.swim = make_board(self.user)

    def test_list_excludes_read_notifications(self):
        Notification.objects.create(
            recipient=self.user, verb="unread notification", board=self.board, read=False,
            action_type=Notification.ActionType.STALE,
        )
        Notification.objects.create(
            recipient=self.user, verb="read notification", board=self.board, read=True,
            action_type=Notification.ActionType.STALE,
        )

        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        verbs = [n["verb"] for n in resp.data]
        self.assertIn("unread notification", verbs)
        self.assertNotIn("read notification", verbs)

    def test_list_includes_action_type_for_board_invite(self):
        Notification.objects.create(
            recipient=self.user,
            verb="You were added to Test Board",
            board=self.board,
            action_type=Notification.ActionType.BOARD_INVITE,
            read=False,
        )

        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["action_type"], "board_invite")

    def test_list_includes_action_type_for_card_notifications(self):
        card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title="Test Card",
            created_by=self.user,
            position=0,
        )
        Notification.objects.create(
            recipient=self.user,
            verb="You were assigned to Test Card",
            board=self.board,
            card=card,
            action_type=Notification.ActionType.ASSIGNED,
            read=False,
        )

        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["action_type"], "assigned")

    def test_list_reports_null_actor_for_system_generated_notification(self):
        """#1192: actor is a SET_NULL FK — a system-generated notification (e.g.
        stale-card alerts, created with actor=None) must serialize with
        `actor: null` rather than omitting the field or erroring."""
        Notification.objects.create(
            recipient=self.user, verb="Card went stale", board=self.board, read=False,
            action_type=Notification.ActionType.STALE, actor=None,
        )

        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertIsNone(resp.data[0]["actor"])

    def test_mark_all_read_then_list_is_empty(self):
        Notification.objects.create(
            recipient=self.user, verb="will be read", board=self.board, read=False,
            action_type=Notification.ActionType.STALE,
        )

        self.client.post("/api/v1/notifications/mark-read/", {"all": True})
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 0)


class NotificationAccessAfterRemovalTests(TestCase):
    """Notifications referencing a board the user has lost access to must
    not surface card_title / board_name on subsequent reads (#987).
    """

    def setUp(self):
        self.client = APIClient()
        # ``viewer`` was the recipient when the notification was created;
        # ``other`` keeps owning the board so the board itself remains.
        self.viewer = User.objects.create_user(username="ex_viewer", password="pass")
        self.other = User.objects.create_user(username="board_owner", password="pass")
        self.board, self.col, _, self.swim = make_board(self.other)
        # Add the viewer as a member so a notification is legitimately created
        # while they have access.
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Pre-removal Card", created_by=self.other, position=0,
        )
        self.notification = Notification.objects.create(
            recipient=self.viewer,
            verb="You were assigned to Pre-removal Card",
            board=self.board,
            card=self.card,
            action_type=Notification.ActionType.ASSIGNED,
            read=False,
        )

    def test_notification_visible_while_member(self):
        self.client.force_authenticate(self.viewer)
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["board_name"], "Test Board")
        self.assertEqual(resp.data[0]["card_title"], "Pre-removal Card")

    def test_notification_filtered_after_removal(self):
        BoardMembership.objects.filter(board=self.board, user=self.viewer).delete()
        self.client.force_authenticate(self.viewer)
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            len(resp.data), 0,
            "Notification for a board the user no longer has access to must "
            "be filtered from the list response (#987).",
        )

    def test_unread_count_filtered_after_removal(self):
        BoardMembership.objects.filter(board=self.board, user=self.viewer).delete()
        self.client.force_authenticate(self.viewer)
        resp = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.data["count"], 0,
            "unread-count must match the list endpoint after access loss (#987).",
        )

    def test_global_notification_without_board_passes_through(self):
        """Notifications with no board attached (e.g. account-level) are not affected."""
        Notification.objects.create(
            recipient=self.viewer,
            verb="account verified",
            action_type=Notification.ActionType.STALE,
            read=False,
            # board left null
        )
        BoardMembership.objects.filter(board=self.board, user=self.viewer).delete()
        self.client.force_authenticate(self.viewer)
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["verb"], "account verified")


class NotificationUnreadCountTests(TestCase):
    """The unread-count badge counts every accessible unread row (#1959).

    It was previously sliced to 50 *before* the board-access filter, so it
    could never exceed 50 and could undercount when rows on boards the user
    lost access to sat inside the window. The count is now done in SQL, after
    the access filter, and matches the documented (uncapped) contract.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="cap_user", password="pass")
        self.board, self.col, _, self.swim = make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )

    def _make_unread(self, n, board=None, card=None):
        Notification.objects.bulk_create([
            Notification(
                recipient=self.user,
                verb=f"unread {i}",
                board=board or self.board,
                card=card if card is not None else (self.card if board is None else None),
                action_type=Notification.ActionType.CARD_MOVED,
                read=False,
            )
            for i in range(n)
        ])

    def _count(self):
        self.client.force_authenticate(self.user)
        resp = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(resp.status_code, 200)
        return resp.data["count"]

    def test_count_below_threshold(self):
        self._make_unread(7)
        self.assertEqual(self._count(), 7)

    def test_count_is_not_capped_at_fifty(self):
        self._make_unread(73)
        self.assertEqual(self._count(), 73)

    def test_inaccessible_rows_do_not_hide_accessible_ones(self):
        """60 newer rows on a revoked board must not push 5 accessible rows out of view."""
        other = User.objects.create_user(username="other_owner", password="pass")
        lost_board, _, _, _ = make_board(other)
        self._make_unread(5)
        self._make_unread(60, board=lost_board)
        # Make the inaccessible rows the newest so they would fill a [:50] window.
        Notification.objects.filter(board=lost_board).update(
            created_at=timezone.now() + datetime.timedelta(hours=1)
        )
        self.assertEqual(self._count(), 5)
        resp = self.client.get("/api/v1/notifications/")
        self.assertEqual(len(resp.data), 5)

    def test_revoked_membership_not_counted(self):
        other = User.objects.create_user(username="other_owner2", password="pass")
        shared, _, _, _ = make_board(other)
        BoardMembership.objects.create(board=shared, user=self.user, role=BoardMembership.Role.VIEWER)
        self._make_unread(3, board=shared)
        self.assertEqual(self._count(), 3)
        BoardMembership.objects.filter(board=shared, user=self.user).delete()
        self.assertEqual(self._count(), 0)

    def test_group_inherited_access_counted(self):
        from groups.models import Group, GroupMembership

        other = User.objects.create_user(username="other_owner3", password="pass")
        group = Group.objects.create(name="G1959", owner=other)
        GroupMembership.objects.create(group=group, user=self.user, role=GroupMembership.Role.MEMBER)
        grouped, _, _, _ = make_board(other)
        grouped.group = group
        grouped.save()
        self._make_unread(2, board=grouped)
        self.assertEqual(self._count(), 2)

    def test_boardless_rows_counted(self):
        Notification.objects.create(
            recipient=self.user, verb="account", action_type=Notification.ActionType.STALE, read=False,
        )
        self.assertEqual(self._count(), 1)

    def test_site_admin_counts_every_board(self):
        admin = User.objects.create_user(username="all_access", password="pass")
        admin.can_access_all_content = True
        admin.save()
        other = User.objects.create_user(username="other_owner4", password="pass")
        foreign, _, _, _ = make_board(other)
        Notification.objects.create(
            recipient=admin, verb="x", board=foreign, action_type=Notification.ActionType.CARD_MOVED, read=False,
        )
        self.client.force_authenticate(admin)
        self.assertEqual(self.client.get("/api/v1/notifications/unread-count/").data["count"], 1)

    def test_query_count_constant_across_boards(self):
        """Both endpoints issue a fixed number of queries however many boards the rows span (#1959)."""
        self._make_unread(1)
        self.client.force_authenticate(self.user)

        def measure(url):
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(self.client.get(url).status_code, 200)
            return len(ctx)

        urls = ["/api/v1/notifications/", "/api/v1/notifications/unread-count/"]
        # Group-inherited access: the user belongs to a parent group; boards sit
        # in a nested child. The group walk costs a bounded number of queries
        # per request (depth, not board count), so it is part of the baseline.
        from groups.models import Group, GroupMembership

        other = User.objects.create_user(username="other_owner5", password="pass")
        parent = Group.objects.create(name="P1959", owner=other)
        child = Group.objects.create(name="C1959", owner=other, parent=parent)
        GroupMembership.objects.create(group=parent, user=self.user, role=GroupMembership.Role.MEMBER)
        Notification.objects.create(
            recipient=self.user, verb="g", board=Board.objects.create(name="GB", owner=other, group=child),
            action_type=Notification.ActionType.BOARD_INVITE, read=False,
        )

        baseline = {u: measure(u) for u in urls}

        for i in range(12):
            b = Board.objects.create(name=f"B{i}", owner=other)
            BoardMembership.objects.create(board=b, user=self.user, role=BoardMembership.Role.VIEWER)
            Notification.objects.create(
                recipient=self.user, verb=f"n{i}", board=b,
                action_type=Notification.ActionType.BOARD_INVITE, read=False,
            )
        for i in range(4):
            gb = Board.objects.create(name=f"GB{i}", owner=other, group=child)
            Notification.objects.create(
                recipient=self.user, verb=f"g{i}", board=gb,
                action_type=Notification.ActionType.BOARD_INVITE, read=False,
            )
        for u in urls:
            self.assertEqual(measure(u), baseline[u], f"{u} query count grew with board count")
        self.assertEqual(self.client.get(urls[1]).data["count"], 18)


class CardAssignmentNotificationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.owner)
        self.board, self.col_a, _, self.swim = make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title="Assignable Card",
            created_by=self.owner,
            position=0,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_assigning_card_notifies_assignee(self, _mock_broadcast):
        assignee = User.objects.create_user(username="assignee", password="pass")
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)

        self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": assignee.pk},
        )

        self.assertTrue(
            Notification.objects.filter(
                recipient=assignee,
                card=self.card,
                verb__contains="assigned",
            ).exists()
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_self_assignment_does_not_notify(self, _mock_broadcast):
        self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"assignee_id": self.owner.pk},
        )

        self.assertEqual(
            Notification.objects.filter(recipient=self.owner, card=self.card).count(), 0
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_notifies_assignee(self, _mock_broadcast):
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        # notif_card_moved=True — card-move notifications respect this preference.
        assignee = User.objects.create_user(username="mover_assignee", password="pass", notif_card_moved=True)
        BoardMembership.objects.create(board=self.board, user=assignee, role=BoardMembership.Role.MEMBER)
        self.card.assignee = assignee
        self.card.save()

        self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )

        self.assertTrue(
            Notification.objects.filter(recipient=assignee, card=self.card).exists()
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_skips_assignee_who_is_not_a_current_member(self, _mock_broadcast):
        """Recipients of a card-move notification must be current members."""
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        outsider = User.objects.create_user(
            username="mover_outsider", password="pass", notif_card_moved=True
        )
        self.card.assignee = outsider
        self.card.save()
        received = []

        def _receiver(sender, notification=None, **kwargs):
            received.append(notification)

        post_notification_created.connect(_receiver, dispatch_uid="test_member_scope_move", weak=False)
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_member_scope_move")

        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
                {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
            )

        self.assertFalse(Notification.objects.filter(recipient=outsider).exists())
        self.assertFalse(any(n.recipient_id == outsider.pk for n in received))

    def _move_with_assignee(self, user):
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        self.card.assignee = user
        self.card.save()
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
                {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
            )

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_skips_inactive_member_assignee(self, _mock_broadcast):
        inactive = User.objects.create_user(
            username="mover_inactive", password="pass", notif_card_moved=True, is_active=False
        )
        BoardMembership.objects.create(board=self.board, user=inactive, role=BoardMembership.Role.MEMBER)
        received = []

        def _receiver(sender, notification=None, **kwargs):
            received.append(notification)

        post_notification_created.connect(_receiver, dispatch_uid="test_inactive_move", weak=False)
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_inactive_move")

        self._move_with_assignee(inactive)

        self.assertFalse(Notification.objects.filter(recipient=inactive).exists())
        self.assertFalse(any(n.recipient_id == inactive.pk for n in received))

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_notifies_site_admin_assignee(self, _mock_broadcast):
        admin = User.objects.create_user(
            username="mover_siteadmin", password="pass", notif_card_moved=True,
            can_access_all_content=True,
        )
        self._move_with_assignee(admin)
        self.assertTrue(Notification.objects.filter(recipient=admin, card=self.card).exists())

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_notifies_group_inherited_assignee(self, _mock_broadcast):
        from groups.models import Group, GroupMembership

        parent = Group.objects.create(name="move_parent_group", owner=self.owner)
        child = Group.objects.create(name="move_child_group", owner=self.owner, parent=parent)
        user = User.objects.create_user(
            username="mover_group", password="pass", notif_card_moved=True
        )
        GroupMembership.objects.create(group=parent, user=user, role=GroupMembership.Role.MEMBER)
        self.board.group = child
        self.board.save()
        self._move_with_assignee(user)
        self.assertTrue(Notification.objects.filter(recipient=user, card=self.card).exists())

    @patch("boards.broadcast.broadcast_board_event")
    def test_card_move_does_not_notify_mover_when_self_assigned(self, _mock_broadcast):
        col_b = Column.objects.create(board=self.board, name="Doing", position=2)
        self.card.assignee = self.owner
        self.card.save()

        self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": col_b.pk, "swimlane_id": self.swim.pk, "position": 0},
        )

        self.assertEqual(
            Notification.objects.filter(recipient=self.owner, card=self.card).count(), 0
        )


class MentionNotificationEdgeCaseTests(TestCase):
    """Edge cases for @mention notifications in comments."""

    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.client.force_authenticate(self.owner)
        self.board, self.col_a, _, self.swim = make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board,
            column=self.col_a,
            swimlane=self.swim,
            title="Mention Test Card",
            created_by=self.owner,
            position=0,
        )

    def _post_comment(self, body):
        return self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
            {"body": body},
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_self_mention_does_not_create_notification(self, _):
        """Author mentioning themselves should NOT create a notification."""
        resp = self._post_comment(f"Note to self: @{self.owner.username} fix this")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.owner, card=self.card, verb__contains="mentioned"
            ).count(),
            0,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_mentioning_non_board_member_does_not_notify(self, _):
        """Mentioning a user who is not a board member should NOT create a notification."""
        outsider = User.objects.create_user(username="outsider", password="pass")
        resp = self._post_comment("Hey @outsider check this out")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            Notification.objects.filter(recipient=outsider).count(), 0
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_duplicate_mention_creates_single_notification(self, _):
        """Mentioning the same user twice in one comment should create only ONE notification."""
        member = User.objects.create_user(username="member", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=member, role=BoardMembership.Role.MEMBER
        )
        resp = self._post_comment("@member please review. @member are you there?")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            Notification.objects.filter(
                recipient=member, card=self.card, verb__contains="mentioned"
            ).count(),
            1,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_mentioning_nonexistent_user_is_silently_ignored(self, _):
        """Mentioning a username that does not exist should not cause errors."""
        resp = self._post_comment("Hey @ghost_user_12345 what do you think?")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(Notification.objects.count(), 0)


# ---------------------------------------------------------------------------
# #572 — Notification.action_type backfill migration + constraint
# ---------------------------------------------------------------------------

class NotificationActionTypeBackfillTests(TestCase):
    """Verify the 0040 backfill migration correctly infers action_type from verb.

    The backfill function is imported directly from the migration module so the
    test exercises the real logic without running the full migration framework.
    """

    def setUp(self):
        import importlib
        from django.apps import apps as django_apps
        self.user = User.objects.create_user(username="u", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        mod = importlib.import_module("boards.migrations.0040_backfill_notification_action_type")
        # Bind the real apps registry so get_model() resolves correctly outside
        # the migration framework.
        raw_fn = mod.backfill_action_type
        self.backfill = lambda *_: raw_fn(django_apps, None)

    def _make_blank(self, verb):
        # Use update() to bypass model-level validation and write an empty
        # action_type as legacy rows would have had.
        n = Notification.objects.create(
            recipient=self.user, verb=verb, board=self.board,
            action_type=Notification.ActionType.ASSIGNED,
        )
        Notification.objects.filter(pk=n.pk).update(action_type="")
        n.refresh_from_db()
        return n

    def test_mentioned_verb_inferred(self):
        n = self._make_blank('alice mentioned you in "Fix login"')
        self.backfill(None, None)
        n.refresh_from_db()
        self.assertEqual(n.action_type, "mentioned")

    def test_assigned_verb_inferred(self):
        n = self._make_blank('You were assigned to "Fix login"')
        self.backfill(None, None)
        n.refresh_from_db()
        self.assertEqual(n.action_type, "assigned")

    def test_board_invite_verb_inferred(self):
        n = self._make_blank('alice added you to "My Board"')
        self.backfill(None, None)
        n.refresh_from_db()
        self.assertEqual(n.action_type, "board_invite")

    def test_stale_verb_inferred(self):
        n = self._make_blank('"Fix login" hasn\'t moved in 14 days (board: My Board)')
        self.backfill(None, None)
        n.refresh_from_db()
        self.assertEqual(n.action_type, "stale")

    def test_card_moved_verb_inferred(self):
        n = self._make_blank('alice moved "Fix login" to Done')
        self.backfill(None, None)
        n.refresh_from_db()
        self.assertEqual(n.action_type, "card_moved")

    def test_rows_with_existing_action_type_are_untouched(self):
        n = Notification.objects.create(
            recipient=self.user, verb="You were assigned to X", board=self.board,
            action_type=Notification.ActionType.BOARD_INVITE,
        )
        self.backfill(None, None)
        n.refresh_from_db()
        # Non-blank row must not be overwritten
        self.assertEqual(n.action_type, "board_invite")


# ---------------------------------------------------------------------------
# #572 — Notification.action_type blank=False constraint
# ---------------------------------------------------------------------------

class NotificationActionTypeConstraintTests(TestCase):
    """Verify that Notification.action_type rejects blank values at the model level."""

    def setUp(self):
        self.user = User.objects.create_user(username="ctest", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)

    def test_blank_action_type_fails_full_clean(self):
        """A Notification with an empty action_type must fail model validation."""
        from django.core.exceptions import ValidationError
        n = Notification(
            recipient=self.user,
            verb="some verb",
            board=self.board,
            action_type="",
        )
        with self.assertRaises(ValidationError) as ctx:
            n.full_clean()
        self.assertIn("action_type", ctx.exception.message_dict)

    def test_valid_action_type_passes_full_clean(self):
        """A Notification with a valid action_type must pass model validation."""
        n = Notification(
            recipient=self.user,
            verb="You were assigned to X",
            board=self.board,
            action_type=Notification.ActionType.ASSIGNED,
        )
        # Should not raise
        n.full_clean()


# ---------------------------------------------------------------------------
# #437 — Board invite notification wiring
# ---------------------------------------------------------------------------

class BoardInviteNotificationTests(TestCase):
    """Verify that adding a new member to a board creates a BOARD_INVITE notification."""

    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(username="boardadmin", password="pass")
        self.client.force_authenticate(self.admin)
        self.board, _, _, _ = make_board(self.admin)

    @patch("boards.broadcast.broadcast_board_event")
    def test_adding_member_creates_board_invite_notification(self, _mock_broadcast):
        """Adding a new member to a board must create a BOARD_INVITE notification."""
        new_member = User.objects.create_user(
            username="newmember", password="pass", notif_board_invite=True
        )

        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": new_member.pk, "role": "member"},
        )

        self.assertEqual(resp.status_code, 201)
        self.assertTrue(
            Notification.objects.filter(
                recipient=new_member,
                board=self.board,
                action_type=Notification.ActionType.BOARD_INVITE,
            ).exists()
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_self_add_does_not_create_notification(self, _mock_broadcast):
        """An admin adding themselves must not create a self-notification."""
        # The admin is already a member from make_board — re-adding should not
        # fire a self-notification regardless of the notif_board_invite pref.
        # ``admin``: the admin is the board owner here, whose row cannot be
        # demoted (#1828).
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.admin.pk, "role": "admin"},
        )

        # 201 (upsert) or 200 both acceptable; key assertion is no notification
        self.assertIn(resp.status_code, [200, 201])
        self.assertEqual(
            Notification.objects.filter(
                recipient=self.admin,
                board=self.board,
                action_type=Notification.ActionType.BOARD_INVITE,
            ).count(),
            0,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_opted_out_member_does_not_receive_notification(self, _mock_broadcast):
        """A user with notif_board_invite=False must not receive a BOARD_INVITE notification."""
        opted_out = User.objects.create_user(
            username="optedout", password="pass", notif_board_invite=False
        )

        self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": opted_out.pk, "role": "member"},
        )

        self.assertEqual(
            Notification.objects.filter(
                recipient=opted_out,
                action_type=Notification.ActionType.BOARD_INVITE,
            ).count(),
            0,
        )

    @patch("boards.broadcast.broadcast_board_event")
    def test_role_update_does_not_create_duplicate_notification(self, _mock_broadcast):
        """Updating an existing member's role must not fire a second BOARD_INVITE notification."""
        existing = User.objects.create_user(
            username="existing", password="pass", notif_board_invite=True
        )
        # First add — creates one notification
        self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": existing.pk, "role": "member"},
        )
        # Promote — should NOT create a second notification
        self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": existing.pk, "role": "admin"},
        )

        self.assertEqual(
            Notification.objects.filter(
                recipient=existing,
                board=self.board,
                action_type=Notification.ActionType.BOARD_INVITE,
            ).count(),
            1,
        )


# ---------------------------------------------------------------------------
# #1277 — "Comment on a watched card" (COMMENT_ADDED) notifications
# ---------------------------------------------------------------------------

@override_settings(NOTIFICATION_EMAIL_ASYNC=False)
@patch("boards.broadcast.broadcast_board_event")
class CommentAddedNotificationTests(TestCase):
    """A comment notifies the card's implicit watchers: creator + assignee.

    v1 has no CardWatcher model (#229 adds one in 1.4); ``card_watcher_ids`` is
    the seam. Every recipient rule the docs promise has a test here.
    """

    def setUp(self):
        self.client = APIClient()
        # The commenter is the board owner; the watchers are plain members.
        self.commenter = User.objects.create_user(
            username="commenter", password="pass", notif_comment_added=True
        )
        self.client.force_authenticate(self.commenter)
        self.board, self.col_a, _, self.swim = make_board(self.commenter)
        self.creator = self._member("creator")
        self.assignee = self._member("assignee")
        self.card = self._card(created_by=self.creator, assignee=self.assignee)

    def _member(self, username, **prefs):
        prefs.setdefault("notif_comment_added", True)
        user = User.objects.create_user(username=username, password="pass", **prefs)
        BoardMembership.objects.create(board=self.board, user=user, role=BoardMembership.Role.MEMBER)
        return user

    def _card(self, created_by, assignee=None, title="Watched card"):
        return Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title=title, created_by=created_by, assignee=assignee, position=0,
        )

    def _post_comment(self, body="Looks good to me", card=None):
        card = card or self.card
        return self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/comments/",
            {"body": body}, format="json",
        )

    def _comment_rows(self, **filters):
        return Notification.objects.filter(
            action_type=Notification.ActionType.COMMENT_ADDED, **filters
        )

    def test_assignee_is_notified(self, _):
        card = self._card(created_by=None, assignee=self.assignee)
        resp = self._post_comment(card=card)
        self.assertEqual(resp.status_code, 201)
        rows = list(self._comment_rows(card=card))
        self.assertEqual([n.recipient_id for n in rows], [self.assignee.pk])
        n = rows[0]
        self.assertEqual(n.actor_id, self.commenter.pk)
        self.assertEqual(n.board_id, self.board.pk)
        self.assertEqual(n.verb, 'commenter commented on "Watched card"')

    def test_creator_is_notified(self, _):
        card = self._card(created_by=self.creator, assignee=None)
        self.assertEqual(self._post_comment(card=card).status_code, 201)
        self.assertEqual(
            list(self._comment_rows(card=card).values_list("recipient_id", flat=True)),
            [self.creator.pk],
        )

    def test_creator_and_assignee_are_both_notified(self, _):
        self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(
            set(self._comment_rows(card=self.card).values_list("recipient_id", flat=True)),
            {self.creator.pk, self.assignee.pk},
        )

    def test_creator_who_is_also_assignee_gets_exactly_one_row(self, _):
        card = self._card(created_by=self.creator, assignee=self.creator)
        self.assertEqual(self._post_comment(card=card).status_code, 201)
        self.assertEqual(self._comment_rows(card=card, recipient=self.creator).count(), 1)
        self.assertEqual(self._comment_rows(card=card).count(), 1)

    def test_commenter_is_not_notified_of_own_comment(self, _):
        # The commenter created and is assigned the card, and has the toggle on.
        card = self._card(created_by=self.commenter, assignee=self.commenter)
        self.assertEqual(self._post_comment(card=card).status_code, 201)
        self.assertEqual(self._comment_rows(card=card).count(), 0)

    def test_watcher_commenting_does_not_notify_themselves_but_notifies_the_other(self, _):
        self.client.force_authenticate(self.assignee)
        self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(
            list(self._comment_rows(card=self.card).values_list("recipient_id", flat=True)),
            [self.creator.pk],
        )

    def test_toggle_off_creates_no_row(self, _):
        User.objects.filter(pk__in=[self.creator.pk, self.assignee.pk]).update(
            notif_comment_added=False
        )
        self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(self._comment_rows().count(), 0)

    def test_toggle_defaults_off(self, _):
        # Upgrading must not start notifying anybody who never opted in.
        watcher = User.objects.create_user(username="default_prefs", password="pass")
        BoardMembership.objects.create(board=self.board, user=watcher, role=BoardMembership.Role.MEMBER)
        card = self._card(created_by=watcher, assignee=watcher)
        self.assertEqual(self._post_comment(card=card).status_code, 201)
        self.assertEqual(self._comment_rows(card=card).count(), 0)

    def test_watcher_removed_from_board_is_not_notified(self, _):
        BoardMembership.objects.filter(board=self.board, user=self.creator).delete()
        self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(
            list(self._comment_rows(card=self.card).values_list("recipient_id", flat=True)),
            [self.assignee.pk],
        )

    def test_inactive_watcher_is_skipped(self, _):
        User.objects.filter(pk=self.assignee.pk).update(is_active=False)
        self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(
            list(self._comment_rows(card=self.card).values_list("recipient_id", flat=True)),
            [self.creator.pk],
        )

    def test_mentioned_watcher_gets_mention_only(self, _):
        self.assertEqual(self._post_comment("@assignee can you check?").status_code, 201)
        assignee_rows = Notification.objects.filter(recipient=self.assignee, card=self.card)
        self.assertEqual(
            list(assignee_rows.values_list("action_type", flat=True)),
            [Notification.ActionType.MENTIONED],
        )
        # The un-mentioned watcher still hears about the comment.
        self.assertEqual(self._comment_rows(recipient=self.creator).count(), 1)

    def test_watcher_with_mentions_off_still_gets_comment_added(self, _):
        # No MENTIONED row was created, so there is nothing to de-duplicate
        # against: the watcher must not fall through both nets.
        User.objects.filter(pk=self.assignee.pk).update(notif_mentioned=False)
        self.assertEqual(self._post_comment("@assignee can you check?").status_code, 201)
        self.assertEqual(
            list(
                Notification.objects.filter(recipient=self.assignee).values_list(
                    "action_type", flat=True
                )
            ),
            [Notification.ActionType.COMMENT_ADDED],
        )

    def _set_watcher_emails(self, **prefs):
        User.objects.filter(pk=self.creator.pk).update(email="creator@example.test", **prefs)
        User.objects.filter(pk=self.assignee.pk).update(email="assignee@example.test", **prefs)

    def test_no_email_without_comment_email_opt_in(self, _):
        # #1295: every OTHER email preference is on, but email_notif_comment_added
        # is left at its default (False) — none of the others covers this event.
        self._set_watcher_emails(
            email_notif_card_assigned=True,
            email_notif_mentioned=True,
            email_notif_due_soon=True,
            email_notif_card_moved=True,
        )
        mail.outbox = []
        received = []

        def _receiver(sender, **kwargs):
            received.append(kwargs)

        post_notification_created.connect(_receiver, dispatch_uid="test_1277")
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_1277")
        # Without executing on_commit callbacks the outbox assertion is vacuous.
        with self.captureOnCommitCallbacks(execute=True):
            resp = self._post_comment("Shipping it")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(self._comment_rows().count(), 2)
        self.assertEqual(mail.outbox, [])
        # The delivery seam still fires, with the documented context keys.
        self.assertEqual(len(received), 2)
        self.assertEqual(received[0]["context"]["comment_body"], "Shipping it")
        self.assertEqual(received[0]["context"]["comment_id"], resp.data["id"])

    def test_email_is_sent_when_opted_in(self, _):
        # #1295: email_notif_comment_added maps COMMENT_ADDED to email delivery.
        self._set_watcher_emails(email_notif_comment_added=True)
        mail.outbox = []
        with self.captureOnCommitCallbacks(execute=True):
            resp = self._post_comment("Shipping it")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(
            sorted(addr for m in mail.outbox for addr in m.to),
            ["assignee@example.test", "creator@example.test"],
        )
        for message in mail.outbox:
            self.assertIn("Watched card", message.subject)
            self.assertIn(f"?card={self.card.pk}", message.body)

    def test_email_opt_in_is_inert_while_in_app_is_off(self, _):
        # Email rides on the in-app row: with notif_comment_added off there is no
        # COMMENT_ADDED notification, so nothing to email either.
        self._set_watcher_emails(notif_comment_added=False, email_notif_comment_added=True)
        mail.outbox = []
        with self.captureOnCommitCallbacks(execute=True):
            resp = self._post_comment("Shipping it")
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(self._comment_rows().count(), 0)
        self.assertEqual(mail.outbox, [])

    def test_500_character_title_still_creates_comment(self, _):
        card = self._card(created_by=self.creator, assignee=self.assignee, title="T" * 500)
        resp = self._post_comment("@creator see this", card=card)
        self.assertEqual(resp.status_code, 201)
        max_len = Notification._meta.get_field("verb").max_length
        rows = Notification.objects.filter(card=card)
        # One MENTIONED (creator) and one COMMENT_ADDED (assignee), both clipped.
        self.assertEqual(rows.count(), 2)
        for n in rows:
            self.assertLessEqual(len(n.verb), max_len)
            self.assertTrue(n.verb.endswith('…"'), n.verb)

    def test_query_count_is_constant_in_watchers(self, _):
        # Fixed cost for the watcher path: one SELECT for the recipients and one
        # bulk INSERT, regardless of how many watchers there are. Pin the whole
        # request so a per-watcher query shows up as a failure.
        card_one = self._card(created_by=self.creator, assignee=None)
        # Warm-up: the first request of a test fills process-level caches.
        self.assertEqual(self._post_comment(card=card_one).status_code, 201)
        with CaptureQueriesContext(connection) as one_watcher:
            self.assertEqual(self._post_comment(card=card_one).status_code, 201)
        with self.assertNumQueries(len(one_watcher.captured_queries)):
            self.assertEqual(self._post_comment().status_code, 201)
        self.assertEqual(self._comment_rows(card=self.card).count(), 2)


class CardWatcherIdsTests(TestCase):
    """``card_watcher_ids`` is the seam #229 replaces; pin its contract."""

    def test_creator_and_assignee_without_none(self):
        self.assertEqual(card_watcher_ids(Card(created_by_id=1, assignee_id=2)), {1, 2})
        self.assertEqual(card_watcher_ids(Card(created_by_id=1, assignee_id=1)), {1})
        self.assertEqual(card_watcher_ids(Card(created_by_id=None, assignee_id=None)), set())


class QuotedCardVerbTests(TestCase):
    def test_short_title_is_untouched(self):
        self.assertEqual(quoted_card_verb("a commented on", "Fix login"), 'a commented on "Fix login"')

    def test_long_title_is_clipped_to_verb_max_length(self):
        max_len = Notification._meta.get_field("verb").max_length
        lead = "u" * 150 + " commented on"
        verb = quoted_card_verb(lead, "x" * 500)
        self.assertEqual(len(verb), max_len)
        self.assertTrue(verb.startswith(lead + ' "'))
        self.assertTrue(verb.endswith('\u2026"'))
