import datetime

from django.utils import timezone
from rest_framework import serializers

from accounts.models import User
from accounts.serializers import UserSerializer

from .models import (
    Board, BoardMembership, BoardTemplate, Column, Swimlane, Label, Card, CardMovement,
    CardComment, CardActivity, CardAttachment, CardChecklist,
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
    class Meta:
        model = Swimlane
        fields = ["id", "uid", "name", "contact_email", "notes", "position", "color", "is_collapsed", "created_at"]
        read_only_fields = ["uid"]


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
        movement = obj.movements.first()
        return movement.moved_at if movement else None

    def get_attachment_count(self, obj):
        # Use the prefetch cache populated by CardViewSet.get_queryset() to avoid
        # an extra COUNT query per card when listing the board.
        return len([a for a in obj.attachments.all()])

    def get_checklist_total(self, obj):
        # Use the prefetch cache to avoid an extra COUNT query per card.
        return len([i for i in obj.checklist_items.all()])

    def get_checklist_done(self, obj):
        # Use the prefetch cache to avoid an extra filtered COUNT query per card.
        return len([i for i in obj.checklist_items.all() if i.is_checked])

    def get_is_stale(self, obj):
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        last_mv = obj.movements.first()  # ordered by -moved_at
        if last_mv:
            return last_mv.moved_at < cutoff
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
        fields = ["id", "uid", "name", "description", "owner", "group", "group_name", "member_count", "card_count", "staleness_threshold_days", "allowed_priorities", "created_at", "updated_at", "is_starred"]
        read_only_fields = ["uid", "created_at", "updated_at"]

    def get_member_count(self, obj):
        return obj.memberships.count()

    def get_card_count(self, obj):
        return obj.cards.count()

    def get_is_starred(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.favorites.filter(user=request.user).exists()


class BoardFullSerializer(serializers.ModelSerializer):
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = SwimlaneSerializer(many=True, read_only=True)
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
            "cards", "labels", "members", "staleness_threshold_days",
            "allowed_priorities", "created_at", "updated_at", "current_user_role", "is_starred",
        ]
        read_only_fields = ["uid"]

    def get_cards(self, obj):
        """Return only active (non-archived) cards for the board view.

        Archived cards are excluded here; they are fetched separately via the
        /cards/archived/ action when the user opens the archived panel.
        """
        qs = obj.cards.filter(archived_at__isnull=True).prefetch_related("labels", "movements")
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

        # Group-inherited members (walk ancestor chain)
        if obj.group_id:
            node = obj.group
            depth = 0
            while node and depth < 6:
                for gm in node.memberships.select_related("user").all():
                    if gm.user_id not in seen:
                        seen[gm.user_id] = {"id": None, "user": gm.user, "role": gm.role, "joined_at": gm.joined_at}
                node = node.parent
                depth += 1

        # Include the board owner if not already present
        if obj.owner_id and obj.owner_id not in seen:
            seen[obj.owner_id] = {"id": None, "user": obj.owner, "role": "admin", "joined_at": obj.created_at}

        # Include site admins so they appear in @mention autocomplete
        for u in User.objects.filter(is_site_admin=True):
            if u.pk not in seen:
                seen[u.pk] = {"id": None, "user": u, "role": "site_admin", "joined_at": obj.created_at}

        result = []
        for entry in seen.values():
            user = entry["user"]
            result.append({
                "id": entry["id"],
                "user": {
                    "id": user.id,
                    "username": user.username,
                    "email": user.email,
                    "display_name": getattr(user, "display_name", "") or "",
                    "avatar_url": getattr(user, "avatar_url", "") or "",
                },
                "role": entry["role"],
                "joined_at": entry["joined_at"],
            })
        return result

    def get_current_user_role(self, obj):
        request = self.context.get("request")
        if not request:
            return None
        from .permissions import get_board_role
        return get_board_role(request.user, obj)

    def get_is_starred(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.favorites.filter(user=request.user).exists()
