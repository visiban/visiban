from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement, CardComment, CardActivity, CardAttachment, CardChecklist
from .permissions import IsBoardMember, IsBoardAdminOrOwner, get_board_role
from .serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    ColumnSerializer, SwimlaneSerializer, LabelSerializer,
    CardSerializer, CardMovementSerializer, CardCommentSerializer, CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
)
from accounts.models import User
from accounts.serializers import UserSerializer


def get_board_for_user(board_id, user):
    board = get_object_or_404(Board, pk=board_id)
    role = get_board_role(user, board)
    if role is None:
        from rest_framework.exceptions import PermissionDenied
        raise PermissionDenied
    return board, role


# ---------------------------------------------------------------------------
# Boards
# ---------------------------------------------------------------------------

class BoardViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = BoardSerializer

    def get_queryset(self):
        from django.db.models import Q
        from groups.models import get_accessible_group_ids
        user = self.request.user
        return Board.objects.filter(
            Q(owner=user) |
            Q(memberships__user=user) |
            Q(group__in=get_accessible_group_ids(user))
        ).distinct()

    def perform_create(self, serializer):
        board = serializer.save(owner=self.request.user)
        BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)
        default_columns = [
            ("Backlog", "#6B7280"),   # grey
            ("To Do",   "#3B82F6"),   # blue
            ("Doing",   "#F59E0B"),   # amber
            ("Done",    "#10B981"),   # green
        ]
        Column.objects.bulk_create([
            Column(board=board, name=name, position=i, color=color, allow_card_creation=(i == 0))
            for i, (name, color) in enumerate(default_columns)
        ])
        Swimlane.objects.create(board=board, name="General", position=0, color="#6B7280")

    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        if board.owner != request.user:
            return Response(status=status.HTTP_403_FORBIDDEN)
        board.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="move-group")
    def move_group(self, request, pk=None):
        board, role = get_board_for_user(pk, request.user)
        if board.owner != request.user and role != BoardMembership.Role.ADMIN:
            return Response(status=status.HTTP_403_FORBIDDEN)

        group_id = request.data.get("group_id")  # None = move to personal
        if group_id is not None:
            from groups.models import Group, GroupMembership
            group = get_object_or_404(Group, pk=group_id)
            is_member = (
                group.owner_id == request.user.id or
                GroupMembership.objects.filter(group=group, user=request.user).exists()
            )
            if not is_member:
                return Response(
                    {"error": "You are not a member of the target group."},
                    status=status.HTTP_403_FORBIDDEN,
                )
            board.group = group
        else:
            board.group = None

        board.save()
        return Response(BoardSerializer(board).data)

    @action(detail=True, methods=["get"])
    def full(self, request, pk=None):
        board, _ = get_board_for_user(pk, request.user)
        return Response(BoardFullSerializer(board, context={"request": request}).data)

    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        board, role = get_board_for_user(pk, request.user)
        if role != BoardMembership.Role.ADMIN:
            return Response(status=status.HTTP_403_FORBIDDEN)
        user_id = request.data.get("user_id")
        member_role = request.data.get("role", BoardMembership.Role.MEMBER)
        user = get_object_or_404(User, pk=user_id)
        membership, created = BoardMembership.objects.get_or_create(
            board=board, user=user, defaults={"role": member_role}
        )
        if not created:
            membership.role = member_role
            membership.save()
        return Response(BoardMembershipSerializer(membership).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="members/(?P<user_id>[^/.]+)")
    def remove_member(self, request, pk=None, user_id=None):
        board, role = get_board_for_user(pk, request.user)
        if role != BoardMembership.Role.ADMIN:
            return Response(status=status.HTTP_403_FORBIDDEN)
        BoardMembership.objects.filter(board=board, user_id=user_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------

class ColumnViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = ColumnSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Column.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        max_pos = board.columns.count()
        serializer.save(board=board, position=max_pos)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save()

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        instance.delete()

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        order = request.data.get("order", [])  # list of column IDs in new order
        with transaction.atomic():
            # Two-pass update to avoid unique_together(board, position) violations.
            # First pass: shift to high positions so no two columns share a position mid-update.
            count = board.columns.count()
            for i, col_id in enumerate(order):
                Column.objects.filter(board=board, pk=col_id).update(position=count + i)
            # Second pass: assign final positions.
            for pos, col_id in enumerate(order):
                Column.objects.filter(board=board, pk=col_id).update(position=pos)
        return Response(ColumnSerializer(board.columns.all(), many=True).data)


# ---------------------------------------------------------------------------
# Swimlanes
# ---------------------------------------------------------------------------

class SwimlaneViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = SwimlaneSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Swimlane.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        max_pos = board.swimlanes.count()
        serializer.save(board=board, position=max_pos)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save()

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        instance.delete()

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        order = request.data.get("order", [])
        with transaction.atomic():
            for pos, swimlane_id in enumerate(order):
                Swimlane.objects.filter(board=board, pk=swimlane_id).update(position=pos)
        return Response(SwimlaneSerializer(board.swimlanes.all(), many=True).data)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

class LabelViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = LabelSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Label.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save(board=board)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save()

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role != BoardMembership.Role.ADMIN:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        instance.delete()


# ---------------------------------------------------------------------------
# Cards
# ---------------------------------------------------------------------------

class CardViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = CardSerializer

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def _board(self):
        return self._board_and_role()[0]

    def get_queryset(self):
        return Card.objects.filter(board=self._board()).prefetch_related("labels", "movements")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        column = get_object_or_404(Column, pk=serializer.validated_data["column"].pk, board=board)
        if not column.allow_card_creation:
            from rest_framework.exceptions import ValidationError
            raise ValidationError({"column": "Card creation is not allowed in this column."})
        swimlane = get_object_or_404(Swimlane, pk=serializer.validated_data["swimlane"].pk, board=board)
        max_pos = Card.objects.filter(board=board, column=column, swimlane=swimlane).count()
        with transaction.atomic():
            card = serializer.save(board=board, created_by=self.request.user, position=max_pos)
            CardMovement.objects.create(
                card=card,
                from_column=None,
                from_swimlane=None,
                to_column=column,
                to_swimlane=swimlane,
                moved_by=self.request.user,
                notes="Card created",
            )

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        instance.delete()

    def update(self, request, *args, **kwargs):
        _, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        partial = kwargs.pop("partial", False)
        card = self.get_object()

        # Snapshot before update
        old_title = card.title
        old_priority = card.priority
        old_weight = card.weight
        old_assignee_id = card.assignee_id
        old_assignee_name = card.assignee.username if card.assignee else "Unassigned"
        old_description = card.description
        old_label_ids = set(card.labels.values_list("id", flat=True))

        serializer = self.get_serializer(card, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        card.refresh_from_db()

        activities = []
        ET = CardActivity.EventType

        if old_title != card.title and "title" in request.data:
            activities.append(CardActivity(
                card=card, event_type=ET.TITLE_CHANGE,
                from_value=old_title, to_value=card.title, actor=request.user,
            ))
        if old_priority != card.priority:
            activities.append(CardActivity(
                card=card, event_type=ET.PRIORITY_CHANGE,
                from_value=old_priority, to_value=card.priority, actor=request.user,
            ))
        if old_weight != card.weight:
            activities.append(CardActivity(
                card=card, event_type=ET.WEIGHT_CHANGE,
                from_value=str(old_weight), to_value=str(card.weight), actor=request.user,
            ))
        if old_assignee_id != card.assignee_id:
            new_name = card.assignee.username if card.assignee else "Unassigned"
            activities.append(CardActivity(
                card=card, event_type=ET.ASSIGNEE_CHANGE,
                from_value=old_assignee_name, to_value=new_name, actor=request.user,
            ))
        if old_description != card.description and "description" in request.data:
            activities.append(CardActivity(
                card=card, event_type=ET.DESCRIPTION_CHANGE,
                from_value="", to_value="", actor=request.user,
            ))
        new_label_ids = set(card.labels.values_list("id", flat=True))
        if old_label_ids != new_label_ids:
            added = new_label_ids - old_label_ids
            removed = old_label_ids - new_label_ids
            parts = []
            if added:
                names = list(Label.objects.filter(id__in=added).values_list("name", flat=True))
                parts.append(f"+{', '.join(names)}")
            if removed:
                names = list(Label.objects.filter(id__in=removed).values_list("name", flat=True))
                parts.append(f"-{', '.join(names)}")
            activities.append(CardActivity(
                card=card, event_type=ET.LABEL_CHANGE,
                from_value="", to_value=", ".join(parts), actor=request.user,
            ))

        if activities:
            CardActivity.objects.bulk_create(activities)

        return Response(serializer.data)

    @action(detail=True, methods=["post"])
    @transaction.atomic
    def move(self, request, board_pk=None, pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)

        target_column_id = request.data.get("column_id")
        target_swimlane_id = request.data.get("swimlane_id")
        new_position = request.data.get("position", 0)

        target_column = get_object_or_404(Column, pk=target_column_id, board=board)
        target_swimlane = get_object_or_404(Swimlane, pk=target_swimlane_id, board=board)

        column_changed = card.column_id != target_column.pk
        swimlane_changed = card.swimlane_id != target_swimlane.pk

        movement = None
        if column_changed or swimlane_changed:
            movement = CardMovement.objects.create(
                card=card,
                from_column=card.column,
                to_column=target_column,
                from_swimlane=card.swimlane,
                to_swimlane=target_swimlane,
                moved_by=request.user,
            )

        # Reorder siblings in source cell (fill gap)
        if column_changed or swimlane_changed:
            source_siblings = Card.objects.filter(
                board=board, column=card.column, swimlane=card.swimlane
            ).exclude(pk=card.pk).order_by("position")
            for i, sibling in enumerate(source_siblings):
                sibling.position = i
                sibling.save(update_fields=["position"])

        # Shift target cell siblings to make room
        Card.objects.filter(
            board=board, column=target_column, swimlane=target_swimlane
        ).exclude(pk=card.pk).filter(position__gte=new_position).update(
            position=F("position") + 1
        )

        card.column = target_column
        card.swimlane = target_swimlane
        card.position = new_position
        card.save(update_fields=["column", "swimlane", "position"])

        response_data = {
            "card": CardSerializer(card, context={"request": request, "board": board}).data,
        }
        if movement:
            response_data["movement"] = CardMovementSerializer(movement).data

        return Response(response_data)

    @action(detail=True, methods=["get"])
    def movements(self, request, board_pk=None, pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        movements = card.movements.select_related(
            "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"
        )
        return Response(CardMovementSerializer(movements, many=True).data)

    @action(detail=True, methods=["get"])
    def activities(self, request, board_pk=None, pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        serializer = CardActivitySerializer(card.activities.select_related("actor"), many=True)
        return Response(serializer.data)

    @action(detail=True, methods=["post", "get"])
    def comments(self, request, board_pk=None, pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        if request.method == "GET":
            return Response(CardCommentSerializer(card.comments.all(), many=True).data)
        serializer = CardCommentSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        serializer.save(card=card, author=request.user)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.COMMENT_ADDED,
            from_value="", to_value="", actor=request.user,
        )
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["get", "post"], url_path="attachments")
    def attachments(self, request, board_pk=None, pk=None):
        from django.conf import settings as django_settings
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)

        if request.method == "GET":
            serializer = CardAttachmentSerializer(
                card.attachments.all(), many=True, context={"request": request}
            )
            return Response(serializer.data)

        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No file provided."}, status=status.HTTP_400_BAD_REQUEST)

        max_size = getattr(django_settings, "MAX_UPLOAD_SIZE", 10 * 1024 * 1024)
        if file.size > max_size:
            return Response(
                {"detail": f"File too large. Maximum size is {max_size // (1024 * 1024)} MB."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        attachment = CardAttachment.objects.create(
            card=card,
            file=file,
            filename=file.name,
            size=file.size,
            uploaded_by=request.user,
        )
        serializer = CardAttachmentSerializer(attachment, context={"request": request})
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="attachments/(?P<attachment_pk>[^/.]+)")
    def delete_attachment(self, request, board_pk=None, pk=None, attachment_pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        attachment = get_object_or_404(CardAttachment, pk=attachment_pk, card=card)
        attachment.file.delete(save=False)
        attachment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get", "post"], url_path="checklist")
    def checklist(self, request, board_pk=None, pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        if request.method == "GET":
            items = card.checklist_items.all()
            return Response(CardChecklistSerializer(items, many=True).data)
        serializer = CardChecklistSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        position = card.checklist_items.count()
        item = serializer.save(card=card, position=position)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED,
            from_value="", to_value=item.text, actor=request.user,
        )
        return Response(CardChecklistSerializer(item).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch", "delete"], url_path="checklist/(?P<item_pk>[^/.]+)")
    def checklist_item(self, request, board_pk=None, pk=None, item_pk=None):
        board = self._board()
        card = get_object_or_404(Card, pk=pk, board=board)
        item = get_object_or_404(CardChecklist, pk=item_pk, card=card)
        if request.method == "DELETE":
            CardActivity.objects.create(
                card=card, event_type=CardActivity.EventType.CHECKLIST_ITEM_DELETED,
                from_value=item.text, to_value="", actor=request.user,
            )
            item.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        old_checked = item.is_checked
        serializer = CardChecklistSerializer(item, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        if "is_checked" in request.data and request.data["is_checked"] != old_checked:
            event_type = (
                CardActivity.EventType.CHECKLIST_ITEM_CHECKED
                if item.is_checked
                else CardActivity.EventType.CHECKLIST_ITEM_UNCHECKED
            )
            CardActivity.objects.create(
                card=card, event_type=event_type,
                from_value="", to_value=item.text, actor=request.user,
            )
        return Response(serializer.data)

