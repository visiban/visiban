from rest_framework import serializers
from accounts.models import User
from accounts.serializers import UserSerializer
from .models import (
    Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement, CardComment, CardActivity, CardAttachment
)


class BoardMembershipSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = BoardMembership
        fields = ["id", "user", "role", "joined_at"]


class ColumnSerializer(serializers.ModelSerializer):
    class Meta:
        model = Column
        fields = ["id", "name", "position", "color", "wip_limit", "weight_limit"]


class SwimlaneSerializer(serializers.ModelSerializer):
    class Meta:
        model = Swimlane
        fields = ["id", "name", "contact_email", "notes", "position", "color", "is_collapsed", "created_at"]


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "name", "color"]


class CardMovementSerializer(serializers.ModelSerializer):
    moved_by = UserSerializer(read_only=True)
    from_column_name = serializers.CharField(source="from_column.name", default=None)
    to_column_name = serializers.CharField(source="to_column.name", default=None)
    from_swimlane_name = serializers.CharField(source="from_swimlane.name", default=None)
    to_swimlane_name = serializers.CharField(source="to_swimlane.name", default=None)

    class Meta:
        model = CardMovement
        fields = [
            "id", "from_column", "from_column_name", "to_column", "to_column_name",
            "from_swimlane", "from_swimlane_name", "to_swimlane", "to_swimlane_name",
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

    class Meta:
        model = Card
        fields = [
            "id", "column", "swimlane", "title", "description", "priority",
            "assignee", "assignee_id", "labels", "label_ids", "due_date",
            "weight", "position", "created_by", "created_at", "updated_at",
            "last_moved_at", "attachment_count",
        ]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def get_last_moved_at(self, obj):
        movement = obj.movements.first()
        return movement.moved_at if movement else None

    def get_attachment_count(self, obj):
        return obj.attachments.count()


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

    class Meta:
        model = Board
        fields = ["id", "name", "description", "owner", "member_count", "created_at", "updated_at"]
        read_only_fields = ["created_at", "updated_at"]

    def get_member_count(self, obj):
        return obj.memberships.count()


class BoardFullSerializer(serializers.ModelSerializer):
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = SwimlaneSerializer(many=True, read_only=True)
    cards = CardSerializer(many=True, read_only=True)
    labels = LabelSerializer(many=True, read_only=True)
    members = BoardMembershipSerializer(source="memberships", many=True, read_only=True)

    class Meta:
        model = Board
        fields = [
            "id", "name", "description", "columns", "swimlanes",
            "cards", "labels", "members", "created_at", "updated_at",
        ]
