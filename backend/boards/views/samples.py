"""Sample board gallery endpoints (#1452).

``GET /boards/samples/`` lists the shipped sample boards and
``GET /boards/samples/{id}/`` returns one as the raw JSON file. The client
sends that file through the unchanged ``POST /boards/import/``, so group
access and the import throttle stay enforced there.
"""

from django.http import HttpResponse
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import TokenHasScope
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from ..services import sample_boards


class SampleBoardSummarySerializer(serializers.Serializer):
    """Documentation-only: the list is built from the manifest, not a model."""

    id = serializers.CharField()
    title = serializers.CharField()
    description = serializers.CharField()
    swimlane_theme = serializers.CharField()
    card_count = serializers.IntegerField(help_text="Active (non-archived) cards.")
    includes = serializers.ListField(
        child=serializers.ChoiceField(choices=["labels", "checklists", "comments", "history"]),
        help_text="What the board carries, derived from its contents.",
    )
    order = serializers.IntegerField()
    schema_version = serializers.IntegerField()
    date_anchor = serializers.DateField(
        help_text="Pass as the import option shift_dates_from to date the board around the import day.",
    )


_PERMISSIONS = [
    IsAuthenticated,
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
    TokenHasScope,
]


class SampleBoardListView(APIView):
    """Sample boards in gallery order. Same access as the import they feed."""

    permission_classes = _PERMISSIONS

    @extend_schema(
        summary="List the sample boards",
        responses={200: SampleBoardSummarySerializer(many=True), 401: OpenApiResponse(description="Not authenticated"),
                   403: OpenApiResponse(description="Pending password or username change")},
    )
    def get(self, request):
        response = Response(sample_boards.list_samples())
        response["Cache-Control"] = "private, max-age=3600"
        return response


class SampleBoardDetailView(APIView):
    """One sample board as the raw export file, with a strong ETag."""

    permission_classes = _PERMISSIONS

    @extend_schema(
        summary="Download a sample board file",
        parameters=[OpenApiParameter("sample_id", str, OpenApiParameter.PATH)],
        responses={
            200: OpenApiResponse(description="The Visiban JSON export, ready to post to /boards/import/."),
            304: OpenApiResponse(description="If-None-Match matched the current ETag."),
            401: OpenApiResponse(description="Not authenticated"),
            403: OpenApiResponse(description="Pending password or username change"),
            404: OpenApiResponse(description="Unknown sample id"),
        },
    )
    def get(self, request, sample_id):
        entry = sample_boards.get_entry(sample_id)
        if entry is None:
            return Response({"detail": "Sample not found."}, status=status.HTTP_404_NOT_FOUND)
        etag = f'"{entry["sha256"]}"'
        candidates = {t.strip().removeprefix("W/") for t in request.headers.get("If-None-Match", "").split(",")}
        # A 304 never reads the file: the ETag comes from the manifest.
        if etag in candidates:
            response = HttpResponse(status=304)
        else:
            response = HttpResponse(sample_boards.read_body(entry), content_type="application/json")
        response["ETag"] = etag
        response["Cache-Control"] = "private, max-age=3600"
        return response
