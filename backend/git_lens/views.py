import hashlib

import requests
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from allauth.socialaccount.models import SocialToken
from boards.broadcast import broadcast_board_event
from boards.models import BoardMembership
from boards.permissions import SITE_ADMIN
from boards.views import get_board_for_user
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

from . import providers
from .models import LensConnection
from .serializers import (
    _VALID_COLUMN_DIMS,
    _VALID_SWIMLANE_DIMS,
    LensConnectionSerializer,
)
from .types import LensConfig

LENS_CACHE_TTL = 60  # seconds — short, since the repo is the source of truth

# Explicit permission chain, mirroring every other board-scoped view in the
# codebase so an accidental change to DEFAULT_PERMISSION_CLASSES cannot silently
# drop the auth gate from these endpoints without a visible diff here.
_BOARD_PERMISSIONS = [
    IsAuthenticated,
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
]


def _require_board_admin(role):
    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        raise PermissionDenied("Only board admins can configure the issue lens.")


def _user_provider_token(user, provider):
    """Return a non-expired OAuth token for *provider*, or None.

    Never log or serialize the returned value — it is sent only as an outbound
    Authorization header to the provider API.
    """
    tok = (
        SocialToken.objects.filter(account__user=user, account__provider=provider)
        .order_by("-expires_at")
        .first()
    )
    if not tok:
        return None
    if tok.expires_at and tok.expires_at < timezone.now():
        return None
    return tok.token


def _cache_key(user_id, provider, repo, column_dim, swimlane_dim):
    digest = hashlib.sha256(
        f"{provider}|{repo}|{column_dim}|{swimlane_dim}".encode()
    ).hexdigest()[:16]
    return f"git_lens:v1:{user_id}:{digest}"


class LensConnectionView(APIView):
    """Read/configure/detach the lens connection for a board.

    Read: any board member. Write/delete: board admin, owner, or site admin.
    """

    permission_classes = _BOARD_PERMISSIONS

    def get(self, request, board_id):
        board, _role = get_board_for_user(board_id, request.user, slim=True)
        # select_related avoids a second query to render the nested created_by user.
        conn = (
            LensConnection.objects.select_related("created_by")
            .filter(board=board)
            .first()
        )
        if conn is None:
            return Response({"detail": "No lens configured for this board."}, status=404)
        return Response(LensConnectionSerializer(conn).data)

    def put(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user, slim=True)
        _require_board_admin(role)
        serializer = LensConnectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with transaction.atomic():
            conn, _created = LensConnection.objects.update_or_create(
                board=board,
                defaults={
                    "provider": data["provider"],
                    "repo_slug": data["repo_slug"],
                    "column_dim": data.get("column_dim", "status"),
                    "swimlane_dim": data.get("swimlane_dim", "milestone"),
                    "created_by": request.user,
                },
            )
            # Re-fetch with the FK pre-loaded so serializing created_by is one query.
            conn = LensConnection.objects.select_related("created_by").get(pk=conn.pk)
            payload = LensConnectionSerializer(conn).data
            # Notify other connected board members so the Lens tab appears for them.
            board_id_int = board.id
            transaction.on_commit(
                lambda b=board_id_int, p=payload: broadcast_board_event(
                    b, "lens_connection.configured", p
                )
            )
        return Response(payload)

    def delete(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user, slim=True)
        _require_board_admin(role)
        with transaction.atomic():
            LensConnection.objects.filter(board=board).delete()
            board_id_int = board.id
            transaction.on_commit(
                lambda b=board_id_int: broadcast_board_event(
                    b, "lens_connection.removed", {"board_id": b}
                )
            )
        return Response(status=204)


class LensBoardView(APIView):
    """Return the rendered, read-only lens board for a configured connection.

    Any board member may read it. Results are cached per (user, repo, pivot) for
    a short TTL to respect provider rate limits.
    """

    permission_classes = _BOARD_PERMISSIONS

    def get(self, request, board_id):
        board, _role = get_board_for_user(board_id, request.user, slim=True)
        conn = LensConnection.objects.filter(board=board).first()
        if conn is None:
            return Response({"detail": "No lens configured for this board."}, status=404)

        # Optional per-request pivot overrides (ad-hoc re-pivot without saving).
        # Coerce unknown values back to the saved dim — this both validates the
        # query params and bounds the per-user cache key space (no pollution).
        column_dim = request.query_params.get("column_dim") or conn.column_dim
        swimlane_dim = request.query_params.get("swimlane_dim") or conn.swimlane_dim
        if column_dim not in _VALID_COLUMN_DIMS:
            column_dim = conn.column_dim
        if swimlane_dim not in _VALID_SWIMLANE_DIMS:
            swimlane_dim = conn.swimlane_dim
        config = LensConfig(column_dim=column_dim, swimlane_dim=swimlane_dim)

        provider_fn = providers.get_provider(conn.provider)
        if provider_fn is None:
            return Response(
                {"detail": "Unknown provider.", "code": "unknown_provider"}, status=400
            )

        # GitHub needs the user's own OAuth token; GitLab public reads go anonymous.
        token = None
        if conn.provider == "github":
            token = _user_provider_token(request.user, "github")
            if not token:
                return Response(
                    {
                        "detail": "Connect your GitHub account to use this lens.",
                        "code": "auth_required",
                    },
                    status=409,
                )

        cache_key = _cache_key(
            request.user.id, conn.provider, conn.repo_slug, column_dim, swimlane_dim
        )
        cached = cache.get(cache_key)
        if cached is not None:
            return Response(cached)

        try:
            data = provider_fn(token, conn.repo_slug, config)
        except providers.LensRateLimited as exc:
            return Response(
                {
                    "detail": "The provider is rate-limiting requests. Try again shortly.",
                    "code": "rate_limited",
                    "retry_after": exc.retry_after,
                },
                status=429,
            )
        except providers.LensNotFound as exc:
            return Response(
                {"detail": str(exc) or "Repository not found.", "code": "repo_not_found"},
                status=404,
            )
        except providers.LensAuthError as exc:
            return Response(
                {"detail": str(exc) or "Authentication required.", "code": "auth_required"},
                status=409,
            )
        except (providers.LensError, requests.RequestException):
            # Network/timeout/unexpected upstream failure → clean 502, never 500.
            return Response(
                {"detail": "Could not fetch issues from the provider.", "code": "lens_error"},
                status=502,
            )

        payload = data.to_dict()
        cache.set(cache_key, payload, LENS_CACHE_TTL)
        return Response(payload)
