import re

from rest_framework import serializers

from accounts.serializers import BoardUserSerializer

from .models import LensConnection
from .providers import available_providers

_VALID_COLUMN_DIMS = {"status", "state", "pipeline"}
_VALID_SWIMLANE_DIMS = {"milestone", "assignee", "label"}

# A single repo path segment: must start and end alphanumeric, may contain
# '.', '_', '-' in between. This deliberately rejects "." and ".." segments and
# leading/trailing dots so a crafted repo_slug cannot collapse to a different
# upstream API path (dot-segment normalization SSRF — see security review).
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


class LensConnectionSerializer(serializers.ModelSerializer):
    # Nested user object to match the FK rendering convention used across the
    # board/card serializers (assignee, created_by, owner are all nested).
    created_by = BoardUserSerializer(read_only=True)

    class Meta:
        model = LensConnection
        fields = [
            "id",
            "provider",
            "repo_slug",
            "column_dim",
            "swimlane_dim",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_by", "created_at", "updated_at"]

    def validate_provider(self, value):
        if value not in available_providers():
            raise serializers.ValidationError(
                f"Unsupported provider. Choose one of: {', '.join(available_providers())}."
            )
        return value

    def validate_repo_slug(self, value):
        value = value.strip().strip("/")
        parts = value.split("/")
        if not (2 <= len(parts) <= 6) or not all(_SEGMENT_RE.match(p) for p in parts):
            raise serializers.ValidationError(
                "Enter a public repository as 'owner/repo' (or "
                "'group/subgroup/project' for GitLab). Each segment may contain "
                "only letters, numbers, '.', '_' and '-'."
            )
        return value

    def validate(self, attrs):
        # GitHub repos are exactly owner/repo; reject extra path segments that a
        # loose slug could otherwise smuggle into the upstream API URL.
        provider = attrs.get("provider")
        repo = attrs.get("repo_slug", "")
        if provider == "github" and repo and repo.count("/") != 1:
            raise serializers.ValidationError(
                {"repo_slug": "GitHub repositories must be in 'owner/repo' form."}
            )
        return attrs

    def validate_column_dim(self, value):
        if value not in _VALID_COLUMN_DIMS:
            raise serializers.ValidationError(
                f"column_dim must be one of: {', '.join(sorted(_VALID_COLUMN_DIMS))}."
            )
        return value

    def validate_swimlane_dim(self, value):
        if value not in _VALID_SWIMLANE_DIMS:
            raise serializers.ValidationError(
                f"swimlane_dim must be one of: {', '.join(sorted(_VALID_SWIMLANE_DIMS))}."
            )
        return value
