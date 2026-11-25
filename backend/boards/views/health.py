"""Health check and version views — liveness, readiness, and version endpoints."""

import logging

from django.conf import settings as django_settings
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
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

# Response schemas (#1793). These views build their bodies by hand, so without
# a declaration drf-spectacular published a bodiless 200 and neither generated
# clients nor the schema-fuzz conformance check could see the shape.
_VersionResponse = inline_serializer(
    name="VersionResponse",
    fields={"version": serializers.CharField()},
)
_LivenessResponse = inline_serializer(
    name="LivenessResponse",
    fields={"status": serializers.ChoiceField(choices=["ok"])},
)
# One component for 200 and 503: the 200 is ``ok`` or ``degraded`` with no
# ``errors``; the 503 is ``error`` plus the deprecated ``errors`` map (#1728,
# #1902), whose only key today is ``db`` and whose value is always
# ``unavailable``. ``errors`` is not required because a 200 never carries it.
_ReadinessResponse = inline_serializer(
    name="ReadinessResponse",
    fields={
        "status": serializers.ChoiceField(choices=["ok", "degraded", "error"]),
        "errors": serializers.DictField(child=serializers.CharField(), required=False),
    },
)


class VersionView(APIView):
    """GET /api/version/ — returns the running application version."""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]

    @extend_schema(responses={200: _VersionResponse})
    def get(self, request):
        return Response({"version": django_settings.APP_VERSION})


class LivenessView(APIView):
    """GET /api/health/liveness/ — K8s liveness probe. Returns 200 if the process is alive."""
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    @extend_schema(responses={200: _LivenessResponse})
    def get(self, request):
        return Response({"status": "ok"})


class ReadinessView(APIView):
    """GET /api/health/readiness/ — K8s readiness probe.

    Readiness depends on the database only (#1465). Valkey backs the channel
    layer and the cache; with it down ordinary REST traffic still works
    (the global throttles fail open and the SiteSetting reads fall through to
    the DB, see visiban/cache_outage.py; named security throttles fail
    closed) and realtime updates stop. Failing
    readiness for that would unready every pod and take the whole app offline
    for a partial outage, so a cache failure reports ``degraded`` with HTTP 200
    and a warning in the server log instead.
    """
    permission_classes = []
    authentication_classes = []
    throttle_classes = []

    @extend_schema(responses={200: _ReadinessResponse, 503: _ReadinessResponse})
    def get(self, request):
        errors = {}
        degraded = False

        # Check database
        try:
            from django.db import connection
            connection.ensure_connection()
        except Exception as exc:
            logger.warning("Readiness check failed: database", exc_info=exc)
            errors["db"] = _UNAVAILABLE

        # Check Valkey cache. Non-fatal: see the class docstring. ONE
        # round-trip: each call can cost up to the cache socket timeout when
        # Valkey is black-holed (REDIS_CACHE_SOCKET_*_TIMEOUT, #1465), and the
        # whole probe must answer inside Kubernetes' 1-second default. A SET
        # that returns proves the connection, auth, and a writable server.
        try:
            from django.core.cache import cache
            cache.set("_health", "ok", timeout=5)
        except Exception as exc:
            logger.warning("Readiness degraded: cache", exc_info=exc)
            degraded = True

        if errors:
            # ``errors`` is deprecated (1.3, #1728): it names the backing
            # services to anonymous callers. It stays in every 1.x response
            # because docs/api/health.md published its keys as a contract;
            # removal is a 2.0 change (#1902). Consumers should read the
            # status code.
            return Response({"status": "error", "errors": errors}, status=503)
        if degraded:
            # 200 so the pod keeps receiving traffic. The body carries no
            # component name (anonymous endpoint, see ``errors`` deprecation).
            return Response({"status": "degraded"})
        return Response({"status": "ok"})
