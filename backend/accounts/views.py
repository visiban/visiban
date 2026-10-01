import re
from datetime import timedelta

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model, password_validation, update_session_auth_hash
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from allauth.account.adapter import get_adapter
from allauth.account.views import EmailView as AllauthEmailView
from dj_rest_auth.registration.views import RegisterView
from dj_rest_auth.registration.views import VerifyEmailView as DjRestAuthVerifyEmailView
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers
from dj_rest_auth.views import LoginView as DjRestAuthLoginView
from dj_rest_auth.views import PasswordResetView as DjRestAuthPasswordResetView
from dj_rest_auth.views import PasswordResetConfirmView as DjRestAuthPasswordResetConfirmView
from dj_rest_auth.views import PasswordChangeView as DjRestAuthPasswordChangeView
from dj_rest_auth.views import UserDetailsView as DjRestAuthUserDetailsView
from rest_framework import serializers as drf_serializers
from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle, UserRateThrottle
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated

from visiban.demo import demo_next_reset_at_iso, demo_reset_schedule
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from rest_framework import status
from .permissions import TokenHasScope
from .models import (
    PAT_DEFAULT_SCOPES,
    PAT_MAX_PER_USER,
    PersonalAccessToken,
    SiteSetting,
    get_registration_mode,
)
from .invite_utils import InviteTokenError, validate_invite_token, consume_invite_token
from .validators import (
    USERNAME_TAKEN_MESSAGE,
    is_username_taken,
    is_valid_username_format,
    username_collides_with_email,
)
from .serializers import (
    ConnectedAccountSerializer,
    CurrentUserSerializer,
    PersonalAccessTokenCreateResponseSerializer,
    PersonalAccessTokenCreateSerializer,
    PersonalAccessTokenSerializer,
    PublicUserSerializer,
    UserSerializer,
)
from .ws_auth import issue_ws_ticket

User = get_user_model()


class UserSearchRateThrottle(UserRateThrottle):
    """Tighter per-user rate limit for the user-search endpoint.

    User search hits the database with a LIKE query on every call, so it is
    more expensive than a typical read endpoint. 30 req/min is generous enough
    for interactive use (autocomplete fires on each keystroke) but prevents a
    single account from enumerating the entire user list at high speed.
    """

    scope = "user_search"


class PasswordResetThrottle(SimpleRateThrottle):
    """Rate-limit password reset requests by IP, authenticated or not.

    AnonRateThrottle skips authenticated users; SimpleRateThrottle keyed on IP
    applies unconditionally, preventing inbox flooding from authenticated sessions.
    """

    scope = "password_reset"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


class ThrottledPasswordResetView(DjRestAuthPasswordResetView):
    """dj-rest-auth PasswordResetView with a project-specific rate limit applied."""

    throttle_classes = [PasswordResetThrottle]


class PasswordResetConfirmThrottle(SimpleRateThrottle):
    """Rate-limit password reset confirm requests by IP, authenticated or not.

    Prevents automated token-stuffing against the confirm endpoint. Keyed on IP
    so the limit applies regardless of session state.
    """

    scope = "password_reset_confirm"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


class ThrottledPasswordResetConfirmView(DjRestAuthPasswordResetConfirmView):
    """dj-rest-auth PasswordResetConfirmView with a project-specific rate limit applied."""

    throttle_classes = [PasswordResetConfirmThrottle]


class LoginRateThrottle(SimpleRateThrottle):
    """Defense-in-depth rate limit for the login endpoint, keyed on IP (#924).

    This is the per-IP layer only. The allauth ``ACCOUNT_RATE_LIMITS`` setting
    (5 failed attempts / 5 min, keyed per-account since #1199) is the per-account
    gate, and the two are complementary, not one "primary" and one "backstop":
    this throttle stops an attacker rotating across many accounts from one IP;
    ACCOUNT_RATE_LIMITS stops an attacker rotating across many IPs at one
    account. Before #1199, that per-account gate never actually engaged on this
    endpoint (see accounts.serializers.LoginSerializer), so in practice this was
    the only real cap — that has been fixed, but this throttle's own per-IP
    ceiling is still needed independently: without it, an attacker rotating
    across many usernames could issue up to the global DRF anonymous ceiling
    (currently 300/hour) before being throttled.

    This scope applies the same per-IP limit whether the request is anonymous
    or carries a stale session cookie, so it cannot be bypassed by toggling
    auth state mid-attack.
    """

    scope = "login"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


class ThrottledLoginView(DjRestAuthLoginView):
    """dj-rest-auth LoginView with a project-specific per-IP rate limit applied (#924).

    The per-account lockout lives in ``ACCOUNT_RATE_LIMITS`` / the
    ``accounts.serializers.LoginSerializer`` set as ``REST_AUTH["LOGIN_SERIALIZER"]``
    (#1199) — this throttle only adds the per-IP layer on top.
    """

    throttle_classes = [LoginRateThrottle]


class VerifyEmailThrottle(AnonRateThrottle):
    """Rate limit for the verify-email endpoint.

    HMAC-SHA256 keys are not brute-forceable, so the ceiling is generous.
    The scope exists for consistency with the rest of the anonymous auth surface
    and to give operators a single knob if abuse is ever observed.
    """

    scope = "verify_email"


class EmailConfirmRedirectThrottle(AnonRateThrottle):
    """Rate limit for the email-confirm redirect endpoint.

    The view only issues a 302 redirect (no token validation or DB access),
    so the practical risk is log flooding and cache-layer exhaustion rather
    than token enumeration. Ceiling is set a notch above `verify_email`
    because a user following a stale link may hit the redirect path multiple
    times while figuring out the flow.
    """

    scope = "email_confirm_redirect"


class SocialSignupRedirectThrottle(AnonRateThrottle):
    """Rate limit for the socialaccount-signup safety-net redirect endpoint.

    Like EmailConfirmRedirectThrottle above, this view only pops a session key
    and issues a 302 (no DB access), so the ceiling exists to bound log/cache
    noise rather than to stop meaningful abuse.
    """

    scope = "socialaccount_signup_redirect"


class UserSearchView(APIView):
    """Search users by display name, email, or username; requires at least 2 characters."""

    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
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
            # Generic OIDC — present when OIDC_CLIENT_ID/OIDC_CLIENT_SECRET/OIDC_SERVER_URL are set.
            # name comes from OIDC_PROVIDER_NAME (default "SSO") for the login button label.
            "oidc": bool(oidc_app.get("client_id")),
            "oidc_name": oidc_app.get("name", "SSO") if oidc_app.get("client_id") else None,
        })


class UsernameChangeThrottleMixin:
    """Apply the choose-username rate limit to profile writes that rename the user.

    ``PATCH /auth/me/`` and dj-rest-auth's ``PATCH /auth/user/`` both accept
    ``username`` (a 1.0 API contract, so it stays writable), which made them a
    way around ``ChooseUsernameThrottle`` for probing which names are taken
    (#1273). The throttle is appended rather than set as ``throttle_classes`` so
    the global user/anon rates still apply, and ``UsernameChangeThrottle``
    only consumes its bucket when the request actually changes the username
    (or, since #1221, the email): the SPA's profile form re-sends the unchanged
    values on every save, and ordinary profile edits must not eat into the
    rename budget.
    """

    def get_throttles(self):
        return [*super().get_throttles(), UsernameChangeThrottle()]


class CurrentUserView(UsernameChangeThrottleMixin, APIView):
    """Retrieve or update the currently authenticated user's profile.

    Exempt from MustNotHavePendingPasswordChange and
    MustNotHavePendingUsernameChange so the frontend can always fetch
    the current user and render the appropriate force-change modal.
    """

    permission_classes = [IsAuthenticated, TokenHasScope]

    def get(self, request):
        return Response(CurrentUserSerializer(request.user, context={"request": request}).data)

    def patch(self, request):
        serializer = CurrentUserSerializer(request.user, data=request.data, partial=True,
                                           context={"request": request})
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


PENDING_EMAIL_NONE_MESSAGE = "No email change is waiting for confirmation."
PENDING_EMAIL_RESENT_MESSAGE = "Confirmation email sent."
PENDING_EMAIL_COOLDOWN_MESSAGE = (
    "A confirmation email was sent to this address a moment ago. Wait a few "
    "minutes before asking again. The link already sent still works."
)


class PendingEmailView(APIView):
    """Withdraw the requesting user's pending email change (#1293).

    ``DELETE /auth/me/pending-email/``. The same effect as PATCHing ``email``
    back to the current address (#1273), as an explicit action the Settings
    page can offer. Idempotent: with nothing pending it is a no-op, so a
    double-click or a retry after a lost response still answers 200.

    Acts only on ``request.user`` — there is no address or id in the request —
    so there is no object to look up and nothing to IDOR. Keeps the default
    permission chain (including the forced password/username-change gates):
    unlike ``/auth/me/`` itself this is not part of the flow that clears them.
    """

    @extend_schema(request=None, responses={200: CurrentUserSerializer})
    def delete(self, request):
        from .email_change import cancel_email_change

        cancel_email_change(request.user)
        return Response(CurrentUserSerializer(request.user, context={"request": request}).data)


class PendingEmailResendView(APIView):
    """Send the confirmation link for the requesting user's pending email change again (#1293).

    ``POST /auth/me/pending-email/resend/``. Sends through allauth's own
    verification mail and its ``confirm_email`` rate limit (see
    ``email_change.resend_email_change``); a send skipped by that limit is a
    429 rather than a silent 200, so the UI can say so instead of claiming it
    sent something. The address is never taken from the request — only the
    row the user's own pending change tracks can be mailed — so this cannot
    be pointed at an arbitrary inbox.
    """

    @extend_schema(
        request=None,
        responses={
            200: inline_serializer(
                name="PendingEmailResendResponse", fields={"detail": serializers.CharField()}
            ),
        },
    )
    def post(self, request):
        from .email_change import resend_email_change

        sent = resend_email_change(request, request.user)
        if sent is None:
            return Response(
                {"detail": PENDING_EMAIL_NONE_MESSAGE}, status=status.HTTP_404_NOT_FOUND
            )
        if not sent:
            return Response(
                {"detail": PENDING_EMAIL_COOLDOWN_MESSAGE},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        return Response({"detail": PENDING_EMAIL_RESENT_MESSAGE})


class PendingConnectView(APIView):
    """Dismiss the "Connect {Provider}?" prompt (#1314).

    ``DELETE /auth/me/pending-connect/``. The prompt's "Not now": clears the
    session-held pending provider so the prompt is never shown again for this
    attempt, on any tab. An explicit call rather than a side effect of reading
    ``/auth/user/`` — a GET that mutates would dismiss the prompt on a
    background refetch the user never saw. Idempotent, acts only on the
    requesting session, so there is nothing to look up and nothing to IDOR.
    """

    @extend_schema(request=None, responses={200: CurrentUserSerializer})
    def delete(self, request):
        from .social_connect import clear_pending_connect

        clear_pending_connect(request)
        return Response(CurrentUserSerializer(request.user, context={"request": request}).data)


DISCONNECT_NOT_CONNECTED_MESSAGE = "That account isn't connected."


class ConnectedAccountsView(APIView):
    """List the sign-in providers the requesting user has connected (#1314).

    ``GET /auth/me/connected-accounts/``. One row per provider this instance
    has configured, plus any the user still has connected through a provider
    the operator has since removed. Connecting is not an API call: it is a
    browser round trip through allauth's ``process=connect`` flow (see the
    Security tab), because it has to visit the provider.
    """

    @extend_schema(responses={200: ConnectedAccountSerializer(many=True)})
    def get(self, request):
        from .social_connect import connected_accounts_status

        rows = connected_accounts_status(request.user)
        return Response(ConnectedAccountSerializer(rows, many=True).data)


class ConnectedAccountDetailView(APIView):
    """Disconnect one of the requesting user's providers (#1314).

    ``DELETE /auth/me/connected-accounts/<provider>/``. Goes through allauth's
    public ``DisconnectForm`` — never ``SocialAccount.delete()`` — so that
    allauth's own guard refuses to remove the last way to sign in (no usable
    password, or no verified email under mandatory verification), and so the
    ``social_account_removed`` signal fires for anything listening to it.

    The queryset is ``DisconnectForm``'s own (``SocialAccount`` rows of
    ``request.user`` only), so another user's account can never be named.
    Answers the refreshed list, so the client needs no second round trip.
    """

    @extend_schema(
        request=None,
        responses={
            200: ConnectedAccountSerializer(many=True),
            400: OpenApiResponse(description="Disconnecting would leave no way to sign in."),
            404: OpenApiResponse(description="No such provider is connected."),
        },
    )
    def delete(self, request, provider):
        from allauth.socialaccount.forms import DisconnectForm

        from .social_connect import connected_accounts_status

        # DisconnectForm reads request.user and allauth adds a Django message;
        # both want the underlying HttpRequest. DRF's authentication has
        # already set its .user.
        django_request = request._request
        accounts = list(request.user.socialaccount_set.filter(provider=provider).order_by("pk"))
        if not accounts:
            return Response(
                {"detail": DISCONNECT_NOT_CONNECTED_MESSAGE}, status=status.HTTP_404_NOT_FOUND
            )
        # Normally one row per provider; a user who connected two identities
        # of the same provider loses both, each still checked by the guard.
        with transaction.atomic():
            for account in accounts:
                form = DisconnectForm(data={"account": account.pk}, request=django_request)
                if not form.is_valid():
                    errors = form.non_field_errors() or [
                        err for errs in form.errors.values() for err in errs
                    ]
                    # All-or-nothing: undo any sibling already removed above.
                    transaction.set_rollback(True)
                    return Response(
                        {"detail": str(errors[0]) if errors else "Can't disconnect this account."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                form.save()
        rows = connected_accounts_status(request.user)
        return Response(ConnectedAccountSerializer(rows, many=True).data)


EMAIL_IN_USE_MESSAGE = (
    "This email address is already in use by another account, so it can't be "
    "confirmed for this one."
)


class VerifyEmailView(DjRestAuthVerifyEmailView):
    """dj-rest-auth's verify-email, answering 409 when confirmation is blocked (#1293).

    With ``ACCOUNT_UNIQUE_EMAIL`` (allauth's default) an address that another
    account has already verified cannot be verified again. allauth's
    ``verify_email`` then quietly does nothing, and dj-rest-auth still answers
    ``200 {"detail": "ok"}`` — so a user confirming an email change saw
    "Email verified" while nothing changed, and their change stayed pending
    forever with no explanation.

    Enumeration: this reveals that the address belongs to some account, but
    only to a caller holding a valid confirmation key, and a key is only ever
    delivered to that address's inbox. Whoever controls the inbox can already
    learn the same thing (e.g. from a password-reset email arriving), so
    nothing new is disclosed. The account that *requested* the change learns
    nothing: its pending state looks the same whether confirmation was
    blocked or simply not attempted yet — deliberately, since that account
    need not control the inbox.
    """

    @extend_schema(
        responses={
            200: inline_serializer(
                name="VerifyEmailResponse", fields={"detail": serializers.CharField()}
            ),
            409: OpenApiResponse(
                description=(
                    "The address is already verified on another account, or (for a "
                    "pending email change) another account already uses it."
                ),
                response=inline_serializer(
                    name="VerifyEmailConflict",
                    fields={"detail": serializers.CharField(), "code": serializers.CharField()},
                ),
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self.kwargs["key"] = serializer.validated_data["key"]
        from .email_change import confirmation_would_collide

        address = self.get_object().email_address
        # #1221: a pending email change is also refused when another active
        # account already holds the address (even unverified) or uses it as a
        # username — see confirmation_would_collide. Same 409 and message as
        # the verified-elsewhere case, so the link holder learns nothing more.
        if not address.verified and (
            not address.can_set_verified() or confirmation_would_collide(address)
        ):
            return Response(
                {"detail": EMAIL_IN_USE_MESSAGE, "code": "email_in_use"},
                status=status.HTTP_409_CONFLICT,
            )
        return super().post(request, *args, **kwargs)


def finalize_password_change(user):
    """Side effects every successful user-initiated password change must have.

    Shared by ChangePasswordView and TokenRevokingPasswordChangeView so the two
    endpoints cannot drift again (#1259: the second only revoked tokens and
    left a forced-change user locked out). Call it inside the same transaction
    as the password save, so a failure here cannot leave a new password in
    place with the old tokens still live.

    - Clears ``must_change_password``: choosing a new password is exactly what
      the forced-change flag asks for, whichever endpoint the user reached.
    - Revokes every Personal Access Token: ``PersonalAccessToken`` documents
      "all tokens are deleted when the password changes", and users are told
      rotating the password is how to cut off a leaked token (#406, #1110).
    """
    user.must_change_password = False
    user.save(update_fields=["must_change_password"])
    user.personal_access_tokens.all().delete()


class ChangePasswordView(APIView):
    """Change the authenticated user's password, keeping the session alive afterwards.

    Explicitly opts out of MustNotHavePendingPasswordChange so that users who
    were forced to change their password can still reach this endpoint.
    """

    permission_classes = [IsAuthenticated, TokenHasScope]

    def post(self, request):
        current_password = request.data.get("current_password", "")
        new_password = request.data.get("new_password", "")

        # Checked here as well as by AUTH_PASSWORD_VALIDATORS' MinimumLengthValidator
        # (same PASSWORD_MIN_LENGTH) so this endpoint keeps its documented
        # single-sentence {"detail": ...} error for a short password.
        if not new_password or len(new_password) < settings.PASSWORD_MIN_LENGTH:
            return Response(
                {"detail": f"New password must be at least {settings.PASSWORD_MIN_LENGTH} characters."},
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

        with transaction.atomic():
            request.user.set_password(new_password)
            request.user.save(update_fields=["password"])
            finalize_password_change(request.user)
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


class UsernameChangeThrottle(ChooseUsernameThrottle):
    """``ChooseUsernameThrottle`` for the profile-update endpoints (#1273).

    Same ``choose_username`` scope, so the per-user bucket is shared with
    ``POST /auth/choose-username/`` — switching endpoints doesn't double the
    probe rate. A request that changes neither the username nor the email
    passes through without being counted.

    #1221: an email change counts too. ``UserSerializer.validate_email`` now
    answers "already in use" when the address is another account's email or
    username, which is the same kind of probe as "username taken" — so it
    draws on the same budget rather than being an unmetered way to test
    which addresses have accounts.
    """

    def allow_request(self, request, view):
        if request.method not in ("PATCH", "PUT"):
            return True
        try:
            new_username = request.data.get("username")
            new_email = request.data.get("email")
        except AttributeError:  # non-dict body (e.g. a JSON list); the serializer rejects it
            return True
        # Normalize like the serializer's CharField would: it accepts ints and
        # floats too (``{"username": 1003}`` renames the account to "1003"), so
        # only skipping str values let a numeric rename bypass the limit.
        renames = new_username is not None and str(new_username).strip() != getattr(
            request.user, "username", None
        )
        # Compared ignoring case, as UserSerializer does: re-sending the
        # current address in another case is not a change and is not counted
        # (the SPA re-sends the unchanged email on every profile save).
        changes_email = (
            new_email is not None
            and str(new_email).strip().lower()
            != (getattr(request.user, "email", "") or "").lower()
        )
        if not (renames or changes_email):
            return True
        return super().allow_request(request, view)


class UserDetailsView(UsernameChangeThrottleMixin, DjRestAuthUserDetailsView):
    """dj-rest-auth's ``/auth/user/`` with the username-change throttle (#1273).

    It writes through the same ``CurrentUserSerializer`` as ``/auth/me/``, so
    the serializer-level checks already apply; this adds the rate limit.
    """


class ChooseUsernameView(APIView):
    """Let a user pick a new username after a forced rename.

    Exempt from MustNotHavePendingUsernameChange so that affected users can
    reach this endpoint. Also exempt from MustNotHavePendingPasswordChange so
    the endpoint is reachable regardless of flag ordering (password change
    takes priority in the UI, but the API must not block the username
    endpoint if both flags are somehow set).
    """

    permission_classes = [IsAuthenticated, TokenHasScope]
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

        # Shared with every other username-writing endpoint (#1120) — see
        # accounts/validators.py for why this is stricter than Django's own
        # UnicodeUsernameValidator.
        if not is_valid_username_format(username):
            return Response(
                {"detail": "Username may only contain letters, digits, and @/./+/-/_ characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Case-insensitive uniqueness check, excluding the requesting user.
        # Shared with UserSerializer.validate_username (#1273).
        # #1221: a username equal to another active account's email would
        # shadow that account's email login, so it counts as taken too — with
        # the same message, so this reveals no more than "taken" already does.
        # Skipped when the name is only a re-casing of the current one: that
        # changes nothing the login resolver sees, so a pre-existing collision
        # must not block it.
        if is_username_taken(username, exclude_pk=request.user.pk) or (
            username.lower() != (request.user.username or "").lower()
            and username_collides_with_email(username, exclude_pk=request.user.pk)
        ):
            return Response(
                {"detail": USERNAME_TAKEN_MESSAGE},
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

    # This view builds its response by hand rather than through a serializer
    # (#1294) — the schema below documents exactly what `get()` returns so
    # drf-spectacular stops falling back to "unable to guess serializer".
    @extend_schema(
        responses=inline_serializer(
            name="SiteConfig",
            fields={
                "registration_open": drf_serializers.BooleanField(),
                "registration_mode": drf_serializers.ChoiceField(
                    choices=SiteSetting.RegistrationMode.choices,
                ),
                "demo_mode": drf_serializers.BooleanField(),
                "demo_login": inline_serializer(
                    name="SiteConfigDemoLogin",
                    fields={
                        "username": drf_serializers.CharField(),
                        "password": drf_serializers.CharField(),
                    },
                    allow_null=True,
                ),
                "demo_reset_schedule": drf_serializers.CharField(required=False, allow_null=True),
                "demo_next_reset_at": drf_serializers.DateTimeField(required=False, allow_null=True),
            },
        ),
    )
    def get(self, request):
        setting = SiteSetting.get()
        return Response({
            "registration_open": setting.registration_mode == "open",
            "registration_mode": setting.registration_mode,
            "demo_mode": settings.DEMO_MODE,
            "demo_login": self._demo_login(),
            # #1179: the reset cadence and the next reset instant, both null
            # unless DEMO_MODE is on (same gating shape as _demo_login). The
            # instant is computed server-side from the same cron value the
            # reset CronJob runs on, so the login-page countdown cannot drift
            # from the real reset and the SPA needs no cron parser.
            # #1180: also null when the reset is disabled (empty schedule).
            "demo_reset_schedule": demo_reset_schedule(),
            "demo_next_reset_at": demo_next_reset_at_iso(),
        })

    @staticmethod
    def _demo_login():
        """Demo credentials for the login-page banner (#1034), or None.

        Gated on DEMO_MODE in code, not merely on "a password is set": a stray
        DEMO_LOGIN_PASSWORD on a real install must never be published by this
        anonymous endpoint.
        """
        if not settings.DEMO_MODE or not settings.DEMO_LOGIN_PASSWORD:
            return None
        return {
            "username": settings.DEMO_LOGIN_USERNAME,
            "password": settings.DEMO_LOGIN_PASSWORD,
        }


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
        TokenHasScope,
    ]

    @extend_schema(responses=PersonalAccessTokenSerializer(many=True))
    def get(self, request):
        tokens = request.user.personal_access_tokens.all()
        return Response(PersonalAccessTokenSerializer(tokens, many=True).data)

    @extend_schema(
        # Parsed by hand below rather than through a serializer (only `scopes`
        # is validated via PersonalAccessTokenCreateSerializer) — documented
        # explicitly so drf-spectacular does not fall back to guessing.
        request=inline_serializer(
            name="PersonalAccessTokenCreateRequest",
            fields={
                "name": drf_serializers.CharField(),
                "expires_at": drf_serializers.DateTimeField(required=False, allow_null=True),
                "scopes": drf_serializers.ListField(child=drf_serializers.CharField(), required=False),
            },
        ),
        responses={201: PersonalAccessTokenCreateResponseSerializer},
    )
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

        scope_serializer = PersonalAccessTokenCreateSerializer(data=request.data)
        if not scope_serializer.is_valid():
            errors = scope_serializer.errors.get("scopes") or ["Invalid scopes."]
            return Response({"detail": str(errors[0])}, status=status.HTTP_400_BAD_REQUEST)

        # Omitting `scopes` yields PAT_DEFAULT_SCOPES, never NULL. NULL means
        # "legacy, full authority" and must stay unreachable from any write path
        # — otherwise every newly minted token silently opts out of scoping.
        # This does narrow the default for API callers who relied on a new token
        # carrying admin authority; that is the point of the change and it is
        # called out in the changelog and upgrade docs.
        # Key presence, not truthiness. `[]` cannot reach validated_data today
        # (allow_empty=False on the serializer field rejects it as a 400), but
        # if that ever relaxes to allow minting a deliberate no-authority token,
        # a truthiness check here would silently upgrade `scopes: []` into
        # read+write — turning an explicit grant of nothing into a real
        # credential. Keyed off presence, that relaxation stays correct.
        validated = scope_serializer.validated_data
        scopes = validated["scopes"] if "scopes" in validated else list(PAT_DEFAULT_SCOPES)

        pat, raw_token = PersonalAccessToken.generate(request.user, name, expires_at, scopes=scopes)
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
        TokenHasScope,
    ]

    def delete(self, request, pk):
        try:
            pat = request.user.personal_access_tokens.get(pk=pk)
        except PersonalAccessToken.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        pat.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TokenRevokingPasswordChangeView(DjRestAuthPasswordChangeView):
    """dj-rest-auth's password change, with the project's token-revocation rule.

    `PersonalAccessToken` documents the invariant "all tokens for a user are
    deleted when their password is changed", and the docs tell users that
    rotating their password is how they cut off a leaked token. Visiban's own
    ChangePasswordView enforces it; dj-rest-auth's stock view does not, so the
    invariant held only for whichever endpoint the caller happened to pick —
    and a client that found this one in the OpenAPI schema would get a password
    change that silently left every token alive.

    Found by the security review on #1110, which made scoping meaningful enough
    that "rotate the password to revoke the credential" has to actually work.

    Since #1257-#1259 it matches ChangePasswordView on every rule, not just
    revocation: the current password is required (VisibanPasswordChangeSerializer),
    the 12-character minimum applies (PASSWORD_MIN_LENGTH via
    AUTH_PASSWORD_VALIDATORS), and a successful change clears
    must_change_password through the same finalize_password_change() helper.
    """

    def post(self, request, *args, **kwargs):
        # The current-password check (#1257) lives in the configured
        # PASSWORD_CHANGE_SERIALIZER, accounts.serializers.VisibanPasswordChangeSerializer.
        # atomic() so the password save and finalize_password_change() commit
        # or roll back together.
        with transaction.atomic():
            response = super().post(request, *args, **kwargs)
            if response.status_code == status.HTTP_200_OK:
                finalize_password_change(request.user)
        return response


class WSTicketThrottle(UserRateThrottle):
    """Per-user rate limit for WebSocket ticket issuance.

    One ticket is spent per connection attempt, so a client that loses its
    network legitimately bursts against this endpoint while it reconnects. The
    ceiling is set to absorb that while still bounding a scripted loop farming
    tickets.
    """

    scope = "ws_ticket"


class WSTicketView(APIView):
    """Mint a short-lived, single-use ticket for a WebSocket handshake (#1109).

    Exists because Channels' ``AuthMiddlewareStack`` reads only the session
    cookie, so PAT- and token-authenticated clients — native, CLI, or a front end
    on another origin that never receives the ``SameSite=Lax`` cookie — can use
    every REST endpoint but get 4001 on ``ws/boards/<id>/`` and
    ``ws/groups/<id>/``.

    Accepts any authentication class in DEFAULT_AUTHENTICATION_CLASSES, so the
    caller proves identity over REST with the credential it already holds and
    spends the returned ticket on the upgrade.

    The ticket authenticates and nothing more — the consumer still resolves the
    caller's role and still closes 4003 for a non-member.
    """

    # TokenHasScope is enumerated here for the same reason every other
    # authenticated view enumerates it (#1110): a ticket minted with a PAT
    # inherits that token's authority on the socket, so the ticket endpoint is
    # the single choke point where a PAT's scope is checked before it reaches
    # the realtime surface — the WS middleware accepts tickets only, never a
    # PAT. Minting is a POST, so the authenticator's baseline already requires
    # `write`; no additional required_scopes are declared.
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    throttle_classes = [WSTicketThrottle]

    def post(self, request):
        # The raw ticket is returned here and never again — it is not stored in
        # recoverable form, matching the PAT-creation contract above.
        ticket, expires_at = issue_ws_ticket(request.user)
        return Response(
            {"ticket": ticket, "expires_at": expires_at},
            status=status.HTTP_201_CREATED,
        )


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

        # Capture the email here — the registration body is the source of truth
        # for what allauth will save.  Used for the per-email redemption check
        # on multi-use invite links (#925).
        signup_email = (request.data.get("email") or "").strip()

        # Token is valid — proceed with registration then consume.
        # Both happen in the same transaction so a failed registration leaves
        # the token unconsumed.
        response = super().create(request, *args, **kwargs)
        if response.status_code in (200, 201):
            try:
                consume_invite_token(link, email=signup_email)
            except InviteTokenError as exc:
                if exc.code == "invite_already_redeemed":
                    # The @transaction.atomic on this view rolls back the user
                    # creation when we return — so a 409 here does not leave a
                    # stale account behind.
                    return Response(
                        {"invite_token": [exc.detail]},
                        status=status.HTTP_409_CONFLICT,
                    )
                raise

        return response


class EmailConfirmRedirectView(APIView):
    """Safety-net for browsers that hit the backend confirm-email URL directly.

    The confirmation link in outgoing emails now points to the frontend SPA
    (via RegistrationAdapter.get_email_confirmation_url). This view handles
    old/stale links (e.g. emails sent before the fix) or direct navigation by
    redirecting the browser to the SPA route, which calls POST /verify-email/.

    Implemented as an APIView so DRF's throttle pipeline applies — a plain
    Django View bypasses DEFAULT_THROTTLE_CLASSES and leaves the path
    unthrottled (#754).
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [EmailConfirmRedirectThrottle]

    # allauth HMAC keys are URL-safe base64 with a colon-separated timestamp
    # suffix (e.g. "Mg:1uABcd-..."). Reject anything that doesn't match before
    # issuing the redirect so we never forward garbage paths to the SPA.
    _KEY_RE = re.compile(r'^[\w:\-]+$')

    def get(self, request, key):
        frontend_url = (getattr(settings, "LOGIN_REDIRECT_URL", None) or "http://localhost:5173").rstrip("/")
        if not self._KEY_RE.match(key):
            return HttpResponseRedirect(f"{frontend_url}/confirm-email/invalid")
        return HttpResponseRedirect(f"{frontend_url}/confirm-email/{key}")


class SocialSignupRedirectView(APIView):
    """Safety-net for allauth's ``socialaccount_signup`` view (#1321).

    Unlike EmailConfirmRedirectView above, the dead-end this guards against
    is NOT a crash: allauth 65.14.3 ships its own
    ``socialaccount/signup.html`` and Visiban's ``TEMPLATES`` has
    ``APP_DIRS=True``, so ``GET /accounts/3rdparty/signup/`` renders
    allauth's stock, unstyled signup form instead of raising
    ImproperlyConfigured. That form pre-fills the OAuth-provided email in a
    plain, editable ``forms.EmailField`` (``allauth.socialaccount.forms.
    SignupForm`` / ``allauth.account.forms.BaseSignupForm``) —
    ``validate_unique_email`` only rejects resubmitting the exact same
    colliding address, so nothing stops the field being edited to a
    different email and the form being submitted, creating a second
    account for the same OAuth identity. Confirmed by manual repro — see
    this MR's description.

    allauth reaches this view via ``redirect_to_signup``
    (``allauth.socialaccount.internal.flows.signup``) in two cases, both
    after ``is_open_for_signup`` has already passed:
      1. The OAuth-provided email collides with an existing account
         (``process_auto_signup_email`` -> ``assess_unique_email`` is
         False).
      2. The provider returned no email at all (e.g. GitHub with a private
         email) while ``ACCOUNT_SIGNUP_FIELDS`` requires ``email*``.

    Registered ahead of ``include("allauth.urls")`` in visiban/urls.py, same
    override technique as EmailConfirmRedirectView, so this view wins the
    match. Clears the pending SocialLogin allauth stashed in the session
    (mirrors allauth's own ``clear_pending_signup``) so a stale login can't
    be resumed from this session, then bounces to the frontend with a
    generic ``oauth_failed`` code — the SPA has no page that could render
    allauth's HTML form fields, and both trigger cases are rare enough that
    a single fallback message is not worth a richer error taxonomy.

    Not a duplicate of #1312: that issue is a ``clean_email`` gap on the
    plain HTML password-signup form (``/accounts/signup/``, wired via
    ``ACCOUNT_FORMS``/``VisibanSignupForm``) and has no bearing on this
    view's OAuth path, which allauth routes through a completely separate
    form class (``allauth.socialaccount.forms.SignupForm``, gated by the
    unset ``SOCIALACCOUNT_FORMS``) — #1312's fix does not, and could not,
    cover this one. They share only a surface theme (an email-collision gap
    in a signup form) — see this MR's ``## Notes`` for the full comparison.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [SocialSignupRedirectThrottle]

    def get(self, request):
        request.session.pop("socialaccount_sociallogin", None)
        frontend_url = getattr(settings, "LOGIN_REDIRECT_URL", None) or "http://localhost:5173"
        separator = "&" if "?" in frontend_url else "?"
        return HttpResponseRedirect(f"{frontend_url}{separator}auth_error=oauth_failed")


class VisibanEmailView(AllauthEmailView):
    """allauth's manage-email page (``/accounts/email/``), plus: "Make Primary"
    can't promote a secondary address that collides (#1221, #1312).

    ``AddEmailForm`` (adding a secondary, unverified address — see
    ``accounts.forms.VisibanSignupForm``'s docstring) is deliberately left
    unchecked because it never writes ``User.email``. This view's
    "Make Primary" action is the gap that observation depended on being
    covered elsewhere and wasn't: ``flows.manage_email.mark_as_primary`` ->
    ``EmailAddress.set_as_primary()`` -> ``user_email(user, email,
    commit=True)`` writes ``User.email`` UNCONDITIONALLY once
    ``can_mark_as_primary()`` passes — and ``can_mark_as_primary()`` allows
    promoting an entirely UNVERIFIED address whenever the account has zero
    verified emails, which is every fresh account under Visiban's default
    ``EMAIL_VERIFICATION=optional``. Confirmed exploitable: create an account,
    add an unverified secondary email equal to another account's username via
    ``/accounts/email/`` (unchecked, by design), then POST ``action_primary``
    — no collision check anywhere in that path.

    This is a completely separate code path from
    ``accounts.email_change.confirmation_would_collide`` (gated on
    ``User.pending_email_address``, which ``mark_as_primary`` never touches;
    also, under Visiban's ``ACCOUNT_CHANGE_EMAIL=False`` default, allauth's own
    confirm-driven promotion never emits ``email_changed`` at all — see
    ``allauth.account.internal.flows.email_verification.verify_email``, gated
    on ``app_settings.CHANGE_EMAIL``). So a *pre-check* here, before
    ``mark_as_primary`` runs, is the only point that reliably stops the write:
    by the time allauth's own ``email_changed`` signal fires, ``User.email``
    has already been saved, and reverting it back out synchronously inside a
    signal receiver depends on execution-order details of code this project
    doesn't own — the wrong place to put a security boundary. Overriding this
    one method, instead, keeps allauth's rate limiting and ``login_required``
    (both applied to ``EmailView.dispatch`` via class decorators, and
    inherited unchanged here since this subclass doesn't override
    ``dispatch``) exactly as allauth wired them.

    No REST equivalent exists for "make an existing secondary address
    primary" (searched accounts/views.py and admin_views.py) — this HTML
    action is the only entry point.
    """

    def _action_primary(self, request, *args, **kwargs):
        """Inlines allauth's ``_action_primary`` body (rather than pre-checking
        then calling ``super()``) so the ``EmailAddress`` this method already
        fetched for the collision check isn't looked up a second time —
        perf-check, #1312 follow-up."""
        from allauth.account.internal import flows

        from .validators import EMAIL_TAKEN_MESSAGE, email_collides_with_identifier

        email_address = self._get_email_address(request)
        if email_address:
            if email_collides_with_identifier(email_address.email, exclude_pk=request.user.pk):
                get_adapter(request).add_message(
                    request, messages.ERROR, message=EMAIL_TAKEN_MESSAGE
                )
                return HttpResponseRedirect(self.get_success_url())
            if flows.manage_email.mark_as_primary(request, email_address):
                return HttpResponseRedirect(self.get_success_url())
        return None
