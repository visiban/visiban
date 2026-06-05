import datetime
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card, CardMovement, Notification


def make_board(owner):
    board = Board.objects.create(name="Test Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col_a = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col_b = Column.objects.create(board=board, name="Done", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col_a, col_b, swim


class StaleCardNotificationTests(TestCase):
    def setUp(self):
        # notif_due_soon=True — stale-card notifications respect this preference.
        self.owner = User.objects.create_user(username="owner", password="pass", notif_due_soon=True)
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
        assignee = User.objects.create_user(username="assignee", password="pass", notif_due_soon=True)
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


class NotificationUnreadCountCapTests(TestCase):
    """The unread-count badge is capped at 50 to match the list endpoint.

    The dropdown never shows more than 50 unread notifications, so the badge
    must not load the user's entire unread backlog into memory just to count
    it. Capping keeps the count in lock-step with what the dropdown can show
    and bounds the per-board access checks the endpoint performs.
    """

    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="cap_user", password="pass")
        self.board, self.col, _, self.swim = make_board(self.user)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.swim,
            title="Card", created_by=self.user, position=0,
        )

    def _make_unread(self, n):
        Notification.objects.bulk_create([
            Notification(
                recipient=self.user,
                verb=f"unread {i}",
                board=self.board,
                card=self.card,
                action_type=Notification.ActionType.CARD_MOVED,
                read=False,
            )
            for i in range(n)
        ])

    def test_count_uncapped_below_threshold(self):
        self._make_unread(7)
        self.client.force_authenticate(self.user)
        resp = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["count"], 7)

    def test_count_capped_at_fifty(self):
        self._make_unread(73)
        self.client.force_authenticate(self.user)
        resp = self.client.get("/api/v1/notifications/unread-count/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.data["count"], 50,
            "unread-count must cap at 50 to match the list endpoint's window "
            "and avoid loading the full unread backlog into memory.",
        )


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
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": self.admin.pk, "role": "member"},
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
