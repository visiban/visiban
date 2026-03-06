from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Board, BoardMembership, Column, Customer, Label, Card, CardMovement, CardComment, CardActivity
from .permissions import IsBoardMember, IsBoardAdminOrOwner, get_board_role
from .serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    ColumnSerializer, CustomerSerializer, LabelSerializer,
    CardSerializer, CardMovementSerializer, CardCommentSerializer, CardActivitySerializer,
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
        return Board.objects.filter(
            memberships__user=self.request.user
        ).distinct() | Board.objects.filter(owner=self.request.user).distinct()

    def perform_create(self, serializer):
        board = serializer.save(owner=self.request.user)
        BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

    @action(detail=True, methods=["get"])
    def full(self, request, pk=None):
        board, _ = get_board_for_user(pk, request.user)
        return Response(BoardFullSerializer(board).data)

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

    def _board(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)[0]

    def get_queryset(self):
        return Column.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board = self._board()
        max_pos = board.columns.count()
        serializer.save(board=board, position=max_pos)

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board = self._board()
        order = request.data.get("order", [])  # list of column IDs in new order
        with transaction.atomic():
            for pos, col_id in enumerate(order):
                Column.objects.filter(board=board, pk=col_id).update(position=pos)
        return Response(ColumnSerializer(board.columns.all(), many=True).data)


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------

class CustomerViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = CustomerSerializer

    def _board(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)[0]

    def get_queryset(self):
        return Customer.objects.filter(board=self._board())

    def perform_create(self, serializer):
        board = self._board()
        max_pos = board.customers.count()
        serializer.save(board=board, position=max_pos)

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board = self._board()
        order = request.data.get("order", [])
        with transaction.atomic():
            for pos, cust_id in enumerate(order):
                Customer.objects.filter(board=board, pk=cust_id).update(position=pos)
        return Response(CustomerSerializer(board.customers.all(), many=True).data)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

class LabelViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = LabelSerializer

    def _board(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)[0]

    def get_queryset(self):
        return Label.objects.filter(board=self._board())

    def perform_create(self, serializer):
        serializer.save(board=self._board())


# ---------------------------------------------------------------------------
# Cards
# ---------------------------------------------------------------------------

class CardViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = CardSerializer

    def _board(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)[0]

    def get_queryset(self):
        return Card.objects.filter(board=self._board()).prefetch_related("labels", "movements")

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx["board"] = self._board()
        return ctx

    def perform_create(self, serializer):
        board = self._board()
        column_id = self.request.data.get("column_id") or serializer.validated_data.get("column_id")
        customer_id = self.request.data.get("customer_id") or serializer.validated_data.get("customer_id")
        column = get_object_or_404(Column, pk=serializer.validated_data["column"].pk, board=board)
        customer = get_object_or_404(Customer, pk=serializer.validated_data["customer"].pk, board=board)
        max_pos = Card.objects.filter(board=board, column=column, customer=customer).count()
        serializer.save(board=board, created_by=self.request.user, position=max_pos)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        card = self.get_object()

        # Snapshot before update
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
        target_customer_id = request.data.get("customer_id")
        new_position = request.data.get("position", 0)

        target_column = get_object_or_404(Column, pk=target_column_id, board=board)
        target_customer = get_object_or_404(Customer, pk=target_customer_id, board=board)

        column_changed = card.column_id != target_column.pk
        customer_changed = card.customer_id != target_customer.pk

        movement = None
        if column_changed or customer_changed:
            movement = CardMovement.objects.create(
                card=card,
                from_column=card.column,
                to_column=target_column,
                from_customer=card.customer,
                to_customer=target_customer,
                moved_by=request.user,
            )

        # Reorder siblings in source cell (fill gap)
        if column_changed or customer_changed:
            source_siblings = Card.objects.filter(
                board=board, column=card.column, customer=card.customer
            ).exclude(pk=card.pk).order_by("position")
            for i, sibling in enumerate(source_siblings):
                sibling.position = i
                sibling.save(update_fields=["position"])

        # Shift target cell siblings to make room
        Card.objects.filter(
            board=board, column=target_column, customer=target_customer
        ).exclude(pk=card.pk).filter(position__gte=new_position).update(
            position=F("position") + 1
        )

        card.column = target_column
        card.customer = target_customer
        card.position = new_position
        card.save(update_fields=["column", "customer", "position"])

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
            "from_column", "to_column", "from_customer", "to_customer", "moved_by"
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

