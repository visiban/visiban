import re
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model, password_validation, update_session_auth_hash
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.views import View
from dj_rest_auth.registration.views import RegisterView
from dj_rest_auth.views import PasswordResetView as DjRestAuthPasswordResetView
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated

from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from rest_framework import status
from .models import PAT_MAX_PER_USER, PersonalAccessToken, SiteSetting, get_registration_mode
from .invite_utils import InviteTokenError, validate_invite_token, consume_invite_token
from .serializers import CurrentUserSerializer, PersonalAccessTokenSerializer, PublicUserSerializer, UserSerializer

User = get_user_model()


class UserSearchRateThrottle(UserRateThrottle):
    """Tighter per-user rate limit for the user-search endpoint.

    User search hits the database with a LIKE query on every call, so it is
    more expensive than a typical read endpoint. 30 req/min is generous enough
    for interactive use (autocomplete fires on each keystroke) but prevents a
    single account from enumerating the entire user list at high speed.
    """

    scope = "user_search"


class PasswordResetThrottle(AnonRateThrottle):
    """Rate limit for the password-reset request endpoint.

    Prevents a caller from using the reset flow to trigger bulk email sends.
    5 requests per hour per IP is generous enough for legitimate use (a user
    who lost access to their email and needs to retry) while blocking abuse.
    """

    scope = "password_reset"


class ThrottledPasswordResetView(DjRestAuthPasswordResetView):
    """dj-rest-auth PasswordResetView with a project-specific rate limit applied."""

    throttle_classes = [PasswordResetThrottle]


class UserSearchView(APIView):
    """Search users by display name, email, or username; requires at least 2 characters."""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]
    throttle_classes = [UserSearchRateThrottle]

    def get(self, request):
        query = request.query_params.get("search", "").strip()
        if len(query) < 2:
            return Response([])
        users = (
            User.objects.filter(
                Q(display_name__icontains=query)
                | Q(username__icontains=query)
                | Q(first_name__icontains=query)
                # email intentionally excluded: filtering on email without returning it
                # creates a silent email-existence oracle for any authenticated caller.
            )
            .exclude(pk=request.user.pk)
            .order_by("display_name", "username")[:10]
        )
        return Response(PublicUserSerializer(users, many=True).data)


class AuthProvidersView(APIView):
    """Return which social login providers are configured on this instance.

    Used by the frontend to conditionally render login buttons. OIDC is
    reported separately from the pre-configured providers so the frontend
    can display a generic "SSO" button with the configured provider name.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        providers = settings.SOCIALACCOUNT_PROVIDERS
        oidc_apps = providers.get("openid_connect", {}).get("APPS", [])
        oidc_app = oidc_apps[0] if oidc_apps else {}
        return Response({
            "google": bool(providers.get("google", {}).get("APP", {}).get("client_id")),
            "github": bool(providers.get("github", {}).get("APP", {}).get("client_id")),
            "gitlab": bool(providers.get("gitlab", {}).get("APP", {}).get("client_id")),
            # Generic OIDC — present when OIDC_CLIENT_ID/OIDC_SECRET/OIDC_SERVER_URL are set.
            # name comes from OIDC_PROVIDER_NAME (default "SSO") for the login button label.
            "oidc": bool(oidc_app.get("client_id")),
            "oidc_name": oidc_app.get("name", "SSO") if oidc_app.get("client_id") else None,
        })


class CurrentUserView(APIView):
    """Retrieve or update the currently authenticated user's profile.

    Exempt from MustNotHavePendingPasswordChange and
    MustNotHavePendingUsernameChange so the frontend can always fetch
    the current user and render the appropriate force-change modal.
    """

    permission_classes = [IsAuthenticated]

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

        try:
            password_validation.validate_password(new_password, request.user)
        except ValidationError as exc:
            return Response(
                {"detail": " ".join(exc.messages)},
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


class ChooseUsernameThrottle(UserRateThrottle):
    """Per-user rate limit for the choose-username endpoint.

    Prevents username enumeration by an authenticated attacker probing
    different values and observing "already taken" vs. success responses.
    """

    scope = "choose_username"


class ChooseUsernameView(APIView):
    """Let a user pick a new username after a forced rename.

    Exempt from MustNotHavePendingUsernameChange so that affected users can
    reach this endpoint. Also exempt from MustNotHavePendingPasswordChange so
    the endpoint is reachable regardless of flag ordering (password change
    takes priority in the UI, but the API must not block the username
    endpoint if both flags are somehow set).
    """

    permission_classes = [IsAuthenticated]
    throttle_classes = [ChooseUsernameThrottle]

    def post(self, request):
        username = (request.data.get("username") or "").strip()

        if not username:
            return Response(
                {"detail": "Username is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if len(username) > 150:
            return Response(
                {"detail": "Username must be 150 characters or fewer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Django's default username validator: letters, digits, @/./+/-/_
        if not re.match(r"^[\w.@+-]+$", username):
            return Response(
                {"detail": "Username may only contain letters, digits, and @/./+/-/_ characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Case-insensitive uniqueness check, excluding the requesting user.
        if User.objects.filter(username__iexact=username).exclude(pk=request.user.pk).exists():
            return Response(
                {"detail": "That username is already taken."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # The DB functional index (unique_username_ci) is the ultimate guard
        # against concurrent races — catch IntegrityError so a TOCTOU
        # collision returns a clean 400 instead of an unhandled 500.
        try:
            with transaction.atomic():
                request.user.username = username
                request.user.must_change_username = False
                request.user.save(update_fields=["username", "must_change_username"])
        except IntegrityError:
            return Response(
                {"detail": "That username is already taken."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            UserSerializer(request.user, context={"request": request}).data
        )


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

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

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

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
    ]

    def delete(self, request, pk):
        try:
            pat = request.user.personal_access_tokens.get(pk=pk)
        except PersonalAccessToken.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        pat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class RegisterAnonThrottle(AnonRateThrottle):
    """Per-IP rate limit for the registration endpoint.

    The endpoint is unauthenticated, so invite token brute-force attempts are
    rate-limited here. 10 req/min is generous for legitimate use but prevents
    enumeration attacks against the token space.
    """

    scope = "register"


class InviteRegisterView(RegisterView):
    """Registration endpoint that enforces invite-only mode when configured.

    In INVITE_ONLY mode: validates and consumes the invite token atomically
    with user creation so a single-use token cannot be replayed under concurrent
    load (select_for_update on the token row).

    In OPEN mode: delegates to the parent RegisterView unchanged.
    In CLOSED mode: adapter.save_user raises PermissionDenied before this runs.
    """

    # Declared at the class level to override the parent RegisterView (which
    # sets no throttle classes) — applies in both OPEN and INVITE_ONLY modes.
    throttle_classes = [RegisterAnonThrottle]

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        mode = get_registration_mode()
        if mode != SiteSetting.RegistrationMode.INVITE_ONLY:
            return super().create(request, *args, **kwargs)

        token_raw = (request.data.get("invite_token") or "").strip()

        try:
            link = validate_invite_token(token_raw)
        except InviteTokenError as exc:
            return Response(
                {"invite_token": [exc.detail]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Token is valid — proceed with registration then consume.
        # Both happen in the same transaction so a failed registration leaves
        # the token unconsumed.
        response = super().create(request, *args, **kwargs)
        if response.status_code in (200, 201):
            consume_invite_token(link)

        return response


class EmailConfirmRedirectView(View):
    """Safety-net for browsers that hit the backend confirm-email URL directly.

    The confirmation link in outgoing emails now points to the frontend SPA
    (via RegistrationAdapter.get_email_confirmation_url). This view handles
    old/stale links (e.g. emails sent before the fix) or direct navigation by
    redirecting the browser to the SPA route, which calls POST /verify-email/.
    """

    def get(self, request, key):
        frontend_url = getattr(settings, "LOGIN_REDIRECT_URL", "http://localhost:5173").rstrip("/")
        return HttpResponseRedirect(f"{frontend_url}/confirm-email/{key}")
