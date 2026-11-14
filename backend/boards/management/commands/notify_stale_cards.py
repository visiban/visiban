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
from django.utils import timezone

from accounts.models import User
from boards.models import Board, Card, Notification
from boards.notifications_email import drain_email_on_exit
from boards.serializers import _annotate_is_stale
from boards.services.notifications import clip_text, create_notifications, quoted_card_verb
from boards.utils import _get_effective_member_ids

# Boards fetched per DB round trip, and notifications written per bulk_create.
BOARD_CHUNK_SIZE = 200
NOTIFICATION_CHUNK_SIZE = 500


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
        # Loaded once: the effective-membership check below must not issue a
        # site-admin query per board.
        site_admin_ids = set(
            User.objects.filter(can_access_all_content=True).values_list("id", flat=True)
        )

        # .iterator() streams boards instead of materializing every board (and,
        # formerly, every membership and user) on the instance (#1960). Only the
        # columns this command reads are loaded; _get_effective_member_ids needs
        # owner_id and group_id.
        boards = Board.objects.only(
            "id", "name", "owner_id", "group_id", "staleness_threshold_days"
        ).iterator(chunk_size=BOARD_CHUNK_SIZE)

        for board in boards:
            cutoff = now - datetime.timedelta(days=board.staleness_threshold_days)

            # Finished work is never stale (#1845): the board UI shows no aging
            # tint or badge for Done-column cards (#1841), so a digest entry
            # would land on a card with no stale signal. Staleness is decided in
            # SQL by the shared latest-movement subquery (_annotate_is_stale)
            # rather than by prefetching each card's full, unbounded movement
            # history just to read its newest row (#1960). Evaluated first so a
            # board with nothing stale costs this one query and skips the
            # membership, recipient and idempotency lookups entirely.
            stale_cards = list(
                _annotate_is_stale(
                    Card.objects.filter(
                        board=board, archived_at__isnull=True, column__is_done=False
                    ),
                    cutoff,
                ).filter(_is_stale_annotated=True)
            )
            if not stale_cards:
                continue

            admin_users = set(
                board.memberships.filter(role="admin").values_list("user_id", flat=True)
            )
            admin_users.add(board.owner_id)

            # Hoist user opt-in lookup: fetch all opted-in user IDs for this
            # board's potential recipients in one query instead of per-card.
            all_candidate_ids = set(admin_users)
            all_candidate_ids.update(
                c.assignee_id for c in stale_cards if c.assignee_id
            )
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

            # Batch idempotency check: fetch all (card_id, recipient_id) pairs
            # already notified today in one query instead of per-card-per-user.
            # The Notification rows ARE the "already sent" record — there is no
            # separate ledger — so prune_notifications enforces a minimum
            # retention window rather than letting a prune erase this history.
            already_notified = set(
                Notification.objects.filter(
                    card_id__in=[c.pk for c in stale_cards],
                    recipient_id__in=opted_in_ids,
                    action_type=Notification.ActionType.STALE,
                    created_at__gte=today_start,
                ).values_list("card_id", "recipient_id")
            )

            notifications_to_create = []

            for card in stale_cards:
                # A never-moved card falls back to its creation time, matching
                # the SQL stale predicate.
                stale_since = card._last_moved_at or card.created_at
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

            # Dispatched per board in bounded chunks so memory stays flat as the
            # instance grows, instead of one list and one bulk_create for every
            # notification on every board (#1960). Count rows the funnel wrote,
            # not rows offered to it.
            for start in range(0, len(notifications_to_create), NOTIFICATION_CHUNK_SIZE):
                chunk = notifications_to_create[start:start + NOTIFICATION_CHUNK_SIZE]
                created_count += len(create_notifications(chunk))

        self.stdout.write(
            self.style.SUCCESS(
                f"notify_stale_cards: {created_count} notifications created, {skipped_count} skipped (already sent today)."
            )
        )
