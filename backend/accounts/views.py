from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model, update_session_auth_hash
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework import status
from .models import PAT_MAX_PER_USER, PersonalAccessToken, SiteSetting
from .serializers import CurrentUserSerializer, PersonalAccessTokenSerializer, PublicUserSerializer

User = get_user_model()


class UserSearchRateThrottle(UserRateThrottle):
    """Tighter per-user rate limit for the user-search endpoint.

    User search hits the database with a LIKE query on every call, so it is
    more expensive than a typical read endpoint. 30 req/min is generous enough
    for interactive use (autocomplete fires on each keystroke) but prevents a
    single account from enumerating the entire user list at high speed.
    """

    scope = "user_search"


class UserSearchView(APIView):
    """Search users by display name, email, or username; requires at least 2 characters."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [UserSearchRateThrottle]

    def get(self, request):
        query = request.query_params.get("search", "").strip()
        if len(query) < 2:
            return Response([])
        users = (
            User.objects.filter(
                Q(display_name__icontains=query)
                | Q(email__icontains=query)
                | Q(username__icontains=query)
                | Q(first_name__icontains=query)
            )
            .exclude(pk=request.user.pk)
            .order_by("display_name", "username")[:10]
        )
        return Response(PublicUserSerializer(users, many=True).data)


class AuthProvidersView(APIView):
    """Return which OAuth providers (Google, GitHub, GitLab) are configured on this instance."""

    permission_classes = [AllowAny]

    def get(self, request):
        providers = settings.SOCIALACCOUNT_PROVIDERS
        return Response({
            "google": bool(providers.get("google", {}).get("APP", {}).get("client_id")),
            "github": bool(providers.get("github", {}).get("APP", {}).get("client_id")),
            "gitlab": bool(providers.get("gitlab", {}).get("APP", {}).get("client_id")),
        })


class CurrentUserView(APIView):
    """Retrieve or update the currently authenticated user's profile."""

    def get(self, request):
        return Response(CurrentUserSerializer(request.user, context={"request": request}).data)

    def patch(self, request):
        serializer = CurrentUserSerializer(request.user, data=request.data, partial=True,
                                           context={"request": request})
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class ChangePasswordView(APIView):
    """Change the authenticated user's password, keeping the session alive afterwards.

    Explicitly opts out of MustNotHavePendingPasswordChange so that users who
    were forced to change their password can still reach this endpoint.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        current_password = request.data.get("current_password", "")
        new_password = request.data.get("new_password", "")

        if not new_password or len(new_password) < 12:
            return Response(
                {"detail": "New password must be at least 12 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Social-only accounts have no usable password — skip the current
        # password check so they can set one for the first time.
        if request.user.has_usable_password():
            if not request.user.check_password(current_password):
                return Response(
                    {"detail": "Current password is incorrect."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        request.user.set_password(new_password)
        request.user.must_change_password = False
        request.user.save(update_fields=["password", "must_change_password"])
        # Revoke all personal access tokens on password change so that a
        # compromised account cannot retain API access after a credential reset.
        # Documented behaviour: users must regenerate any tokens they need after
        # changing their password.
        request.user.personal_access_tokens.all().delete()
        # Keep the current session alive after the password rotation so the
        # user does not get logged out and left with a broken session state.
        update_session_auth_hash(request, request.user)
        return Response({"detail": "Password changed successfully."})


class SiteConfigView(APIView):
    """Return public instance configuration needed before login (e.g. registration open/closed)."""

    permission_classes = [AllowAny]

    def get(self, request):
        setting = SiteSetting.get()
        return Response({
            "registration_open": setting.registration_mode == "open",
            "registration_mode": setting.registration_mode,
        })


class PersonalAccessTokenListCreateView(APIView):
    """List and create personal access tokens for the authenticated user.

    GET  — returns all tokens (name, prefix, dates) — never the raw value.
    POST — creates a new token; returns the raw value in this response only.

    Maximum PAT_MAX_PER_USER (10) tokens per user. Tokens are revoked
    automatically when the user changes their password.
    """

    def get(self, request):
        tokens = request.user.personal_access_tokens.all()
        return Response(PersonalAccessTokenSerializer(tokens, many=True).data)

    def post(self, request):
        if request.user.personal_access_tokens.count() >= PAT_MAX_PER_USER:
            return Response(
                {"detail": f"Maximum of {PAT_MAX_PER_USER} access tokens allowed per account."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"detail": "Token name is required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > 64:
            return Response({"detail": "Token name must be 64 characters or fewer."}, status=status.HTTP_400_BAD_REQUEST)

        expires_at = None
        raw_expires = request.data.get("expires_at")
        if raw_expires:
            expires_at = parse_datetime(raw_expires)
            if expires_at is None:
                return Response({"detail": "Invalid expires_at value."}, status=status.HTTP_400_BAD_REQUEST)
            max_expiry = timezone.now() + timedelta(days=365)
            if expires_at > max_expiry:
                return Response(
                    {"detail": "Token expiry cannot be more than 1 year from now."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if expires_at <= timezone.now():
                return Response({"detail": "Token expiry must be in the future."}, status=status.HTTP_400_BAD_REQUEST)

        pat, raw_token = PersonalAccessToken.generate(request.user, name, expires_at)
        data = PersonalAccessTokenSerializer(pat).data
        # The raw token is included exactly once — in the creation response.
        # It is not persisted and cannot be retrieved again.
        data["token"] = raw_token
        return Response(data, status=status.HTTP_201_CREATED)


class PersonalAccessTokenDeleteView(APIView):
    """Revoke a single personal access token.

    The queryset is scoped to request.user — attempting to delete another
    user's token returns 404, not 403, to avoid confirming token existence.
    """

    def delete(self, request, pk):
        try:
            pat = request.user.personal_access_tokens.get(pk=pk)
        except PersonalAccessToken.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        pat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
