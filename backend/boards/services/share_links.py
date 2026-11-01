"""Public share link lifetime tied to the admin who enabled it (#1865).

``Board.share_enabled_by`` records the account that enabled the board's current
public share link. The link lasts only while that account keeps the standing
that let it enable sharing on that board: an active account whose effective
role there is board admin or site admin (the same check ``BoardViewSet.share``
applies). Standing is always re-derived from current state with
``get_board_role`` / ``get_board_roles``, so an account that is still an admin
another way (owner, a group admin role, all-content access) keeps the link.

Two halves, the same shape invite links use for their creator:

- ``share_enabler_has_standing`` is evaluated by the public view on every read,
  so a link stops answering the moment its enabler's standing lapses, whichever
  route (or race) caused it.
- ``revoke_lapsed_share_links`` clears the link on the board itself, called in
  the same transaction as the write that removed the standing, so the board's
  Sharing tab shows sharing as off and a later return of the standing does not
  bring the old link back.

A link whose ``share_enabled_by`` is NULL (one enabled before the field
existed) has no enabler whose standing could keep it (#1939):
``share_enabler_has_standing(None, board)`` is False, so the public view
refuses it and clears it with ``include_unrecorded=True``. The access-change
sweeps, scoped by enabler or by board, leave such links to the view. A board
admin who enables sharing again issues a new link that records them.
"""

from django.contrib.auth import get_user_model

from ..models import Board, BoardMembership

#: Effective roles that may enable sharing, and so keep a link alive.
SHARE_ADMIN_ROLES = frozenset({BoardMembership.Role.ADMIN, "site_admin"})


def share_enabler_has_standing(user, board):
    """True while *user* may still hold the public share link on *board*.

    *board* should be loaded with ``GROUP_ANCESTOR_SELECT_RELATED`` so the
    group walk in ``get_board_role`` reads from the ORM cache.
    """
    from ..permissions import get_board_role

    if user is None or not user.is_active:
        return False
    return get_board_role(user, board) in SHARE_ADMIN_ROLES


def share_link_state_payload(board):
    """The ``share_link.updated`` payload for *board*'s current share state (#1967).

    ``active`` is the ``/full/`` ``share_link_active`` rule: a stored token
    with a recorded enabler (an unrecorded link never resolves, #1939).
    ``expires_at`` is null when there is no live link, matching
    ``/full/`` ``share_token_expires_at``. The token and the enabler are never
    included: the token is shown once, from the share action's response
    (#1935), and the enabler is not returned by any endpoint or event (#1865).
    """
    active = board.share_token is not None and board.share_enabled_by_id is not None
    expires_at = board.share_token_expires_at if active else None
    return {
        "board_uid": board.uid,
        "active": active,
        "expires_at": expires_at.isoformat() if expires_at is not None else None,
    }


def record_share_link_updated(board, *, actor_id=None):
    """Persist ``share_link.updated`` for *board* and publish it on commit (#1967).

    Every write that enables, rotates or clears a share link calls this after
    the write, in the same transaction: the share action, ``_clear_lapsed``
    below, the deleted-enabler receiver in ``boards.models``, and a Django
    admin edit of ``share_token_expires_at`` on a live link
    (``BoardAdmin.save_model``). The
    ``board.updated`` those writes also record cannot carry the share state
    (``ADMIN_ONLY_BOARD_FIELDS`` drops it from every payload), so without this
    event an open admin session kept showing a revoked link as active. The
    event is admin-only (``boards.permissions.ADMIN_ONLY_EVENTS``): the
    consumer and the change feed withhold it from every role below admin.
    """
    from .. import broadcast as _broadcast

    return _broadcast.record_board_event(
        board.pk, _broadcast.EVT_SHARE_LINK_UPDATED, share_link_state_payload(board),
        actor_id=actor_id,
    )


def revoke_lapsed_share_links(*, enabler=None, board_ids=None, actor_id=None, include_unrecorded=False):
    """Clear the share links whose enabler no longer has standing on the board.

    Scope the check with *enabler* (a user or user pk: every board whose link
    that account enabled), *board_ids* (those boards, whoever enabled them), or
    both. Call it inside the transaction that made the access change, after the
    change is written, so the standing is judged on the new state and the
    revocation commits or rolls back with it. Returns the ids of the boards
    whose link was cleared, in pk order.

    *include_unrecorded* also clears, within the scope, links with no recorded
    enabler; they have no standing (module docstring). Only meaningful with
    *board_ids*: an *enabler* scope never matches them.

    Each clear is a conditional UPDATE that matches only while the board still
    carries the link that was judged (same enabler, same token), so a link an
    admin re-enabled meanwhile is never cleared by mistake. Each cleared board
    records ``board.updated`` and ``share_link.updated`` (persisted, published
    on commit), the same pair the share action records. The share fields are
    admin-only and stripped from ``board.updated``, so admin clients learn the
    link is off from ``share_link.updated``, which only admins receive (#1967).
    """
    from django.db import transaction

    from ..permissions import GROUP_ANCESTOR_SELECT_RELATED, get_board_roles

    if enabler is None and board_ids is None:
        raise ValueError("revoke_lapsed_share_links needs an enabler or board_ids")

    qs = Board.objects.filter(share_token__isnull=False)
    if not include_unrecorded:
        qs = qs.filter(share_enabled_by__isnull=False)
    if enabler is not None:
        qs = qs.filter(share_enabled_by=getattr(enabler, "pk", enabler))
    if board_ids is not None:
        board_ids = sorted({bid for bid in board_ids if bid is not None})
        if not board_ids:
            return []
        qs = qs.filter(pk=board_ids[0]) if len(board_ids) == 1 else qs.filter(pk__in=board_ids)
    boards = list(qs.select_related(GROUP_ANCESTOR_SELECT_RELATED).order_by("pk"))
    if not boards:
        return []

    by_enabler = {}
    for board in boards:
        by_enabler.setdefault(board.share_enabled_by_id, []).append(board)
    # A fresh read of each enabler: the caller's instance may predate the
    # change it just wrote (a flag cleared through update(), for instance).
    users = get_user_model().objects.in_bulk([uid for uid in by_enabler if uid is not None])

    lapsed = []
    for user_id, user_boards in by_enabler.items():
        # No recorded enabler (user_id None, include_unrecorded) lapses here too.
        user = users.get(user_id)
        if user is None or not user.is_active:
            lapsed.extend(user_boards)
            continue
        roles = get_board_roles(user, user_boards)
        lapsed.extend(b for b in user_boards if roles.get(b.pk) not in SHARE_ADMIN_ROLES)

    # Atomic on its own too (free when nested): each clear and its event row
    # commit together even for a caller outside a transaction.
    with transaction.atomic():
        return _clear_lapsed(lapsed, actor_id)


def _clear_lapsed(lapsed, actor_id):
    """Clear each judged link that is still in place; record the events per clear.

    Each clear records ``board.updated`` (kept for the clients that treat it
    as a "board changed" signal) and the admin-only ``share_link.updated``
    that carries the new share state (#1967).

    ``share_enabled_by_id=None`` in the match below is an IS NULL test, so an
    unrecorded link is cleared only while it is still unrecorded.
    """
    from .. import broadcast as _broadcast
    from ..serializers import BoardSerializer

    revoked = []
    for board in sorted(lapsed, key=lambda b: b.pk):
        # Clears the hash with the token (#1880). Keywords spelled out (the
        # columns of Board.SHARE_LINK_CLEARED): the group-placement entry-point
        # check reads update() keywords statically.
        updated = Board.objects.filter(
            pk=board.pk,
            share_enabled_by_id=board.share_enabled_by_id,
            share_token=board.share_token,
        ).update(
            share_token=None, share_token_hash=None, share_token_expires_at=None,
            share_enabled_by=None,
        )
        if not updated:
            continue
        board.clear_share_link()
        revoked.append(board.pk)
        _broadcast.record_board_event(
            board.pk, _broadcast.EVT_BOARD_UPDATED, BoardSerializer(board).data,
            actor_id=actor_id,
        )
        record_share_link_updated(board, actor_id=actor_id)
    return revoked
