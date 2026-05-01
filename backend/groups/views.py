import logging

import datetime

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, AllowAny

from visiban.permissions import MustNotHavePendingPasswordChange, MustNotHavePendingUsernameChange
from visiban.utils import get_client_ip
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import Group, GroupFavorite, GroupLabel, GroupMembership, GroupInviteLink
from .serializers import GroupSerializer, GroupDetailSerializer, GroupLabelSerializer, GroupMembershipSerializer, GroupInviteLinkSerializer, GroupInviteLinkCreateSerializer

logger = logging.getLogger(__name__)


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


class GroupViewSet(viewsets.ModelViewSet):
    """CRUD endpoints for groups, scoped to groups the requesting user is a member of."""

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
        group = serializer.save(owner=self.request.user)
        GroupMembership.objects.create(
            group=group, user=self.request.user, role=GroupMembership.Role.ADMIN
        )

    def update(self, request, *args, **kwargs):
        # Only group admins may rename or re-parent a group.
        # The default ModelViewSet inherits no admin guard here — add it explicitly.
        _require_group_admin(request.user, self.get_object())
        return super().update(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        _require_group_admin(request.user, self.get_object())
        return super().partial_update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        group = self.get_object()
        if group.owner != request.user and not getattr(request.user, "can_access_all_content", False):
            return Response(status=status.HTTP_403_FORBIDDEN)
        group.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Members
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get"])
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
                    from boards.broadcast import broadcast_board_event
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
                            broadcast_board_event(bid, "member.removed", {"user_id": uid})

                transaction.on_commit(_evict_stale_ws)

            return Response(status=status.HTTP_204_NO_CONTENT)
        # PATCH — update role
        membership = get_object_or_404(GroupMembership, group=group, user=target_user)
        role = request.data.get("role")
        if role not in GroupMembership.Role.values:
            return Response({"detail": f"Must be one of: {', '.join(GroupMembership.Role.values)}"}, status=status.HTTP_400_BAD_REQUEST)
        membership.role = role
        membership.save()
        return Response(GroupMembershipSerializer(membership).data)

    # ------------------------------------------------------------------
    # Subgroups
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get"])
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

    @action(detail=True, methods=["get", "post"])
    def boards(self, request, pk=None):
        from boards.models import Board, Column, Swimlane
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

            from boards.templates import BOARD_TEMPLATES
            template_key = (request.data.get("template") or "simple_kanban").strip()
            template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])
            if template["columns"]:
                Column.objects.bulk_create([
                    Column(board=board, name=col["name"], position=i, color=col["color"], allow_card_creation=(i == 0))
                    for i, col in enumerate(template["columns"])
                ])

            swimlane_name = ((request.data.get("swimlane_name") or "").strip() or template.get("default_swimlane") or "General")[:255]
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

            allowed = group.get_allowed_priorities()
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
                _is_starred=Exists(_BoardFavorite.objects.filter(board=OuterRef("pk"), user=request.user)),
            ).get(pk=board.pk)

            # Broadcast board.created so live sessions (group dashboards, sidebars)
            # can refresh their board list without a manual reload. Mirrors the
            # broadcast in BoardViewSet.perform_create so the event contract is
            # identical regardless of which endpoint created the board. Deferred
            # with on_commit so subscribers never see a board that later rolls back.
            from boards.broadcast import broadcast_board_event as _broadcast_board_event
            from .broadcast import broadcast_group_event as _broadcast_group_event
            _board_id = board.id
            _board_event_payload = BoardSerializer(board, context={"request": request}).data
            _group_id = group.id
            def _broadcast_created(
                bid=_board_id, bd=_board_event_payload, gid=_group_id,
            ):
                _broadcast_board_event(bid, "board.created", bd)
                # Powers live refresh of GroupDetail's boards list (#753).
                _broadcast_group_event(gid, "board.created", bd)
            transaction.on_commit(_broadcast_created)

        return Response(BoardSerializer(board, context={"request": request}).data, status=status.HTTP_201_CREATED)

    # ------------------------------------------------------------------
    # Descendant boards
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get"], url_path="descendant-boards")
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
            # GroupBriefSerializer.parent_name (``source="parent.name"``)
            # doesn't issue a per-board lookup when the response is serialized.
            # #845 adds ancestors via a dedicated bulk map, but parent_name
            # is a separate field path that has its own N+1 if not joined here.
            .select_related("owner", "group", "group__parent")
            .annotate(
                _member_count=Count("memberships", distinct=True),
                _card_count=Count("cards", filter=Q(cards__archived_at__isnull=True), distinct=True),
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
            group_data = GroupSerializer(group, context={"request": request}).data

            def _broadcast_transfer(gid=group.pk, data=group_data):
                from .broadcast import broadcast_group_event
                broadcast_group_event(gid, "group.updated", data)

            transaction.on_commit(_broadcast_transfer)

        # Note (#952): the board channel intentionally does not receive an
        # ownership-transferred event.  Board UI surfaces (header, settings,
        # toolbar) do not show group ownership; only GroupDetail does, and it
        # already refetches on the existing group-channel ``group.updated``
        # event.  Adding a board-channel fanout would create permanent
        # contract surface (events cannot be removed without a major bump)
        # for no client benefit.

        return Response(GroupSerializer(group, context={"request": request}).data)

    # ------------------------------------------------------------------
    # Invite links
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get", "post"], url_path="invite-links")
    def invite_links(self, request, pk=None):
        group = self.get_object()
        _require_group_admin(request.user, group)

        if request.method == "GET":
            # Include consumed single-use links so admins can audit past usage.
            links = GroupInviteLink.objects.filter(
                Q(group=group) & (Q(is_active=True) | Q(used_at__isnull=False))
            ).order_by("created_at")
            return Response(GroupInviteLinkSerializer(links, many=True).data)

        # POST — create a new invite link (max 5 active per group)
        # Active count excludes consumed single-use links — they are dead weight.
        active_count = GroupInviteLink.objects.filter(group=group, is_active=True, used_at__isnull=True).count()
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

    @action(detail=True, methods=["delete"], url_path=r"invite-links/(?P<link_id>[^/.]+)")
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
        link.is_active = False
        link.save(update_fields=["is_active"])
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Board defaults (shared labels, allowed priorities, default role)
    # ------------------------------------------------------------------

    @action(detail=True, methods=["get", "post"], url_path="labels")
    def group_labels(self, request, pk=None):
        """GET/POST group-level shared label library."""
        group = self.get_object()
        _require_group_member(request.user, group)

        if request.method == "GET":
            return Response(GroupLabelSerializer(group.labels.all(), many=True).data)

        # POST — create a label (admin only)
        _require_group_admin(request.user, group)
        serializer = GroupLabelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        label = serializer.save(group=group)
        return Response(GroupLabelSerializer(label).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path=r"labels/(?P<label_id>[^/.]+)")
    def update_group_label(self, request, pk=None, label_id=None):
        """PATCH or DELETE a group shared label."""
        group = self.get_object()
        _require_group_admin(request.user, group)
        label = get_object_or_404(GroupLabel, pk=label_id, group=group)

        if request.method == "DELETE":
            label.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)

        # PATCH — update name/color
        serializer = GroupLabelSerializer(label, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(GroupLabelSerializer(label).data)

    @action(detail=True, methods=["patch"], url_path="board-defaults")
    def board_defaults(self, request, pk=None):
        """PATCH group board defaults: default_board_member_role, allowed_priorities."""
        group = self.get_object()
        _require_group_admin(request.user, group)

        allowed_fields = {"default_board_member_role", "allowed_priorities"}
        data = {k: v for k, v in request.data.items() if k in allowed_fields}

        serializer = GroupSerializer(group, data=data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(GroupSerializer(group).data)

    # ------------------------------------------------------------------
    # Favorites (star / unstar)
    # ------------------------------------------------------------------

    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        group = self.get_object()
        # Confirm the requesting user is actually a member of this group before
        # allowing a star/unstar — get_object() only checks visibility (accessible
        # group ids), but starring is a member-level action.
        _require_group_member(request.user, group)
        if request.method == "DELETE":
            GroupFavorite.objects.filter(user=request.user, group=group).delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        _, created = GroupFavorite.objects.get_or_create(user=request.user, group=group)
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
        return [IsAuthenticated(), MustNotHavePendingPasswordChange(), MustNotHavePendingUsernameChange()]

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
        if link.single_use and link.used_at is not None:
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
        return Response({
            "group_id": link.group_id,
            "group_name": link.group.name,
            "role": link.role,
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
                link = GroupInviteLink.objects.select_for_update().get(
                    token_hash=hashed, is_active=True
                )
            except GroupInviteLink.DoesNotExist:
                return Response(
                    {"detail": "Not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )

            if link.single_use and link.used_at is not None:
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

            if link.single_use:
                link.used_at = timezone.now()
                link.save(update_fields=["used_at"])

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
