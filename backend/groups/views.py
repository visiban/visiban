import logging

import datetime

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from rest_framework.generics import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, AllowAny

from accounts.permissions import TokenHasScope
from visiban.authorization import invite_creator_is_valid, principal_is_active
from visiban.permissions import MustNotHavePendingPasswordChange, MustNotHavePendingUsernameChange
from visiban.utils import get_client_ip
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from visiban.invite_email import InviteEmailBadRequestSerializer, InviteEmailErrorSerializer
from . import broadcast as _group_broadcast
from .invite_registration import link_can_register
from .models import (
    GROUP_PARENT_CHAIN, Group, GroupFavorite, GroupLabel, GroupMembership, GroupInviteLink,
)
from .serializers import (
    GroupSerializer, GroupDetailSerializer, GroupLabelSerializer, GroupMembershipSerializer,
    GroupInviteLinkSerializer, GroupInviteLinkCreateSerializer, GroupInviteLinkEmailSerializer,
    _ALLOWED_PRIORITY_SLUGS, _MAX_ALLOWED_PRIORITIES_LENGTH,
)

# Module-level only for @extend_schema, which needs the class at class-body
# evaluation time (same reason boards/serializers.py imports GroupBriefSerializer
# module-level). Every runtime use inside the action bodies below still imports
# boards.serializers/.models lazily, so this does not change the app's
# dependency direction (groups still has no *runtime* import of boards) — it
# only makes the response type visible to schema generation.
from boards.serializers import BoardSerializer as _BoardSerializer

logger = logging.getLogger(__name__)


def _sanitize_group_allowed_priorities(value):
    """Bound and clean a group's allowed_priorities before copying it onto a new board.

    ``GroupSerializer.validate_allowed_priorities`` caps, dedupes, and validates
    every ``allowed_priorities`` value written through the API since #1169 — but
    a ``Group`` row saved *before* that validator existed can still hold raw,
    unbounded, undeduped, or invalid-slug data, and ``GroupViewSet.boards()``
    reads that field straight off the model via ``group.get_allowed_priorities()``,
    bypassing the validator entirely (#1187). Without this, a pre-#1169 group
    would keep propagating its bad data onto every new board created in it until
    the group itself is next saved through ``GroupSerializer``. Not a new attack
    surface introduced by #1169 — this is residual data hygiene on rows that
    predate the fix, so invalid entries are silently dropped instead of raising:
    this path creates a board, it doesn't validate a client-submitted group write.

    Slicing to the cap *before* iterating (rather than after) keeps this O(cap)
    even against a pathologically long stale row, mirroring the L1 hardening
    note in ``GroupSerializer.validate_allowed_priorities``.
    """
    if not isinstance(value, list):
        return []
    valid = set(_ALLOWED_PRIORITY_SLUGS)
    seen = set()
    deduped = []
    for p in value[:_MAX_ALLOWED_PRIORITIES_LENGTH]:
        if isinstance(p, str) and p in valid and p not in seen:
            seen.add(p)
            deduped.append(p)
    return deduped


# Pending emailed invite links per group (#731) — separate from the 5 shareable
# links, because each one is single-use and addressed to one person.
GROUP_MAX_PENDING_EMAILED_INVITES = 50


def _require_group_admin(user, group):
    """Raise PermissionDenied if user is not an admin of this group or any ancestor.

    Collects all ancestor PKs in a single traversal, then issues one batched
    membership query instead of one query per level to avoid N+1 on deep trees.
    Traversal is capped at _GROUP_TRAVERSAL_MAX_DEPTH levels.
    """
    from rest_framework.exceptions import PermissionDenied
    from django.utils.translation import gettext_lazy as _
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH
    if getattr(user, "can_access_all_content", False):
        return
    ancestor_ids = []
    node = group
    depth = 0
    while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        ancestor_ids.append(node.pk)
        node = node.parent
        depth += 1
    if GroupMembership.objects.filter(
        group_id__in=ancestor_ids,
        user=user,
        role=GroupMembership.Role.ADMIN,
    ).exists():
        return
    raise PermissionDenied(_("You must be a group admin to perform this action."))


def sender_is_group_admin(link) -> bool:
    """True when the invite link's creator is active and still administers the group.

    Re-checked at preview and join, not only at creation (#1490): a creator who
    was deactivated or demoted since minting the link must not keep adding
    people through it. Mirrors ``boards.invites.sender_is_board_admin``.
    Deactivation also revokes the link outright (``AdminUserDeactivateView``);
    this covers demotion and any path that leaves the link active.

    This is the group rule behind ``visiban.authorization.invite_creator_is_valid``;
    entry points (preview, join) call that, not this (#1517).
    """
    from rest_framework.exceptions import PermissionDenied

    # Memoized on the instance: the public preview also asks this through
    # ``link_can_register`` and the ancestor walk should run once per request.
    cached = getattr(link, "_sender_is_group_admin", None)
    if cached is not None:
        return cached
    creator = link.created_by
    result = False
    if principal_is_active(creator):
        try:
            _require_group_admin(creator, link.group)
            result = True
        except PermissionDenied:
            result = False
    link._sender_is_group_admin = result
    return result


def _require_group_member(user, group):
    """Raise PermissionDenied if user is not a member of this group or any ancestor.

    Collects all ancestor PKs in a single traversal, then issues one batched
    membership query instead of one query per level to avoid N+1 on deep trees.
    Traversal is capped at _GROUP_TRAVERSAL_MAX_DEPTH levels.
    """
    from rest_framework.exceptions import PermissionDenied
    from django.utils.translation import gettext_lazy as _
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH
    if getattr(user, "can_access_all_content", False):
        return
    ancestor_ids = []
    node = group
    depth = 0
    while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
        ancestor_ids.append(node.pk)
        node = node.parent
        depth += 1
    if GroupMembership.objects.filter(
        group_id__in=ancestor_ids,
        user=user,
    ).exists():
        return
    raise PermissionDenied(_("You must be a group member to perform this action."))


def _revoke_lapsed_admin_invite_links(user, group=None):
    """Revoke ``user``'s unused invite links they can no longer administer (#1510).

    Called after the user's membership in ``group`` was removed or demoted, or
    (``group=None``) after a site flag that granted admin rights everywhere
    (``can_access_all_content``) was cleared. The join/preview recheck
    (``sender_is_group_admin``) already refuses such a link, but it would
    otherwise stay ``is_active`` — shown as active to other admins and counted
    toward the 5-active-link cap.

    Links are queried first, in one query: most users hold none, and this
    avoids walking the group subtree for them. With ``group`` set, only links
    on that group or a descendant qualify — judged from the loaded ancestor
    chain, since admin rights are inherited down the tree. A link is kept when
    the user still administers its group by another path (a direct admin row
    there or on another ancestor).

    Inherited admin rights are only honored within ``_GROUP_TRAVERSAL_MAX_DEPTH``
    (6) ancestor levels, the same cap as ``_require_group_admin``; an admin
    row further up the tree does not keep a link alive.

    Must run inside the caller's ``transaction.atomic()``; the
    ``invite_link.revoked`` broadcasts are deferred to ``on_commit``.
    """
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH

    links = list(
        GroupInviteLink.objects.select_for_update(of=("self",)).select_related(
            GROUP_PARENT_CHAIN,
        ).filter(created_by=user, is_active=True, used_at__isnull=True)
    )
    if group is not None:
        def _in_subtree(link_group):
            node, depth = link_group, 0
            while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
                if node.pk == group.pk:
                    return True
                node = node.parent
                depth += 1
            return False

        links = [lk for lk in links if _in_subtree(lk.group)]
    if not links:
        return
    # Revocation housekeeping only (#1517): this walk mirrors
    # sender_is_group_admin in bulk. Preview and join re-check through
    # visiban.authorization.invite_creator_is_valid, so drift here can leave a
    # link listed as active but cannot let it admit anyone.
    if user.is_active and getattr(user, "can_access_all_content", False):
        return  # still passes _require_group_admin everywhere
    admin_group_ids = set(
        GroupMembership.objects.filter(
            user=user, role=GroupMembership.Role.ADMIN,
        ).values_list("group_id", flat=True)
    )

    def _still_admin(link_group):
        node, depth = link_group, 0
        while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
            if node.pk in admin_group_ids:
                return True
            node = node.parent
            depth += 1
        return False

    lapsed = [(lk.pk, lk.group_id) for lk in links if not (user.is_active and _still_admin(lk.group))]
    if not lapsed:
        return
    # used_at__isnull=True: a consumed single-use link keeps its history (#1445).
    GroupInviteLink.objects.filter(
        pk__in=[pk for pk, _ in lapsed], used_at__isnull=True,
    ).update(is_active=False)

    def _announce():
        from .broadcast import broadcast_group_event
        for link_id, group_id in lapsed:
            broadcast_group_event(group_id, _group_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link_id})

    transaction.on_commit(_announce)


def _revoke_lapsed_subtree_invite_links(group):
    """Revoke unused invite links in ``group``'s subtree whose creators lost admin (#1513).

    Run after a re-parent: admin rights are inherited down the tree, so a
    creator who administered a link's group only through the old ancestor chain
    no longer does. Delegates per creator to ``_revoke_lapsed_admin_invite_links``
    so there is a single definition of "still administers". Must run inside the
    caller's ``transaction.atomic()``.
    """
    from .models import _GROUP_TRAVERSAL_MAX_DEPTH

    # Bound the scan to the moved subtree (one query per level, at most the
    # traversal depth) rather than loading every active link system-wide.
    # A link's group sits at most depth-1 levels below ``group`` for the
    # inherited-admin walk to reach it.
    subtree_ids = {group.pk}
    frontier = [group.pk]
    for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH - 1):
        frontier = list(
            Group.objects.filter(parent_id__in=frontier).values_list("pk", flat=True)
        )
        if not frontier:
            break
        subtree_ids.update(frontier)
    creators = {
        link.created_by_id: link.created_by
        for link in GroupInviteLink.objects.select_related("created_by").filter(
            group_id__in=subtree_ids, created_by__isnull=False,
            is_active=True, used_at__isnull=True,
        )
    }
    for creator in creators.values():
        _revoke_lapsed_admin_invite_links(creator, group)


class GroupViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for groups, scoped to groups the requesting user is a member of."""

    # Groups are only ever addressed by integer pk (no slug/uid lookup field
    # exists or is exposed to clients). Constraining the router's pk segment
    # to digits prevents a literal sibling path under the same "groups/"
    # prefix — e.g. groups/join/<token>/ — from being swallowed by a detail
    # route (groups/<pk>/star/, /boards/, /members/, ...) whenever the token
    # or path segment happens to match an action name (#1202).
    lookup_value_regex = r"\d+"

    # Explicitly enumerate the global default permission chain (#989) so that
    # any future @action(permission_classes=[...]) override is visibly diffed
    # against the baseline rather than silently dropping the pending-change
    # gates that the global default supplies.
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    serializer_class = GroupSerializer

    def get_serializer_class(self):
        # Use the richer GroupDetailSerializer only for single-object retrieval.
        # The list endpoint omits `ancestors` to avoid per-group N+1 queries.
        if self.action == "retrieve":
            return GroupDetailSerializer
        return GroupSerializer

    def get_queryset(self):
        from .models import get_accessible_group_ids
        user = self.request.user
        # Pre-fetch the full ancestor chain for all actions (not just "retrieve")
        # so _require_group_admin() and _require_group_member() read from already-
        # loaded parent objects instead of issuing up to 5 lazy FK queries per
        # write action on nested groups. Six levels matches _GROUP_TRAVERSAL_MAX_DEPTH.
        related = ["owner"] + ["__".join(["parent"] * d) for d in range(1, 7)]
        qs = Group.objects.filter(
            id__in=get_accessible_group_ids(user)
        ).select_related(*related).prefetch_related(
            # Prefetch shared labels to avoid one query per group in list responses.
            "labels",
        ).annotate(
            # Annotate counts so GroupSerializer can read _member_count etc.
            # directly from the object instead of issuing 3-4 extra queries per group.
            _member_count=Count("memberships", distinct=True),
            _board_count=Count("boards", distinct=True),
            _subgroup_count=Count("subgroups", distinct=True),
            _is_starred=Exists(
                GroupFavorite.objects.filter(user=user, group=OuterRef("pk"))
            ),
        )
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        return qs

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["request"] = self.request
        return context

    def perform_create(self, serializer):
        parent = serializer.validated_data.get("parent")
        if parent is not None:
            # validated_data gives a bare instance from PrimaryKeyRelatedField —
            # no ancestor chain is loaded. Re-fetch with the same select_related
            # depth used in get_queryset() so _require_group_admin() traverses
            # already-loaded objects instead of issuing one lazy query per level.
            _ancestor_related = ["__".join(["parent"] * d) for d in range(1, 7)]
            parent = Group.objects.select_related(*_ancestor_related).get(pk=parent.pk)
            _require_group_admin(self.request.user, parent)
        with transaction.atomic():
            group = serializer.save(owner=self.request.user)
            GroupMembership.objects.create(
                group=group, user=self.request.user, role=GroupMembership.Role.ADMIN
            )
            # Broadcast group.created so sidebar trees refresh in real time
            # for other admins watching the parent group (#998).
            # Re-fetch with annotations so the payload exposes the same
            # _member_count / _board_count / _subgroup_count / _is_starred
            # fields as every other group payload.
            annotated = self.get_queryset().get(pk=group.pk)
            group_data = GroupSerializer(annotated, context={"request": self.request}).data
            parent_id = group.parent_id

            def _broadcast_created(gid=group.pk, pid=parent_id, data=group_data):
                from .broadcast import broadcast_group_event
                # Fanout: the new group's own channel (so anyone subscribed
                # by id refreshes), and the parent's channel (so the parent's
                # subgroup list updates).
                broadcast_group_event(gid, _group_broadcast.EVT_GROUP_CREATED, data)
                if pid is not None:
                    broadcast_group_event(pid, _group_broadcast.EVT_GROUP_CREATED, data)

            transaction.on_commit(_broadcast_created)

    def update(self, request, *args, **kwargs):
        # Only group admins may rename or re-parent a group.
        # The default ModelViewSet inherits no admin guard here — add it explicitly.
        group = self.get_object()
        _require_group_admin(request.user, group)
        return self._update_with_broadcast(request, group, partial=False, args=args, kwargs=kwargs)

    def partial_update(self, request, *args, **kwargs):
        group = self.get_object()
        _require_group_admin(request.user, group)
        return self._update_with_broadcast(request, group, partial=True, args=args, kwargs=kwargs)

    def _update_with_broadcast(self, request, group, *, partial, args, kwargs):
        """Run the default DRF update path then broadcast group.updated (#998).

        Re-fetches through ``get_queryset`` so the broadcast payload includes
        the count annotations and resolves any rename / re-parent change.
        """
        old_parent_id = group.parent_id
        with transaction.atomic():
            response = super().partial_update(request, *args, **kwargs) if partial else super().update(request, *args, **kwargs)
            group.refresh_from_db(fields=["parent"])
            if group.parent_id != old_parent_id:
                # Inherited admin rights moved with the subtree (#1513).
                _revoke_lapsed_subtree_invite_links(group)
            annotated = self.get_queryset().get(pk=group.pk)
            group_data = GroupSerializer(annotated, context={"request": request}).data

            def _broadcast_updated(gid=group.pk, data=group_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_GROUP_UPDATED, data)

            transaction.on_commit(_broadcast_updated)
        return response

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if group.owner != request.user and not getattr(request.user, "can_access_all_content", False):
            # JSON body, like every other 403 here: a bodyless 403 with no
            # Content-Type contradicts the documented JSON error shape (#1570).
            return Response(
                {"detail": "Only the group owner can delete this group."},
                status=status.HTTP_403_FORBIDDEN,
            )
        gid = group.pk
        parent_id = group.parent_id
        with transaction.atomic():
            group.delete()
            payload = {"id": gid}

            def _broadcast_deleted(g=gid, pid=parent_id, pl=payload):
                from .broadcast import broadcast_group_event
                broadcast_group_event(g, _group_broadcast.EVT_GROUP_DELETED, pl)
                if pid is not None:
                    # Sidebar tree under the parent needs to refresh too.
                    broadcast_group_event(pid, _group_broadcast.EVT_GROUP_DELETED, pl)

            transaction.on_commit(_broadcast_deleted)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Members
    # ------------------------------------------------------------------

    # pagination_class=None: the response is the plain member list (direct +
    # inherited), never paginated. Without it drf-spectacular wraps the schema
    # in the viewset's default paginated-list envelope (same bug #1142 fixed
    # for reorder actions), which never matches what this action returns.
    @extend_schema(responses=GroupMembershipSerializer(many=True))
    @action(detail=True, methods=["get"], pagination_class=None)
    def members(self, request, pk=None):
        group = self.get_object()
        _require_group_member(request.user, group)

        from accounts.serializers import BoardUserSerializer

        # Direct memberships
        direct = list(group.memberships.select_related("user"))
        seen_user_ids = {m.user_id for m in direct}

        result = [
            {
                "id": m.id,
                "user": BoardUserSerializer(m.user).data,
                "role": m.role,
                "joined_at": m.joined_at,
                "is_inherited": False,
                "inherited_from": None,
            }
            for m in direct
        ]

        # Inherited memberships from ancestor groups (nearest ancestor wins,
        # ancestors() returns nearest-first).
        # Collect ancestor PKs in a single traversal (uses the prefetched chain,
        # no extra queries), then issue ONE batched membership query instead of
        # one SELECT per ancestor level to avoid N+1 on deep hierarchies.
        ancestors = group.ancestors()
        ancestor_ids = [a.pk for a in ancestors]
        if ancestor_ids:
            ancestor_map = {a.pk: a for a in ancestors}
            inherited_memberships = (
                GroupMembership.objects
                .filter(group_id__in=ancestor_ids)
                .select_related("user", "group")
            )
            # Re-apply nearest-first ordering by sorting against the ancestors list.
            ancestor_rank = {pk: i for i, pk in enumerate(ancestor_ids)}
            sorted_memberships = sorted(inherited_memberships, key=lambda m: ancestor_rank.get(m.group_id, 999))
            for m in sorted_memberships:
                if m.user_id not in seen_user_ids:
                    ancestor = ancestor_map[m.group_id]
                    result.append({
                        "id": None,
                        "user": BoardUserSerializer(m.user).data,
                        "role": m.role,
                        "joined_at": m.joined_at,
                        "is_inherited": True,
                        "inherited_from": ancestor.name,
                    })
                    seen_user_ids.add(m.user_id)

        return Response(result)

    @extend_schema(summary="Update a member's role", methods=["PATCH"], responses=GroupMembershipSerializer)
    @extend_schema(summary="Remove a member", methods=["DELETE"], responses={204: None})
    @action(detail=True, methods=["patch", "delete"], url_path=r"members/(?P<user_id>[^/.]+)")
    def update_member(self, request, pk=None, user_id=None):
        from accounts.models import User
        group = self.get_object()
        _require_group_admin(request.user, group)
        target_user = get_object_or_404(User, pk=user_id)
        if target_user.is_site_admin and not request.user.is_site_admin:
            return Response(
                {"detail": "Cannot modify a site admin's group membership."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if request.method == "DELETE":
            # Only set up WS eviction when a membership row actually exists.
            # An idempotent DELETE of a non-existent membership must not
            # broadcast member.removed — the user never had group-inherited
            # access, so there are no stale connections to close.
            membership_exists = GroupMembership.objects.filter(
                group=group, user=target_user
            ).exists()

            if not membership_exists:
                GroupMembership.objects.filter(group=group, user=target_user).delete()
                return Response(status=status.HTTP_204_NO_CONTENT)

            # Before deleting, snapshot board IDs in this group's subtree where
            # the user has no *direct* BoardMembership. Boards with a direct
            # membership are unaffected by group membership changes; boards
            # without one relied entirely on group-inherited access.
            #
            # We collect the board IDs now (inside the transaction) so the
            # on_commit callback does not need to re-query the group tree under
            # a new connection after the membership row is gone.
            #
            # Trade-off: this does not consider other group paths (e.g. the
            # user belongs to a sibling group that also covers the same board).
            # To avoid false positives, the on_commit callback re-checks
            # get_board_role() after the deletion has committed. Only boards
            # where access is truly gone receive the eviction broadcast.
            from .models import _GROUP_TRAVERSAL_MAX_DEPTH as _MAX_DEPTH
            from boards.models import Board, BoardMembership as _BM

            # Collect IDs of all groups in this group's subtree (including itself)
            # so we cover inherited access through child groups as well.
            subtree_ids = {group.pk}
            frontier = {group.pk}
            for _ in range(_MAX_DEPTH):
                if not frontier:
                    break
                children = set(
                    Group.objects.filter(parent__in=frontier)
                    .exclude(id__in=subtree_ids)
                    .values_list("id", flat=True)
                )
                subtree_ids |= children
                frontier = children

            # Boards in the subtree where the user has NO direct board membership —
            # these are the boards whose access was inherited purely from group membership.
            direct_board_ids = set(
                _BM.objects.filter(
                    board__group_id__in=subtree_ids, user=target_user
                ).values_list("board_id", flat=True)
            )
            candidate_board_ids = list(
                Board.objects.filter(group_id__in=subtree_ids)
                .exclude(id__in=direct_board_ids)
                .values_list("id", flat=True)
            )

            removed_user_id = target_user.id

            with transaction.atomic():
                GroupMembership.objects.filter(group=group, user=target_user).delete()
                # A removed admin's links must not linger as active (#1510).
                _revoke_lapsed_admin_invite_links(target_user, group)

                def _evict_stale_ws(
                    uid=removed_user_id,
                    board_ids=candidate_board_ids,
                ):
                    """Broadcast member.removed to boards where the user lost all access.

                    Re-checks get_board_role() after the deletion has committed so
                    we only evict connections on boards where the group membership
                    was the sole access path. Users who retain access via a direct
                    board membership or another group path are not evicted.
                    """
                    from boards.broadcast import record_board_event
                    from boards.models import Board as _Board
                    from boards.permissions import get_board_role as _get_role
                    from accounts.models import User as _User

                    try:
                        user_obj = _User.objects.get(pk=uid)
                    except _User.DoesNotExist:
                        return

                    # Batch-fetch all candidate boards in one query rather than
                    # one SELECT per board (O(n) → O(1) round-trips).
                    board_map = {
                        b.pk: b
                        for b in _Board.objects.filter(pk__in=board_ids).select_related(
                            "group",
                            "group__parent",
                            "group__parent__parent",
                            "group__parent__parent__parent",
                            "group__parent__parent__parent__parent",
                            "group__parent__parent__parent__parent__parent",
                        )
                    }
                    for bid in board_ids:
                        board_obj = board_map.get(bid)
                        if board_obj is None:
                            continue
                        if _get_role(user_obj, board_obj) is None:
                            # This callback already runs post-commit — the role is
                            # deliberately re-checked after the deletion has landed
                            # — so the feed row gets its own short transaction
                            # rather than joining one that is already closed.
                            with transaction.atomic():
                                record_board_event(bid, _group_broadcast.EVT_MEMBER_REMOVED, {"user_id": uid})

                transaction.on_commit(_evict_stale_ws)

                # Additive: notify the group channel so other admins viewing the
                # group page see the members list converge in real time. This is
                # distinct from the board-channel eviction above (which closes
                # stale board connections) — the group channel drives the members
                # panel. New event type; no existing payload shape changed (#1051).
                group_id = group.pk

                def _broadcast_group_member_removed(gid=group_id, uid=removed_user_id):
                    from .broadcast import broadcast_group_event
                    # member.* mirrors the board channel's member.added/updated/
                    # removed naming so one frontend socket layer handles both.
                    broadcast_group_event(gid, _group_broadcast.EVT_MEMBER_REMOVED, {"user_id": uid})

                transaction.on_commit(_broadcast_group_member_removed)

            return Response(status=status.HTTP_204_NO_CONTENT)
        # PATCH — update role
        membership = get_object_or_404(GroupMembership, group=group, user=target_user)
        role = request.data.get("role")
        if role not in GroupMembership.Role.values:
            return Response({"detail": f"Must be one of: {', '.join(GroupMembership.Role.values)}"}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            membership.role = role
            membership.save()
            # A demoted admin's links must not linger as active (#1510).
            if role != GroupMembership.Role.ADMIN:
                _revoke_lapsed_admin_invite_links(target_user, group)
            # Pre-build the payload before registering the on_commit callback
            # so the closure carries plain data, not an ORM instance (#998).
            membership_data = GroupMembershipSerializer(membership).data
            group_id = group.pk

            def _broadcast_membership_updated(gid=group_id, data=membership_data):
                from .broadcast import broadcast_group_event
                # member.* mirrors the board channel's member.added/updated/removed
                # naming so a single frontend socket layer handles both channels.
                broadcast_group_event(gid, _group_broadcast.EVT_MEMBER_UPDATED, data)

            transaction.on_commit(_broadcast_membership_updated)
        return Response(membership_data)

    # ------------------------------------------------------------------
    # Subgroups
    # ------------------------------------------------------------------

    # pagination_class=None: returns the full subgroup list in one payload, never paginated.
    @extend_schema(
        summary="List direct subgroups of a group",
        responses=GroupSerializer(many=True),
    )
    @action(detail=True, methods=["get"], pagination_class=None)
    def subgroups(self, request, pk=None):
        group = self.get_object()
        _require_group_member(request.user, group)
        # Subgroup visibility follows the documented RBAC inheritance model:
        # parent-group membership implies visibility into descendant groups.
        # This aligns `subgroups` with `descendant_boards`, the sidebar tree,
        # and get_accessible_group_ids — previously the odd one out (see
        # commit 7ca7b6c9 "Finding 4", reversed for #846). Without this, a
        # member added to a parent group sees "0 boards" and no
        # "Show subgroup boards" toggle because the toggle renders only when
        # this endpoint returns subgroups, yet descendant-boards would
        # already expose those same boards if the UI knew to ask.
        from .models import get_accessible_group_ids
        accessible_ids = get_accessible_group_ids(request.user)
        subgroups = group.subgroups.filter(id__in=accessible_ids)
        # Annotate and prefetch so GroupSerializer avoids per-subgroup queries —
        # mirrors the approach in get_queryset().
        subgroups = subgroups.select_related("owner", "parent").prefetch_related("labels").annotate(
            _member_count=Count("memberships", distinct=True),
            _board_count=Count("boards", distinct=True),
            _subgroup_count=Count("subgroups", distinct=True),
            _is_starred=Exists(
                GroupFavorite.objects.filter(user=request.user, group=OuterRef("pk"))
            ),
        )
        return Response(GroupSerializer(subgroups, many=True, context={"request": request}).data)

    # ------------------------------------------------------------------
    # Boards
    # ------------------------------------------------------------------

    # pagination_class=None: GET returns the full board list in one payload, never paginated.
    @extend_schema(summary="List boards directly in a group", methods=["GET"], responses=_BoardSerializer(many=True))
    @extend_schema(
        summary="Create a board inside a group",
        methods=["POST"],
        request=_BoardSerializer,
        responses={201: _BoardSerializer},
    )
    @action(detail=True, methods=["get", "post"], pagination_class=None)
    def boards(self, request, pk=None):
        from boards.models import Board, Swimlane
        from boards.serializers import BoardSerializer

        group = self.get_object()
        _require_group_member(request.user, group)

        if request.method == "GET":
            # Group membership implies access to all boards in the group —
            # no separate BoardMembership required. This means a viewer-role
            # group member can see all board names and metadata in the group
            # even without an explicit BoardMembership row. This is intentional:
            # adding someone to a group grants visibility into that group's
            # boards. Operators should document this in their onboarding guides
            # (see docs/features/rbac/roles.md).
            # Annotations mirror BoardViewSet.get_queryset() so BoardSerializer
            # can use the cached values instead of issuing 3 extra queries per board.
            from boards.models import BoardFavorite
            boards = (
                Board.objects.filter(group=group)
                .select_related("owner")
                .annotate(
                    _member_count=Count("memberships", distinct=True),
                    _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
                    _archived_card_count=Count("cards", filter=Q(cards__archived_at__isnull=False), distinct=True),
                    _is_starred=Exists(
                        BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)
                    ),
                )
            )
            return Response(BoardSerializer(boards, many=True, context={"request": request}).data)

        # POST — create a new board inside this group
        _require_group_admin(request.user, group)
        serializer = BoardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Wrap the entire creation sequence in a transaction so a failure in any
        # step (column bulk_create, swimlane create, label copy, allowed_priorities
        # save) rolls back the board and membership — preventing orphaned rows.
        # Mirrors BoardViewSet.perform_create() in boards/views/boards.py.
        with transaction.atomic():
            board = serializer.save(owner=request.user, group=group)
            # Create an explicit BoardMembership for the owner so they appear in the
            # board's member list. BoardViewSet.perform_create() does this too; without
            # it the owner relies on the implicit owner check in get_board_role(), but
            # no membership row would exist, causing the member list to appear empty.
            from boards.models import BoardMembership as _BM
            _BM.objects.create(board=board, user=request.user, role=_BM.Role.ADMIN)

            # `template` was already validated by BoardSerializer.is_valid()
            # above (unknown explicit slugs get a 400 before this point) —
            # resolve the same BoardTemplate row BoardViewSet.perform_create
            # uses, and apply it with the same shared helper, so group-scoped
            # board creation can no longer drift from the top-level endpoint
            # (previously this read its own separate BOARD_TEMPLATES dict
            # copy and never set is_done on any column — #1115).
            from boards.utils import create_template_columns, resolve_board_template
            template = resolve_board_template(serializer.validated_data.get("template", ""))
            create_template_columns(board, template)

            swimlane_name = ((request.data.get("swimlane_name") or "").strip() or "General")[:255]
            Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

            # Apply group defaults: copy shared labels and allowed priorities
            from boards.models import Label as BoardLabel
            # list() evaluates the queryset once; .exists() + iteration would fire two queries.
            group_labels = list(group.labels.all())
            if group_labels:
                BoardLabel.objects.bulk_create([
                    BoardLabel(board=board, name=gl.name, color=gl.color)
                    for gl in group_labels
                ], ignore_conflicts=True)

            # Sanitized rather than copied raw (#1187) — see
            # _sanitize_group_allowed_priorities for why a raw model-level
            # save here would bypass BoardSerializer.validate_allowed_priorities
            # and could propagate a pre-#1169 group's unbounded/undeduped data.
            allowed = _sanitize_group_allowed_priorities(group.get_allowed_priorities())
            if allowed != ["low", "medium", "high", "urgent"]:
                board.allowed_priorities = allowed
                board.save(update_fields=["allowed_priorities"])

            # Re-fetch with annotations so BoardSerializer.get_member_count / card_count /
            # is_starred reads from annotation fast-paths instead of issuing 3 fallback queries
            # — both for the broadcast payload below and for the response.
            from django.db.models import Q as _Q
            from boards.models import BoardFavorite as _BoardFavorite
            board = Board.objects.select_related("owner", "group").annotate(
                _member_count=Count("memberships", distinct=True),
                _card_count=Count("cards", filter=_Q(cards__archived_at__isnull=True), distinct=True),
                _archived_card_count=Count("cards", filter=_Q(cards__archived_at__isnull=False), distinct=True),
                _is_starred=Exists(_BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
            ).get(pk=board.pk)

            # Broadcast board.created so live sessions (group dashboards, sidebars)
            # can refresh their board list without a manual reload. Mirrors the
            # broadcast in BoardViewSet.perform_create so the event contract is
            # identical regardless of which endpoint created the board. Deferred
            # with on_commit so subscribers never see a board that later rolls back.
            from boards.broadcast import broadcast_board_event as _broadcast_board_event
            from boards.broadcast import persist_board_event as _persist_board_event
            from .broadcast import broadcast_group_event as _broadcast_group_event
            _board_id = board.id
            _board_event_payload = BoardSerializer(board, context={"request": request}).data
            _group_id = group.id
            # Persisted inside this transaction (#1114); the board and group
            # channels keep firing from one on_commit callback.
            _event_id = _persist_board_event(
                _board_id, _group_broadcast.EVT_BOARD_CREATED, _board_event_payload,
                actor_id=request.user.id,
            )
            def _broadcast_created(
                bid=_board_id, bd=_board_event_payload, gid=_group_id, eid=_event_id,
            ):
                _broadcast_board_event(bid, _group_broadcast.EVT_BOARD_CREATED, bd, event_id=eid)
                # Powers live refresh of GroupDetail's boards list (#753).
                _broadcast_group_event(gid, _group_broadcast.EVT_BOARD_CREATED, bd)
            transaction.on_commit(_broadcast_created)

        return Response(BoardSerializer(board, context={"request": request}).data, status=status.HTTP_201_CREATED)

    # ------------------------------------------------------------------
    # Descendant boards
    # ------------------------------------------------------------------

    # pagination_class=None: returns the full descendant board list in one payload, never paginated.
    @extend_schema(
        summary="List boards in a group and all its descendant subgroups",
        responses=_BoardSerializer(many=True),
    )
    @action(detail=True, methods=["get"], url_path="descendant-boards", pagination_class=None)
    def descendant_boards(self, request, pk=None):
        """Return all boards in this group and all its descendants that the user can access.

        This endpoint answers the question "what boards live anywhere inside this group
        subtree?" — including boards in deeply nested subgroups.  It powers the GroupDetail
        page's board list and the sidebar's auto-expand logic for deeply nested boards.

        The traversal uses get_accessible_group_ids() which already caps at
        _GROUP_TRAVERSAL_MAX_DEPTH, so we avoid unbounded recursion here too.
        """
        from boards.models import Board, BoardFavorite
        from boards.serializers import BoardSerializer
        from .models import get_accessible_group_ids, _GROUP_TRAVERSAL_MAX_DEPTH

        group = self.get_object()
        _require_group_member(request.user, group)

        # Collect accessible group IDs for this user, then filter to only those
        # that are descendants of the target group (including the group itself).
        accessible_ids = get_accessible_group_ids(request.user)

        # Walk down from the target group to find all descendant group IDs.
        # Bounded BFS: at most _GROUP_TRAVERSAL_MAX_DEPTH (=6) round-trips,
        # one query per level. A recursive CTE would collapse this to a
        # single query but adds PG-specific raw SQL; the fixed cap keeps
        # the cost predictable and well below problematic levels (#793).
        descendant_ids = {group.pk}
        frontier = {group.pk}
        for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH):
            if not frontier:
                break
            children = set(
                Group.objects.filter(parent__in=frontier)
                .exclude(id__in=descendant_ids)
                .values_list("id", flat=True)
            )
            descendant_ids |= children
            frontier = children

        # Intersect with what the user is allowed to see.
        visible_descendant_ids = descendant_ids & accessible_ids

        boards = (
            Board.objects.filter(group_id__in=visible_descendant_ids)
            # ``group__parent`` joins the immediate parent so
            # GroupBriefSerializer.parent_name (a method field reading
            # ``group.parent.name``)
            # doesn't issue a per-board lookup when the response is serialized.
            # #845 adds ancestors via a dedicated bulk map, but parent_name
            # is a separate field path that has its own N+1 if not joined here.
            .select_related("owner", "group", "group__parent")
            .annotate(
                _member_count=Count("memberships", distinct=True),
                _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
                _archived_card_count=Count("cards", filter=Q(cards__archived_at__isnull=False), distinct=True),
                _is_starred=Exists(
                    BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)
                ),
            )
        )

        # Build a one-query ancestor map for every group we may need to resolve
        # while serializing — the descendants plus any ancestor of the target
        # group. Without this, GroupBriefSerializer.get_ancestors would walk
        # parent pointers per board (#845 N+1 mitigation).
        ancestor_ids = {g.pk for g in group.ancestors()}
        map_ids = visible_descendant_ids | ancestor_ids | {group.pk}
        group_ancestor_map = {
            g["id"]: {"name": g["name"], "parent_id": g["parent_id"]}
            for g in Group.objects.filter(pk__in=map_ids).values("id", "name", "parent_id")
        }

        # Force ``?expand=group`` internally so BoardSerializer returns the
        # GroupBriefSerializer payload (including ancestors) for every board —
        # the GroupDetail boards list needs the full relative path to render
        # its metadata column (#845). Uses the ``_force_expand`` context flag
        # rather than mutating the request so the public expand API is unchanged.
        context = {
            "request": request,
            "_force_expand": {"group"},
            "group_ancestor_map": group_ancestor_map,
        }
        return Response(BoardSerializer(boards, many=True, context=context).data)

    # ------------------------------------------------------------------
    # Ownership transfer
    # ------------------------------------------------------------------

    @action(detail=True, methods=["post"], url_path="transfer-ownership")
    def transfer_ownership(self, request, pk=None):
        from rest_framework.exceptions import PermissionDenied
        # A JSON body that parses to a non-mapping (a bare number/string/array/
        # null/bool — valid JSON, just not a JSON *object*) makes
        # `request.data.get(...)` below raise AttributeError, uncaught, as an
        # unhandled 500 instead of the documented 400 (#1120 baseline finding
        # — same class as CardViewSet.move's fix, found separately by
        # schemathesis's negative-data fuzzing on this endpoint).
        if not isinstance(request.data, dict):
            return Response(
                {"detail": "Request body must be a JSON object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        group = self.get_object()

        # Only current owner can transfer
        if group.owner_id != request.user.id:
            raise PermissionDenied("Only the group owner can transfer ownership.")

        new_owner_id = request.data.get("new_owner_id")
        confirmation = request.data.get("confirmation", "")

        # Require typing the group name as confirmation
        if confirmation != group.name:
            return Response(
                {"detail": "Confirmation does not match the group name."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # New owner must be a current admin member
        try:
            membership = GroupMembership.objects.get(group=group, user_id=new_owner_id)
        except GroupMembership.DoesNotExist:
            return Response(
                {"detail": "New owner must already be a group member."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if membership.role != GroupMembership.Role.ADMIN:
            return Response(
                {"detail": "New owner must be an admin of this group."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Transfer: new owner gets owner role, previous owner becomes admin
        from django.db import transaction
        with transaction.atomic():
            group.owner_id = new_owner_id
            group.save(update_fields=["owner_id"])
            # Ensure previous owner stays as admin member
            GroupMembership.objects.update_or_create(
                group=group, user=request.user,
                defaults={"role": GroupMembership.Role.ADMIN},
            )
            # Re-fetch through ``get_queryset`` so the ``_member_count``,
            # ``_board_count``, ``_subgroup_count`` and ``_is_starred``
            # annotations are populated.  Without the annotations the
            # GroupSerializer method fields fall through to four live count
            # subqueries each, doubled across the broadcast and response
            # serializations — eight avoidable queries per request (#993).
            annotated = self.get_queryset().get(pk=group.pk)
            group_data = GroupSerializer(annotated, context={"request": request}).data

            def _broadcast_transfer(gid=group.pk, data=group_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_GROUP_UPDATED, data)

            transaction.on_commit(_broadcast_transfer)

        # Note (#952): the board channel intentionally does not receive an
        # ownership-transferred event.  Board UI surfaces (header, settings,
        # toolbar) do not show group ownership; only GroupDetail does, and it
        # already refetches on the existing group-channel ``group.updated``
        # event.  Adding a board-channel fanout would create permanent
        # contract surface (events cannot be removed without a major bump)
        # for no client benefit.

        return Response(group_data)

    # ------------------------------------------------------------------
    # Invite links
    # ------------------------------------------------------------------

    @extend_schema(summary="List invite links for a group", methods=["GET"], responses=GroupInviteLinkSerializer(many=True))
    @extend_schema(
        summary="Create an invite link for a group",
        methods=["POST"],
        request=GroupInviteLinkCreateSerializer,
        # The raw token is appended to GroupInviteLinkSerializer's own fields
        # by hand below (never persisted) — GroupInviteLink.token in
        # frontend/src/types/index.ts is optional for exactly this reason.
        responses={201: GroupInviteLinkSerializer},
    )
    # pagination_class=None (#1359 sweep): GET returns the full link list as a
    # bare array, never paginated — same envelope drift as saved-filters.
    @action(detail=True, methods=["get", "post"], url_path="invite-links", pagination_class=None)
    def invite_links(self, request, pk=None):
        group = self.get_object()
        _require_group_admin(request.user, group)

        if request.method == "GET":
            # Include consumed single-use links so admins can audit past usage.
            links = GroupInviteLink.objects.filter(
                Q(group=group) & (Q(is_active=True) | Q(used_at__isnull=False))
            ).select_related("created_by").order_by("created_at")
            return Response(GroupInviteLinkSerializer(links, many=True).data)

        # POST — create a new invite link (max 5 active per group)
        # Active count excludes consumed single-use links — they are dead weight —
        # and emailed links (#731), which have their own cap in
        # invite_link_send so a round of emailed invites never blocks the admin
        # from minting a shareable link.
        active_count = GroupInviteLink.objects.filter(
            group=group, is_active=True, used_at__isnull=True,
            delivery=GroupInviteLink.Delivery.LINK,
        ).count()
        if active_count >= 5:
            return Response(
                {"detail": "Maximum of 5 active invite links per group."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        create_serializer = GroupInviteLinkCreateSerializer(data=request.data)
        if not create_serializer.is_valid():
            return Response(create_serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        validated = create_serializer.validated_data
        expires_at = None
        if validated["expiry_days"] is not None:
            expires_at = timezone.now() + datetime.timedelta(days=validated["expiry_days"])

        link, raw_token = GroupInviteLink.generate(
            group=group,
            created_by=request.user,
            name=validated["name"],
            role=validated["role"],
            expires_at=expires_at,
            single_use=validated["single_use"],
        )
        data = GroupInviteLinkSerializer(link).data
        data["token"] = raw_token
        return Response(data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Email a single-use invite link to one address",
        request=GroupInviteLinkEmailSerializer,
        responses={
            202: inline_serializer(
                name="GroupInviteEmailSent",
                fields={
                    "detail": drf_serializers.CharField(),
                    "sent_to": drf_serializers.CharField(),
                    "delivery": drf_serializers.CharField(required=False),
                },
            ),
            400: InviteEmailBadRequestSerializer,
            403: InviteEmailErrorSerializer,
            502: InviteEmailErrorSerializer,
        },
    )
    @action(detail=True, methods=["post"], url_path="invite-links/send")
    def invite_link_send(self, request, pk=None):
        """Mint a single-use link and email it to one address (#731).

        Enumeration: the response is identical whether the address belongs to a
        member, an existing non-member user, or nobody, and the mail is always
        sent — otherwise a group admin could probe which addresses have accounts
        on the instance. The raw token only ever travels in the email; it is
        never returned here.
        """
        from visiban import invite_email

        if not invite_email.invite_email_enabled():
            return Response(
                {
                    "code": invite_email.CODE_INVITE_EMAIL_DISABLED,
                    "detail": "Sending invites by email is disabled on this instance.",
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        group = self.get_object()
        _require_group_admin(request.user, group)

        serializer = GroupInviteLinkEmailSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        validated = serializer.validated_data

        with transaction.atomic():
            # Lock the group row so two concurrent sends cannot both read a
            # count of 49 and overshoot the emailed-link cap.
            Group.objects.select_for_update().filter(pk=group.pk).first()
            pending_emailed = GroupInviteLink.objects.filter(
                group=group,
                delivery=GroupInviteLink.Delivery.EMAIL,
                is_active=True,
                used_at__isnull=True,
                expires_at__gt=timezone.now(),
            ).count()
            if pending_emailed >= GROUP_MAX_PENDING_EMAILED_INVITES:
                return Response(
                    {
                        "code": "invite_email_cap_reached",
                        "detail": (
                            f"Maximum of {GROUP_MAX_PENDING_EMAILED_INVITES} pending emailed "
                            "invites per group. Revoke some or wait for them to expire."
                        ),
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Throttles last, so a request refused for any other reason
            # (permission, validation, cap) spends no budget. Raising here
            # rolls the transaction back before anything is minted.
            recorded_throttles = invite_email.check_send_throttles(request, self, group_id=group.pk)
            link, raw_token = GroupInviteLink.generate(
                group=group,
                created_by=request.user,
                role=validated["role"],
                expires_at=timezone.now() + datetime.timedelta(days=validated["expiry_days"]),
                single_use=True,
                delivery=GroupInviteLink.Delivery.EMAIL,
            )

            def _broadcast_invite_created(gid=group.pk, lid=link.pk):
                # Minimal payload, like invite_link.revoked: group-channel
                # subscribers include non-admin members, so clients refetch the
                # admin-only list rather than receiving link details here.
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_INVITE_LINK_CREATED, {"id": lid})

            transaction.on_commit(_broadcast_invite_created)

        # Sent after the commit, never inside the transaction: an SMTP session
        # must not run while the group row lock is held.
        message = invite_email.build_group_invite_message(
            group_name=group.name,
            inviter_name=request.user.username,
            raw_token=raw_token,
            expires_at=link.expires_at,
            to=validated["email"],
        )
        error_code = invite_email.send_invite_message(
            message, link_pk=link.pk, prefix=link.prefix, actor_id=request.user.pk, kind="group",
        )
        if error_code is not None:
            invite_email.refund_send_throttles(recorded_throttles)
            # A link whose email never left would sit in the pending list as a
            # live credential nobody holds — revoke it so the admin can retry.
            with transaction.atomic():
                GroupInviteLink.objects.filter(pk=link.pk).update(is_active=False)

                def _broadcast_invite_revoked(gid=group.pk, lid=link.pk):
                    from .broadcast import broadcast_group_event
                    broadcast_group_event(gid, _group_broadcast.EVT_INVITE_LINK_REVOKED, {"id": lid})

                transaction.on_commit(_broadcast_invite_revoked)
            return Response(
                {
                    "code": error_code,
                    "detail": "The invite email could not be sent. The link was revoked.",
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        body = {"detail": "Invite sent", "sent_to": validated["email"]}
        if invite_email.delivers_to_console():
            body["delivery"] = "console"
        return Response(body, status=status.HTTP_202_ACCEPTED)

    # link_id is digits-only (#731): without the constraint this pattern also
    # matched "invite-links/send/" and, depending on route order, answered the
    # send endpoint's POST with 405.
    @action(detail=True, methods=["delete"], url_path=r"invite-links/(?P<link_id>\d+)")
    def revoke_invite_link(self, request, pk=None, link_id=None):
        group = self.get_object()
        _require_group_admin(request.user, group)
        link = get_object_or_404(GroupInviteLink, pk=link_id, group=group, is_active=True)
        # A consumed single-use link must not be revoked: doing so would flip
        # is_active=False on a link that already has used_at set, producing an
        # ambiguous state where status() returns "revoked" instead of "used",
        # silently discarding the consumption history from the audit list.
        if link.used_at is not None:
            return Response(
                {"detail": "This link has already been consumed and cannot be revoked."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            link.is_active = False
            link.save(update_fields=["is_active"])
            # Additive: notify the group channel so other admins with the invite
            # panel open see the link drop to revoked in real time rather than
            # showing it as active until reload. New event type; deferred to
            # on_commit so it never fires on a rolled-back revoke (#1051).
            revoked_group_id = link.group_id
            revoked_link_id = link.pk

            def _broadcast_invite_revoked(gid=revoked_group_id, lid=revoked_link_id):
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_INVITE_LINK_REVOKED, {"id": lid})

            transaction.on_commit(_broadcast_invite_revoked)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Board defaults (shared labels, allowed priorities, default role)
    # ------------------------------------------------------------------

    @extend_schema(
        summary="List a group's shared label library", methods=["GET"],
        responses=GroupLabelSerializer(many=True),
    )
    @extend_schema(
        summary="Create a group shared label", methods=["POST"],
        request=GroupLabelSerializer, responses={201: GroupLabelSerializer},
    )
    # pagination_class=None: GET returns the full label library in one payload, never paginated.
    @action(detail=True, methods=["get", "post"], url_path="labels", pagination_class=None)
    def group_labels(self, request, pk=None):
        """GET/POST group-level shared label library."""
        group = self.get_object()
        _require_group_member(request.user, group)

        if request.method == "GET":
            return Response(GroupLabelSerializer(group.labels.all(), many=True).data)

        # POST — create a label (admin only)
        _require_group_admin(request.user, group)
        serializer = GroupLabelSerializer(data=request.data, context={"group": group})
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            label = serializer.save(group=group)
            label_data = GroupLabelSerializer(label).data
            gid = group.pk

            def _broadcast_label_created(g=gid, data=label_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(g, _group_broadcast.EVT_GROUP_LABEL_CREATED, data)

            transaction.on_commit(_broadcast_label_created)
        return Response(label_data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Update a group shared label", methods=["PATCH"],
        request=GroupLabelSerializer, responses=GroupLabelSerializer,
    )
    @extend_schema(summary="Delete a group shared label", methods=["DELETE"], responses={204: None})
    @action(detail=True, methods=["patch", "delete"], url_path=r"labels/(?P<label_id>[^/.]+)")
    def update_group_label(self, request, pk=None, label_id=None):
        """PATCH or DELETE a group shared label."""
        group = self.get_object()
        _require_group_admin(request.user, group)
        label = get_object_or_404(GroupLabel, pk=label_id, group=group)

        if request.method == "DELETE":
            lid = label.pk
            gid = group.pk
            with transaction.atomic():
                label.delete()
                payload = {"id": lid}

                def _broadcast_label_deleted(g=gid, pl=payload):
                    from .broadcast import broadcast_group_event
                    broadcast_group_event(g, _group_broadcast.EVT_GROUP_LABEL_DELETED, pl)

                transaction.on_commit(_broadcast_label_deleted)
            return Response(status=status.HTTP_204_NO_CONTENT)

        # PATCH — update name/color
        serializer = GroupLabelSerializer(label, data=request.data, partial=True, context={"group": group})
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            serializer.save()
            label_data = GroupLabelSerializer(label).data
            gid = group.pk

            def _broadcast_label_updated(g=gid, data=label_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(g, _group_broadcast.EVT_GROUP_LABEL_UPDATED, data)

            transaction.on_commit(_broadcast_label_updated)
        return Response(label_data)

    @action(detail=True, methods=["patch"], url_path="board-defaults")
    def board_defaults(self, request, pk=None):
        """PATCH group board defaults: default_board_member_role, allowed_priorities."""
        group = self.get_object()
        _require_group_admin(request.user, group)

        # A JSON body that parses to a non-mapping (a bare number/string/array/
        # null/bool — valid JSON, just not a JSON *object*) makes the
        # ``request.data.items()`` below raise AttributeError, uncaught, as an
        # unhandled 500 instead of a 400 (#1136, found by backend-schema-fuzz;
        # same class as CardViewSet.move, GroupViewSet.transfer_ownership and
        # BoardViewSet.saved_filters). DRF has no built-in "request body must be
        # an object" check for a bare ``request.data`` mapping access the way a
        # serializer's ``is_valid()`` would.
        #
        # Deliberately placed *after* the admin check, not before it as in
        # ``transfer_ownership``: a caller who may not touch this group should
        # learn that before learning anything about their body being well-formed.
        if not isinstance(request.data, dict):
            return Response(
                {"detail": "Request body must be a JSON object."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        allowed_fields = {"default_board_member_role", "allowed_priorities"}
        data = {k: v for k, v in request.data.items() if k in allowed_fields}

        serializer = GroupSerializer(group, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            serializer.save()
            # Re-fetch through ``get_queryset`` so the count annotations are
            # populated — same pattern as ``transfer_ownership`` (#993).
            annotated = self.get_queryset().get(pk=group.pk)
            group_data = GroupSerializer(annotated, context={"request": request}).data

            def _broadcast_defaults(gid=group.pk, gd=group_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, _group_broadcast.EVT_GROUP_UPDATED, gd)

            transaction.on_commit(_broadcast_defaults)
        return Response(group_data)

    # ------------------------------------------------------------------
    # Favorites (star / unstar)
    # ------------------------------------------------------------------

    @extend_schema(
        # Deliberately lean — {"starred": bool} rather than the full Group shape,
        # unlike BoardViewSet.star which re-serializes the whole board. Without
        # this override drf-spectacular infers the viewset's GroupSerializer for
        # every action, which schemathesis correctly flags as a schema violation
        # (#1120: "board_count" is a required property, ...).
        responses={
            200: inline_serializer("GroupStarred", {"starred": drf_serializers.BooleanField()}),
            201: inline_serializer("GroupStarredCreated", {"starred": drf_serializers.BooleanField()}),
            204: None,
        },
    )
    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        group = self.get_object()
        # Confirm the requesting user is actually a member of this group before
        # allowing a star/unstar — get_object() only checks visibility (accessible
        # group ids), but starring is a member-level action.
        _require_group_member(request.user, group)
        # Mirror the board.star_changed contract (#945) so multiple browser
        # tabs of the same user stay in sync on the GroupDetail star state (#998).
        gid = group.pk
        uid = request.user.id

        def _broadcast_star(g=gid, u=uid, starred=False):
            from .broadcast import broadcast_group_event
            broadcast_group_event(g, _group_broadcast.EVT_GROUP_STAR_CHANGED, {"id": g, "user_id": u, "is_starred": starred})

        if request.method == "DELETE":
            with transaction.atomic():
                GroupFavorite.objects.filter(user=request.user, group=group).delete()
                transaction.on_commit(lambda: _broadcast_star(starred=False))
            return Response(status=status.HTTP_204_NO_CONTENT)
        with transaction.atomic():
            _, created = GroupFavorite.objects.get_or_create(user=request.user, group=group)
            transaction.on_commit(lambda: _broadcast_star(starred=True))
        return Response({"starred": True}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class JoinGroupRateThrottle(AnonRateThrottle):
    """Shared rate limit for invite-link redemption attempts.

    Applied to both the anonymous GET (token preview) and authenticated POST
    (join) endpoints. 10 requests per hour prevents brute-force token scanning
    while still allowing a user to retry after a network error or browser
    back-navigation within the same hour.
    """

    scope = "join_group"

    def get_cache_key(self, request, view):
        # Use IP address for both anon and authenticated requests so that an
        # attacker cannot escape the limit by logging in.
        ident = self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


def _is_member(user, group_id) -> bool:
    """True when ``user`` is an authenticated member of the group ``group_id``."""
    return bool(
        user is not None
        and user.is_authenticated
        and GroupMembership.objects.filter(group_id=group_id, user=user).exists()
    )


class JoinGroupView(APIView):
    """
    Invite-link join flow.

    GET  /api/groups/join/<token>/ — public; resolve token to group name and role.
    POST /api/groups/join/<token>/ — authenticated; add the requesting user to the group.
    """

    throttle_classes = [JoinGroupRateThrottle]

    def get_permissions(self):
        if self.request.method == "GET":
            return [AllowAny()]
        return [
            IsAuthenticated(),
            MustNotHavePendingPasswordChange(),
            MustNotHavePendingUsernameChange(),
            TokenHasScope(),
        ]

    def get(self, request, token):
        # Intentionally public preview — the token itself is a capability: 160
        # bits of entropy from `secrets.token_hex(20)` in
        # `GroupInviteLink.generate`, rate-limited to 10 req/hour/IP, and
        # invalidated by revocation or expiry. Returning group_name/role to a
        # holder of the raw token is by design so invitees can confirm what
        # they are joining before authenticating. Treat the group name as
        # public-via-this-path (#801).
        # Truncate token in log to avoid leaking the full value into log files
        # while still making it possible to correlate with an audit trail.
        token_hint = str(token)[:8]
        ip = get_client_ip(request)
        link = GroupInviteLink.lookup_by_token(str(token))
        if link is None:
            return Response(
                {"detail": "Not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        # Creator check first (#1510): a link whose creator is gone or no
        # longer a group admin answers 404 whatever its used/expired state, so
        # the status code does not leak the creator's state to a token holder.
        # A used single-use link stays visible to its own members (#1445).
        is_member_of_used = link.used_at is not None and _is_member(request.user, link.group_id)
        if not is_member_of_used and not invite_creator_is_valid(link):
            logger.info("Invite token lookup failed: creator not admin. token=%s ip=%s", token_hint, ip)
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        # Residual distinction accepted: with a live creator an expired or
        # consumed link still answers 410, so "creator gone" (404) is
        # distinguishable from "creator live, link expired/used". The SPA
        # needs the 410 to show its own message, and the raw token is already a
        # capability (#801), so only the gone-creator side is made uniform.
        if link.single_use and link.used_at is not None and not is_member_of_used:
            logger.info(
                "Invite token lookup failed: already used. token=%s ip=%s",
                token_hint,
                ip,
            )
            return Response(
                {"detail": "This invite link has already been used."},
                status=status.HTTP_410_GONE,
            )
        if link.is_expired:
            logger.info(
                "Invite token lookup failed: expired. token=%s ip=%s",
                token_hint,
                ip,
            )
            return Response(
                {"detail": "This invite link has expired."},
                status=status.HTTP_410_GONE,
            )
        logger.info(
            "Invite token preview. token=%s group_id=%s ip=%s",
            token_hint,
            link.group_id,
            ip,
        )
        # ``can_register`` (#1481) is a bare advisory boolean: whether sign-up
        # would accept this link right now. Same value for anonymous and
        # signed-in callers, and never the reason, the mode, the delivery or
        # the sender — the preview must not disclose more than #801 allows.
        # Disclosure decision: the bit itself is visible to any token holder
        # and can narrow down whether the site is closed, whether the link is
        # an emailed single-use one, and whether its sender still has admin
        # rights. That is accepted under #801's capability model — the holder
        # could learn the same by attempting registration with the token — and
        # no reason or mode is ever exposed.
        # A member previewing their own consumed single-use invite gets
        # false, which is correct: it cannot create another account.
        return Response({
            "group_id": link.group_id,
            "group_name": link.group.name,
            "role": link.role,
            "can_register": link_can_register(link),
        })

    def post(self, request, token):
        token_hint = str(token)[:8]
        ip = get_client_ip(request)

        # Always lock the row regardless of single_use so the join path is
        # consistently atomic. Overhead is negligible for low-frequency joins,
        # and this future-proofs the view against max_uses or other counters.
        hashed = GroupInviteLink._hash_token(str(token))
        with transaction.atomic():
            try:
                # of=("self",): created_by is a nullable FK, and Postgres cannot
                # lock the nullable side of the outer join select_related adds.
                link = GroupInviteLink.objects.select_related(
                    "created_by", GROUP_PARENT_CHAIN,
                ).select_for_update(of=("self",)).get(
                    token_hash=hashed, is_active=True
                )
            except GroupInviteLink.DoesNotExist:
                return Response(
                    {"detail": "Not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            # Creator no longer active / group admin: same 404 as a revoked
            # link (#1490), checked before the used/expired answers so the
            # status code does not leak the creator's state (#1510).
            # An already-used single-use invite still answers its own group's
            # members (#1445): an emailed invite that authorized registration
            # was redeemed by that registration, and the SPA's follow-up join
            # must land the new member in the group rather than on a "this
            # link has already been used" dead end. Non-members still get 410,
            # and consumed links for existing members skip the creator check —
            # joining is then a no-op that changes nothing.
            already_member = _is_member(request.user, link.group_id)
            if not (link.used_at is not None and already_member) and not invite_creator_is_valid(link):
                logger.info(
                    "Invite token redemption failed: creator not admin. token=%s user_id=%s ip=%s outcome=failure",
                    token_hint,
                    request.user.pk,
                    ip,
                )
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

            if link.single_use and link.used_at is not None and not already_member:
                logger.info(
                    "Invite token redemption failed: already used. token=%s user_id=%s ip=%s outcome=failure",
                    token_hint,
                    request.user.pk,
                    ip,
                )
                return Response(
                    {"detail": "This invite link has already been used."},
                    status=status.HTTP_410_GONE,
                )

            if link.is_expired:
                logger.info(
                    "Invite token redemption failed: expired. token=%s user_id=%s ip=%s outcome=failure",
                    token_hint,
                    request.user.pk,
                    ip,
                )
                return Response(
                    {"detail": "This invite link has expired."},
                    status=status.HTTP_410_GONE,
                )

            # get_or_create: if the user is already a member, their existing role is preserved.
            # Invite links never downgrade or upgrade an existing membership — this is intentional.
            # An admin must explicitly change the role via the members API.
            membership, created = GroupMembership.objects.get_or_create(
                group=link.group,
                user=request.user,
                defaults={"role": link.role},
            )

            if link.single_use and link.used_at is None:
                link.used_at = timezone.now()
                link.save(update_fields=["used_at"])

            # Broadcast member.added on the group channel so other admin
            # sessions on GroupDetail see the new member appear in real time
            # (#998).  Only emit on a fresh join — re-redemption of an
            # already-active membership does not change observable state.
            # member.* mirrors the board channel's member.added/updated/removed
            # naming so a single frontend socket layer handles both channels.
            if created:
                membership_data = GroupMembershipSerializer(membership).data
                joined_gid = link.group_id

                def _broadcast_member_added(gid=joined_gid, data=membership_data):
                    from .broadcast import broadcast_group_event
                    broadcast_group_event(gid, _group_broadcast.EVT_MEMBER_ADDED, data)

                transaction.on_commit(_broadcast_member_added)

        logger.info(
            "Invite token redeemed. token=%s group_id=%s user_id=%s new_member=%s ip=%s outcome=success",
            token_hint,
            link.group_id,
            request.user.pk,
            created,
            ip,
        )
        # Re-fetch the group with the same annotations that GroupViewSet.get_queryset()
        # applies so GroupSerializer.get_member_count / board_count / subgroup_count
        # and get_is_starred() read from annotated attributes instead of issuing up to
        # 4 extra subqueries against the bare instance (#722).
        annotated_group = Group.objects.select_related("owner", "parent").prefetch_related("labels").annotate(
            _member_count=Count("memberships", distinct=True),
            _board_count=Count("boards", distinct=True),
            _subgroup_count=Count("subgroups", distinct=True),
            _is_starred=Exists(
                GroupFavorite.objects.filter(user=request.user, group=OuterRef("pk"))
            ),
        ).get(pk=link.group_id)
        group_data = GroupSerializer(annotated_group, context={"request": request}).data
        return Response(group_data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
