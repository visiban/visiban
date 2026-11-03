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
    from visiban.colors import normalize_hex_color

    from .column_policy import policy_or_none
    from .models import Column

    if not template or not template.columns_json:
        return
    # .get() with fallbacks rather than col["name"]/col["color"] — a
    # template's columns_json can, in principle, come from a
    # boards.hooks.TEMPLATE_PROVIDERS-registered row (see
    # boards/template_sync.py) rather than only the built-in, trusted
    # BOARD_TEMPLATES data. This is a last line of defense: a malformed
    # column dict should render as an oddly-named/colored column, not a
    # 500 that fails board creation entirely. The color gets the same rule:
    # a non-hex provider value falls back to the default rather than being
    # stored (#2093).
    Column.objects.bulk_create([
        Column(
            board=board,
            name=col.get("name") or f"Column {i + 1}",
            position=i,
            color=normalize_hex_color(col.get("color")) or "#6B7280",
            allow_card_creation=(i == 0),
            is_done=bool(col.get("is_done", False)),
            # Explicit column policy (#1101). policy_or_none, not the
            # raising validator: a malformed provider-supplied policy yields
            # a column with no policy rather than a failed board creation.
            policy=policy_or_none(col.get("policy")),
        )
        for i, col in enumerate(template.columns_json)
    ])


def extract_mentions(text: str) -> set:
    """Return the set of @usernames found in text.

    The negative lookbehind (?<!\\w) ensures that email-style patterns like
    user@example.com are not matched — only standalone @username tokens.
    """
    return set(re.findall(r"(?<!\w)@(\w+)", text))


def _explicit_membership_roles(board):
    """Return ``{user_id: role}`` for every explicit BoardMembership row.

    Uses the prefetch cache populated by get_board_for_user() when available.
    The stored role is returned as is (possibly outside the enum): callers
    decide what an unrecognized value means.
    """
    prefetched = getattr(board, "_prefetched_memberships", None)
    if prefetched is not None:
        return {m.user_id: m.role for m in prefetched}
    return dict(board.memberships.values_list("user_id", "role"))


def _group_inherited_roles(board):
    """Return ``{user_id: role}`` inherited through the board's group chain.

    Mirrors ``boards.permissions._nearest_ancestor_role``: the closest ancestor
    group the user belongs to wins, and a stored group role outside the enum is
    skipped. One GroupMembership query (none when the serializer has already
    cached the rows on the board instance, #695/#927).
    """
    if not board.group_id:
        return {}
    from boards.permissions import _group_ancestor_ids
    from groups.models import GroupMembership

    ancestor_ids = _group_ancestor_ids(board)
    if not ancestor_ids:
        return {}
    rows = getattr(board, "_cached_group_memberships", None)
    if rows is None:
        rows = GroupMembership.objects.filter(group_id__in=ancestor_ids).only(
            "group_id", "user_id", "role"
        )
    rank = {gid: i for i, gid in enumerate(ancestor_ids)}
    allowed = GroupMembership.Role.values
    best = {}
    for gm in rows:
        if gm.role not in allowed or gm.group_id not in rank:
            continue
        cur = best.get(gm.user_id)
        if cur is None or rank[gm.group_id] < cur[0]:
            best[gm.user_id] = (rank[gm.group_id], gm.role)
    return {uid: role for uid, (_, role) in best.items()}


def _get_effective_member_ids(board, site_admin_ids=None):
    """
    Return the set of user IDs that are effective members of the board.

    Includes direct board memberships, the board owner, site admins, and
    group-inherited members (up to 6 ancestor levels).

    Follows the same role-resolution ladder as ``get_board_role``: a user with
    an explicit BoardMembership row is judged by that row alone, so a row whose
    role is outside the enum (which grants no access) does not make the user a
    member, and group membership does not re-admit them. Group-inherited users
    are added only when they have no explicit row.

    ``site_admin_ids`` may be passed by callers that have already loaded the
    site-admin set (e.g. BoardFullSerializer.get_cards()) to avoid a duplicate
    ``can_access_all_content`` query on the same request.
    """
    from accounts.models import User
    from boards.models import BoardMembership

    explicit = _explicit_membership_roles(board)
    allowed = BoardMembership.Role.values
    eff_ids = {uid for uid, role in explicit.items() if role in allowed}
    eff_ids.add(board.owner_id)
    if site_admin_ids is not None:
        eff_ids.update(site_admin_ids)
    else:
        eff_ids.update(User.objects.filter(can_access_all_content=True).values_list("id", flat=True))
    eff_ids.update(
        uid for uid in _group_inherited_roles(board) if uid not in explicit
    )
    return eff_ids


def _get_assignable_member_ids(board, site_admin_ids=None):
    """Return the set of user IDs that may be assigned to a card on this board.

    Viewers must not appear in card assignee dropdowns — assigning a viewer
    implies work ownership, which contradicts the viewer role's read-only
    semantics.  Only admin, member, and collaborator roles are eligible.

    Derived from the same ladder as ``get_board_role``.  An explicit
    BoardMembership row overrides anything inherited from a group, so a user
    with an explicit row is judged by that row only (a viewer or out-of-enum
    row excludes them even if a group would have made them a member); the
    group-inherited role is consulted only for users with no explicit row, and
    it is the nearest ancestor's role, as in ``get_board_role``.  The board
    owner and site admins are always included (implicit admin-level access).
    """
    from accounts.models import User
    from boards.models import BoardMembership

    _VIEWER = BoardMembership.Role.VIEWER
    allowed = BoardMembership.Role.values

    explicit = _explicit_membership_roles(board)
    eff_ids = {uid for uid, role in explicit.items() if role in allowed and role != _VIEWER}
    eff_ids.add(board.owner_id)
    if site_admin_ids is not None:
        eff_ids.update(site_admin_ids)
    else:
        eff_ids.update(User.objects.filter(can_access_all_content=True).values_list("id", flat=True))
    eff_ids.update(
        uid
        for uid, role in _group_inherited_roles(board).items()
        if uid not in explicit and role != _VIEWER
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
    from .services.notifications import create_notifications, quoted_card_verb

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
                verb=quoted_card_verb(f"{actor.username} mentioned you in", fresh_card.title),
                card=fresh_card,
                board=fresh_card.board,
            )
        )
        new_ids.append(u.pk)

    if notifications:
        # Write the re-notification guard BEFORE handing the batch to
        # create_notifications. This function is always called from an
        # on_commit hook, so no transaction is open and the nested on_commit
        # inside create_notifications runs inline — meaning delivery happens
        # before this line would otherwise be reached. If delivery then blocked
        # or crashed, mentioned_user_ids would be left unwritten and the same
        # users would be notified all over again on the next description save.
        Card.objects.filter(pk=fresh_card.pk).update(
            mentioned_user_ids=list(already_notified | set(new_ids))
        )
        created = create_notifications(notifications, context={"source": "description"})
        # The funnel can drop recipients it does not deliver to. Record only the
        # users who actually received a row, so a dropped user is notified of
        # this mention if they become eligible later. Known limitation: this
        # rewrite starts from the already_notified snapshot taken at the top of
        # the function, so it can overwrite ids a concurrent save added in the
        # meantime. It only runs when the funnel dropped someone (rare), and the
        # first write above has always used the same snapshot pattern.
        created_ids = {n.recipient_id for n in created}
        if created_ids != set(new_ids):
            Card.objects.filter(pk=fresh_card.pk).update(
                mentioned_user_ids=list(already_notified | created_ids)
            )
