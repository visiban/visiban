from rest_framework import serializers
from accounts.serializers import UserSerializer
from .models import Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite


class GroupLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupLabel
        fields = ["id", "name", "color"]


class GroupSerializer(serializers.ModelSerializer):
    owner = UserSerializer(read_only=True)
    parent_name = serializers.CharField(source="parent.name", default=None, read_only=True)
    member_count = serializers.SerializerMethodField()
    board_count = serializers.SerializerMethodField()
    subgroup_count = serializers.SerializerMethodField()
    shared_labels = GroupLabelSerializer(source="labels", many=True, read_only=True)
    is_starred = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = [
            "id", "name", "owner", "parent", "parent_name",
            "member_count", "board_count", "subgroup_count", "created_at",
            "default_board_member_role", "allowed_priorities", "shared_labels",
            "is_starred",
        ]
        read_only_fields = ["owner", "created_at", "shared_labels", "is_starred"]

    def get_member_count(self, obj):
        return obj.memberships.count()

    def get_board_count(self, obj):
        return obj.boards.count()

    def get_subgroup_count(self, obj):
        return obj.subgroups.count()

    def get_is_starred(self, obj):
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
    user = UserSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ["id", "user", "role", "joined_at"]


class GroupInviteLinkSerializer(serializers.ModelSerializer):
    is_expired = serializers.BooleanField(read_only=True)

    class Meta:
        model = GroupInviteLink
        fields = ["id", "token", "is_active", "created_at", "name", "role", "expires_at", "is_expired"]
        read_only_fields = ["id", "token", "is_active", "created_at", "is_expired"]
