"""Admin API views — all endpoints gated by IsSiteAdmin."""
import logging
from datetime import timedelta

from django.contrib.auth import get_user_model, password_validation
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers as drf_serializers
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from boards.permissions import get_board_role
from .adapter import invalidate_registration_mode_cache
from .models import InviteLink, MAX_ACTIVE_INVITE_LINKS, SiteSetting, invalidate_uploads_enabled_cache
from .permissions import IsSiteAdmin
from visiban.permissions import MustNotHavePendingPasswordChange

logger = logging.getLogger(__name__)

# Combining both permissions ensures that a site admin with a forced-password-
# reset flag (must_change_password=True) cannot reach any admin endpoint.
# Declaring permission_classes = [IsSiteAdmin] alone would silently drop the
# global MustNotHavePendingPasswordChange default.
_ADMIN_PERMISSIONS = [IsSiteAdmin, MustNotHavePendingPasswordChange]

User = get_user_model()


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class SiteSettingSerializer(drf_serializers.Serializer):
    registration_mode = drf_serializers.ChoiceField(
        choices=SiteSetting.RegistrationMode.choices,
    )
    uploads_enabled = drf_serializers.BooleanField(required=False)


class OwnedBoardSummarySerializer(drf_serializers.Serializer):
    id = drf_serializers.IntegerField()
    uid = drf_serializers.CharField()
    name = drf_serializers.CharField()


class AdminUserSerializer(drf_serializers.ModelSerializer):
    """Full user representation for the admin users list."""

    owned_boards = drf_serializers.SerializerMethodField()

    def get_owned_boards(self, obj):
        # Use the pre-built map injected by AdminUsersView.get() when available.
        # This allows the list endpoint to load owned boards in a single query
        # rather than one query per user. Single-object responses (create, patch,
        # deactivate) do not inject the map and fall back to the live query.
        owned_map = self.context.get("_owned_boards_map")
        if owned_map is not None:
            return owned_map.get(obj.id, [])
        # Deferred import to avoid circular dependency at module load time
        # (boards imports accounts for User; accounts must not import boards at top level).
        from boards.models import Board
        return list(Board.objects.filter(owner=obj).values("id", "uid", "name"))

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
            "can_access_all_content",
            "must_change_password",
            "has_completed_tour",
            "date_joined",
            "owned_boards",
        ]
        read_only_fields = ["id", "date_joined", "owned_boards"]


class AdminCreateUserSerializer(drf_serializers.Serializer):
    """Validates the payload for admin-created accounts."""
    username = drf_serializers.CharField(max_length=150)
    email = drf_serializers.EmailField()
    password = drf_serializers.CharField(min_length=12, write_only=True)
    force_password_reset = drf_serializers.BooleanField(default=True)

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise drf_serializers.ValidationError("A user with that username already exists.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise drf_serializers.ValidationError("A user with that email already exists.")
        return value

    def validate_password(self, value):
        password_validation.validate_password(value)
        return value


class AdminPatchUserSerializer(drf_serializers.Serializer):
    """Validates partial updates allowed by site admins."""
    is_active = drf_serializers.BooleanField(required=False)
    is_site_admin = drf_serializers.BooleanField(required=False)
    can_access_all_content = drf_serializers.BooleanField(required=False)
    must_change_password = drf_serializers.BooleanField(required=False)
    has_completed_tour = drf_serializers.BooleanField(required=False)


class InviteLinkSerializer(drf_serializers.Serializer):
    """Read-only invite link representation — never returns the raw token."""
    id = drf_serializers.IntegerField(read_only=True)
    prefix = drf_serializers.CharField(read_only=True)
    expires_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    single_use = drf_serializers.BooleanField(read_only=True)
    used_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    revoked_at = drf_serializers.DateTimeField(read_only=True, allow_null=True)
    created_at = drf_serializers.DateTimeField(read_only=True)
    status = drf_serializers.SerializerMethodField()
    created_by_username = drf_serializers.SerializerMethodField()

    def get_status(self, obj):
        return obj.status

    def get_created_by_username(self, obj):
        return obj.created_by.username if obj.created_by else None


class InviteLinkCreateResponseSerializer(InviteLinkSerializer):
    """Extends InviteLinkSerializer with the raw token — included once at creation only."""
    raw_token = drf_serializers.CharField(read_only=True)


class InviteLinkCreateSerializer(drf_serializers.Serializer):
    """Validates the payload for invite link creation."""
    expires_in_days = drf_serializers.IntegerField(required=False, allow_null=True)
    single_use = drf_serializers.BooleanField(default=False)

    def validate_expires_in_days(self, value):
        if value is not None and value not in InviteLink.VALID_TTL_DAYS:
            raise drf_serializers.ValidationError(
                f"expires_in_days must be one of {InviteLink.VALID_TTL_DAYS} or null."
            )
        return value


class TransferItemSerializer(drf_serializers.Serializer):
    board_id = drf_serializers.IntegerField()
    transfer_to = drf_serializers.IntegerField()


class DeactivateSerializer(drf_serializers.Serializer):
    """Validates the ownership-transfer payload for user deactivation."""
    transfers = TransferItemSerializer(many=True, default=list)


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
    permission_classes = _ADMIN_PERMISSIONS

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
    permission_classes = _ADMIN_PERMISSIONS
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

        # Build owned_boards in a single query across all users on this page,
        # then inject a pre-built map into the serializer context so
        # AdminUserSerializer.get_owned_boards() does not fire one query per user.
        # Deferred import to avoid circular dependency at module load time.
        from boards.models import Board as _Board
        user_ids = [u.id for u in page]
        board_rows = _Board.objects.filter(owner_id__in=user_ids).values("owner_id", "id", "uid", "name")
        owned_map: dict = {}
        for row in board_rows:
            owned_map.setdefault(row["owner_id"], []).append(
                {"id": row["id"], "uid": row["uid"], "name": row["name"]}
            )

        serializer = AdminUserSerializer(page, many=True, context={"_owned_boards_map": owned_map})
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
    permission_classes = _ADMIN_PERMISSIONS

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
            # Guard: deactivating a board-owning user via PATCH is not allowed —
            # use POST /api/admin/users/{id}/deactivate/ to provide ownership transfers.
            from boards.models import Board
            owned = list(Board.objects.filter(owner=target).values("id", "uid", "name"))
            if owned:
                return Response(
                    {
                        "code": "owned_boards",
                        "detail": "User owns boards that must be transferred before deactivation.",
                        "owned_boards": owned,
                    },
                    status=status.HTTP_409_CONFLICT,
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

        # Apply each validated field to the target user.
        _PATCHABLE_FIELDS = (
            "is_active", "is_site_admin", "can_access_all_content",
            "must_change_password", "has_completed_tour",
        )
        for field in _PATCHABLE_FIELDS:
            if field in validated:
                setattr(target, field, validated[field])
                update_fields.append(field)

        if update_fields:
            target.save(update_fields=update_fields)

        return Response(AdminUserSerializer(target).data)


class AdminInviteLinkListCreateView(APIView):
    """
    GET  /api/admin/invite-links/  — list all invite links
    POST /api/admin/invite-links/  — create a new invite link
    """
    permission_classes = _ADMIN_PERMISSIONS

    def get(self, request):
        links = InviteLink.objects.select_related("created_by").all()
        return Response(InviteLinkSerializer(links, many=True).data)

    @transaction.atomic
    def post(self, request):
        serializer = InviteLinkCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        # Serialize invite link creation through the SiteSetting row lock to
        # prevent two concurrent admin requests from both reading a count below
        # MAX_ACTIVE_INVITE_LINKS and both creating a link, overshooting the cap.
        # get_or_create ensures the singleton exists before acquiring the lock.
        SiteSetting.objects.get_or_create(pk=1)
        SiteSetting.objects.select_for_update().get(pk=1)

        # Soft cap: prevent token flood from a compromised admin account.
        active_count = InviteLink.objects.filter(
            used_at__isnull=True,
            revoked_at__isnull=True,
        ).exclude(expires_at__lt=timezone.now()).count()
        if active_count >= MAX_ACTIVE_INVITE_LINKS:
            return Response(
                {"detail": f"Maximum active invite links ({MAX_ACTIVE_INVITE_LINKS}) reached. Revoke or wait for expiry before creating more."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        expires_in_days = data.get("expires_in_days")
        expires_at = (
            timezone.now() + timedelta(days=expires_in_days)
            if expires_in_days
            else None
        )

        link, raw_token = InviteLink.generate(
            created_by=request.user,
            expires_at=expires_at,
            single_use=data.get("single_use", False),
        )
        logger.info(
            "invite_link.created pk=%d prefix=%s created_by=%d single_use=%s expires_at=%s",
            link.pk, link.prefix, request.user.pk, link.single_use, link.expires_at,
        )
        # Attach raw_token as a transient attribute — the serializer reads it
        # once for the creation response; it is never persisted.
        link.raw_token = raw_token
        return Response(InviteLinkCreateResponseSerializer(link).data, status=status.HTTP_201_CREATED)


class AdminInviteLinkRevokeView(APIView):
    """DELETE /api/admin/invite-links/{pk}/ — revoke an invite link."""
    permission_classes = _ADMIN_PERMISSIONS

    def delete(self, request, pk):
        try:
            link = InviteLink.objects.get(pk=pk)
        except InviteLink.DoesNotExist:
            return Response({"detail": "Invite link not found."}, status=status.HTTP_404_NOT_FOUND)

        if link.revoked_at or link.used_at:
            return Response(
                {"detail": "Link is already used or revoked."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at"])
        logger.info(
            "invite_link.revoked pk=%d prefix=%s revoked_by=%d",
            link.pk, link.prefix, request.user.pk,
        )
        return Response(InviteLinkSerializer(link).data)


class AdminUserDeactivateView(APIView):
    """POST /api/admin/users/{pk}/deactivate/

    Atomically deactivates a user and transfers their board ownership.
    Returns 409 with owned_boards list if the user owns boards and no
    transfers are provided — this is the signal for the UI to show the
    offboarding modal.

    Also revokes all pending invite links created by the departing user.
    """
    permission_classes = _ADMIN_PERMISSIONS

    def _validate_transfers(self, transfers, target, owned_boards):
        """Validate ownership transfer entries. Returns an error Response or None."""
        from boards.models import Board

        owned_ids = {b["id"] for b in owned_boards}
        transferred_ids = {t["board_id"] for t in transfers}
        missing = owned_ids - transferred_ids
        if missing:
            missing_names = [b["name"] for b in owned_boards if b["id"] in missing]
            return Response(
                {"detail": f"Missing transfer target for: {', '.join(missing_names)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Bulk-fetch all transfer targets in 2 queries rather than 2 per entry.
        transfer_user_ids = {t["transfer_to"] for t in transfers}
        transfer_board_ids = {t["board_id"] for t in transfers}
        users_by_id = {
            u.pk: u
            for u in User.objects.filter(pk__in=transfer_user_ids, is_active=True)
        }
        boards_by_id = {
            b.id: b for b in Board.objects.filter(pk__in=transfer_board_ids)
        }

        for t in transfers:
            if t["transfer_to"] == target.pk:
                return Response(
                    {"detail": "Cannot transfer board ownership to the user being deactivated."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            to_user = users_by_id.get(t["transfer_to"])
            if to_user is None:
                return Response(
                    {"detail": f"Transfer target {t['transfer_to']} not found or inactive."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # Use get_board_role to honor group-inherited memberships, not
            # just direct BoardMembership rows.
            board_obj = boards_by_id.get(t["board_id"])
            if board_obj is None or get_board_role(to_user, board_obj) is None:
                board_name = next(
                    (b["name"] for b in owned_boards if b["id"] == t["board_id"]),
                    str(t["board_id"]),
                )
                return Response(
                    {"detail": f"Transfer target is not a member of '{board_name}'."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # All transfers valid — execute in bulk.
        for t in transfers:
            Board.objects.filter(id=t["board_id"], owner=target).update(
                owner_id=t["transfer_to"]
            )
        return None

    @transaction.atomic
    def post(self, request, pk):
        try:
            target = User.objects.select_for_update().get(pk=pk)
        except User.DoesNotExist:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)

        if target.pk == request.user.pk:
            return Response(
                {"detail": "You cannot deactivate your own account."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not target.is_active:
            return Response(
                {"detail": "User is already inactive."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from boards.models import Board

        owned_boards = list(Board.objects.filter(owner=target).values("id", "uid", "name"))

        serializer = DeactivateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        transfers = serializer.validated_data.get("transfers", [])

        if owned_boards and not transfers:
            return Response(
                {
                    "code": "owned_boards",
                    "detail": "User owns boards that must be transferred before deactivation.",
                    "owned_boards": owned_boards,
                },
                status=status.HTTP_409_CONFLICT,
            )

        if owned_boards:
            error = self._validate_transfers(transfers, target, owned_boards)
            if error is not None:
                return error

        target.is_active = False
        target.save(update_fields=["is_active"])

        # Security: revoke all personal access tokens so a deactivated user
        # cannot retain API access via previously issued tokens.
        target.personal_access_tokens.all().delete()

        # Security: a departing admin's unused invite links must not remain valid.
        InviteLink.objects.filter(
            created_by=target,
            used_at__isnull=True,
            revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())

        logger.info(
            "user.deactivated pk=%d deactivated_by=%d transfers=%s",
            target.pk, request.user.pk,
            [(t["board_id"], t["transfer_to"]) for t in transfers],
        )
        return Response(AdminUserSerializer(target).data)
