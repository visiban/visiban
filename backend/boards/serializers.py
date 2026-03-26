import datetime

from django.db.models import Prefetch
from django.utils import timezone
from rest_framework import serializers

from accounts.models import User
from accounts.serializers import UserSerializer

from .models import (
    Board, BoardMembership, BoardTemplate, Column, Swimlane, Label, Card, CardMovement,
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
    user = UserSerializer(read_only=True)

    class Meta:
        model = BoardMembership
        fields = ["id", "user", "role", "joined_at"]


class ColumnSerializer(serializers.ModelSerializer):
    class Meta:
        model = Column
        fields = ["id", "uid", "name", "position", "color", "wip_limit", "weight_limit", "allow_card_creation"]
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
    moved_by = UserSerializer(read_only=True)

    class Meta:
        model = CardMovement
        fields = [
            "id",
            "from_column", "from_column_name", "from_column_uid",
            "to_column", "to_column_name", "to_column_uid",
            "from_swimlane", "from_swimlane_name", "from_swimlane_uid",
            "to_swimlane", "to_swimlane_name", "to_swimlane_uid",
            "moved_by", "moved_at", "notes",
        ]


class CardCommentSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)

    class Meta:
        model = CardComment
        fields = ["id", "author", "body", "created_at", "updated_at"]


class CardActivitySerializer(serializers.ModelSerializer):
    actor = UserSerializer(read_only=True)

    class Meta:
        model = CardActivity
        fields = ["id", "event_type", "from_value", "to_value", "actor", "created_at"]


class CardChecklistSerializer(serializers.ModelSerializer):
    class Meta:
        model = CardChecklist
        fields = ["id", "text", "is_checked", "position"]


def _card_queryset(qs):
    """Apply the standard prefetch chain required by CardSerializer.

    Centralised here so CardViewSet, BoardFullSerializer, and the archived
    action all use identical prefetches — avoids drift that reintroduces N+1s.

    Movements are prefetched ordered by -moved_at so that serializer methods
    that need the most-recent movement can use movements.all()[0] without
    issuing an additional ORDER BY + LIMIT 1 query per card.
    """
    from .models import CardMovement as _CM
    return (
        qs
        .select_related("board", "assignee", "created_by")
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


class CardSerializer(serializers.ModelSerializer):
    labels = LabelSerializer(many=True, read_only=True)
    label_ids = serializers.PrimaryKeyRelatedField(
        many=True, write_only=True, queryset=Label.objects.all(), source="labels", required=False
    )
    assignee = UserSerializer(read_only=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        write_only=True, read_only=False, queryset=User.objects.all(), source="assignee", required=False, allow_null=True
    )
    last_moved_at = serializers.SerializerMethodField()
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
            "is_stale", "archived_at",
        ]
        read_only_fields = ["uid", "created_by", "created_at", "updated_at", "archived_at"]

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
        # obj.board requires select_related("board") on the queryset.
        # obj.movements.all() uses the prefetch cache (ordered by -moved_at).
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


class CardAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = UserSerializer(read_only=True)
    url = serializers.SerializerMethodField()

    class Meta:
        model = CardAttachment
        fields = ["id", "filename", "size", "url", "uploaded_by", "uploaded_at"]

    def get_url(self, obj):
        request = self.context.get("request")
        if request:
            return request.build_absolute_uri(obj.file.url)
        return obj.file.url


class BoardSerializer(serializers.ModelSerializer):
    owner = UserSerializer(read_only=True)
    member_count = serializers.SerializerMethodField()
    card_count = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True)
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Board
        fields = ["id", "uid", "name", "description", "owner", "group", "group_name", "member_count", "card_count", "staleness_threshold_days", "stale_warning_pct", "allowed_priorities", "enforce_wip_limits", "enforce_weight_limits", "created_at", "updated_at", "is_starred"]
        read_only_fields = ["uid", "created_at", "updated_at"]

    def validate_stale_warning_pct(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("stale_warning_pct must be between 0 and 100.")
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
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.favorites.filter(user=request.user).exists()


class BoardFullSerializer(serializers.ModelSerializer):
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = serializers.SerializerMethodField()
    cards = serializers.SerializerMethodField()
    labels = LabelSerializer(many=True, read_only=True)
    members = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True)
    current_user_role = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Board
        fields = [
            "id", "uid", "name", "description", "group", "group_name", "columns", "swimlanes",
            "cards", "labels", "members", "staleness_threshold_days", "stale_warning_pct",
            "allowed_priorities", "enforce_wip_limits", "enforce_weight_limits", "created_at", "updated_at", "current_user_role", "is_starred",
        ]
        read_only_fields = ["uid"]

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
        """
        qs = _card_queryset(obj.cards.filter(archived_at__isnull=True))
        return CardSerializer(qs, many=True, context=self.context).data

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
        from accounts.models import User

        # Direct board members keyed by user_id
        seen = {}
        for m in obj.memberships.select_related("user").all():
            seen[m.user_id] = {"id": m.id, "user": m.user, "role": m.role, "joined_at": m.joined_at}

        # Group-inherited members — collect ancestor group IDs in a single
        # traversal (parent FK only, no memberships fetched yet), then load
        # all group memberships for those IDs in one query instead of one
        # query per ancestor level.
        if obj.group_id:
            ancestor_ids = []
            node = obj.group
            depth = 0
            while node and depth < 6:
                ancestor_ids.append(node.pk)
                node = node.parent
                depth += 1
            if ancestor_ids:
                from groups.models import GroupMembership
                for gm in (
                    GroupMembership.objects
                    .filter(group_id__in=ancestor_ids)
                    .select_related("user")
                ):
                    if gm.user_id not in seen:
                        seen[gm.user_id] = {"id": None, "user": gm.user, "role": gm.role, "joined_at": gm.joined_at}

        # Include the board owner if not already present
        if obj.owner_id and obj.owner_id not in seen:
            seen[obj.owner_id] = {"id": None, "user": obj.owner, "role": "admin", "joined_at": obj.created_at}

        # Include users with can_access_all_content so they appear in @mention autocomplete
        for u in User.objects.filter(can_access_all_content=True):
            if u.pk not in seen:
                seen[u.pk] = {"id": None, "user": u, "role": "site_admin", "joined_at": obj.created_at}

        result = []
        for entry in seen.values():
            # Delegate to UserSerializer so inherited/implicit member rows stay
            # in sync with direct member rows if new User fields are added post-1.0.
            result.append({
                "id": entry["id"],
                "user": UserSerializer(entry["user"], context=self.context).data,
                "role": entry["role"],
                "joined_at": entry["joined_at"],
            })
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


class SavedFilterSerializer(serializers.ModelSerializer):
    """Serializer for user-scoped saved filter presets on a board.

    ``state_json`` is accepted as-is from the frontend and returned unchanged;
    schema validation is the frontend's responsibility since the filter shape
    evolves independently of the API contract.
    """

    class Meta:
        model = SavedFilter
        fields = ["id", "name", "state_json", "created_at"]
        read_only_fields = ["id", "created_at"]
