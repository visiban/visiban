"""Notify assignees of cards whose due date is within the next 24 hours (#356).

Recipients opt in with the ``notif_due_soon`` preference. Before 1.2 that flag
was, despite its name and its settings-UI label ("24h warning before a card you
own is due"), the opt-in for the *staleness* scan; #356 moved staleness to
``notif_stale`` so this flag finally means what it says.

Usage:
    python manage.py notify_due_soon
    # Add to cron: 0 7 * * * docker compose run --rm backend python manage.py notify_due_soon
"""
import datetime

from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import User
from boards.models import Card, Notification
from boards.services.notifications import create_notifications
from boards.utils import _get_effective_member_ids


class Command(BaseCommand):
    help = "Create notifications for cards due within the next 24 hours."

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=1,
            help=(
                "How far ahead to look, in whole days. The default of 1 is the "
                "documented 24-hour warning. Card.due_date is a DateField, so "
                "this is deliberately expressed in days rather than hours: "
                "there is no time-of-day to compare against."
            ),
        )

    def handle(self, *args, **options):
        horizon = max(options["days"], 0)
        # timezone.localdate() rather than date.today(): the window has to be
        # anchored to the instance's TIME_ZONE, or a run near UTC midnight on a
        # non-UTC install shifts the window by a day.
        today = timezone.localdate()
        window_end = today + datetime.timedelta(days=horizon)

        created_count = 0
        skipped_count = 0

        cards = list(
            Card.objects.filter(
                archived_at__isnull=True,
                assignee_id__isnull=False,
                due_date__gte=today,
                due_date__lte=window_end,
            ).select_related("board")
        )
        if not cards:
            self._report(0, 0)
            return

        assignee_ids = {c.assignee_id for c in cards}
        opted_in_ids = set(
            User.objects.filter(pk__in=assignee_ids, notif_due_soon=True)
            .values_list("pk", flat=True)
        )
        if not opted_in_ids:
            self._report(0, 0)
            return

        # An assignee can outlive their board membership: the FK is not cleared
        # when a member is removed. Notifying — and, with email on, mailing — a
        # card title to somebody who has lost access to the board is an
        # information disclosure, so re-check effective membership per board
        # rather than trusting the stale FK. One query per distinct board.
        members_by_board = {}
        # Hoisted: the site-admin set is identical for every board, so resolving
        # it inside the loop would cost one query per board.
        site_admin_ids = set(
            User.objects.filter(can_access_all_content=True).values_list("pk", flat=True)
        )

        # One query for the whole idempotency check. Reference point per card is
        # (due_date - horizon), the earliest moment this card could have entered
        # the window, so the oldest row that could matter is that many days back.
        earliest = today - datetime.timedelta(days=horizon)
        already = {}
        for card_id, recipient_id, created_at in Notification.objects.filter(
            card_id__in=[c.pk for c in cards],
            recipient_id__in=opted_in_ids,
            action_type=Notification.ActionType.DUE_SOON,
            created_at__gte=timezone.make_aware(
                datetime.datetime.combine(earliest, datetime.time.min),
                timezone.get_current_timezone(),
            ),
        ).values_list("card_id", "recipient_id", "created_at"):
            key = (card_id, recipient_id)
            if key not in already or created_at > already[key]:
                already[key] = created_at

        to_create = []
        for card in cards:
            if card.assignee_id not in opted_in_ids:
                continue

            board = card.board
            if board.pk not in members_by_board:
                members_by_board[board.pk] = _get_effective_member_ids(board, site_admin_ids)
            if card.assignee_id not in members_by_board[board.pk]:
                continue

            # Fire exactly once per (card, recipient, due_date).
            #
            # The window is [today, due_date], so a card is visible to this
            # command on up to `horizon + 1` consecutive days. Comparing against
            # "any DUE_SOON notification created on or after (due_date - horizon)"
            # collapses those runs into one notification — and, because the
            # reference point moves with due_date, a card whose due date is
            # *changed* correctly becomes eligible again.
            cutoff_date = card.due_date - datetime.timedelta(days=horizon)
            cutoff = timezone.make_aware(
                datetime.datetime.combine(cutoff_date, datetime.time.min),
                timezone.get_current_timezone(),
            )
            last_sent = already.get((card.pk, card.assignee_id))
            if last_sent is not None and last_sent >= cutoff:
                skipped_count += 1
                continue

            to_create.append(
                Notification(
                    recipient_id=card.assignee_id,
                    action_type=Notification.ActionType.DUE_SOON,
                    # Matches the string docs/features/notifications.md has
                    # documented since before the feature existed.
                    verb=f'"{card.title}" is due soon',
                    card=card,
                    board=board,
                )
            )
            created_count += 1

        if to_create:
            # One create_notifications call per due_date, because context is
            # per-event and the due date is the event. Cheap: a batch per
            # distinct date in a one-or-two-day window.
            by_due_date = {}
            for notification in to_create:
                by_due_date.setdefault(notification.card.due_date, []).append(notification)
            for due_date, batch in by_due_date.items():
                create_notifications(batch, context={"due_date": due_date.isoformat()})

        self._report(created_count, skipped_count)

    def _report(self, created_count, skipped_count):
        self.stdout.write(
            self.style.SUCCESS(
                f"notify_due_soon: {created_count} notifications created, "
                f"{skipped_count} skipped (already sent for this due date)."
            )
        )
