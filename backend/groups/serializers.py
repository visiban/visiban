from rest_framework import serializers
from accounts.serializers import BoardUserSerializer
from .models import Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite


class GroupLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupLabel
        fields = ["id", "name", "color"]


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

    class Meta:
        model = GroupInviteLink
        fields = ["id", "prefix", "is_active", "created_at", "name", "role", "expires_at", "is_expired"]
        read_only_fields = ["id", "prefix", "is_active", "created_at", "is_expired"]
