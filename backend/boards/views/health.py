"""Health check and version views — liveness, readiness, and version endpoints."""

import logging

from django.conf import settings as django_settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)

logger = logging.getLogger(__name__)

# Fixed value reported for a failing component. Detail stays in server logs:
# this endpoint is anonymous, so it must not echo driver/exception text.
_UNAVAILABLE = "unavailable"


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    def get(self, request):
        return Response({"version": django_settings.APP_VERSION})


class LivenessView(APIView):
    """GET /api/health/liveness/ — K8s liveness probe. Returns 200 if the process is alive."""
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        return Response({"status": "ok"})


class ReadinessView(APIView):
    """GET /api/health/readiness/ — K8s readiness probe. Checks DB and Redis."""
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        errors = {}

        # Check database
        try:
            from django.db import connection
            connection.ensure_connection()
        except Exception as exc:
            logger.warning("Readiness check failed: database", exc_info=exc)
            errors["db"] = _UNAVAILABLE

        # Check Redis cache
        try:
            from django.core.cache import cache
            cache.set("_health", "ok", timeout=5)
            if cache.get("_health") != "ok":
                logger.warning("Readiness check failed: cache read/write mismatch")
                errors["redis"] = _UNAVAILABLE
        except Exception as exc:
            logger.warning("Readiness check failed: cache", exc_info=exc)
            errors["redis"] = _UNAVAILABLE

        if errors:
            # ``errors`` is deprecated (1.3, #1728): it names the backing
            # services to anonymous callers. It stays in every 1.x response
            # because docs/api/health.md published its keys as a contract;
            # removal is a 2.0 change (#1902). Consumers should read the
            # status code.
            return Response({"status": "error", "errors": errors}, status=503)
        return Response({"status": "ok"})
