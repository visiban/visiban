"""The "webhook disabled" notice (#863, owner decision D7).

Sent in-app and by email when a subscription is disabled automatically, to the
board's current effective admins and to the webhook's owner (its standing
principal, ``configured_by``) while the owner still has standing (decision #7). Email bypasses the recipient's opt-in
(``boards.notifications_email.MANDATORY_EMAIL_ACTIONS``) but still requires an
active account, current board access and a verified address.

Content is deliberately thin: the board name, the subscription id and the
reason code. Never the URL (it may be a credential) and never anything the
receiver sent back.
"""

from boards.models import Board, Notification
from boards.permissions import GROUP_ANCESTOR_SELECT_RELATED, get_board_role
from boards.services.notifications import clip_text, create_notifications
from boards.utils import _explicit_membership_roles, _group_inherited_roles

#: Plain-language label for each automatic reason code, shown beside the code
#: (which is printed too, so the email and the settings tab match).
REASON_LABELS = {
    "failures": "Repeated delivery failures",
    "cursor_expired": "Fell too far behind",
    "creator_lost_access": "Its creator lost access",
    "secret_unavailable": "Its stored secret can't be read",
}


def reason_label(reason: str) -> str:
    return REASON_LABELS.get(reason, reason)


def _admin_roles():
    # Imported lazily: dispatch imports this module.
    from .dispatch import STANDING_ROLES

    return STANDING_ROLES


def board_admin_ids(board) -> list[int]:
    """Ids of the accounts whose effective role on *board* is admin or site admin.

    Candidates are the board's own people (owner, explicit members, group
    members); each is then judged by ``get_board_role`` so the answer follows
    the role ladder exactly. Accounts that see the board only through
    instance-wide content access are not notified about every board on the
    instance.
    """
    from accounts.models import User

    candidates = {board.owner_id, *_explicit_membership_roles(board), *_group_inherited_roles(board)}
    candidates.discard(None)
    users = User.objects.filter(pk__in=candidates, is_active=True)
    return sorted(u.pk for u in users if get_board_role(u, board) in _admin_roles())


def verb_for(subscription_id: int, reason: str, board_name: str) -> str:
    """``A webhook on "Board" was turned off (webhook #12, failures)``."""
    max_len = Notification._meta.get_field("verb").max_length
    lead = "A webhook on "
    tail = f" was turned off (webhook #{subscription_id}, {reason})"
    return f'{lead}"{clip_text(board_name, max_len - len(lead) - len(tail) - 2)}"{tail}'


def recipient_ids(subscription, board) -> list[int]:
    """The board's admins plus the webhook's owner while the owner has standing.

    ``board_admin_ids`` leaves out accounts that see every board through
    instance-wide content access, so a site admin who set up a webhook on a
    board they are not a member of would otherwise never hear it stopped. The
    owner is added only while ``configurer_has_standing`` holds, so an owner
    who lost access (the ``creator_lost_access`` case) is not told about a
    board they can no longer see.
    """
    from .dispatch import configurer_has_standing

    ids = set(board_admin_ids(board))
    owner = subscription.configured_by
    if owner is not None and owner.pk not in ids and configurer_has_standing(owner, board):
        ids.add(owner.pk)
    return sorted(ids)


def notify_disabled(subscription, reason: str):
    """Create the notice for every recipient. Call inside the disabling transaction."""
    board = Board.objects.select_related("owner", GROUP_ANCESTOR_SELECT_RELATED).get(
        pk=subscription.board_id
    )
    verb = verb_for(subscription.pk, reason, board.name)
    return create_notifications(
        [
            Notification(
                recipient_id=uid,
                actor=None,
                action_type=Notification.ActionType.WEBHOOK_DISABLED,
                verb=verb,
                board=board,
            )
            for uid in recipient_ids(subscription, board)
        ],
        context={"subscription_id": subscription.pk, "reason": reason},
    )
