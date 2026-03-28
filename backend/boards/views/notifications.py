"""Notification views — list, mark-read, and unread-count endpoints."""

from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import Notification


class NotificationListView(APIView):
    """GET /api/notifications/ — last 50 notifications for current user"""

    def get(self, request):
        qs = Notification.objects.filter(recipient=request.user, read=False).select_related("card", "board")[:50]
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

    def post(self, request):
        if request.data.get("all"):
            Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        else:
            ids = request.data.get("ids", [])
            Notification.objects.filter(recipient=request.user, id__in=ids).update(read=True)
        return Response({"ok": True})


class NotificationUnreadCountView(APIView):
    """GET /api/notifications/unread-count/"""

    def get(self, request):
        count = Notification.objects.filter(recipient=request.user, read=False).count()
        return Response({"count": count})
