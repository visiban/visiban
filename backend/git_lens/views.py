import hashlib
import json
import time

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

# Per-repo lens-board cache. The board is shared, so the cache is keyed by
# (provider, repo, pivot) — NOT by user — so N members viewing one board collapse
# to a single upstream fetch per soft-TTL window. Stale-while-revalidate keeps the
# outbound provider-call rate bounded and predictable (the API-politeness contract).
LENS_CACHE_SOFT_TTL = 60     # serve cached data without revalidating for this long
LENS_CACHE_HARD_TTL = 600    # keep a stale-servable copy this long (SWR + error fallback)
LENS_FETCH_LOCK_TTL = 45     # single-flight lock; must exceed worst-case fetch (MAX_PAGES * timeout)

# The lock must outlive the worst-case synchronous fetch, or it could expire
# mid-fetch and let a second fetcher dogpile the provider. Tie the constants
# together so a future bump to the provider page cap / timeout can't silently
# break the guarantee — fail loudly at import instead.
assert LENS_FETCH_LOCK_TTL >= providers.MAX_PAGES * providers.REQUEST_TIMEOUT, (
    "LENS_FETCH_LOCK_TTL must exceed the worst-case provider fetch duration "
    "(MAX_PAGES * REQUEST_TIMEOUT)"
)

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


def _board_cache_key(provider, repo, column_dim, swimlane_dim, user_scope=None):
    # GitLab public reads are anonymous → the rendered board is identical for every
    # viewer and safe to SHARE by repo (one fetch serves the whole board). GitHub
    # reads use the viewer's OWN token, which may see repos other members can't, so
    # those are scoped per user (``user_scope``) to preserve that boundary — the
    # "public repos only" contract is not enforced upstream, so we must not let one
    # member's token-authorized view leak to another through a shared cache.
    digest = hashlib.sha256(
        f"{provider}|{repo}|{column_dim}|{swimlane_dim}".encode()
    ).hexdigest()[:16]
    scope = f":u{user_scope}" if user_scope is not None else ""
    return f"git_lens:board:v2{scope}:{digest}"


def _lock_key(cache_key: str) -> str:
    return f"{cache_key}:lock"


def _payload_etag(payload: dict) -> str:
    # Content hash for client-side conditional GETs. Excludes ``fetched_at`` so an
    # unchanged repo yields a stable ETag across revalidations and the browser gets
    # a 304. (The Visiban<->provider leg is bounded separately by the shared cache.)
    content = {k: v for k, v in payload.items() if k != "fetched_at"}
    raw = json.dumps(content, sort_keys=True, default=str).encode()
    return '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'


def _board_response(payload: dict, request) -> Response:
    etag = _payload_etag(payload)
    if request.headers.get("If-None-Match") == etag:
        resp = Response(status=304)
    else:
        resp = Response(payload)
    resp["ETag"] = etag
    return resp


def _provider_error_response(exc) -> Response:
    if isinstance(exc, providers.LensRateLimited):
        return Response(
            {
                "detail": "The provider is rate-limiting requests. Try again shortly.",
                "code": "rate_limited",
                "retry_after": exc.retry_after,
            },
            status=429,
        )
    if isinstance(exc, providers.LensNotFound):
        return Response(
            {"detail": str(exc) or "Repository not found.", "code": "repo_not_found"},
            status=404,
        )
    if isinstance(exc, providers.LensAuthError):
        return Response(
            {"detail": str(exc) or "Authentication required.", "code": "auth_required"},
            status=409,
        )
    # Network/timeout/unexpected upstream failure → clean 502, never 500.
    return Response(
        {"detail": "Could not fetch issues from the provider.", "code": "lens_error"},
        status=502,
    )


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

    Any board member may read it. The rendered board is cached and served
    stale-while-revalidate behind a single-flight lock so concurrent viewers never
    dogpile the provider API. GitLab (anonymous, public) is cached per
    (provider, repo, pivot) and shared across all members; GitHub (the viewer's own
    token) is additionally scoped per user so a token-authorized view never leaks
    to a member whose token lacks that access.
    """

    permission_classes = _BOARD_PERMISSIONS

    def get(self, request, board_id):
        board, _role = get_board_for_user(board_id, request.user, slim=True)
        conn = LensConnection.objects.filter(board=board).first()
        if conn is None:
            return Response({"detail": "No lens configured for this board."}, status=404)

        # Optional per-request pivot overrides (ad-hoc re-pivot without saving).
        # Coerce unknown values back to the saved dim — this both validates the
        # query params and bounds the shared cache key space (no pollution).
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

        # GitHub needs the viewer's OWN OAuth token; GitLab public reads go
        # anonymous. This gate stays BEFORE the cache so a viewer without a GitHub
        # token cannot free-ride on a copy another member's token populated.
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

        return self._serve_board(
            request, conn, provider_fn, config, column_dim, swimlane_dim, token
        )

    def _serve_board(self, request, conn, provider_fn, config, column_dim, swimlane_dim, token):
        """Stale-while-revalidate read with a single-flight lock.

        At most one request revalidates a given (repo, pivot) at a time; every
        other concurrent viewer is served the last good copy immediately. On a
        provider error we degrade to the stale copy rather than failing the board,
        so a transient rate-limit or network blip is invisible to viewers and we
        never retry-storm the provider.
        """
        # Scope the cache to the viewer only when we fetch with their credential
        # (GitHub). Anonymous (GitLab public) reads share one copy across the board.
        user_scope = request.user.id if token is not None else None
        key = _board_cache_key(
            conn.provider, conn.repo_slug, column_dim, swimlane_dim, user_scope
        )
        entry = cache.get(key)
        if entry is not None and time.time() < entry["soft_expires"]:
            return _board_response(entry["payload"], request)  # fresh

        # Stale or cold: try to become the sole fetcher for this (repo, pivot).
        holding_lock = cache.add(_lock_key(key), "1", LENS_FETCH_LOCK_TTL)
        if entry is not None and not holding_lock:
            # Another request is already revalidating — serve the stale copy now.
            return _board_response(entry["payload"], request)

        try:
            data = provider_fn(token, conn.repo_slug, config)
        except (providers.LensError, requests.RequestException) as exc:
            if entry is not None:
                # Degrade to the last good copy instead of failing the board.
                return _board_response(entry["payload"], request)
            return _provider_error_response(exc)
        finally:
            if holding_lock:
                cache.delete(_lock_key(key))

        payload = data.to_dict()
        cache.set(
            key,
            {"payload": payload, "soft_expires": time.time() + LENS_CACHE_SOFT_TTL},
            LENS_CACHE_HARD_TTL,
        )
        return _board_response(payload, request)
