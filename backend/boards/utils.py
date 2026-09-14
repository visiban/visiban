"""Shared board utilities — mention parsing, notification, and board-creation helpers."""

import operator
import re
from functools import reduce


def resolve_board_template(template_slug):
    """Return the active BoardTemplate row to apply for a new board, or None.

    ``template_slug`` must already be the *validated* value from
    ``BoardSerializer.validated_data["template"]`` — an empty string for the
    omitted/blank case (BoardSerializer.validate() rejects any other value
    that doesn't match an active template's slug with a 400 before this is
    ever called, so a lookup miss here is not expected in normal operation).

    Blank resolves to the built-in default (``simple_kanban``) — this
    preserves the pre-#1115 contract for clients that don't send `template`
    at all. If even the default row is missing (e.g. an install's seed data
    has not run), this returns None and the caller creates a board with no
    template-driven columns, the same as the built-in "blank" template,
    rather than raising — a missing default should degrade gracefully, not
    500 every board creation on that install.
    """
    from .models import BoardTemplate

    slug = template_slug or "simple_kanban"
    return BoardTemplate.objects.filter(slug=slug, is_active=True).first()


def create_template_columns(board, template):
    """Create Column rows on *board* from *template*.columns_json.

    No-ops when *template* is None or has no columns (the "blank" template,
    or a missing default — see resolve_board_template()).

    Shared by BoardViewSet.perform_create (boards/views/boards.py) and
    GroupViewSet.boards() (groups/views.py) so both board-creation paths
    apply identical column data from the single BoardTemplate table —
    previously each read its own copy of a separate BOARD_TEMPLATES dict,
    and the two silently drifted from what GET /boards/templates/ listed
    (#1115).
    """
    from .models import Column

    if not template or not template.columns_json:
        return
    # .get() with fallbacks rather than col["name"]/col["color"] — a
    # template's columns_json can, in principle, come from a
    # boards.hooks.TEMPLATE_PROVIDERS-registered row (see
    # boards/template_sync.py) rather than only the built-in, trusted
    # BOARD_TEMPLATES data. This is a last line of defense: a malformed
    # column dict should render as an oddly-named/colored column, not a
    # 500 that fails board creation entirely.
    Column.objects.bulk_create([
        Column(
            board=board,
            name=col.get("name") or f"Column {i + 1}",
            position=i,
            color=col.get("color") or "#6B7280",
            allow_card_creation=(i == 0),
            is_done=bool(col.get("is_done", False)),
        )
        for i, col in enumerate(template.columns_json)
    ])


def extract_mentions(text: str) -> set:
    """Return the set of @usernames found in text.

    The negative lookbehind (?<!\\w) ensures that email-style patterns like
    user@example.com are not matched — only standalone @username tokens.
    """
    return set(re.findall(r"(?<!\w)@(\w+)", text))


def _get_effective_member_ids(board, site_admin_ids=None):
    """
    Return the set of user IDs that are effective members of the board.

    Includes direct board memberships, the board owner, site admins, and all
    group ancestors (up to 6 levels) so group-inherited access is respected.

    ``site_admin_ids`` may be passed by callers that have already loaded the
    site-admin set (e.g. BoardFullSerializer.get_cards()) to avoid a duplicate
    ``can_access_all_content`` query on the same request.
    """
    from accounts.models import User

    # Use the prefetch cache populated by get_board_for_user() when available
    # to avoid a live membership query that duplicates already-loaded data.
    prefetched = getattr(board, "_prefetched_memberships", None)
    if prefetched is not None:
        eff_ids = {m.user_id for m in prefetched}
    else:
        eff_ids = set(board.memberships.values_list("user_id", flat=True))
    eff_ids.add(board.owner_id)
    if site_admin_ids is not None:
        eff_ids.update(site_admin_ids)
    else:
        eff_ids.update(User.objects.filter(can_access_all_content=True).values_list("id", flat=True))
    if board.group_id:
        # Use the pre-computed group member IDs when BoardFullSerializer's
        # to_representation() has already cached them on the board instance (#695).
        # This avoids a redundant GroupMembership query when both get_cards() and
        # get_members() call _get_effective_member_ids() in the same request.
        cached_group_ids = getattr(board, "_cached_group_member_ids", None)
        if cached_group_ids is not None:
            eff_ids.update(cached_group_ids)
        else:
            # Collect ancestor group IDs first, then load all memberships in a
            # single query instead of issuing one query per ancestor level.
            ancestor_ids = []
            node = board.group
            depth = 0
            while node and depth < 6:
                ancestor_ids.append(node.pk)
                node = getattr(node, "parent", None)
                depth += 1
            if ancestor_ids:
                from groups.models import GroupMembership

                eff_ids.update(
                    GroupMembership.objects.filter(group_id__in=ancestor_ids)
                    .values_list("user_id", flat=True)
                )
    return eff_ids


def _get_assignable_member_ids(board, site_admin_ids=None):
    """Return the set of user IDs that may be assigned to a card on this board.

    Viewers must not appear in card assignee dropdowns — assigning a viewer
    implies work ownership, which contradicts the viewer role's read-only
    semantics.  Only admin, member, and collaborator roles are eligible.

    Mirrors the structure of _get_effective_member_ids() but filters out
    viewer-role memberships at both the direct and group-inherited levels.
    The board owner and site admins are always included (they have implicit
    admin-level access).
    """
    from accounts.models import User
    from boards.models import BoardMembership

    _VIEWER = BoardMembership.Role.VIEWER

    prefetched = getattr(board, "_prefetched_memberships", None)
    if prefetched is not None:
        eff_ids = {m.user_id for m in prefetched if m.role != _VIEWER}
    else:
        eff_ids = set(
            board.memberships.exclude(role=_VIEWER).values_list("user_id", flat=True)
        )
    eff_ids.add(board.owner_id)
    if site_admin_ids is not None:
        eff_ids.update(site_admin_ids)
    else:
        eff_ids.update(User.objects.filter(can_access_all_content=True).values_list("id", flat=True))
    if board.group_id:
        ancestor_ids = []
        node = board.group
        depth = 0
        while node and depth < 6:
            ancestor_ids.append(node.pk)
            node = getattr(node, "parent", None)
            depth += 1
        if ancestor_ids:
            from groups.models import GroupMembership

            eff_ids.update(
                GroupMembership.objects.filter(group_id__in=ancestor_ids)
                .exclude(role=GroupMembership.Role.VIEWER)
                .values_list("user_id", flat=True)
            )
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

    # Re-fetch to get the latest mentioned_user_ids — the lambda closure captures
    # the card object at on_commit registration time, which may be stale.
    # select_related("board") avoids a deferred FK hit when _get_effective_member_ids
    # and the Notification bulk_create both access fresh_card.board below.
    try:
        fresh_card = Card.objects.select_related("board").get(pk=card.pk)
    except Card.DoesNotExist:
        return

    eff_ids = _get_effective_member_ids(fresh_card.board)

    already_notified = set(fresh_card.mentioned_user_ids or [])
    # Case-insensitive username lookup: @mentions typed in any casing
    # should match the user regardless of how the username is stored.
    from django.db.models import Q
    username_q = reduce(operator.or_, (Q(username__iexact=u) for u in added_usernames))
    recipients = (
        User.objects.filter(username_q, pk__in=eff_ids, notif_mentioned=True)
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
