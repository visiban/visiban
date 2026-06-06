from rest_framework import serializers

from accounts.serializers import BoardUserSerializer

from .models import LensConnection
from .providers import available_providers

_VALID_COLUMN_DIMS = {"status", "state"}
_VALID_SWIMLANE_DIMS = {"milestone", "assignee", "label"}


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
        if not value or "/" not in value or " " in value or value.count("/") > 5:
            raise serializers.ValidationError(
                "Enter a public repository as 'owner/repo' "
                "(or 'group/subgroup/project' for GitLab)."
            )
        return value

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
