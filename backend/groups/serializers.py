from rest_framework import serializers
from accounts.serializers import BoardUserSerializer
from .models import Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite, _GROUP_TRAVERSAL_MAX_DEPTH


class GroupLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupLabel
        fields = ["id", "name", "color"]


class GroupBriefSerializer(serializers.ModelSerializer):
    """Minimal Group payload for inline expansion on other resources (#817).

    Used by BoardSerializer / BoardFullSerializer when the caller passes
    ``?expand=group``. Deliberately flat and small to avoid adding N+1 risk
    to list endpoints: no counts, no owner, no labels — just enough to render
    a breadcrumb link without a follow-up request.

    ``ancestors`` is root-first ({id, name}, not including the group itself)
    so callers can render a full relative breadcrumb for the group without
    extra requests (#845).
    """

    parent_name = serializers.CharField(source="parent.name", default=None, read_only=True)
    ancestors = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = ["id", "name", "parent", "parent_name", "ancestors"]

    def get_ancestors(self, obj):
        # A context-provided ``group_ancestor_map`` (id -> {"name", "parent_id"})
        # lets the caller resolve every ancestor with a single bulk query — used
        # by endpoints that render many boards at once (e.g. descendant_boards)
        # to avoid an N+1 walk. Falls back to ``Group.ancestors()`` otherwise.
        group_map = self.context.get("group_ancestor_map") if self.context else None
        if group_map is not None:
            chain = []
            node_id = obj.parent_id
            depth = 0
            while node_id is not None and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
                entry = group_map.get(node_id)
                if entry is None:
                    break
                chain.append({"id": node_id, "name": entry["name"]})
                node_id = entry.get("parent_id")
                depth += 1
            chain.reverse()
            return chain
        return [{"id": g.id, "name": g.name} for g in reversed(obj.ancestors())]


class GroupSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    parent_name = serializers.CharField(source="parent.name", default=None, read_only=True)
    member_count = serializers.SerializerMethodField()
    board_count = serializers.SerializerMethodField()
    subgroup_count = serializers.SerializerMethodField()
    shared_labels = GroupLabelSerializer(source="labels", many=True, read_only=True)
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = [
            "id", "name", "description", "owner", "parent", "parent_name",
            "member_count", "board_count", "subgroup_count", "created_at",
            "default_board_member_role", "allowed_priorities", "shared_labels",
            "is_starred",
        ]
        read_only_fields = ["owner", "created_at", "shared_labels", "is_starred"]

    def get_member_count(self, obj):
        # Use annotation from GroupViewSet.get_queryset() when available to avoid
        # an extra COUNT query per group in list responses.
        if hasattr(obj, "_member_count"):
            return obj._member_count
        return obj.memberships.count()

    def get_board_count(self, obj):
        if hasattr(obj, "_board_count"):
            return obj._board_count
        return obj.boards.count()

    def get_subgroup_count(self, obj):
        if hasattr(obj, "_subgroup_count"):
            return obj._subgroup_count
        return obj.subgroups.count()

    def get_is_starred(self, obj):
        if hasattr(obj, "_is_starred"):
            return obj._is_starred
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        # Footgun: live query fires when _is_starred annotation is absent (i.e. the group
        # was not fetched through GroupViewSet.get_queryset()). Always use get_queryset()
        # to ensure the annotation is present and avoid a per-group EXISTS query.
        return GroupFavorite.objects.filter(user=request.user, group=obj).exists()

    def validate_allowed_priorities(self, value):
        valid = {"low", "medium", "high", "urgent"}
        for p in value:
            if p not in valid:
                raise serializers.ValidationError(
                    f"'{p}' is not a valid priority. Choose from: {', '.join(sorted(valid))}."
                )
        return value

    def validate_default_board_member_role(self, value):
        valid = {c[0] for c in Group.DefaultMemberRole.choices}
        if value not in valid:
            raise serializers.ValidationError(
                f"'{value}' is not a valid role. Choose from: {', '.join(sorted(valid))}."
            )
        return value


class GroupMembershipSerializer(serializers.ModelSerializer):
    user = BoardUserSerializer(read_only=True)
    # is_inherited and inherited_from are not model fields — they are set
    # dynamically by the members action in GroupViewSet when building the
    # combined direct + inherited membership list. Declared here so that
    # drf-spectacular generates an accurate schema for the members endpoint.
    is_inherited = serializers.BooleanField(read_only=True, required=False)
    inherited_from = serializers.CharField(read_only=True, required=False, allow_null=True)

    class Meta:
        model = GroupMembership
        fields = ["id", "user", "role", "joined_at", "is_inherited", "inherited_from"]


class GroupDetailSerializer(GroupSerializer):
    """Extended serializer for the group retrieve endpoint.

    Adds an `ancestors` field (root-first list of {id, name} dicts) so the
    frontend can render a full ancestor breadcrumb chain without extra requests.
    This field is intentionally absent from the list serializer to avoid N+1
    queries when returning many groups at once.
    """

    ancestors = serializers.SerializerMethodField()

    class Meta(GroupSerializer.Meta):
        fields = GroupSerializer.Meta.fields + ["ancestors"]
        read_only_fields = list(GroupSerializer.Meta.read_only_fields) + ["ancestors"]

    def get_ancestors(self, obj):
        # ancestors() returns [immediate_parent, grandparent, …, root].
        # Reverse so the breadcrumb renders root-first (left-to-right).
        return [{"id": g.id, "name": g.name} for g in reversed(obj.ancestors())]


class GroupInviteLinkSerializer(serializers.ModelSerializer):
    is_expired = serializers.BooleanField(read_only=True)
    status = serializers.CharField(read_only=True)
    # Audit field (#1008) — matches AdminInviteLink.created_by_username so
    # group admins can see who created an invite link, parity with the
    # admin-level invite UI.  Use a CharField with source so we don't have
    # to nest a User serializer for one string.
    created_by_username = serializers.CharField(source="created_by.username", read_only=True, default=None)

    class Meta:
        model = GroupInviteLink
        fields = [
            "id", "prefix", "is_active", "created_at", "created_by_username", "name", "role",
            "expires_at", "is_expired", "single_use", "used_at", "status",
        ]
        read_only_fields = ["id", "prefix", "is_active", "created_at", "created_by_username", "is_expired", "single_use", "used_at", "status"]


class GroupInviteLinkCreateSerializer(serializers.Serializer):
    """Validates input for creating a new GroupInviteLink."""

    name = serializers.CharField(max_length=100, required=False, default="", allow_blank=True)
    role = serializers.ChoiceField(
        choices=GroupInviteLink.Role.choices,
        required=False,
        default=GroupInviteLink.Role.MEMBER,
    )
    expiry_days = serializers.IntegerField(required=False, allow_null=True, default=None, min_value=1)
    single_use = serializers.BooleanField(required=False, default=False)
