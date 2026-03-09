from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404
from rest_framework import status, viewsets
from rest_framework.decorators import action
from .broadcast import broadcast_board_event
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement, CardActivity, CardAttachment, CardChecklist, CardComment
from .permissions import get_board_role, SITE_ADMIN
from .serializers import (
    BoardSerializer, BoardFullSerializer, BoardMembershipSerializer,
    ColumnSerializer, SwimlaneSerializer, LabelSerializer,
    CardSerializer, CardMovementSerializer, CardCommentSerializer, CardActivitySerializer, CardAttachmentSerializer, CardChecklistSerializer,
)
from accounts.models import User


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
        if user.is_site_admin:
            return Board.objects.all()
        return Board.objects.filter(
            Q(owner=user) |
            Q(memberships__user=user) |
            Q(group__in=get_accessible_group_ids(user))
        ).distinct()

    def perform_create(self, serializer):
        from .templates import BOARD_TEMPLATES
        board = serializer.save(owner=self.request.user)
        BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

        template_key = self.request.data.get("template", "simple_kanban")
        template = BOARD_TEMPLATES.get(template_key, BOARD_TEMPLATES["simple_kanban"])

        if template["columns"]:
            Column.objects.bulk_create([
                Column(board=board, name=col["name"], position=i, color=col["color"], allow_card_creation=(i == 0))
                for i, col in enumerate(template["columns"])
            ])

        if template["default_swimlane"]:
            Swimlane.objects.create(board=board, name=template["default_swimlane"], position=0, color="#6B7280")

    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        role = get_board_role(request.user, board)
        if board.owner != request.user and role != SITE_ADMIN:
            return Response(status=status.HTTP_403_FORBIDDEN)
        board.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="move-group")
    def move_group(self, request, pk=None):
        board, role = get_board_for_user(pk, request.user)
        if board.owner != request.user and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
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

    @action(detail=True, methods=["get"])
    def summary(self, request, pk=None):
        """Per-swimlane card counts, stage distribution, and velocity."""
        import datetime
        from django.utils import timezone

        board, _ = get_board_for_user(pk, request.user)
        now = timezone.now()
        cutoff_7d = now - datetime.timedelta(days=7)
        cutoff_30d = now - datetime.timedelta(days=30)

        columns = list(board.columns.order_by("position"))
        last_column = columns[-1] if columns else None

        result = []
        for swimlane in board.swimlanes.order_by("position"):
            cards = board.cards.filter(swimlane=swimlane)
            stage_dist = {col.name: cards.filter(column=col).count() for col in columns}

            vel_7d = vel_30d = 0
            if last_column:
                base_qs = CardMovement.objects.filter(
                    card__board=board, card__swimlane=swimlane, to_column=last_column
                )
                vel_7d = base_qs.filter(moved_at__gte=cutoff_7d).count()
                vel_30d = base_qs.filter(moved_at__gte=cutoff_30d).count()

            result.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "color": swimlane.color,
                "total_cards": cards.count(),
                "stage_distribution": stage_dist,
                "velocity_7d": vel_7d,
                "velocity_30d": vel_30d,
            })

        return Response({"swimlanes": result})

    @action(detail=True, methods=["get"])
    def analytics(self, request, pk=None):
        """Time-in-stage heatmap with outlier detection and stalled cards."""
        import datetime
        import statistics
        from django.utils import timezone

        board, _ = get_board_for_user(pk, request.user)
        days = int(request.query_params.get("days", 30))
        stalled_days = int(request.query_params.get("stalled_days", 7))
        now = timezone.now()
        stall_cutoff = now - datetime.timedelta(days=stalled_days)

        columns = list(board.columns.order_by("position"))
        col_id_to_name = {c.id: c.name for c in columns}

        swimlane_results = []
        all_col_dwells: dict[str, list[float]] = {c.name: [] for c in columns}

        for swimlane in board.swimlanes.order_by("position"):
            cards = list(
                board.cards.filter(swimlane=swimlane).prefetch_related("movements")
            )
            col_dwells: dict[str, list[float]] = {c.name: [] for c in columns}
            stalled_cards = []
            deal_velocity_days = []

            for card in cards:
                movements = list(card.movements.order_by("moved_at"))
                if not movements:
                    continue
                for i, mv in enumerate(movements):
                    col_name = col_id_to_name.get(mv.to_column_id)
                    if not col_name:
                        continue
                    entry = mv.moved_at
                    exit_ = movements[i + 1].moved_at if i + 1 < len(movements) else now
                    dwell_days = (exit_ - entry).total_seconds() / 86400
                    col_dwells[col_name].append(dwell_days)
                    all_col_dwells[col_name].append(dwell_days)
                if len(movements) > 1:
                    deal_velocity_days.append(
                        (movements[-1].moved_at - movements[0].moved_at).total_seconds() / 86400
                    )
                if movements[-1].moved_at < stall_cutoff:
                    stalled_cards.append({
                        "id": card.id,
                        "title": card.title,
                        "days_since_move": (now - movements[-1].moved_at).days,
                    })

            avg_days = {
                col.name: (
                    round(sum(col_dwells[col.name]) / len(col_dwells[col.name]), 1)
                    if col_dwells[col.name] else None
                )
                for col in columns
            }
            swimlane_results.append({
                "id": swimlane.id,
                "name": swimlane.name,
                "avg_days_per_column": avg_days,
                "deal_velocity_days": (
                    round(sum(deal_velocity_days) / len(deal_velocity_days), 1)
                    if deal_velocity_days else None
                ),
                "stalled_cards": stalled_cards,
                "is_outlier": {},
            })

        board_medians = {
            col.name: (
                round(statistics.median(all_col_dwells[col.name]), 1)
                if all_col_dwells[col.name] else None
            )
            for col in columns
        }
        for sw in swimlane_results:
            sw["is_outlier"] = {
                col.name: (
                    sw["avg_days_per_column"][col.name] is not None
                    and board_medians[col.name] is not None
                    and board_medians[col.name] > 0
                    and sw["avg_days_per_column"][col.name] > 2 * board_medians[col.name]
                )
                for col in columns
            }

        return Response({
            "days": days,
            "columns": [c.name for c in columns],
            "board_medians": board_medians,
            "swimlanes": swimlane_results,
            "stalled_threshold_days": stalled_days,
        })

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        """Export board data as CSV or JSON."""
        import csv
        import io
        import datetime
        from django.http import HttpResponse

        board, _ = get_board_for_user(pk, request.user)
        export_format = request.query_params.get("format", "csv")
        today = datetime.date.today().isoformat()
        safe_name = board.name.replace(" ", "-").replace("/", "-")

        cards = (
            Card.objects.filter(board=board)
            .select_related("column", "swimlane", "assignee", "created_by")
            .prefetch_related(
                "labels",
                "movements__from_column",
                "movements__to_column",
                "movements__moved_by",
                "comments__author",
                "checklist_items",
            )
            .order_by("position")
        )

        if export_format == "json":
            columns = board.columns.order_by("position")
            swimlanes = board.swimlanes.order_by("position")
            labels = board.labels.all()

            cards_data = []
            for card in cards:
                movements = list(card.movements.order_by("moved_at"))
                cards_data.append({
                    "title": card.title,
                    "description": card.description,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "priority": card.priority,
                    "assignee": card.assignee.username if card.assignee else None,
                    "labels": [l.name for l in card.labels.all()],
                    "due_date": card.due_date.isoformat() if card.due_date else None,
                    "weight": card.weight,
                    "position": card.position,
                    "created_at": card.created_at.isoformat(),
                    "created_by": card.created_by.username if card.created_by else None,
                    "comments": [
                        {
                            "author": c.author.username if c.author else None,
                            "body": c.body,
                            "created_at": c.created_at.isoformat(),
                        }
                        for c in card.comments.order_by("created_at")
                    ],
                    "checklist": [
                        {
                            "text": item.text,
                            "is_checked": item.is_checked,
                        }
                        for item in card.checklist_items.order_by("position")
                    ],
                })

            payload = {
                "name": board.name,
                "description": board.description,
                "columns": [
                    {
                        "name": col.name,
                        "position": col.position,
                        "color": col.color,
                        "wip_limit": col.wip_limit,
                        "weight_limit": col.weight_limit,
                        "allow_card_creation": col.allow_card_creation,
                    }
                    for col in columns
                ],
                "swimlanes": [
                    {
                        "name": sw.name,
                        "position": sw.position,
                        "color": sw.color,
                        "contact_email": sw.contact_email,
                        "notes": sw.notes,
                    }
                    for sw in swimlanes
                ],
                "labels": [
                    {"name": l.name, "color": l.color}
                    for l in labels
                ],
                "cards": cards_data,
            }

            import json
            content = json.dumps(payload, indent=2, ensure_ascii=False)
            response = HttpResponse(content, content_type="application/json")
            response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.json"'
            return response

        # Default: CSV export
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "Card ID", "Title", "Description", "Column", "Swimlane",
            "Priority", "Assignee", "Labels", "Due Date", "Weight",
            "Created At", "Created By", "Last Moved At", "Movement Count",
            "Movement History",
        ])

        for card in cards:
            movements = list(card.movements.order_by("moved_at"))
            label_names = ", ".join(l.name for l in card.labels.all())
            last_moved = movements[-1].moved_at.isoformat() if movements else ""
            history_parts = []
            for mv in movements:
                from_col = mv.from_column.name if mv.from_column else ""
                to_col = mv.to_column.name if mv.to_column else ""
                moved_by = mv.moved_by.username if mv.moved_by else ""
                history_parts.append(
                    f"{mv.moved_at.isoformat()}|{from_col}|{to_col}|{moved_by}"
                )
            history = "; ".join(history_parts)

            writer.writerow([
                card.id,
                card.title,
                card.description,
                card.column.name,
                card.swimlane.name,
                card.priority,
                card.assignee.username if card.assignee else "",
                label_names,
                card.due_date.isoformat() if card.due_date else "",
                card.weight,
                card.created_at.isoformat(),
                card.created_by.username if card.created_by else "",
                last_moved,
                len(movements),
                history,
            ])

        response = HttpResponse(buf.getvalue(), content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="{safe_name}-{today}.csv"'
        return response

    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            return Response(status=status.HTTP_403_FORBIDDEN)
        user_id = request.data.get("user_id")
        member_role = request.data.get("role", BoardMembership.Role.MEMBER)
        target_user = get_object_or_404(User, pk=user_id)
        # Only site admins can add/change other site admins
        if target_user.is_site_admin and role != SITE_ADMIN:
            return Response(
                {"detail": "Cannot modify a site admin's board membership."},
                status=status.HTTP_403_FORBIDDEN,
            )
        membership, created = BoardMembership.objects.get_or_create(
            board=board, user=target_user, defaults={"role": member_role}
        )
        if not created:
            membership.role = member_role
            membership.save()
        return Response(BoardMembershipSerializer(membership).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path="members/(?P<user_id>[^/.]+)")
    def remove_member(self, request, pk=None, user_id=None):
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            return Response(status=status.HTTP_403_FORBIDDEN)
        target_user = get_object_or_404(User, pk=user_id)
        if target_user.is_site_admin and role != SITE_ADMIN:
            return Response(
                {"detail": "Cannot remove a site admin from a board."},
                status=status.HTTP_403_FORBIDDEN,
            )
        BoardMembership.objects.filter(board=board, user=target_user).delete()
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
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        max_pos = board.columns.count()
        column = serializer.save(board=board, position=max_pos)
        broadcast_board_event(board.id, "column.created", ColumnSerializer(column).data)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        column = serializer.save()
        broadcast_board_event(column.board_id, "column.updated", ColumnSerializer(column).data)

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        board_id = instance.board_id
        column_id = instance.id
        instance.delete()
        broadcast_board_event(board_id, "column.deleted", {"column_id": column_id})

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
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
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        max_pos = board.swimlanes.count()
        swimlane = serializer.save(board=board, position=max_pos)
        broadcast_board_event(board.id, "swimlane.created", SwimlaneSerializer(swimlane).data)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        swimlane = serializer.save()
        broadcast_board_event(swimlane.board_id, "swimlane.updated", SwimlaneSerializer(swimlane).data)

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        board_id = instance.board_id
        swimlane_id = instance.id
        instance.delete()
        broadcast_board_event(board_id, "swimlane.deleted", {"swimlane_id": swimlane_id})

    @action(detail=False, methods=["post"])
    def reorder(self, request, board_pk=None):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
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
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save(board=board)

    def perform_update(self, serializer):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        serializer.save()

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
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
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
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
        broadcast_board_event(board.id, "card.created",
            CardSerializer(card, context={"request": self.request, "board": board}).data)

    def perform_destroy(self, instance):
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
        board_id = instance.board_id
        card_id = instance.id
        instance.delete()
        broadcast_board_event(board_id, "card.deleted", {"card_id": card_id})

    def update(self, request, *args, **kwargs):
        _, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
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
            # Notify new assignee
            if card.assignee and card.assignee != request.user:
                from .models import Notification
                Notification.objects.create(
                    recipient=card.assignee,
                    verb=f"You were assigned to \"{card.title}\"",
                    card=card,
                    board=card.board,
                )
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

        broadcast_board_event(card.board_id, "card.updated", serializer.data)
        return Response(serializer.data)

    @action(detail=True, methods=["post"])
    @transaction.atomic
    def move(self, request, board_pk=None, pk=None):
        board, role = self._board_and_role()
        if role in (BoardMembership.Role.VIEWER, BoardMembership.Role.COLLABORATOR):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied
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

        card_data = CardSerializer(card, context={"request": request, "board": board}).data
        response_data = {"card": card_data}
        if movement:
            response_data["movement"] = CardMovementSerializer(movement).data

        broadcast_board_event(board.id, "card.moved", card_data)
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
        comment = serializer.save(card=card, author=request.user)
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.COMMENT_ADDED,
            from_value="", to_value="", actor=request.user,
        )
        # Parse @username mentions and notify each mentioned board member
        import re
        from .models import Notification
        mentioned_usernames = set(re.findall(r"@(\w+)", comment.body))
        if mentioned_usernames:
            # Collect effective member IDs: direct memberships + owner + group-inherited + site admins
            eff_ids = set(board.memberships.values_list("user_id", flat=True))
            eff_ids.add(board.owner_id)
            eff_ids.update(User.objects.filter(is_site_admin=True).values_list("id", flat=True))
            if board.group_id:
                node = board.group
                depth = 0
                while node and depth < 6:
                    eff_ids.update(node.memberships.values_list("user_id", flat=True))
                    node = node.parent
                    depth += 1
            member_users = User.objects.filter(
                username__in=mentioned_usernames,
                pk__in=eff_ids,
            ).exclude(pk=request.user.pk)
            Notification.objects.bulk_create([
                Notification(
                    recipient=u,
                    verb=f"{request.user.username} mentioned you in \"{card.title}\"",
                    card=card,
                    board=board,
                )
                for u in member_users
            ])
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



# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .models import Notification
        qs = Notification.objects.filter(recipient=request.user).select_related("card", "board")[:50]
        data = [
            {
                "id": n.id,
                "verb": n.verb,
                "card_id": n.card_id,
                "card_title": n.card.title if n.card else None,
                "board_id": n.board_id,
                "board_name": n.board.name if n.board else None,
                "read": n.read,
                "created_at": n.created_at,
            }
            for n in qs
        ]
        return Response(data)


class NotificationMarkReadView(APIView):
    """POST /api/notifications/mark-read/"""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .models import Notification
        if request.data.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = request.data.get("ids", [])
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .models import Notification
        count = Notification.objects.filter(recipient=request.user, read=False).count()
        return Response({"count": count})


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from django.conf import settings
        return Response({"version": settings.APP_VERSION})
