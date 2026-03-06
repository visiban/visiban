from rest_framework import serializers
from accounts.serializers import UserSerializer
from .models import Group, GroupMembership, GroupInviteLink


class GroupSerializer(serializers.ModelSerializer):
    owner = UserSerializer(read_only=True)
    parent_name = serializers.CharField(source="parent.name", default=None, read_only=True)
    member_count = serializers.SerializerMethodField()
    board_count = serializers.SerializerMethodField()
    subgroup_count = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = [
            "id", "name", "owner", "parent", "parent_name",
            "member_count", "board_count", "subgroup_count", "created_at",
        ]
        read_only_fields = ["owner", "created_at"]

    def get_member_count(self, obj):
        return obj.memberships.count()

    def get_board_count(self, obj):
        return obj.boards.count()

    def get_subgroup_count(self, obj):
        return obj.subgroups.count()


class GroupMembershipSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = GroupMembership
        fields = ["id", "user", "role", "joined_at"]


class GroupInviteLinkSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupInviteLink
        fields = ["id", "token", "is_active", "created_at"]
