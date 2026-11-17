"""ShareBoardView — public read-only board access via share token."""

import hmac
import uuid

from drf_spectacular.utils import extend_schema, inline_serializer, OpenApiResponse
from rest_framework.generics import get_object_or_404
from django.db import transaction
from django.http import Http404
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from ..models import Board
from ..permissions import GROUP_ANCESTOR_SELECT_RELATED
from ..services.share_links import revoke_lapsed_share_links, share_enabler_has_standing
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


class ShareLinkTokenThrottle(SimpleRateThrottle):
    """Per-token rate limit for share-link reads (#988).

    Defense in depth on top of ``ShareLinkThrottle`` (per-IP).  UUID share
    tokens already provide 122 bits of entropy so brute-force enumeration is
    impractical; this throttle bounds the volume of legitimate-looking reads
    against any *single* token regardless of source IP, which is what
    catches CGNAT/proxy-pool abuse that would otherwise bypass the per-IP
    limit.

    Keyed on the hash of the token segment from the URL (passed via
    ``view.kwargs``). The throttle silently no-ops when no token is in scope.
    """

    scope = "share_link_token"

    def get_cache_key(self, request, view):
        token = (view.kwargs or {}).get("token")
        if not token:
            return None
        # Key on the hash of the canonical UUID, not the raw segment: uuid.UUID() accepts
        # several spellings of one value (uppercase, no hyphens, braces,
        # urn:uuid:), and each would otherwise get its own bucket and
        # multiply the per-token limit (#1530).  A non-UUID segment returns
        # None so it mints no cache key at all (the view answers it with 404);
        # the per-IP ShareLinkThrottle still applies to it.  The key holds the
        # token's hash, never the token itself (#1880): the cache is a store
        # like the database, and the hash is what links are resolved by.
        # hash_share_token canonicalizes first, so the spellings above still
        # share one bucket.
        try:
            ident = Board.hash_share_token(token)
        except (ValueError, AttributeError, TypeError):
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": ident,
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
    throttle_classes = [ShareLinkThrottle, ShareLinkTokenThrottle]

    @extend_schema(
        summary="Get a public read-only board by its share token",
        description="No authentication required. The UUID token is the sole credential.",
        responses={
            200: PublicBoardSerializer,
            404: OpenApiResponse(
                description=(
                    "Token is not a valid UUID, no board has that share token, the "
                    "admin who enabled the link is no longer active or no longer an "
                    "admin of the board, or the link has no recorded enabler (a board "
                    "admin enables sharing again to issue a new link)."
                ),
            ),
            410: OpenApiResponse(
                description="The share link has expired.",
                response=inline_serializer(name="ShareLinkExpired", fields={"detail": serializers.CharField()}),
            ),
        },
    )
    def get(self, request, token):
        try:
            token_hash = Board.hash_share_token(uuid.UUID(token))
        except ValueError:
            raise Http404
        # Resolved by the token's hash, as invite links are (#1880); the
        # stored plaintext is never matched against the presented value.
        # ``share_token__isnull=False`` is a liveness check, not a value
        # match: a link whose token was cleared is gone even if a clear route
        # ever left its hash behind.
        board = get_object_or_404(
            Board.objects.select_related("share_enabled_by", GROUP_ANCESTOR_SELECT_RELATED)
            .prefetch_related(
                "columns", "swimlanes", "labels",
                # PublicColumnSerializer's sub_columns / tracks (#1102, #1921).
                "columns__sub_columns", "columns__stage_tracks__field_definition",
            ),
            share_token_hash=token_hash,
            share_token__isnull=False,
        )
        # The row's own hash must still be the hash of the row's own token.
        # A writer that changes the token without the hash (a backend of the
        # previous release during a rolling upgrade rotates or re-enables a
        # link without knowing about the hash) leaves a stale pair; it answers
        # 404 rather than letting the previous token keep resolving. This
        # compares two stored values; the presented token is matched only by
        # the hash lookup above.
        if not hmac.compare_digest(board.share_token_hash, Board.hash_share_token(board.share_token)):
            raise Http404
        # A link lasts while the admin who enabled it keeps admin standing on
        # the board (#1865). Checked on every read, before the expiry branch,
        # so a lapsed link answers like a revoked one. The board is cleared
        # here too, so a later return of that standing does not bring this
        # link back; the clear is conditional on this token and enabler, so
        # it never touches a link re-enabled meanwhile.
        #
        # A link with no recorded enabler (#1939) is answered the same way:
        # there is no account whose standing could keep it, so it stops
        # resolving and is cleared until a board admin enables sharing again,
        # which records that admin. The enabler is deliberately not inferred
        # from the board's current admins: one of them did not choose to share
        # the board, and holding the link on their standing would keep it live
        # after the account that did choose to share it lost its role.
        if not share_enabler_has_standing(board.share_enabled_by, board):
            with transaction.atomic():
                revoke_lapsed_share_links(board_ids=[board.pk], include_unrecorded=True)
            raise Http404
        # TTL enforcement (#804): once the expiry has passed, stop serving the
        # board but keep returning 410 Gone rather than 404 so the caller can
        # tell "expired" apart from "never existed". Token is not auto-rotated
        # here — an admin must disable or regenerate it explicitly.
        if board.share_token_expires_at is not None and board.share_token_expires_at <= timezone.now():
            return Response(
                {"detail": "This share link has expired."},
                status=status.HTTP_410_GONE,
            )
        return Response(PublicBoardSerializer(board).data)
