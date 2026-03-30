"""Health check and version views — liveness, readiness, and version endpoints."""

from django.conf import settings as django_settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
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
            errors["db"] = str(exc)

        # Check Redis cache
        try:
            from django.core.cache import cache
            cache.set("_health", "ok", timeout=5)
            if cache.get("_health") != "ok":
                errors["redis"] = "cache read/write mismatch"
        except Exception as exc:
            errors["redis"] = str(exc)

        if errors:
            return Response({"status": "error", "errors": errors}, status=503)
        return Response({"status": "ok"})
