"""Outbound notification email and the post_notification_created seam (#356).

A trap worth naming, because it makes a broken test pass rather than fail:
``TestCase`` wraps each test in a transaction that never commits, so
``transaction.on_commit`` callbacks never run. Every send in this feature is
deferred with ``on_commit``, so a test that just asserts on ``mail.outbox``
would find it empty and pass **vacuously**. Every test below either wraps the
triggering call in ``captureOnCommitCallbacks(execute=True)`` or calls the
dispatch half directly.
"""
import datetime
from unittest.mock import patch

from django.core import mail
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardMovement,
    Column,
    Notification,
    Swimlane,
)
from boards.notifications_email import (
    deliver_notification_emails,
    suppress_notification_email,
)
from boards.services.notifications import create_notifications
from boards.signals import post_notification_created


def make_board(owner, name="Email Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col_a = Column.objects.create(board=board, name="Backlog", position=0, allow_card_creation=True)
    col_b = Column.objects.create(board=board, name="Doing", position=1)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col_a, col_b, swim


class SignalExtensionPointTests(TestCase):
    """``post_notification_created`` is the seam enterprise delivery attaches to."""

    def setUp(self):
        self.owner = User.objects.create_user(username="sig_owner", password="pass")
        self.recipient = User.objects.create_user(
            username="sig_recipient", password="pass", email="sig@example.test"
        )
        self.board, self.col_a, _, self.swim = make_board(self.owner)
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Signal card", created_by=self.owner, position=0,
        )
        self.received = []

        def _receiver(sender, **kwargs):
            self.received.append(kwargs)

        self._receiver = _receiver
        post_notification_created.connect(_receiver, dispatch_uid="test_sig")
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_sig")

    def _notification(self, action_type=Notification.ActionType.ASSIGNED):
        return Notification(
            recipient=self.recipient,
            actor=self.owner,
            action_type=action_type,
            verb="You were assigned to \"Signal card\"",
            card=self.card,
            board=self.board,
        )

    def test_signal_fires_once_per_row_with_the_documented_kwargs(self):
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications([self._notification()], context={"k": "v"})

        self.assertEqual(len(self.received), 1)
        kwargs = self.received[0]
        self.assertEqual(kwargs["notification"].action_type, Notification.ActionType.ASSIGNED)
        self.assertIsNotNone(kwargs["notification"].pk)
        self.assertEqual(kwargs["recipient"], self.recipient)
        self.assertEqual(kwargs["actor"], self.owner)
        self.assertEqual(kwargs["context"], {"k": "v"})

    def test_signal_does_not_fire_before_commit(self):
        """A receiver must never see a row the transaction could still roll back."""
        with self.captureOnCommitCallbacks(execute=False):
            create_notifications([self._notification()])
            self.assertEqual(self.received, [])

    def test_signal_fires_for_bulk_created_rows(self):
        """bulk_create sends no post_save — the funnel is what closes that hole."""
        second = User.objects.create_user(username="sig_second", password="pass")
        BoardMembership.objects.create(
            board=self.board, user=second, role=BoardMembership.Role.MEMBER
        )
        rows = [self._notification(), self._notification()]
        rows[1].recipient = second
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications(rows)
        self.assertEqual(len(self.received), 2)

    def test_signal_fires_for_events_oss_never_emails(self):
        """board_invite has no email preference, but the seam must still fire."""
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications([self._notification(Notification.ActionType.BOARD_INVITE)])
        self.assertEqual(len(self.received), 1)
        self.assertEqual(mail.outbox, [])

    def test_a_raising_receiver_cannot_break_the_write(self):
        """send_robust: one bad add-on must not fail the request or starve others."""
        def _boom(sender, **kwargs):
            raise RuntimeError("enterprise backend exploded")

        post_notification_created.connect(_boom, dispatch_uid="test_boom")
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_boom")

        with self.assertLogs("boards.services.notifications", level="ERROR") as logs:
            with self.captureOnCommitCallbacks(execute=True):
                create_notifications([self._notification()])

        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(len(self.received), 1)
        # The log line has to name the receiver, or an always-throwing add-on
        # produces an unattributable error nobody can trace.
        self.assertTrue(any("_boom" in line for line in logs.output))

    def test_empty_batch_is_a_no_op(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(create_notifications([]), [])
        self.assertEqual(self.received, [])


class EmailDeliveryPerEventTests(TestCase):
    """Each of the four in-scope events sends mail when the user opted in."""

    def setUp(self):
        self.actor = User.objects.create_user(username="mover", password="pass")
        self.target = User.objects.create_user(
            username="target", password="pass", email="target@example.test",
            notif_card_assigned=True, email_notif_card_assigned=True,
            notif_mentioned=True, email_notif_mentioned=True,
            notif_card_moved=True, email_notif_card_moved=True,
            notif_due_soon=True, email_notif_due_soon=True,
        )
        self.board, self.col_a, self.col_b, self.swim = make_board(self.actor)
        BoardMembership.objects.create(
            board=self.board, user=self.target, role=BoardMembership.Role.MEMBER
        )
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Deploy v2.3", created_by=self.actor, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.actor)
        mail.outbox = []

    def test_assignment_sends_email(self):
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"assignee_id": self.target.pk}, format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, ["target@example.test"])
        self.assertIn("Deploy v2.3", message.subject)
        self.assertIn(self.board.name, message.subject)
        # The body carries the same deep link the bell dropdown uses, so the
        # email and the in-app notification land in the same place.
        self.assertIn(f"/boards/{self.board.pk}?card={self.card.pk}", message.body)
        self.assertIn("/settings", message.body)
        self.assertEqual(message.extra_headers["Auto-Submitted"], "auto-generated")
        self.assertIn("/settings>", message.extra_headers["List-Unsubscribe"])

    def test_comment_mention_sends_email(self):
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
                {"body": "please look at this @target"}, format="json",
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("mentioned you", mail.outbox[0].subject)

    def test_description_mention_sends_email(self):
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"description": "cc @target"}, format="json",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)

    def test_description_mention_writes_the_reprompt_guard_before_sending(self):
        """The guard must be committed even if delivery is slow or fails."""
        with patch(
            "boards.notifications_email.deliver_notification_emails",
            side_effect=RuntimeError("smtp wedged"),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                    {"description": "cc @target"}, format="json",
                )
        self.card.refresh_from_db()
        self.assertIn(self.target.pk, self.card.mentioned_user_ids or [])

    def test_card_moved_sends_email(self):
        self.card.assignee = self.target
        self.card.save(update_fields=["assignee"])
        mail.outbox = []
        with self.captureOnCommitCallbacks(execute=True):
            CardMovement.objects.create(
                card=self.card, from_column=self.col_a, to_column=self.col_b,
                from_column_name=self.col_a.name, to_column_name=self.col_b.name,
                moved_by=self.actor,
            )
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Doing", mail.outbox[0].subject)

    def test_due_soon_sends_email(self):
        self.card.assignee = self.target
        self.card.due_date = timezone.localdate() + datetime.timedelta(days=1)
        self.card.save(update_fields=["assignee", "due_date"])
        mail.outbox = []
        with self.captureOnCommitCallbacks(execute=True):
            call_command("notify_due_soon")
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("is due soon", mail.outbox[0].subject)

    def test_card_moved_context_carries_the_columns(self):
        """A delivery backend cannot get from/to out of the Notification row."""
        seen = {}

        def _receiver(sender, **kwargs):
            seen.update(kwargs["context"])

        post_notification_created.connect(_receiver, dispatch_uid="test_ctx")
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_ctx")

        self.card.assignee = self.target
        self.card.save(update_fields=["assignee"])
        with self.captureOnCommitCallbacks(execute=True):
            CardMovement.objects.create(
                card=self.card, from_column=self.col_a, to_column=self.col_b,
                from_column_name=self.col_a.name, to_column_name=self.col_b.name,
                moved_by=self.actor,
            )
        self.assertEqual(seen["from_column_name"], "Backlog")
        self.assertEqual(seen["to_column_name"], "Doing")

    def test_comment_mention_context_carries_the_comment(self):
        seen = {}

        def _receiver(sender, **kwargs):
            seen.update(kwargs["context"])

        post_notification_created.connect(_receiver, dispatch_uid="test_ctx2")
        self.addCleanup(post_notification_created.disconnect, dispatch_uid="test_ctx2")

        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
                {"body": "ping @target"}, format="json",
            )
        self.assertEqual(seen["source"], "comment")
        self.assertIn("ping @target", seen["comment_body"])
        self.assertIsNotNone(seen["comment_id"])


class EmailOptOutTests(TestCase):
    """Nothing is sent that the recipient did not ask for."""

    def setUp(self):
        self.actor = User.objects.create_user(username="optout_actor", password="pass")
        self.board, self.col_a, self.col_b, self.swim = make_board(self.actor, "OptOut")
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Opt out card", created_by=self.actor, position=0,
        )
        mail.outbox = []

    def _member(self, **kwargs):
        kwargs.setdefault("email", "member@example.test")
        user = User.objects.create_user(username=f"m{User.objects.count()}", password="pass", **kwargs)
        BoardMembership.objects.create(
            board=self.board, user=user, role=BoardMembership.Role.MEMBER
        )
        return user

    def _assign(self, user):
        client = APIClient()
        client.force_authenticate(self.actor)
        with self.captureOnCommitCallbacks(execute=True):
            return client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"assignee_id": user.pk}, format="json",
            )

    def test_email_preference_defaults_to_off(self):
        """The whole safety story: an upgrade must not start emailing anybody."""
        user = self._member(notif_card_assigned=True)
        self.assertFalse(user.email_notif_card_assigned)
        self._assign(user)
        # The in-app notification is still created — only the email is withheld.
        self.assertEqual(Notification.objects.filter(recipient=user).count(), 1)
        self.assertEqual(mail.outbox, [])

    def test_email_preference_off_sends_nothing(self):
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=False)
        self._assign(user)
        self.assertEqual(mail.outbox, [])

    def test_in_app_preference_off_means_no_notification_and_no_email(self):
        """Email rides on the row, so the in-app toggle gates both."""
        user = self._member(notif_card_assigned=False, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(Notification.objects.filter(recipient=user).count(), 0)
        self.assertEqual(mail.outbox, [])

    def test_per_event_preferences_are_independent(self):
        user = self._member(
            notif_card_assigned=True, email_notif_card_assigned=False,
            notif_mentioned=True, email_notif_mentioned=True,
        )
        self._assign(user)
        self.assertEqual(mail.outbox, [])
        client = APIClient()
        client.force_authenticate(self.actor)
        with self.captureOnCommitCallbacks(execute=True):
            client.post(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
                {"body": f"hi @{user.username}"}, format="json",
            )
        self.assertEqual(len(mail.outbox), 1)

    def test_recipient_with_no_email_address_is_skipped(self):
        user = self._member(email="", notif_card_assigned=True, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(mail.outbox, [])

    def test_deactivated_recipient_is_skipped(self):
        """History is kept; mail is not. A disabled account stops receiving."""
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(len(mail.outbox), 1)

        mail.outbox = []
        user.is_active = False
        user.save(update_fields=["is_active"])
        notification = Notification(
            recipient=user, actor=self.actor,
            action_type=Notification.ActionType.ASSIGNED,
            verb="You were assigned to \"Opt out card\"",
            card=self.card, board=self.board,
        )
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications([notification])
        self.assertEqual(mail.outbox, [])

    @override_settings(NOTIFICATION_EMAIL_ENABLED=False)
    def test_operator_kill_switch_stops_delivery_but_not_notifications(self):
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(Notification.objects.filter(recipient=user).count(), 1)
        self.assertEqual(mail.outbox, [])

    def test_suppress_context_manager_stops_delivery(self):
        """What keeps seed_demo_data from mailing hundreds of demo addresses."""
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        with suppress_notification_email():
            self._assign(user)
        self.assertEqual(mail.outbox, [])
        # And restores itself afterwards.
        mail.outbox = []
        notification = Notification(
            recipient=user, actor=self.actor,
            action_type=Notification.ActionType.ASSIGNED,
            verb="again", card=self.card, board=self.board,
        )
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications([notification])
        self.assertEqual(len(mail.outbox), 1)

    @override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
    def test_unverified_address_is_skipped_when_verification_is_mandatory(self):
        """Mailing board content to an unproven address is a disclosure."""
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(mail.outbox, [])

    @override_settings(ACCOUNT_EMAIL_VERIFICATION="mandatory")
    def test_verified_address_still_receives_under_mandatory_verification(self):
        from allauth.account.models import EmailAddress

        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
        self._assign(user)
        self.assertEqual(len(mail.outbox), 1)

    def test_unverified_address_receives_when_verification_is_optional(self):
        """The default policy accepts unverified addresses, so so does email."""
        user = self._member(notif_card_assigned=True, email_notif_card_assigned=True)
        self._assign(user)
        self.assertEqual(len(mail.outbox), 1)


class EmailFailureIsolationTests(TestCase):
    """A mail failure never breaks the write that produced the notification."""

    def setUp(self):
        self.actor = User.objects.create_user(username="fail_actor", password="pass")
        self.target = User.objects.create_user(
            username="fail_target", password="pass", email="fail@example.test",
            notif_card_assigned=True, email_notif_card_assigned=True,
        )
        self.board, self.col_a, self.col_b, self.swim = make_board(self.actor, "Fail")
        BoardMembership.objects.create(
            board=self.board, user=self.target, role=BoardMembership.Role.MEMBER
        )
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Fail card", created_by=self.actor, position=0,
        )
        self.client = APIClient()
        self.client.force_authenticate(self.actor)
        mail.outbox = []

    def _patch_send(self, exc):
        return patch(
            "django.core.mail.backends.locmem.EmailBackend.send_messages",
            side_effect=exc,
        )

    def test_smtp_failure_leaves_the_card_update_committed(self):
        import smtplib

        with self._patch_send(smtplib.SMTPAuthenticationError(535, b"nope")):
            with self.assertLogs("boards.notifications_email", level="ERROR") as logs:
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.client.patch(
                        f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                        {"assignee_id": self.target.pk}, format="json",
                    )

        self.assertEqual(response.status_code, 200)
        self.card.refresh_from_db()
        self.assertEqual(self.card.assignee_id, self.target.pk)
        self.assertEqual(Notification.objects.count(), 1)
        joined = "\n".join(logs.output)
        self.assertIn("auth_failed", joined)
        # Never log the address — see the "no PII in logs" rule.
        self.assertNotIn("fail@example.test", joined)

    def test_connection_refused_is_classified_and_swallowed(self):
        with self._patch_send(ConnectionRefusedError()):
            with self.assertLogs("boards.notifications_email", level="ERROR") as logs:
                with self.captureOnCommitCallbacks(execute=True):
                    response = self.client.patch(
                        f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                        {"assignee_id": self.target.pk}, format="json",
                    )
        self.assertEqual(response.status_code, 200)
        self.assertIn("connection_refused", "\n".join(logs.output))

    def test_a_timeout_floor_is_requested_for_every_batch(self):
        """A blackholed SMTP port must not hang a worker indefinitely."""
        with patch("boards.notifications_email.get_connection") as get_conn:
            get_conn.return_value.send_messages.return_value = 1
            with self.captureOnCommitCallbacks(execute=True):
                self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                    {"assignee_id": self.target.pk}, format="json",
                )
        self.assertEqual(get_conn.call_args.kwargs["timeout"], 10)

    def test_one_connection_is_reused_for_the_whole_batch(self):
        """Not one SMTP connect per recipient — see the module docstring."""
        others = []
        for index in range(3):
            user = User.objects.create_user(
                username=f"batch{index}", password="pass",
                email=f"batch{index}@example.test",
                notif_mentioned=True, email_notif_mentioned=True,
            )
            BoardMembership.objects.create(
                board=self.board, user=user, role=BoardMembership.Role.MEMBER
            )
            others.append(user)

        body = " ".join(f"@{u.username}" for u in others)
        with patch("boards.notifications_email.get_connection") as get_conn:
            get_conn.return_value.send_messages.return_value = 3
            with self.captureOnCommitCallbacks(execute=True):
                self.client.post(
                    f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/comments/",
                    {"body": body}, format="json",
                )
        self.assertEqual(get_conn.call_count, 1)
        self.assertEqual(len(get_conn.return_value.send_messages.call_args.args[0]), 3)

    def test_newlines_in_a_card_title_cannot_reach_the_subject_header(self):
        """Header injection: Django raises on a CR/LF in a subject."""
        self.card.title = "Bad\r\nBcc: attacker@example.test"
        self.card.save(update_fields=["title"])
        notification = Notification(
            recipient=self.target, actor=self.actor,
            action_type=Notification.ActionType.ASSIGNED,
            verb=f"You were assigned to \"{self.card.title}\"",
            card=self.card, board=self.board,
        )
        with self.captureOnCommitCallbacks(execute=True):
            create_notifications([notification])
        self.assertEqual(len(mail.outbox), 1)
        subject = mail.outbox[0].subject
        self.assertNotIn("\n", subject)
        self.assertNotIn("\r", subject)

    def test_an_overlong_subject_is_clipped(self):
        notification = Notification(
            recipient=self.target, actor=self.actor,
            action_type=Notification.ActionType.ASSIGNED,
            verb="x" * 400, card=self.card, board=self.board,
        )
        deliver_notification_emails([_saved(notification)], {})
        self.assertLessEqual(len(mail.outbox[0].subject), 200)


def _saved(notification):
    notification.save()
    return notification


class DueSoonScanTests(TestCase):
    """The due-date scan: window, membership gate, and idempotency."""

    def setUp(self):
        self.owner = User.objects.create_user(username="due_owner", password="pass")
        self.assignee = User.objects.create_user(
            username="due_assignee", password="pass", email="due@example.test",
            notif_due_soon=True, email_notif_due_soon=True,
        )
        self.board, self.col_a, self.col_b, self.swim = make_board(self.owner, "Due")
        BoardMembership.objects.create(
            board=self.board, user=self.assignee, role=BoardMembership.Role.MEMBER
        )
        mail.outbox = []

    def _card(self, *, due_in_days, title="Due card", assignee=None, archived=False):
        return Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim, title=title,
            created_by=self.owner, position=0,
            assignee=self.assignee if assignee is None else assignee,
            due_date=(
                None if due_in_days is None
                else timezone.localdate() + datetime.timedelta(days=due_in_days)
            ),
            archived_at=timezone.now() if archived else None,
        )

    def _run(self):
        with self.captureOnCommitCallbacks(execute=True):
            call_command("notify_due_soon")

    def test_card_due_tomorrow_notifies(self):
        self._card(due_in_days=1)
        self._run()
        notification = Notification.objects.get()
        self.assertEqual(notification.action_type, Notification.ActionType.DUE_SOON)
        self.assertIn("is due soon", notification.verb)
        self.assertEqual(len(mail.outbox), 1)

    def test_card_due_today_notifies(self):
        self._card(due_in_days=0)
        self._run()
        self.assertEqual(Notification.objects.count(), 1)

    def test_card_due_in_three_days_is_outside_the_window(self):
        self._card(due_in_days=3)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(mail.outbox, [])

    def test_overdue_card_is_outside_the_window(self):
        """"Due soon" is not "overdue" — a separate event, not this one."""
        self._card(due_in_days=-2)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)

    def test_card_with_no_due_date_is_ignored(self):
        self._card(due_in_days=None)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)

    def test_archived_card_is_ignored(self):
        self._card(due_in_days=1, archived=True)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)

    def test_unassigned_card_is_ignored(self):
        card = self._card(due_in_days=1)
        Card.objects.filter(pk=card.pk).update(assignee=None)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)

    def test_opt_out_is_respected(self):
        self.assignee.notif_due_soon = False
        self.assignee.save(update_fields=["notif_due_soon"])
        self._card(due_in_days=1)
        self._run()
        self.assertEqual(Notification.objects.count(), 0)

    def test_assignee_who_lost_board_access_is_not_notified(self):
        """The assignee FK outlives the membership; mailing them is a leak."""
        self._card(due_in_days=1)
        BoardMembership.objects.filter(board=self.board, user=self.assignee).delete()
        self._run()
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(mail.outbox, [])

    def test_running_twice_on_the_same_day_sends_one_email(self):
        self._card(due_in_days=1)
        self._run()
        self._run()
        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(len(mail.outbox), 1)

    def test_a_card_crossing_the_window_is_notified_only_once(self):
        """Due tomorrow today, due today tomorrow — still one email in total."""
        card = self._card(due_in_days=1)
        self._run()
        self.assertEqual(len(mail.outbox), 1)

        # Simulate the next day's run: the due date is now today, and yesterday's
        # notification still exists.
        today = timezone.localdate()
        Card.objects.filter(pk=card.pk).update(due_date=today)
        Notification.objects.update(created_at=timezone.now() - datetime.timedelta(days=1))
        self._run()
        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(len(mail.outbox), 1)

    def test_changing_the_due_date_makes_the_card_eligible_again(self):
        """A rescheduled card is a new commitment and warrants a new warning."""
        card = self._card(due_in_days=1)
        self._run()
        self.assertEqual(Notification.objects.count(), 1)

        Card.objects.filter(pk=card.pk).update(
            due_date=timezone.localdate() + datetime.timedelta(days=8)
        )
        # Age the existing notification well past the new reference point.
        Notification.objects.update(created_at=timezone.now() - datetime.timedelta(days=1))
        self._run()  # still outside the window
        self.assertEqual(Notification.objects.count(), 1)

        Card.objects.filter(pk=card.pk).update(
            due_date=timezone.localdate() + datetime.timedelta(days=1)
        )
        Notification.objects.update(created_at=timezone.now() - datetime.timedelta(days=3))
        self._run()
        self.assertEqual(Notification.objects.count(), 2)

    def test_days_argument_widens_the_window(self):
        self._card(due_in_days=3)
        with self.captureOnCommitCallbacks(execute=True):
            call_command("notify_due_soon", "--days", "3")
        self.assertEqual(Notification.objects.count(), 1)

    def test_empty_run_reports_zero(self):
        self._run()
        self.assertEqual(Notification.objects.count(), 0)


class StalePreferenceSplitTests(TestCase):
    """notif_stale now gates the staleness scan, not notif_due_soon (#356)."""

    def setUp(self):
        self.owner = User.objects.create_user(
            username="split_owner", password="pass", notif_stale=True
        )
        self.board, self.col_a, _, self.swim = make_board(self.owner, "Split")
        self.card = Card.objects.create(
            board=self.board, column=self.col_a, swimlane=self.swim,
            title="Old card", created_by=self.owner, position=0,
            created_at=timezone.now() - datetime.timedelta(days=60),
        )
        Card.objects.filter(pk=self.card.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=60)
        )

    def test_notif_stale_opts_in_to_the_staleness_scan(self):
        call_command("notify_stale_cards")
        self.assertEqual(
            Notification.objects.filter(action_type=Notification.ActionType.STALE).count(), 1
        )

    def test_notif_due_soon_alone_no_longer_opts_in_to_staleness(self):
        self.owner.notif_stale = False
        self.owner.notif_due_soon = True
        self.owner.save(update_fields=["notif_stale", "notif_due_soon"])
        call_command("notify_stale_cards")
        self.assertEqual(Notification.objects.count(), 0)

    def test_staleness_has_no_email_preference_and_sends_no_mail(self):
        self.owner.email = "split@example.test"
        self.owner.save(update_fields=["email"])
        mail.outbox = []
        with self.captureOnCommitCallbacks(execute=True):
            call_command("notify_stale_cards")
        self.assertEqual(
            Notification.objects.filter(action_type=Notification.ActionType.STALE).count(), 1
        )
        self.assertEqual(mail.outbox, [])


class PreferenceApiTests(TestCase):
    """The four new fields are readable and writable on /api/v1/auth/me/."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="pref_user", password="pass", email="pref@example.test"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_new_fields_are_exposed_and_default_to_false(self):
        response = self.client.get("/api/v1/auth/me/")
        self.assertEqual(response.status_code, 200)
        for field in (
            "email_notif_card_assigned", "email_notif_mentioned",
            "email_notif_due_soon", "email_notif_card_moved", "notif_stale",
        ):
            self.assertIn(field, response.data)
            self.assertFalse(response.data[field])

    def test_fields_are_patchable(self):
        response = self.client.patch(
            "/api/v1/auth/me/", {"email_notif_mentioned": True}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.email_notif_mentioned)

    def test_a_user_cannot_set_another_users_preference(self):
        """The endpoint is always scoped to request.user — no id is accepted."""
        other = User.objects.create_user(username="pref_other", password="pass")
        response = self.client.patch(
            "/api/v1/auth/me/",
            {"id": other.pk, "email_notif_mentioned": True},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        other.refresh_from_db()
        self.assertFalse(other.email_notif_mentioned)
        self.user.refresh_from_db()
        self.assertTrue(self.user.email_notif_mentioned)

    def test_preferences_are_not_exposed_on_the_public_user_shape(self):
        other = User.objects.create_user(username="pref_public", password="pass")
        response = self.client.get("/api/v1/users/", {"search": other.username})
        self.assertEqual(response.status_code, 200)
        for row in response.json():
            self.assertNotIn("email_notif_mentioned", row)
            self.assertNotIn("email", row)
