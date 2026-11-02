"""
Scan all boards for stale cards and create in-app notifications.

Idempotent: skips cards that already received a staleness notification today.

Recipients opt in with the ``notif_stale`` preference (``notif_due_soon`` before
1.2 — see #356; existing values were copied across by accounts/0030).

Usage:
    python manage.py notify_stale_cards
    # Add to cron: 0 8 * * * docker compose run --rm backend python manage.py notify_stale_cards
"""
import datetime

from django.core.management.base import BaseCommand
from django.db.models import Prefetch
from django.utils import timezone

from accounts.models import User
from boards.models import Board, Card, CardMovement, Notification
from boards.notifications_email import drain_email_on_exit
from boards.services.notifications import clip_text, create_notifications, quoted_card_verb
from boards.utils import _get_effective_member_ids


class Command(BaseCommand):
    help = "Create notifications for cards that exceed the board staleness threshold."

    def handle(self, *args, **options):
        # The email for what this creates is sent on a daemon thread; without
        # the drain, exiting here (cron runs this one-shot) can drop it (#2077).
        with drain_email_on_exit(self.stderr):
            self._handle(*args, **options)

    def _handle(self, *args, **options):
        now = timezone.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        created_count = 0
        skipped_count = 0
        # Accumulated across boards and dispatched once. Per-board dispatch would
        # pay the funnel's recipient lookup and its on_commit hook once per board
        # for no benefit — staleness is a single scan, not a per-board event.
        all_notifications = []
        # Loaded once: the effective-membership check below must not issue a
        # site-admin query per board.
        site_admin_ids = set(
            User.objects.filter(can_access_all_content=True).values_list("id", flat=True)
        )

        for board in Board.objects.prefetch_related("memberships__user"):
            cutoff = now - datetime.timedelta(days=board.staleness_threshold_days)

            # Collect admin user IDs using the prefetch cache — .filter() on a
            # prefetched manager always re-queries the DB, so filter in Python instead.
            admin_users = {
                m.user_id for m in board.memberships.all() if m.role == "admin"
            }
            admin_users.add(board.owner_id)

            # Hoist user opt-in lookup: fetch all opted-in user IDs for this
            # board's potential recipients in one query instead of per-card.
            all_candidate_ids = set(admin_users)
            assignee_ids = set(
                Card.objects.filter(
                    board=board,
                    archived_at__isnull=True,
                    assignee_id__isnull=False,
                    column__is_done=False,
                ).values_list("assignee_id", flat=True).distinct()
            )
            all_candidate_ids |= assignee_ids
            # Recipients are limited to current, active board members, the
            # same rule notify_due_soon applies.
            all_candidate_ids &= _get_effective_member_ids(board, site_admin_ids)
            # notif_stale, not notif_due_soon (#356). The two events were sharing
            # one flag whose own UI label described the *other* one; migration
            # accounts/0030 copies every existing value across, so no user's
            # effective setting changes here.
            opted_in_ids = set(
                User.objects.filter(pk__in=all_candidate_ids, notif_stale=True, is_active=True)
                .values_list("pk", flat=True)
            )

            if not opted_in_ids:
                continue  # no one to notify for this board

            # Finished work is never stale (#1845): the board UI shows no aging
            # tint or badge for Done-column cards (#1841), so a digest entry
            # would land on a card with no stale signal. The same filter is
            # applied to the candidate-recipient query above so an assignee
            # whose only stale cards are Done is not counted as a recipient.
            # Prefetch movements ordered by -moved_at so .all()[0] uses the cache
            cards = (
                Card.objects.filter(
                    board=board, archived_at__isnull=True, column__is_done=False
                )
                .prefetch_related(
                    Prefetch(
                        "movements",
                        queryset=CardMovement.objects.order_by("-moved_at"),
                    )
                )
            )

            # Batch idempotency check: fetch all (card_id, recipient_id) pairs
            # already notified today in one query instead of per-card-per-user.
            # The Notification rows ARE the "already sent" record — there is no
            # separate ledger — so prune_notifications enforces a minimum
            # retention window rather than letting a prune erase this history.
            card_ids = list(cards.values_list("pk", flat=True))
            already_notified = set(
                Notification.objects.filter(
                    card_id__in=card_ids,
                    recipient_id__in=opted_in_ids,
                    action_type=Notification.ActionType.STALE,
                    created_at__gte=today_start,
                ).values_list("card_id", "recipient_id")
            )

            notifications_to_create = []

            for card in cards:
                # Use .all()[0] to hit the prefetch cache instead of .first()
                # which issues a separate ORDER BY + LIMIT 1 query per card.
                movements = card.movements.all()
                if movements:
                    last_mv = movements[0]
                    if last_mv.moved_at >= cutoff:
                        continue  # not stale
                    stale_since = last_mv.moved_at
                else:
                    if (now - card.created_at).days < board.staleness_threshold_days:
                        continue
                    stale_since = card.created_at

                days_stale = (now - stale_since).days
                # Board name is clipped too: it is user-controlled (max 200+) and sits in
                # the suffix, which would otherwise squeeze the title out.
                verb = quoted_card_verb(
                    "",
                    card.title,
                    f" hasn't moved in {days_stale} days (board: {clip_text(board.name, 100)})",
                )

                # Recipients: assignee + board admins, filtered to opted-in
                recipients = set(admin_users)
                if card.assignee_id:
                    recipients.add(card.assignee_id)
                recipients &= opted_in_ids

                for user_id in recipients:
                    if (card.pk, user_id) in already_notified:
                        skipped_count += 1
                        continue
                    notifications_to_create.append(
                        Notification(
                            recipient_id=user_id,
                            action_type=Notification.ActionType.STALE,
                            verb=verb,
                            card=card,
                            board=board,
                        )
                    )

            all_notifications.extend(notifications_to_create)

        if all_notifications:
            # Count rows the funnel wrote, not rows offered to it.
            created_count = len(create_notifications(all_notifications))

        self.stdout.write(
            self.style.SUCCESS(
                f"notify_stale_cards: {created_count} notifications created, {skipped_count} skipped (already sent today)."
            )
        )
