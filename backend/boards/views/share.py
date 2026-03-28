"""ShareBoardView — public read-only board access via share token."""

from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from ..models import Board
from ..serializers import PublicBoardSerializer


class ShareLinkThrottle(SimpleRateThrottle):
    """Rate-limit unauthenticated reads of public share-link boards.

    Scope 'share_link' maps to DEFAULT_THROTTLE_RATES['share_link'] in settings
    (120/hour in production).  Keyed on client IP so the limit applies per
    visitor, not per token.
    """

    scope = "share_link"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


class ShareBoardView(APIView):
    """GET /api/share/<token>/ — public read-only board view, no authentication required.

    The UUID token is the sole credential. Returns a stripped board payload
    (columns, swimlanes, cards, labels) with all PII removed:
    - No user PKs or emails in assignee or any nested user object
    - No swimlane contact_email or notes
    - No comments, movement history, or member list
    - No share_token in the response body
    """

    permission_classes = []
    authentication_classes = []
    throttle_classes = [ShareLinkThrottle]

    def get(self, request, token):
        import uuid as _uuid
        try:
            token_uuid = _uuid.UUID(token)
        except ValueError:
            from django.http import Http404
            raise Http404
        board = get_object_or_404(
            Board.objects.prefetch_related("columns", "swimlanes", "labels"),
            share_token=token_uuid,
        )
        return Response(PublicBoardSerializer(board).data)
