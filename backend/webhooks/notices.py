"""The "webhook disabled" notice (#863, owner decision D7).

Sent in-app and by email when a subscription is disabled automatically, to the
board's current effective admins. Email bypasses the recipient's opt-in
(``boards.notifications_email.MANDATORY_EMAIL_ACTIONS``) but still requires an
active account, current board access and a verified address.

Content is deliberately thin: the board name, the subscription id and the
reason code. Never the URL (it may be a credential) and never anything the
receiver sent back.
"""

from boards.models import Board, BoardMembership, Notification
from boards.permissions import GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN, get_board_role
from boards.services.notifications import clip_text, create_notifications
from boards.utils import _explicit_membership_roles, _group_inherited_roles

ADMIN_ROLES = frozenset({BoardMembership.Role.ADMIN, SITE_ADMIN})


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
    return sorted(u.pk for u in users if get_board_role(u, board) in ADMIN_ROLES)


def verb_for(subscription_id: int, reason: str, board_name: str) -> str:
    max_len = Notification._meta.get_field("verb").max_length
    lead = f"Webhook #{subscription_id} was turned off ({reason}) on "
    return f'{lead}"{clip_text(board_name, max_len - len(lead) - 2)}"'


def notify_disabled(subscription, reason: str):
    """Create the notice for every board admin. Call inside the disabling transaction."""
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
            for uid in board_admin_ids(board)
        ],
        context={"subscription_id": subscription.pk, "reason": reason},
    )
