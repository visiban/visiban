"""BoardTemplateListView — returns available board templates."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from ..models import BoardTemplate
from ..serializers import BoardTemplateSerializer


class BoardTemplateListView(APIView):
    """Return the list of active board templates for the board creation modal.

    Only active templates are returned, ordered by sort_order.
    Authentication is required — the templates contain no sensitive data, but
    an unauthed caller has no reason to query this endpoint and requiring auth
    aligns with the rest of the boards API.
    """

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def get(self, request):
        templates = BoardTemplate.objects.filter(is_active=True).order_by("sort_order", "name")
        return Response(BoardTemplateSerializer(templates, many=True).data)
