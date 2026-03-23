"""Admin API views — all endpoints gated by IsSiteAdmin."""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from .adapter import invalidate_registration_mode_cache
from .models import SiteSetting, invalidate_uploads_enabled_cache
from .permissions import IsSiteAdmin

User = get_user_model()


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class SiteSettingSerializer(drf_serializers.Serializer):
    registration_mode = drf_serializers.ChoiceField(
        choices=SiteSetting.RegistrationMode.choices,
    )
    uploads_enabled = drf_serializers.BooleanField(required=False)


class AdminUserSerializer(drf_serializers.ModelSerializer):
    """Full user representation for the admin users list."""

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "email",
            "display_name",
            "first_name",
            "last_name",
            "avatar_url",
            "is_active",
            "is_site_admin",
            "must_change_password",
            "date_joined",
        ]
        read_only_fields = ["id", "date_joined"]


class AdminCreateUserSerializer(drf_serializers.Serializer):
    """Validates the payload for admin-created accounts."""
    username = drf_serializers.CharField(max_length=150)
    email = drf_serializers.EmailField()
    password = drf_serializers.CharField(min_length=12, write_only=True)
    force_password_reset = drf_serializers.BooleanField(default=True)

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise drf_serializers.ValidationError("A user with that username already exists.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise drf_serializers.ValidationError("A user with that email already exists.")
        return value


class AdminPatchUserSerializer(drf_serializers.Serializer):
    """Validates partial updates allowed by site admins."""
    is_active = drf_serializers.BooleanField(required=False)
    is_site_admin = drf_serializers.BooleanField(required=False)
    must_change_password = drf_serializers.BooleanField(required=False)


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

class AdminUserPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

class AdminSettingsView(APIView):
    """GET/PATCH the singleton SiteSetting row."""
    permission_classes = [IsSiteAdmin]

    def get(self, request):
        setting = SiteSetting.get()
        return Response(SiteSettingSerializer(setting).data)

    def patch(self, request):
        setting = SiteSetting.get()
        serializer = SiteSettingSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        validated = serializer.validated_data
        update_fields = []

        if "registration_mode" in validated:
            setting.registration_mode = validated["registration_mode"]
            update_fields.append("registration_mode")

        if "uploads_enabled" in validated:
            setting.uploads_enabled = validated["uploads_enabled"]
            update_fields.append("uploads_enabled")

        if update_fields:
            setting.save(update_fields=update_fields)
            # Flush caches so changes take effect immediately.
            invalidate_registration_mode_cache()
            invalidate_uploads_enabled_cache()

        return Response(SiteSettingSerializer(setting).data)


class AdminUsersView(APIView):
    """
    GET  /api/admin/users/  — paginated list, optional ?search=
    POST /api/admin/users/  — create a new user
    """
    permission_classes = [IsSiteAdmin]
    pagination_class = AdminUserPagination

    def get(self, request):
        qs = User.objects.all().order_by("username")
        search = request.query_params.get("search", "").strip()
        if search:
            qs = qs.filter(
                Q(display_name__icontains=search)
                | Q(email__icontains=search)
                | Q(username__icontains=search)
            )
        paginator = self.pagination_class()
        page = paginator.paginate_queryset(qs, request)
        serializer = AdminUserSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    @transaction.atomic
    def post(self, request):
        serializer = AdminCreateUserSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        data = serializer.validated_data
        user = User.objects.create_user(
            username=data["username"],
            email=data["email"],
            password=data["password"],
        )
        user.must_change_password = data.get("force_password_reset", True)
        user.save(update_fields=["must_change_password"])

        return Response(AdminUserSerializer(user).data, status=status.HTTP_201_CREATED)


class AdminUserDetailView(APIView):
    """PATCH /api/admin/users/{id}/ — update is_active, is_site_admin, must_change_password."""
    permission_classes = [IsSiteAdmin]

    def _get_user_or_404(self, pk):
        try:
            return User.objects.get(pk=pk)
        except User.DoesNotExist:
            return None

    def patch(self, request, pk):
        target = self._get_user_or_404(pk)
        if target is None:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = AdminPatchUserSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        validated = serializer.validated_data
        update_fields = []

        # Guard: cannot deactivate yourself.
        if "is_active" in validated and not validated["is_active"]:
            if target.pk == request.user.pk:
                return Response(
                    {"detail": "You cannot deactivate your own account."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Guard: cannot remove the last site admin.
        if "is_site_admin" in validated and not validated["is_site_admin"]:
            if target.pk == request.user.pk:
                return Response(
                    {"detail": "You cannot demote yourself from site admin."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            remaining = User.objects.filter(is_site_admin=True, is_active=True).exclude(pk=target.pk).count()
            if remaining == 0:
                return Response(
                    {"detail": "Cannot demote the last active site admin."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        if "is_active" in validated:
            target.is_active = validated["is_active"]
            update_fields.append("is_active")

        if "is_site_admin" in validated:
            target.is_site_admin = validated["is_site_admin"]
            update_fields.append("is_site_admin")

        if "must_change_password" in validated:
            target.must_change_password = validated["must_change_password"]
            update_fields.append("must_change_password")

        if update_fields:
            target.save(update_fields=update_fields)

        return Response(AdminUserSerializer(target).data)
