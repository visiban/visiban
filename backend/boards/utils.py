"""Shared board utilities — mention parsing and notification helpers."""

import re


def extract_mentions(text: str) -> set:
    """Return the set of @usernames found in text.

    The negative lookbehind (?<!\\w) ensures that email-style patterns like
    user@example.com are not matched — only standalone @username tokens.
    """
    return set(re.findall(r"(?<!\w)@(\w+)", text))


def _get_effective_member_ids(board):
    """
    Return the set of user IDs that are effective members of the board.

    Includes direct board memberships, the board owner, site admins, and all
    group ancestors (up to 6 levels) so group-inherited access is respected.
    """
    from accounts.models import User

    eff_ids = set(board.memberships.values_list("user_id", flat=True))
    eff_ids.add(board.owner_id)
    eff_ids.update(User.objects.filter(can_access_all_content=True).values_list("id", flat=True))
    if board.group_id:
        node = board.group
        depth = 0
        while node and depth < 6:
            eff_ids.update(node.memberships.values_list("user_id", flat=True))
            node = node.parent
            depth += 1
    return eff_ids


def notify_new_mentions(card, actor, old_text: str, new_text: str) -> None:
    """
    Fire MENTIONED notifications for usernames that appear in new_text but
    not in old_text, skipping users already recorded in card.mentioned_user_ids.

    The re-notification guard (card.mentioned_user_ids) prevents duplicate
    notifications when a description is edited without removing an existing
    mention. The guard is intentionally stored on the card rather than querying
    the Notification table — notification records may be pruned, so relying on
    them for idempotency would silently break.

    Must be called via transaction.on_commit() to ensure the card row exists
    in the database before we read it back.
    """
    from accounts.models import User
    from .models import Card, Notification

    added_usernames = extract_mentions(new_text) - extract_mentions(old_text)
    if not added_usernames:
        return

    eff_ids = _get_effective_member_ids(card.board)

    # Re-fetch to get the latest mentioned_user_ids — the lambda closure captures
    # the card object at on_commit registration time, which may be stale.
    try:
        fresh_card = Card.objects.get(pk=card.pk)
    except Card.DoesNotExist:
        return

    already_notified = set(fresh_card.mentioned_user_ids or [])
    recipients = (
        User.objects.filter(username__in=added_usernames, pk__in=eff_ids, notif_mentioned=True)
        .exclude(pk=actor.pk)
        .exclude(pk__in=already_notified)
    )

    new_ids = []
    notifications = []
    for u in recipients:
        notifications.append(
            Notification(
                recipient=u,
                actor=actor,
                action_type=Notification.ActionType.MENTIONED,
                verb=f'{actor.username} mentioned you in "{fresh_card.title}"',
                card=fresh_card,
                board=fresh_card.board,
            )
        )
        new_ids.append(u.pk)

    if notifications:
        Notification.objects.bulk_create(notifications)
        Card.objects.filter(pk=fresh_card.pk).update(
            mentioned_user_ids=list(already_notified | set(new_ids))
        )
