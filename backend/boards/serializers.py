import datetime

from django.db import models as _db_models
from django.db.models import Prefetch
from django.utils import timezone
from rest_framework import serializers

from accounts.models import User
from accounts.serializers import BoardUserSerializer

from .models import (
    Board, BoardExportLog, BoardMembership, BoardTemplate, Column, Swimlane, Label, Card, CardMovement,
    CardComment, CardActivity, CardAttachment, CardChecklist, SavedFilter,
)


class BoardTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = BoardTemplate
        fields = [
            "id", "name", "slug", "description", "icon",
            "lane_label", "lane_placeholder", "columns_json",
            "sort_order",
        ]


class BoardMembershipSerializer(serializers.ModelSerializer):
    user = BoardUserSerializer(read_only=True)

    class Meta:
        model = BoardMembership
        fields = ["id", "user", "role", "is_moderator", "joined_at"]

    def to_representation(self, instance):
        """Strip ``is_moderator`` from the response when the requesting user is
        not an admin or site_admin (#920).

        Moderator status is an internal trust tier — admins promote a member to
        moderator so they can edit/delete other members' content.  Exposing the
        flag to viewers and members reveals organisational signal that should
        not be visible at those roles.  Admin reads (members panel, member POST
        response) keep the field; the broadcast surface keeps it for backward
        compatibility because broadcasts have no per-subscriber filter — the
        exposure there is treated as a documented limitation rather than a
        contract change in 1.1.

        The serializer reads the role from ``context["role"]`` (set by the
        view) or falls back to ``get_board_role`` when a request and board are
        available in context.  In contexts where the role cannot be resolved
        (e.g. broadcast payloads built without a request) the field is kept —
        callers that want it stripped must thread the role through context.
        """
        data = super().to_representation(instance)
        from .permissions import get_board_role, SITE_ADMIN
        role = self.context.get("role")
        request = self.context.get("request")
        board = self.context.get("board")
        if role is None and request and board and request.user.is_authenticated:
            role = get_board_role(request.user, board)
        if role is not None and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            data.pop("is_moderator", None)
        return data


class BoardExportLogSerializer(serializers.ModelSerializer):
    """Read-only payload for the export-history endpoint (#842)."""

    actor = BoardUserSerializer(read_only=True)

    class Meta:
        model = BoardExportLog
        fields = ["id", "actor", "role_at_export", "export_format", "row_count", "created_at"]
        read_only_fields = fields


class ColumnSerializer(serializers.ModelSerializer):
    class Meta:
        model = Column
        fields = ["id", "uid", "name", "position", "color", "wip_limit", "weight_limit", "allow_card_creation", "is_done"]
        read_only_fields = ["uid"]


class SwimlaneSerializer(serializers.ModelSerializer):
    """Public swimlane representation — omits contact_email and notes.

    Viewer-role members have read access to the board but must not see PII or
    internal notes stored on swimlanes (customer records). Admin-role members and
    write operations use SwimlaneAdminSerializer which includes those fields.
    """

    class Meta:
        model = Swimlane
        fields = ["id", "uid", "name", "position", "color", "is_collapsed", "created_at"]
        read_only_fields = ["uid"]


class SwimlaneAdminSerializer(SwimlaneSerializer):
    """Full swimlane representation including contact_email and notes.

    Used for admin/site_admin members only. Never served to viewer-role members.
    """

    class Meta(SwimlaneSerializer.Meta):
        fields = ["id", "uid", "name", "contact_email", "notes", "position", "color", "is_collapsed", "created_at"]


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "uid", "name", "color"]
        read_only_fields = ["uid"]


class CardMovementSerializer(serializers.ModelSerializer):
    moved_by = BoardUserSerializer(read_only=True)
    # card_uid / card_title allow board-level history consumers to identify
    # which card a movement belongs to without a secondary fetch.
    # source="card.*" is safe because the board-level movements queryset
    # always select_related("card"), and the card-level queryset trivially
    # has the card available.
    card_uid = serializers.CharField(source="card.uid", read_only=True)
    card_title = serializers.CharField(source="card.title", read_only=True)

    class Meta:
        model = CardMovement
        fields = [
            "id",
            "card_uid", "card_title",
            "from_column", "from_column_name", "from_column_uid",
            "to_column", "to_column_name", "to_column_uid",
            "from_swimlane", "from_swimlane_name", "from_swimlane_uid",
            "to_swimlane", "to_swimlane_name", "to_swimlane_uid",
            "moved_by", "moved_at", "notes", "movement_type",
        ]


class CardCommentSerializer(serializers.ModelSerializer):
    author = BoardUserSerializer(read_only=True)
    body = serializers.CharField(max_length=10_000)

    class Meta:
        model = CardComment
        fields = ["id", "author", "body", "created_at", "updated_at"]


class CardActivitySerializer(serializers.ModelSerializer):
    actor = BoardUserSerializer(read_only=True)

    class Meta:
        model = CardActivity
        fields = ["id", "event_type", "from_value", "to_value", "actor", "created_at"]


class CardChecklistSerializer(serializers.ModelSerializer):
    class Meta:
        model = CardChecklist
        fields = ["id", "text", "is_checked", "position"]


def _annotate_is_stale(qs, stale_cutoff):
    """Annotate the queryset with ``_is_stale_annotated`` at the SQL level.

    A card is stale when its most recent movement predates the cutoff, or —
    for never-moved cards — when it was created before the cutoff.  Computing
    the boolean once via a single subquery avoids a per-card ``timezone.now()``
    branch in the serializer (#669).

    Used by both the authenticated ``_card_queryset`` and the public share-link
    queryset (#926) so all read paths share the same stale logic.
    """
    from .models import CardMovement as _CM
    _last_moved_sq = _db_models.Subquery(
        _CM.objects.filter(card=_db_models.OuterRef("pk"))
        .order_by("-moved_at")
        .values("moved_at")[:1]
    )
    return qs.annotate(
        _last_moved_at_for_stale=_last_moved_sq,
        _is_stale_annotated=_db_models.Case(
            # Card has at least one movement and it predates the cutoff.
            _db_models.When(
                _last_moved_at_for_stale__lt=stale_cutoff,
                then=_db_models.Value(True),
            ),
            # Never-moved card: fall back to created_at.
            _db_models.When(
                _last_moved_at_for_stale__isnull=True,
                created_at__lt=stale_cutoff,
                then=_db_models.Value(True),
            ),
            default=_db_models.Value(False),
            output_field=_db_models.BooleanField(),
        )
    )


def _card_queryset(qs, stale_cutoff=None):
    """Apply the standard prefetch chain required by CardSerializer.

    Centralised here so CardViewSet, BoardFullSerializer, and the archived
    action all use identical prefetches — avoids drift that reintroduces N+1s.

    Movements are prefetched ordered by -moved_at so that serializer methods
    that need the most-recent movement can use movements.all()[0] without
    issuing an additional ORDER BY + LIMIT 1 query per card.

    When ``stale_cutoff`` is provided, an ``is_stale`` boolean annotation is
    added at the SQL level (one query, not one per card) so
    CardSerializer.get_is_stale() can read the pre-computed value instead of
    calling timezone.now() per row (#669).  Pass ``stale_cutoff=None`` only
    when the board's staleness_threshold_days is not yet known (e.g. nested
    serializers that do not have access to the board settings) — in that case
    the serializer falls back to per-row logic.
    """
    from .models import CardMovement as _CM
    qs = (
        qs
        .select_related("board", "column", "swimlane", "assignee", "created_by")
        .prefetch_related(
            "labels",
            "attachments",
            "checklist_items",
            Prefetch(
                "movements",
                queryset=_CM.objects.select_related(
                    "moved_by", "from_column", "to_column", "from_swimlane", "to_swimlane"
                ).order_by("-moved_at"),
            ),
        )
    )
    if stale_cutoff is not None:
        qs = _annotate_is_stale(qs, stale_cutoff)
    return qs


class CardSerializer(serializers.ModelSerializer):
    labels = LabelSerializer(many=True, read_only=True)
    label_ids = serializers.PrimaryKeyRelatedField(
        many=True, write_only=True, queryset=Label.objects.all(), source="labels", required=False
    )
    assignee = BoardUserSerializer(read_only=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        write_only=True, read_only=False, queryset=User.objects.all(), source="assignee", required=False, allow_null=True
    )
    created_by = BoardUserSerializer(read_only=True)
    description = serializers.CharField(max_length=50_000, allow_blank=True, required=False)
    last_moved_at = serializers.SerializerMethodField()

    def __init__(self, *args, **kwargs):
        """Scope label_ids and assignee_id querysets to the current board.

        Without this, a client could assign labels from another board or assign
        a user who is not a member of the board — both are cross-board IDOR
        vulnerabilities.  The board must be passed via serializer context.

        When called from BoardFullSerializer.get_cards() or CardViewSet, the
        context may contain pre-computed _member_ids and _board_labels_qs to
        avoid re-querying per card instance (N+1 fix — see #490).
        """
        super().__init__(*args, **kwargs)
        board = self.context.get("board")
        if board:
            labels_qs = self.context.get("_board_labels_qs") or Label.objects.filter(board=board)
            self.fields["label_ids"].child_relation.queryset = labels_qs
            from .utils import _get_assignable_member_ids
            # Use _assignable_member_ids if pre-computed (viewers excluded); fall
            # back to computing it now.  _member_ids is NOT used here because it
            # includes viewer-role users who must not appear as assignee options.
            assignable_ids = self.context.get("_assignable_member_ids") or _get_assignable_member_ids(board)
            self.fields["assignee_id"].queryset = User.objects.filter(
                pk__in=assignable_ids
            )
    attachment_count = serializers.SerializerMethodField()
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()

    class Meta:
        model = Card
        fields = [
            "id", "uid", "column", "swimlane", "title", "description", "priority",
            "assignee", "assignee_id", "labels", "label_ids", "due_date",
            "weight", "position", "created_by", "created_at", "updated_at",
            "last_moved_at", "attachment_count", "checklist_total", "checklist_done",
            "is_stale", "archived_at", "version",
        ]
        read_only_fields = ["uid", "created_by", "created_at", "updated_at", "archived_at", "version"]

    def get_last_moved_at(self, obj):
        # Use .all() not .first() — .first() bypasses the prefetch cache and
        # issues a new query with ORDER BY + LIMIT 1 for every card.
        movements = obj.movements.all()
        return movements[0].moved_at if movements else None

    def get_attachment_count(self, obj):
        # len() on a prefetched relation uses the in-memory cache; .count() does not.
        return len(obj.attachments.all())

    def get_checklist_total(self, obj):
        return len(obj.checklist_items.all())

    def get_checklist_done(self, obj):
        return sum(1 for item in obj.checklist_items.all() if item.is_checked)

    def get_is_stale(self, obj):
        # Fast path: use the queryset-level annotation when it was pre-computed
        # by _card_queryset(stale_cutoff=...) — avoids a timezone.now() call per
        # card and mirrors the per-row fallback exactly (#669).
        if hasattr(obj, "_is_stale_annotated"):
            return obj._is_stale_annotated
        # Fallback: per-row logic for callers that built the queryset without a
        # stale_cutoff (e.g. single-card re-fetch after a move or archive).
        # obj.board requires select_related("board") on the queryset.
        # obj.movements.all() uses the prefetch cache (ordered by -moved_at).
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


class CardAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = BoardUserSerializer(read_only=True)
    url = serializers.SerializerMethodField()

    class Meta:
        model = CardAttachment
        fields = ["id", "filename", "size", "url", "uploaded_by", "uploaded_at"]

    def get_url(self, obj):
        request = self.context.get("request")
        if request:
            return request.build_absolute_uri(obj.file.url)
        return obj.file.url


def _expand_requested(context, name):
    """Return True when the caller passed ``?expand=<name>`` (or a CSV containing it).

    Gates nested object expansion on serializers that would otherwise return only
    a foreign-key id. Keeping existing flat fields unchanged preserves the 1.0
    contract; the nested payload is additive. See #817.

    Internal callers (viewsets rendering a pre-bulked payload for their own UI)
    can inject ``_force_expand`` as a set in context to opt-in without polluting
    the public ``expand`` query-param API (#845).
    """
    if context:
        force = context.get("_force_expand")
        if force and name in force:
            return True
    request = context.get("request") if context else None
    if request is None:
        return False
    raw = request.query_params.get("expand", "")
    if not raw:
        return False
    return name in {p.strip() for p in raw.split(",") if p.strip()}


class BoardSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    member_count = serializers.SerializerMethodField()
    card_count = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True)
    group_detail = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Board
        fields = ["id", "uid", "name", "description", "owner", "group", "group_name", "group_detail", "member_count", "card_count", "staleness_threshold_days", "stale_warning_pct", "allowed_priorities", "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits", "export_min_role", "card_density", "created_at", "updated_at", "is_starred"]
        read_only_fields = ["uid", "created_at", "updated_at"]

    def get_group_detail(self, obj):
        # Nested expansion is opt-in via ``?expand=group`` so the default response
        # shape stays unchanged — list endpoints do not pay for a join they didn't
        # ask for. See #817.
        if not _expand_requested(self.context, "group") or obj.group_id is None:
            return None
        from groups.serializers import GroupBriefSerializer
        # Forward context so nested serializers can see ``group_ancestor_map``
        # (when the viewset pre-bulked ancestors to avoid N+1) — see #845.
        return GroupBriefSerializer(obj.group, context=self.context).data

    def validate_stale_warning_pct(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("stale_warning_pct must be between 0 and 100.")
        return value

    def validate_export_min_role(self, value):
        # #843: whitelist only the board-relative role hierarchy. ``site_admin``
        # is rejected because it is a cross-cutting identity, not a board-level
        # threshold — conflating the two would confuse the gate logic.
        # ``owner`` is not a BoardMembership.Role; the owner always bypasses
        # the threshold, so admitting it as a setting value would be
        # meaningless.
        allowed = {"viewer", "collaborator", "member", "admin"}
        if value not in allowed:
            raise serializers.ValidationError(
                f"export_min_role must be one of: {sorted(allowed)}."
            )
        return value

    def validate_card_density(self, value):
        # #961: gate the choice set at the serializer so the DB column stays a
        # plain CharField that will accept future tiers (e.g. ``relaxed``)
        # without a schema migration. Middle tier is named ``standard`` rather
        # than ``compact`` to avoid colliding with the per-user "Card layout:
        # Compact / Expanded" toolbar pref.
        allowed = {"comfortable", "standard", "dense"}
        if value not in allowed:
            raise serializers.ValidationError(
                f"card_density must be one of: {sorted(allowed)}."
            )
        return value

    def validate_allowed_priorities(self, value):
        if not value:
            return value
        valid = {p[0] for p in Card.Priority.choices}
        if any(v not in valid for v in value):
            raise serializers.ValidationError(
                f"Invalid priority value. Must be one of: {sorted(valid)}."
            )
        return value

    def get_member_count(self, obj):
        # Use the annotation injected by BoardViewSet.get_queryset() when available
        # to avoid a subquery per board on the list endpoint.
        if hasattr(obj, "_member_count"):
            return obj._member_count
        return obj.memberships.count()

    def get_card_count(self, obj):
        if hasattr(obj, "_card_count"):
            return obj._card_count
        return obj.cards.count()

    def get_is_starred(self, obj):
        if hasattr(obj, "_is_starred"):
            return obj._is_starred
        # _user_favorites is prefetched by get_board_for_user() — use it when present
        # to avoid a live EXISTS query on mutation responses (share, move_group, etc.).
        if hasattr(obj, "_user_favorites"):
            return bool(obj._user_favorites)
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        # Footgun: this live EXISTS query fires when BoardSerializer is used with a bare
        # Board.objects.get() that carries neither annotation. Always fetch boards through
        # BoardViewSet.get_queryset() or get_board_for_user() to avoid the extra query.
        return obj.favorites.filter(user=request.user).exists()


class BoardFullSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = serializers.SerializerMethodField()
    cards = serializers.SerializerMethodField()
    labels = LabelSerializer(many=True, read_only=True)
    members = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True)
    group_detail = serializers.SerializerMethodField()
    current_user_role = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()
    share_token = serializers.SerializerMethodField()
    share_token_expires_at = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = Board
        fields = [
            "id", "uid", "name", "description", "owner", "group", "group_name", "group_detail", "columns", "swimlanes",
            "cards", "labels", "members", "staleness_threshold_days", "stale_warning_pct",
            "allowed_priorities", "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits", "export_min_role", "card_density", "created_at", "updated_at", "current_user_role", "is_starred", "share_token", "share_token_expires_at", "capabilities",
        ]
        read_only_fields = ["uid"]

    def get_group_detail(self, obj):
        # See BoardSerializer.get_group_detail — same gating rule (#817).
        if not _expand_requested(self.context, "group") or obj.group_id is None:
            return None
        from groups.serializers import GroupBriefSerializer
        return GroupBriefSerializer(obj.group, context=self.context).data

    def to_representation(self, instance):
        """Pre-compute board-scoped caches before delegating to field serialization.

        Effective member IDs are used by both get_cards() (via
        _get_effective_member_ids) and get_members() for the group-inherited
        membership block. Computing the GroupMembership set once here and
        caching on the board instance avoids a redundant GroupMembership query
        the second time either field accesses the ancestor chain (#695).

        Caches the full GroupMembership rows (with ``select_related("user")``)
        on ``_cached_group_memberships`` so that ``get_members()`` can iterate
        them directly without issuing a second query for the same group_id
        filter (#927).  The user-id set required by ``_get_effective_member_ids``
        is derived from the same list and stored on
        ``_cached_group_member_ids`` to preserve the existing utils.py contract.
        """
        if instance.group_id and not hasattr(instance, "_cached_group_member_ids"):
            from groups.models import GroupMembership as _GM, Group as _Group
            from groups.models import _GROUP_TRAVERSAL_MAX_DEPTH
            group_obj = instance.group
            # Ensure the ancestor chain is loaded — mirrors the guard in
            # get_members() so cold-cache callers don't trigger per-level FK
            # queries during the while-loop below (#650).
            if group_obj.parent_id is not None and "parent" not in group_obj.__dict__:
                _ancestor_related = ["__".join(["parent"] * d) for d in range(1, 7)]
                group_obj = _Group.objects.select_related(*_ancestor_related).get(pk=instance.group_id)
            ancestor_ids = []
            node = group_obj
            depth = 0
            while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
                ancestor_ids.append(node.pk)
                node = node.parent
                depth += 1
            if ancestor_ids:
                instance._cached_group_memberships = list(
                    _GM.objects.filter(group_id__in=ancestor_ids).select_related("user")
                )
            else:
                instance._cached_group_memberships = []
            instance._cached_group_member_ids = {
                gm.user_id for gm in instance._cached_group_memberships
            }
        return super().to_representation(instance)

    def get_swimlanes(self, obj):
        """Serialize swimlanes with role-appropriate field exposure.

        Admin and site_admin members see contact_email and notes.
        Member and viewer roles receive the public serializer which omits those fields.

        get_board_role() is used (not a direct memberships lookup) so group-inherited
        admin roles are handled correctly.
        """
        from .permissions import get_board_role, SITE_ADMIN
        from .models import BoardMembership as BM

        request = self.context.get("request")
        role = self.context.get("role")
        if role is None and request and request.user.is_authenticated:
            role = get_board_role(request.user, obj)
        use_admin = role in (BM.Role.ADMIN, SITE_ADMIN)
        serializer_class = SwimlaneAdminSerializer if use_admin else SwimlaneSerializer
        return serializer_class(obj.swimlanes.all(), many=True, context=self.context).data

    def get_cards(self, obj):
        """Return only active (non-archived) cards for the board view.

        Archived cards are excluded here; they are fetched separately via the
        /cards/archived/ action when the user opens the archived panel.

        Member IDs and board labels are pre-computed once here and threaded
        through context so CardSerializer.__init__ does not re-query them
        for every card instance (N+1 fix — see #490).

        Site-admin users are pre-fetched here and cached in context so
        get_members() can reuse the same objects without a second identical
        query. ("cards" precedes "members" in Meta.fields so this runs first.)
        """
        from accounts.models import User
        from .utils import _get_effective_member_ids, _get_assignable_member_ids
        # Pre-fetch site admins once; get_members() will read from context.
        site_admin_users = self.context.get("_site_admin_users")
        if site_admin_users is None:
            site_admin_users = list(
                User.objects.filter(can_access_all_content=True).only(
                    "id", "username", "display_name", "avatar_url"
                )
            )
            self.context["_site_admin_users"] = site_admin_users
        site_admin_ids = {u.pk for u in site_admin_users}
        # Compute the stale cutoff once here so _card_queryset can annotate
        # is_stale at the SQL level rather than calling timezone.now() per card
        # in get_is_stale() (#669).
        stale_cutoff = timezone.now() - datetime.timedelta(days=obj.staleness_threshold_days)
        qs = _card_queryset(obj.cards.filter(archived_at__isnull=True), stale_cutoff=stale_cutoff)
        member_ids = _get_effective_member_ids(obj, site_admin_ids=site_admin_ids)
        assignable_ids = _get_assignable_member_ids(obj, site_admin_ids=site_admin_ids)
        # Reuse the labels prefetch loaded by get_board_for_user() rather than
        # issuing a second Label query.  The board must be fetched via
        # get_board_for_user() (which prefetches "labels") for this to hit the
        # cache; a bare Board.objects.get() would fall back to a live query.
        board_labels_qs = obj.labels.all()
        ctx = {**self.context, "board": obj, "_member_ids": member_ids, "_assignable_member_ids": assignable_ids, "_board_labels_qs": board_labels_qs}
        return CardSerializer(qs, many=True, context=ctx).data

    def get_members(self, obj):
        """Return the effective member list for @mention autocomplete and the members panel.

        Combines four sources, in precedence order (first writer wins per user):
          1. Direct BoardMembership rows — authoritative; override any group role.
          2. Group-inherited memberships — walk the group ancestor chain (capped at
             6 levels) and include each user not already seen from step 1.
          3. Board owner — always included as admin even without an explicit row.
          4. Site admins — included so they appear in @mention autocomplete on all boards.

        The ``id`` field is None for inherited/implicit members (they have no
        BoardMembership row on this board).
        """
        # Direct board members keyed by user_id.
        # Use the prefetch loaded by get_board_for_user() when available to avoid
        # a live select_related query on every /full/ request.
        seen = {}
        memberships = getattr(obj, "_prefetched_memberships", None)
        if memberships is None:
            # Footgun: cold-path fallback fires a live select_related query for every
            # member. BoardFullSerializer requires a board fetched via get_board_for_user()
            # so that _prefetched_memberships is populated. A bare Board.objects.get()
            # caller will silently take this path and issue an extra query.
            memberships = list(obj.memberships.select_related("user").all())
        for m in memberships:
            seen[m.user_id] = {"id": m.id, "user": m.user, "role": m.role, "is_moderator": m.is_moderator, "joined_at": m.joined_at}

        # Group-inherited members — collect ancestor group IDs in a single
        # traversal (parent FK only, no memberships fetched yet), then load
        # all group memberships for those IDs in one query instead of one
        # query per ancestor level.
        if obj.group_id:
            # Guard: ensure the full ancestor chain is loaded before traversal.
            # The normal entry point (get_board_for_user) pre-loads up to 6
            # parent levels via select_related("group__parent__parent...") so
            # no extra queries are issued on the happy path.
            # Cold-cache callers (e.g. tests that fetch the board with a bare
            # Board.objects.get()) would otherwise trigger up to 6 live FK
            # queries during the while-loop below — one per unresolved parent
            # FK — which is the N+1 being fixed here (#650).
            # Detect a cold-cache situation by checking whether the group's
            # parent FK has already been resolved in Django's instance cache.
            # If it hasn't, re-fetch the group with the full ancestor chain in
            # a single query before starting the traversal.
            from groups.models import Group as _Group
            group_obj = obj.group
            if group_obj.parent_id is not None and "parent" not in group_obj.__dict__:
                _ancestor_related = ["__".join(["parent"] * d) for d in range(1, 7)]
                group_obj = _Group.objects.select_related(*_ancestor_related).get(pk=obj.group_id)
            ancestor_ids = []
            node = group_obj
            depth = 0
            while node and depth < 6:
                ancestor_ids.append(node.pk)
                node = node.parent
                depth += 1
            if ancestor_ids:
                # Reuse the GroupMembership list pre-fetched by to_representation()
                # rather than re-issuing the same filter+select_related query (#927).
                # The cold-cache fallback (no _cached_group_memberships attribute)
                # only kicks in for callers that bypass to_representation() — e.g.
                # tests or non-standard call paths.
                cached_gms = getattr(obj, "_cached_group_memberships", None)
                if cached_gms is None:
                    from groups.models import GroupMembership
                    cached_gms = list(
                        GroupMembership.objects
                        .filter(group_id__in=ancestor_ids)
                        .select_related("user")
                    )
                for gm in cached_gms:
                    if gm.user_id not in seen:
                        seen[gm.user_id] = {"id": None, "user": gm.user, "role": gm.role, "is_moderator": False, "joined_at": gm.joined_at}

        # Include the board owner if not already present
        if obj.owner_id and obj.owner_id not in seen:
            seen[obj.owner_id] = {"id": None, "user": obj.owner, "role": "admin", "is_moderator": False, "joined_at": obj.created_at}

        # Include users with can_access_all_content so they appear in @mention autocomplete.
        # Reuse the list pre-fetched by get_cards() when available (cached in context so
        # the can_access_all_content query runs at most once per /full/ request — #651/#538).
        # Write back to context on a cold-cache call so repeated get_members() calls
        # (e.g. from tests or non-standard call order) also benefit from the cache.
        site_admin_users = self.context.get("_site_admin_users")
        if site_admin_users is None:
            from accounts.models import User as _User
            site_admin_users = list(
                _User.objects.filter(can_access_all_content=True).only(
                    "id", "username", "display_name", "avatar_url"
                )
            )
            self.context["_site_admin_users"] = site_admin_users
        for u in site_admin_users:
            if u.pk not in seen:
                seen[u.pk] = {"id": None, "user": u, "role": "site_admin", "is_moderator": False, "joined_at": obj.created_at}

        # Hide is_moderator from non-admin viewers (#920).  Resolve the
        # requesting user's role once here rather than in the per-row loop.
        from .permissions import get_board_role, SITE_ADMIN
        viewer_role = self.context.get("role")
        request = self.context.get("request")
        if viewer_role is None and request and request.user.is_authenticated:
            viewer_role = get_board_role(request.user, obj)
        is_admin_viewer = viewer_role in (BoardMembership.Role.ADMIN, SITE_ADMIN)

        result = []
        for entry in seen.values():
            # Use BoardUserSerializer so private per-user fields (notification prefs,
            # UI prefs, can_access_all_content) are not exposed to other board members.
            row = {
                "id": entry["id"],
                "user": BoardUserSerializer(entry["user"], context=self.context).data,
                "role": entry["role"],
                "joined_at": entry["joined_at"],
            }
            if is_admin_viewer:
                row["is_moderator"] = entry["is_moderator"]
            result.append(row)
        return result

    def get_current_user_role(self, obj):
        # Reuse the role already resolved by the view (threaded via context) to
        # avoid a second get_board_role() call on the same request.
        role = self.context.get("role")
        if role is not None:
            return role
        request = self.context.get("request")
        if not request:
            return None
        from .permissions import get_board_role
        return get_board_role(request.user, obj)

    def get_is_starred(self, obj):
        # Use the prefetched _user_favorites attr when available (set by
        # get_board_for_user via Prefetch(to_attr="_user_favorites")) to avoid
        # a per-request favorites query on the full board endpoint.
        if hasattr(obj, "_user_favorites"):
            return len(obj._user_favorites) > 0
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.favorites.filter(user=request.user).exists()

    def _resolved_role(self, obj):
        """Return the current user's role, reading from context or resolving live.

        Both get_share_token and get_share_token_expires_at need the role to
        gate admin-only fields. Centralising the resolution here avoids two
        independent get_board_role() calls per /full/ response when role is
        absent from context.
        """
        from .permissions import get_board_role
        role = self.context.get("role")
        if role is None:
            request = self.context.get("request")
            if request and request.user.is_authenticated:
                role = get_board_role(request.user, obj)
        return role

    def get_share_token(self, obj):
        """Return the share token only to board admins; return null for all other roles.

        The token is a secret credential — exposing it to members/viewers would
        let them share the board publicly without admin intent.
        """
        from .models import BoardMembership as BM
        from .permissions import SITE_ADMIN
        if self._resolved_role(obj) in (BM.Role.ADMIN, SITE_ADMIN):
            return str(obj.share_token) if obj.share_token else None
        return None

    def get_share_token_expires_at(self, obj):
        """Expose the share-link TTL only to board admins; null for all others.

        Mirrors the visibility rules of get_share_token — the expiry timestamp
        is only meaningful alongside the token itself, and both are admin-only
        state.
        """
        from .models import BoardMembership as BM
        from .permissions import SITE_ADMIN
        if self._resolved_role(obj) in (BM.Role.ADMIN, SITE_ADMIN):
            return obj.share_token_expires_at.isoformat() if obj.share_token_expires_at else None
        return None

    def get_capabilities(self, obj):
        """Return feature flags for enterprise-registered extension points.

        OSS always returns False for all keys; enterprise registers backends
        (e.g. MOVEMENT_EXPORT_BACKENDS) to flip the relevant flag.
        """
        from .hooks import MOVEMENT_EXPORT_BACKENDS
        return {"movement_export": bool(MOVEMENT_EXPORT_BACKENDS)}


class CardTimelineEntrySerializer(serializers.Serializer):
    """Read-only serializer for unified card timeline entries (movements + activities).

    Each entry has a common envelope (id, kind, ts, actor, event_type, data) so the
    frontend can render heterogeneous entry types from a single list response.
    """

    id = serializers.IntegerField()
    kind = serializers.CharField()
    ts = serializers.DateTimeField()
    actor = BoardUserSerializer(allow_null=True)
    event_type = serializers.CharField()
    data = serializers.DictField()


class SavedFilterSerializer(serializers.ModelSerializer):
    """Serializer for user-scoped saved filter presets on a board.

    ``state_json`` shape is validated here (not only on the frontend) so
    malformed payloads — including ones constructed by a future board-import
    flow — never reach the database. The validation is intentionally shallow:
    it checks keys and types without enforcing value ranges, so additive
    schema changes don't require an MR to unblock new clients.

    ``state_version`` is optional on write (defaults to 1 for callers that
    predate the versioning scheme) and always present on read. Forward-compat:
    we do not reject ``state_version`` values higher than the current server
    knows about — a mixed-version deploy where a newer client posts v2 to an
    older server would otherwise lose the user's save.
    """

    # Known top-level keys in the v1 FilterState shape. Extra keys are
    # rejected so typos and accidental payload bloat fail loudly rather than
    # piling up as stale state in the DB.
    _STATE_V1_KEYS = {"search", "assigneeIds", "labelIds", "priorities", "dueDate"}
    _STATE_V1_DUE_DATE = {"overdue", "today", "this_week", "none"}
    _STATE_V1_PRIORITIES = {"low", "medium", "high", "urgent"}

    class Meta:
        model = SavedFilter
        fields = ["id", "name", "state_json", "state_version", "created_at"]
        read_only_fields = ["id", "created_at"]
        extra_kwargs = {
            # Keep state_version optional on write so existing clients that
            # don't know about it still succeed; model default (1) fills in.
            "state_version": {"required": False, "default": 1, "min_value": 1},
        }

    def validate_state_json(self, value):
        """Shape check for v1 FilterState. Rejects unknown keys and wrong
        types. Values inside recognized keys get a light type check only —
        the frontend remains responsible for semantic validity (e.g. that
        an assigneeId corresponds to a real user)."""
        if not isinstance(value, dict):
            raise serializers.ValidationError("state_json must be an object.")

        unknown = set(value.keys()) - self._STATE_V1_KEYS
        if unknown:
            raise serializers.ValidationError(
                f"Unknown keys in state_json: {sorted(unknown)}."
            )

        if "search" in value and not isinstance(value["search"], str):
            raise serializers.ValidationError("state_json.search must be a string.")
        for list_key in ("assigneeIds", "labelIds"):
            if list_key in value:
                items = value[list_key]
                if not isinstance(items, list) or not all(isinstance(x, int) and not isinstance(x, bool) for x in items):
                    raise serializers.ValidationError(
                        f"state_json.{list_key} must be a list of integers."
                    )
        if "priorities" in value:
            prios = value["priorities"]
            if not isinstance(prios, list) or not all(p in self._STATE_V1_PRIORITIES for p in prios):
                raise serializers.ValidationError(
                    f"state_json.priorities must be a list with values from {sorted(self._STATE_V1_PRIORITIES)}."
                )
        if "dueDate" in value:
            # None is the "no filter" value in the frontend FilterState type;
            # it round-trips through saved presets so we must accept it here.
            if value["dueDate"] is not None and value["dueDate"] not in self._STATE_V1_DUE_DATE:
                raise serializers.ValidationError(
                    f"state_json.dueDate must be null or one of {sorted(self._STATE_V1_DUE_DATE)}."
                )

        return value


# ---------------------------------------------------------------------------
# Public (unauthenticated) share-link serializers
# ---------------------------------------------------------------------------

class PublicAssigneeSerializer(serializers.Serializer):
    """Minimal user representation for public board views — display_name only.

    Intentionally omits id, username, and email to prevent PII leakage on
    publicly accessible share-link endpoints.
    """
    display_name = serializers.CharField()


class PublicCardSerializer(serializers.ModelSerializer):
    """Read-only card representation for public share-link views.

    Excludes comments, movement history, attachments, and any field that
    could expose PII or sensitive board-internal data.

    Requires the card queryset to be built via PublicBoardSerializer.get_cards()
    which sets up the necessary prefetches (checklist_items, movements) and
    select_related(board) so that no per-card queries are issued.
    """
    labels = LabelSerializer(many=True, read_only=True)
    assignee = PublicAssigneeSerializer(read_only=True)
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    last_moved_at = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()

    class Meta:
        model = Card
        fields = [
            "uid", "column", "swimlane", "title", "priority", "labels",
            "due_date", "weight", "position",
            "checklist_total", "checklist_done", "assignee",
            "last_moved_at", "is_stale",
        ]

    def get_checklist_total(self, obj):
        # len() on a prefetched relation uses the in-memory cache; .count() does not.
        return len(obj.checklist_items.all())

    def get_checklist_done(self, obj):
        return sum(1 for item in obj.checklist_items.all() if item.is_checked)

    def get_last_moved_at(self, obj):
        # movements are prefetched ordered by -moved_at; index [0] is the most recent.
        movements = obj.movements.all()
        return movements[0].moved_at if movements else None

    def get_is_stale(self, obj):
        # Read the SQL-level annotation when PublicBoardSerializer.get_cards()
        # passes stale_cutoff (#926) — avoids a per-card timezone.now() branch.
        if hasattr(obj, "_is_stale_annotated"):
            return obj._is_stale_annotated
        # Fallback for cold-cache callers that did not annotate (e.g. tests
        # that build a public card queryset by hand).  obj.board is available
        # via select_related("board") in the public get_cards() prefetch.
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


class PublicBoardSerializer(serializers.ModelSerializer):
    """Board payload served to unauthenticated share-link visitors.

    Includes only the data required to render the static read-only board grid.
    Excluded: members list, share_token, swimlane contact_email/notes,
    card comments, card movements, and any user PK/email fields.
    """
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = SwimlaneSerializer(many=True, read_only=True)  # public variant — no contact_email/notes
    labels = LabelSerializer(many=True, read_only=True)
    cards = serializers.SerializerMethodField()

    class Meta:
        model = Board
        # staleness_threshold_days intentionally omitted: it is an internal board
        # configuration value; is_stale is computed server-side so the threshold
        # does not need to be exposed to anonymous share-link visitors.
        fields = ["uid", "name", "columns", "swimlanes", "labels", "cards"]

    def get_cards(self, obj):
        qs = (
            obj.cards
            .filter(archived_at__isnull=True)
            .select_related("assignee", "board")
            .prefetch_related(
                "labels",
                "checklist_items",
                # Ordered newest-first so index [0] gives the most recent movement,
                # matching the logic in get_last_moved_at / get_is_stale.
                Prefetch("movements", queryset=CardMovement.objects.order_by("-moved_at")),
            )
        )
        # Annotate is_stale at the SQL level so PublicCardSerializer.get_is_stale()
        # reads a pre-computed boolean rather than calling timezone.now() per
        # card (#926, mirrors CardSerializer at line 524).
        stale_cutoff = timezone.now() - datetime.timedelta(days=obj.staleness_threshold_days)
        qs = _annotate_is_stale(qs, stale_cutoff)
        return PublicCardSerializer(qs, many=True).data
