import re
from datetime import timedelta, timezone as dt_timezone

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model, password_validation, update_session_auth_hash
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.views import View
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache
from django.utils.dateparse import parse_datetime
from allauth.account.adapter import get_adapter
from allauth.account.app_settings import EMAIL_VERIFICATION, EmailVerificationMethod
from allauth.account.views import EmailView as AllauthEmailView
from allauth.account.views import SignupView as AllauthSignupView
from dj_rest_auth.registration.views import RegisterView
from dj_rest_auth.registration.views import VerifyEmailView as DjRestAuthVerifyEmailView
from drf_spectacular.utils import OpenApiResponse, extend_schema, inline_serializer
from rest_framework import serializers
from dj_rest_auth.views import LoginView as DjRestAuthLoginView
from dj_rest_auth.views import PasswordResetView as DjRestAuthPasswordResetView
from dj_rest_auth.views import PasswordResetConfirmView as DjRestAuthPasswordResetConfirmView
from dj_rest_auth.views import PasswordChangeView as DjRestAuthPasswordChangeView
from dj_rest_auth.views import UserDetailsView as DjRestAuthUserDetailsView
from dj_rest_auth.serializers import TokenSerializer as DjRestAuthTokenSerializer
from rest_framework import serializers as drf_serializers
from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle, UserRateThrottle
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated

from visiban.demo import demo_reset_schedule
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.request_shape import require_json_object
from rest_framework import status
from rest_framework.exceptions import NotAuthenticated, PermissionDenied
from .permissions import TokenHasScope
from .models import (
    PAT_DEFAULT_SCOPES,
    PAT_MAX_PER_USER,
    PersonalAccessToken,
    SiteSetting,
    get_registration_mode,
)
from .instance_flags import instance_flags
from .invite_utils import InviteTokenError
# Defined in accounts.credentials (#1551) so the allauth signal receivers, the
# REST reset serializer and the Django admin can share it without importing
# this module; kept importable from here for existing callers.
from . import credentials, password_attempts
from .credentials import finalize_password_change
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
from .ws_auth import credential_for_request, issue_ws_ticket
from visiban.invite_email import invite_email_available

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
    """dj-rest-auth PasswordResetView with a project-specific rate limit applied.

    Same OpenAPI-schema gap as #1408's TokenRevokingPasswordChangeView:
    drf-spectacular's RestAuthPasswordResetView fix matches
    `dj_rest_auth.views.PasswordResetView` by exact class identity, not
    subclass, so it never applies to this subclass. Without the override
    below, the generated schema documents the 200 response using
    PASSWORD_RESET_SERIALIZER's request-only `email` field instead of the
    real `{"detail": ...}` body.
    """

    throttle_classes = [PasswordResetThrottle]

    @extend_schema(
        responses={
            200: inline_serializer(
                name="PasswordResetResponse", fields={"detail": serializers.CharField()}
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


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
    """dj-rest-auth PasswordResetConfirmView with a project-specific rate limit applied.

    Same OpenAPI-schema gap as #1408's TokenRevokingPasswordChangeView: the
    drf-spectacular fix for this view matches
    `dj_rest_auth.views.PasswordResetConfirmView` by exact class identity, not
    subclass, so it never applies here. Without the override below, the
    generated schema documents the 200 response using
    PASSWORD_RESET_CONFIRM_SERIALIZER's request-only fields
    (new_password1/new_password2/uid/token) instead of the real
    `{"detail": ...}` body.
    """

    throttle_classes = [PasswordResetConfirmThrottle]

    @extend_schema(
        responses={
            200: inline_serializer(
                name="PasswordResetConfirmResponse", fields={"detail": serializers.CharField()}
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


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

    Same OpenAPI-schema gap as #1408's TokenRevokingPasswordChangeView:
    drf-spectacular's RestAuthLoginView fix matches `dj_rest_auth.views.LoginView`
    by exact class identity, not subclass, so it never applies to this
    subclass. Without the override below, the generated schema documents the
    200 response using LOGIN_SERIALIZER's request-only fields
    (username/email/password) instead of the real response body. Visiban
    pins REST_AUTH["USE_JWT"] = False with the default TOKEN_MODEL, so the
    real runtime response is `{"key": "<token>"}` (dj_rest_auth's
    TokenSerializer) — confirmed by accounts/tests/test_login_by_email.py.
    """

    throttle_classes = [LoginRateThrottle]

    @extend_schema(responses={200: DjRestAuthTokenSerializer})
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)

    def login(self):
        """Issue the login credentials under the user-row lock (#1586).

        API token issuance is serialized with every other credential write for
        the user (``accounts.credentials.lock_user_row``: PAT creation, token
        reissue, and the password-change, reset and admin-set finalize
        helpers). Under the lock the stored row is re-read: it must still
        exist, carry the password hash the credentials were verified against,
        and be active; otherwise the login is refused with the same 400 body
        as any other credential failure.

        The DRF ``Token`` get-or-create and the session login both run inside
        this transaction, so the credentials a login returns always belong to
        the user row's current password. Lock order is user row, then token
        row, the same order the finalize helpers use (the password save locks
        the user row before ``revoke_auth_token`` touches the token table).
        """
        user = self.serializer.validated_data["user"]
        refused = drf_serializers.ValidationError(
            {"non_field_errors": ["Unable to log in with provided credentials."]}
        )
        with transaction.atomic():
            try:
                locked = credentials.lock_user_row(user)
            except get_user_model().DoesNotExist:
                raise refused from None
            if locked.password != user.password or not locked.is_active:
                raise refused
            super().login()


class VerifyEmailThrottle(AnonRateThrottle):
    """Rate limit for the verify-email endpoint.

    HMAC-SHA256 keys are not brute-forceable, so the ceiling is generous.
    The scope exists for consistency with the rest of the anonymous auth surface
    and to give operators a single knob if abuse is ever observed.
    """

    scope = "verify_email"


class ResendEmailThrottle(SimpleRateThrottle):
    """Scoped rate limit for the resend verification email endpoint (#1552).

    Keyed on client IP for authenticated and anonymous callers alike
    (AnonRateThrottle would skip authenticated users).
    """

    scope = "resend_email"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


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
    """Search active users by display name or username; requires at least 2 characters."""

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
                Q(display_name__icontains=query) | Q(username__icontains=query),
                is_active=True,
                # Only fields the response returns are matched: email and first_name
                # are excluded because filtering on a field the response omits
                # makes the result set depend on data the caller cannot see.
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

    # Schema only (#1783): a plain APIView gives drf-spectacular nothing to
    # infer, so both methods were published with no response body and PATCH
    # with no request body at all. Both use CurrentUserSerializer, the same
    # serializer as /auth/user/; PATCH is partial.
    @extend_schema(responses={200: CurrentUserSerializer})
    def get(self, request):
        return Response(CurrentUserSerializer(request.user, context={"request": request}).data)

    @extend_schema(request=CurrentUserSerializer, responses={200: CurrentUserSerializer})
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
    double-click or a retry after a lost response still answers 204.

    Answers ``204 No Content`` (#2005), the 1.2 convention for a revoke-style
    DELETE; the SPA refetches ``/auth/user/`` for the new state. Only the 1.1
    site invite-link revoke keeps its shipped ``200``-with-body contract.

    Acts only on ``request.user`` — there is no address or id in the request —
    so there is no object to look up and nothing to IDOR. Keeps the default
    permission chain (including the forced password/username-change gates):
    unlike ``/auth/me/`` itself this is not part of the flow that clears them.

    Interactive session only (#1838), like the email change it acts on
    (``credentials.email_change_requires_session``): a token caller could not
    have started the change, and the rule stays uniform across the family.
    """

    @extend_schema(
        request=None,
        # Session only: advertise the cookie scheme, not tokenAuth.
        auth=[{"cookieAuth": []}],
        responses={
            204: OpenApiResponse(description="Withdrawn, or nothing was pending. No body."),
            403: OpenApiResponse(
                description="Authenticated with a token rather than an interactive session."
            ),
        },
    )
    def delete(self, request):
        from .email_change import cancel_email_change

        if not credentials.request_is_interactive_session(request):
            return Response(
                {"detail": credentials.EMAIL_CHANGE_SESSION_REQUIRED_MESSAGE},
                status=status.HTTP_403_FORBIDDEN,
            )
        cancel_email_change(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PendingEmailResendView(APIView):
    """Send the confirmation link for the requesting user's pending email change again (#1293).

    ``POST /auth/me/pending-email/resend/``. Sends through allauth's own
    verification mail and its ``confirm_email`` rate limit (see
    ``email_change.resend_email_change``); a send skipped by that limit is a
    429 rather than a silent 200, so the UI can say so instead of claiming it
    sent something. The address is never taken from the request — only the
    row the user's own pending change tracks can be mailed — so this cannot
    be pointed at an arbitrary inbox.

    Interactive session only (#1838), matching ``PendingEmailView`` and the
    email change itself. Checked before the pending row is looked up, so a
    token caller gets the same 403 whether or not a change is pending.
    """

    @extend_schema(
        request=None,
        # Session only: advertise the cookie scheme, not tokenAuth.
        auth=[{"cookieAuth": []}],
        responses={
            200: inline_serializer(
                name="PendingEmailResendResponse", fields={"detail": serializers.CharField()}
            ),
            403: OpenApiResponse(
                description="Authenticated with a token rather than an interactive session."
            ),
        },
    )
    def post(self, request):
        from .email_change import resend_email_change

        if not credentials.request_is_interactive_session(request):
            return Response(
                {"detail": credentials.EMAIL_CHANGE_SESSION_REQUIRED_MESSAGE},
                status=status.HTTP_403_FORBIDDEN,
            )
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
    Answers ``204 No Content`` (#2005), like ``PendingEmailView``.
    """

    @extend_schema(
        request=None,
        responses={204: OpenApiResponse(description="Dismissed, or nothing was pending. No body.")},
    )
    def delete(self, request):
        from .social_connect import clear_pending_connect

        clear_pending_connect(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


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

    Interactive session only (#1794): removing a sign-in method is an
    account-security mutation, so a request authenticated with any token
    credential (a Personal Access Token, even a ``write``-scoped one, or the
    login API token) is refused with 403 before anything is read or written.
    A leaked token must not be able to strip the owner's ways back in.
    """

    @extend_schema(
        request=None,
        # Session only (#1794): advertise the cookie scheme, not tokenAuth.
        auth=[{"cookieAuth": []}],
        responses={
            200: ConnectedAccountSerializer(many=True),
            400: OpenApiResponse(description="Disconnecting would leave no way to sign in."),
            403: OpenApiResponse(
                description="Authenticated with a token rather than an interactive session."
            ),
            404: OpenApiResponse(description="No such provider is connected."),
        },
    )
    def delete(self, request, provider):
        from allauth.socialaccount.forms import DisconnectForm

        from .social_connect import connected_accounts_status

        # Checked first so a token caller gets the same 403 whether or not the
        # provider is connected (no 404-vs-403 probe of the account's providers).
        if not credentials.request_is_interactive_session(request):
            return Response(
                {"detail": credentials.PROVIDER_DISCONNECT_SESSION_REQUIRED_MESSAGE},
                status=status.HTTP_403_FORBIDDEN,
            )

        # DisconnectForm reads request.user and allauth adds a Django message;
        # both want the underlying HttpRequest. DRF's authentication has
        # already set its .user.
        django_request = request._request
        accounts = list(
            request.user.socialaccount_set.filter(provider=provider).select_related("user").order_by("pk")
        )
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


def _reissued_auth_token(request) -> dict:
    """The ``key`` field a REST password change adds for a ``Token`` caller (#1562).

    ``finalize_password_change`` revokes the DRF auth ``Token``. When that
    ``Token`` is what authenticated this request, the caller would otherwise
    lose its credential by changing its own password, so a new one is minted
    in the same transaction and returned as ``key`` (the field name the login
    response uses). Session and Personal Access Token callers get nothing:
    the session stays valid through ``update_session_auth_hash``, and a PAT
    caller's credential is revoked by design. Must run inside the
    transaction that saved the password.
    """
    from rest_framework.authtoken.models import Token

    if isinstance(request.auth, Token):
        return {"key": credentials.reissue_auth_token(request.user)}
    return {}


# The 403 both password-change routes can answer (#1260). Declared so the
# ``code`` the SPA acts on is part of the contract; without it the schema hook
# (visiban.schema_hooks.add_standard_error_responses) documents the generic
# ``{"detail": ...}`` only. ``code`` is optional: only the recent-login refusal
# sets it, while a token caller setting a first password (#1609) and a scope
# refusal answer ``detail`` alone.
_PASSWORD_CHANGE_FORBIDDEN_RESPONSE = OpenApiResponse(
    description=(
        "Refused. Setting a first password on an account with no usable password "
        "needs an interactive session (token callers are refused) holding a recent "
        "provider sign-in to the account; without one the body carries "
        '``"code": "recent_login_required"``.'
    ),
    response=inline_serializer(
        name="PasswordChangeForbidden",
        fields={
            "detail": serializers.CharField(),
            "code": serializers.CharField(
                required=False,
                help_text=(
                    "``recent_login_required`` when the session has no recent provider "
                    "sign-in to the account. Absent on other refusals."
                ),
            ),
        },
    ),
)

# One component shared by both password-change routes so their documented
# responses cannot drift apart.
_PASSWORD_CHANGE_RESPONSE = inline_serializer(
    name="PasswordChangeResponse",
    fields={
        "detail": serializers.CharField(),
        "key": serializers.CharField(
            required=False,
            help_text=(
                "Present only when the request was authenticated with the DRF auth "
                "token: the replacement token to use from now on."
            ),
        ),
    },
)


class PasswordChangeThrottle(UserRateThrottle):
    """Per-user rate limit for the password-change endpoints (#1673).

    Both endpoints share the one ``password_change`` bucket, so switching
    between them does not multiply the budget. Failed current-password checks
    additionally feed the account lockout bucket (accounts.password_attempts).
    """

    scope = "password_change"


# The response can carry a replacement API token (``key``), so it must not be
# stored by a browser or an intermediate cache (#1562).
@method_decorator(never_cache, name="dispatch")
class ChangePasswordView(APIView):
    """Change the authenticated user's password, keeping the session alive afterwards.

    Explicitly opts out of MustNotHavePendingPasswordChange so that users who
    were forced to change their password can still reach this endpoint.
    """

    permission_classes = [IsAuthenticated, TokenHasScope]

    def get_throttles(self):
        return [*super().get_throttles(), PasswordChangeThrottle()]

    @extend_schema(
        # Schema only (#1783): the body was undocumented. The view reads these
        # two keys by hand; a missing new_password is a 400.
        # Named for its route, /auth/change-password/ (#1825): "ChangePassword"
        # read as the body of dj-rest-auth's /auth/password/change/
        # (PasswordChangeRequest, `old_password`), a different shape.
        # The component name is schema-only; no wire field changes.
        request=inline_serializer(
            name="AuthChangePassword",
            fields={
                "current_password": serializers.CharField(
                    required=False,
                    help_text=(
                        "Required when the account already has a usable password; "
                        "omitted when setting a first password on a social-only account."
                    ),
                ),
                "new_password": serializers.CharField(),
            },
        ),
        responses={200: _PASSWORD_CHANGE_RESPONSE, 403: _PASSWORD_CHANGE_FORBIDDEN_RESPONSE},
    )
    def post(self, request):
        body = require_json_object(request)
        current_password = body.get("current_password", "")
        new_password = body.get("new_password", "")
        # A non-string value is no password: it takes the same "too short" /
        # wrong-password path as an empty one instead of raising TypeError (#1669).
        if not isinstance(current_password, str):
            current_password = ""
        if not isinstance(new_password, str):
            new_password = ""

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

        with transaction.atomic():
            # #1619: the current password is checked against, and the new
            # hash written to, the row read under the user-row lock, not the
            # copy loaded when the request started. A password change or
            # reset committed by another request in between is then checked
            # against instead of being silently replaced, and only the
            # password column is written.
            user = credentials.lock_user_row(request.user)
            # Read before the save: a first password gets its own notice.
            first_password = not user.has_usable_password()
            # #1609: that first password may only be set from an interactive
            # session; a request carrying any token credential is refused
            # before anything is written.
            if credentials.first_password_requires_session(request, user):
                return Response(
                    {"detail": credentials.FIRST_PASSWORD_SESSION_REQUIRED_MESSAGE},
                    status=status.HTTP_403_FORBIDDEN,
                )
            # #1260: and only from a session that signed in to this account
            # through its provider recently, so a copied cookie alone cannot.
            if credentials.first_password_requires_recent_login(request, user):
                return Response(
                    {
                        "detail": credentials.FIRST_PASSWORD_RECENT_LOGIN_REQUIRED_MESSAGE,
                        "code": credentials.RECENT_LOGIN_REQUIRED_CODE,
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            # Social-only accounts have no usable password — skip the current
            # password check so they can set one for the first time.
            if user.has_usable_password():
                attempt = password_attempts.begin_current_password_check(request, user)
                if not user.check_password(current_password):
                    return Response(
                        {"detail": "Current password is incorrect."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                password_attempts.current_password_accepted(attempt)
            user.set_password(new_password)
            user.save(update_fields=["password"])
            finalize_password_change(user, first_password=first_password)
            body = {"detail": "Password changed successfully."}
            body.update(_reissued_auth_token(request))
        # Keep the current session alive after the password rotation so the
        # user does not get logged out and left with a broken session state.
        update_session_auth_hash(request, user)
        return Response(body)


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

    # Schema only (#1783): the body and the response were undocumented. The
    # view reads `username` by hand (a missing one is a 400) and answers with
    # the updated user.
    @extend_schema(
        request=inline_serializer(
            name="ChooseUsername",
            fields={"username": serializers.CharField(max_length=150)},
        ),
        responses={200: UserSerializer},
    )
    def post(self, request):
        username = require_json_object(request).get("username") or ""
        # A non-string username is treated as missing (same 400), not a 500.
        username = username.strip() if isinstance(username, str) else ""

        # A username is a login identifier: only an interactive session may
        # change it. Checked before validation so a token caller gets the same
        # 403 whatever the name. Resending the stored name is not a change.
        # Also refused while a forced rename is pending, even for the stored
        # name: this route clears ``must_change_username``, and a token must
        # not be able to dismiss that requirement without a rename.
        if credentials.username_change_requires_session(
            request, request.user.username, username
        ) or (
            request.user.must_change_username
            and not credentials.request_is_interactive_session(request)
        ):
            raise PermissionDenied(credentials.USERNAME_CHANGE_SESSION_REQUIRED_MESSAGE)

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
                "invite_email_available": drf_serializers.BooleanField(),
                # #1872: instance flags that /auth/user/ also carries (frozen there,
                # #1664). Same values, computed by accounts.instance_flags.
                "git_lens_enabled": drf_serializers.BooleanField(),
                "maintenance_mode": drf_serializers.BooleanField(),
                "maintenance_message": drf_serializers.CharField(),
            },
        ),
    )
    def get(self, request):
        setting = SiteSetting.get()
        # #1872: git_lens_enabled, maintenance_mode, maintenance_message, demo_mode
        # and demo_next_reset_at come from the helper CurrentUserSerializer uses, so
        # the two endpoints cannot disagree. All five describe the instance, not the
        # caller, and each is already observable anonymously. This endpoint is
        # AllowAny, so that matters: see accounts/instance_flags.py for the
        # per-field reasoning. A caller-dependent value must never be added here.
        flags = instance_flags()
        return Response({
            "registration_open": setting.registration_mode == "open",
            "registration_mode": setting.registration_mode,
            "demo_mode": flags["demo_mode"],
            "demo_login": self._demo_login(),
            # #1179: the reset cadence and the next reset instant, both null
            # unless DEMO_MODE is on (same gating shape as _demo_login). The
            # instant is computed server-side from the same cron value the
            # reset CronJob runs on, so the login-page countdown cannot drift
            # from the real reset and the SPA needs no cron parser.
            # #1180: also null when the reset is disabled (empty schedule).
            "demo_reset_schedule": demo_reset_schedule(),
            "demo_next_reset_at": flags["demo_next_reset_at"],
            # #731: whether the SPA should offer "send invite by email". A UI
            # hint only — it reveals no configuration detail beyond "mail looks
            # configured", and the send endpoints still report real failures.
            "invite_email_available": invite_email_available(),
            "git_lens_enabled": flags["git_lens_enabled"],
            "maintenance_mode": flags["maintenance_mode"],
            "maintenance_message": flags["maintenance_message"],
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
            name="PersonalAccessTokenCreate",
            fields={
                "name": drf_serializers.CharField(),
                "expires_at": drf_serializers.DateTimeField(required=False, allow_null=True),
                "scopes": drf_serializers.ListField(child=drf_serializers.CharField(), required=False),
            },
        ),
        responses={201: PersonalAccessTokenCreateResponseSerializer},
    )
    def post(self, request):
        body = require_json_object(request)
        name = body.get("name") or ""
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            return Response({"detail": "Token name is required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > 64:
            return Response({"detail": "Token name must be 64 characters or fewer."}, status=status.HTTP_400_BAD_REQUEST)

        expires_at = None
        raw_expires = body.get("expires_at")
        # Only None and "" mean "no expiry"; any other non-string (0, false, [],
        # {}) is invalid rather than silently minting a non-expiring token.
        if raw_expires is not None and raw_expires != "":
            try:
                expires_at = parse_datetime(raw_expires) if isinstance(raw_expires, str) else None
            except ValueError:  # well-formed but impossible, e.g. 2026-02-30
                expires_at = None
            if expires_at is None:
                return Response({"detail": "Invalid expires_at value."}, status=status.HTTP_400_BAD_REQUEST)
            if timezone.is_naive(expires_at):
                # The API documents expires_at as UTC; a value with no offset is UTC.
                expires_at = expires_at.replace(tzinfo=dt_timezone.utc)
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

        # Serialized with credential changes on the user row (#1564); the
        # request credential is re-read under the lock. A concurrent password
        # hash upgrade also yields a retryable 401.
        with transaction.atomic():
            locked = credentials.lock_user_row(request.user)
            pat_revoked = isinstance(request.auth, PersonalAccessToken) and not (
                PersonalAccessToken.objects.filter(pk=request.auth.pk).exists()
            )
            if locked.password != request.user.password or not locked.is_active or pat_revoked:
                raise NotAuthenticated("Credentials are no longer valid.")
            if locked.personal_access_tokens.count() >= PAT_MAX_PER_USER:
                return Response(
                    {"detail": f"Maximum of {PAT_MAX_PER_USER} access tokens allowed per account."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            pat, raw_token = PersonalAccessToken.generate(locked, name, expires_at, scopes=scopes)
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


# The response can carry a replacement API token (``key``), so it must not be
# stored by a browser or an intermediate cache (#1562).
@method_decorator(never_cache, name="dispatch")
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

    def get_throttles(self):
        return [*super().get_throttles(), PasswordChangeThrottle()]

    @extend_schema(
        responses={
            200: _PASSWORD_CHANGE_RESPONSE,
            403: _PASSWORD_CHANGE_FORBIDDEN_RESPONSE,
        },
    )
    def post(self, request, *args, **kwargs):
        # The current-password check (#1257) lives in the configured
        # PASSWORD_CHANGE_SERIALIZER, accounts.serializers.VisibanPasswordChangeSerializer.
        # atomic() so the password save and finalize_password_change() commit
        # or roll back together.
        #
        # drf-spectacular's dj-rest-auth integration (RestAuthPasswordChangeView,
        # drf_spectacular/contrib/rest_auth.py) already fixes this exact response
        # to {"detail": ...} — but it matches `dj_rest_auth.views.PasswordChangeView`
        # by exact class identity (OpenApiGeneratorExtension.match_subclasses
        # defaults False), not by subclass, so it never applies to this view.
        # Without the override above, drf-spectacular falls back to introspecting
        # PASSWORD_CHANGE_SERIALIZER (VisibanPasswordChangeSerializer, the
        # *request* shape: new_password1/new_password2) for the response too.
        #
        # #1619: the user row is locked and re-read before the serializer
        # runs, and the serializer checks the current password against and
        # writes the new one to that row (see get_serializer_context), so a
        # password change or deactivation committed by another request since
        # this one started is neither checked past nor written back.
        with transaction.atomic():
            self._locked_user = credentials.lock_user_row(request.user)
            # Read before the serializer saves: a first password gets its own notice.
            first_password = not self._locked_user.has_usable_password()
            response = super().post(request, *args, **kwargs)
            if response.status_code == status.HTTP_200_OK:
                finalize_password_change(self._locked_user, first_password=first_password)
                response.data.update(_reissued_auth_token(request))
        return response

    def get_serializer_context(self):
        context = super().get_serializer_context()
        locked_user = getattr(self, "_locked_user", None)
        if locked_user is not None:
            context["locked_user"] = locked_user
        return context


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

    # Schema only (#1783): a plain APIView gave drf-spectacular nothing to
    # infer, so the schema showed a bodiless 200. The view reads no body and
    # answers 201 with the ticket.
    @extend_schema(
        request=None,
        responses={
            201: inline_serializer(
                name="WSTicket",
                fields={
                    "ticket": serializers.CharField(),
                    "expires_at": serializers.DateTimeField(),
                },
            ),
        },
    )
    def post(self, request):
        # The ticket is bound to the credential that asked for it, so a socket
        # opened with it closes once that credential is revoked (#1483). A
        # request authenticated by something we cannot later re-validate is
        # refused rather than handed an unrevocable ticket.
        credential = credential_for_request(request)
        if credential is None:
            return Response(
                {"detail": "This credential cannot be used to open a WebSocket."},
                status=status.HTTP_403_FORBIDDEN,
            )
        # The raw ticket is returned here and never again — it is not stored in
        # recoverable form, matching the PAT-creation contract above.
        ticket, expires_at = issue_ws_ticket(request.user, credential)
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

    An emailed, single-use group invite (``vbng_``, #1445) or board invite
    (``vbnb_``, #1444) from a site admin is also accepted in INVITE_ONLY mode:
    the account is created, joined to the group or board with the invite's
    role, and the invite is consumed, in one transaction. Shareable links are
    refused — see groups/invite_registration.py and boards/invites.py. Under
    ``EMAIL_VERIFICATION=mandatory`` with the invited address not yet verified,
    the invite is reserved for the new account instead, and the membership is
    granted when that address is confirmed (#1704).

    In OPEN mode: delegates to the parent RegisterView unchanged.
    In CLOSED mode: adapter.save_user raises PermissionDenied before this runs,
    for every token kind — CLOSED means no new accounts at all.

    Same OpenAPI-schema gap as #1408's other dj-rest-auth subclasses:
    drf-spectacular's RestAuthRegisterView fix matches
    `dj_rest_auth.registration.views.RegisterView` by exact class identity,
    not subclass, so it never applies to this subclass. Without the override
    below, the generated schema documents the 201 response using
    REGISTER_SERIALIZER's request-only fields (username/email/password1/
    password2) instead of the real body. Mirrors RestAuthRegisterView's own
    branching on RegisterView.get_response_data(): EMAIL_VERIFICATION ==
    MANDATORY returns {"detail": ...}; otherwise (Visiban pins
    REST_AUTH["USE_JWT"] = False with the default TOKEN_MODEL) the real
    runtime response is {"key": "<token>"} — confirmed against a live
    request, matching ThrottledLoginView's fix above.
    """

    # Declared at the class level to override the parent RegisterView (which
    # sets no throttle classes) — applies in both OPEN and INVITE_ONLY modes.
    throttle_classes = [RegisterAnonThrottle]

    @extend_schema(
        responses={
            201: (
                inline_serializer(
                    name="InviteRegisterResponse", fields={"detail": serializers.CharField()}
                )
                if EMAIL_VERIFICATION == EmailVerificationMethod.MANDATORY
                else DjRestAuthTokenSerializer
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        mode = get_registration_mode()
        if mode != SiteSetting.RegistrationMode.INVITE_ONLY:
            return super().create(request, *args, **kwargs)

        # A non-object body carries no token: it takes the same missing-token
        # refusal below, so the response reveals nothing about token validity.
        token_raw = (request.data.get("invite_token") if isinstance(request.data, dict) else None) or ""
        # A non-string JSON value (number, list, object) is no token at all —
        # refuse it as missing instead of letting .strip() raise a 500.
        token_raw = token_raw.strip() if isinstance(token_raw, str) else ""

        # Site (vbnl_), emailed group (vbng_, #1445) and emailed board (vbnb_,
        # #1444) invites: one prefix table decides how each is validated and
        # redeemed — see accounts/registration_tokens.py.
        from .registration_tokens import registration_token_kind

        kind = registration_token_kind(token_raw)
        try:
            # Row-locked: two registrations presenting one single-use token
            # serialize here, and the second sees it consumed.
            invite = kind.validate(token_raw)
        except InviteTokenError as exc:
            return Response({"invite_token": [exc.detail]}, status=status.HTTP_400_BAD_REQUEST)

        # The emailed-invite address check (#1678, #1703) runs in perform_create, after
        # the form has validated and before the account is created.
        self._invite = invite

        # Registration and redemption share this view's transaction, so a
        # failed registration (400) leaves the invite unconsumed and a refused
        # redemption rolls the new account back.
        self._registered_user = None
        # The signup confirmation mail goes out after this transaction commits,
        # not under the board/invite row locks taken above (#1639).
        from .adapter import account_mail_deferred_to_commit

        with account_mail_deferred_to_commit():
            response = super().create(request, *args, **kwargs)
        if self._registered_user is not None:
            try:
                kind.redeem(invite, self._registered_user)
            except InviteTokenError as exc:
                # invite_already_redeemed: this email already redeemed a
                # multi-use site link (#925). invite_invalid: a group/board
                # invite lost a redeem race (unreachable while the row lock
                # above is held). Either way the account must not survive.
                transaction.set_rollback(True)
                # complete_signup already logged the new account in, so the
                # session object holds a key/row written inside the transaction
                # being rolled back. Left "modified", SessionMiddleware would
                # try to UPDATE that vanished row, raise SessionInterrupted and
                # turn this 409 into an HTML 400 for a client with no session
                # (#1718). Marking it unmodified makes the middleware skip the
                # save and set no cookie: the client stays logged out, and a
                # client that already had a session keeps it, since the
                # rollback restores that row too. Assumes Django's default
                # DB-backed session engine (SESSION_ENGINE is not overridden):
                # with cache/cached_db the login writes survive the rollback,
                # though no cookie reaches the client and the key is unreachable.
                request.session.modified = False
                return Response({"invite_token": [exc.detail]}, status=status.HTTP_409_CONFLICT)
        return response

    def perform_create(self, serializer):
        # An emailed site, group or board invite is bound to the address it was sent to
        # (#1678, #1703). Checked here — after the serializer has validated the whole
        # form, so a form error reads the same whatever address was typed, and
        # before the account exists, so a mismatch is a plain 400 that creates
        # nothing and leaves the invite usable. The locked check at redemption
        # re-applies it to the created account. The error is an ``email`` field
        # error with a ``code``, not an ``invite_token`` one: the invite itself
        # is still valid and the client should keep it.
        invite = getattr(self, "_invite", None)
        if invite is not None:
            from rest_framework.exceptions import ValidationError as DRFValidationError

            from visiban.invite_recipient import MISMATCH_CODE, REGISTRATION_MISMATCH_DETAIL, signup_address_admits

            if not signup_address_admits(invite, serializer.validated_data.get("email")):
                raise DRFValidationError({"email": [REGISTRATION_MISMATCH_DETAIL], "code": MISMATCH_CODE})
        # An address already in use under mandatory verification (#1877): no
        # account is created and the response is the same 201 a new
        # registration gets, from dj-rest-auth's get_response_data (which does
        # not read the user in that mode). With no account, create() redeems
        # nothing, so an invite stays usable.
        if serializer.address_in_use:
            serializer.decline_in_use_address(self.request._request)
            self._registered_user = None
            return None
        # Keep the new account so the invite can be redeemed for it;
        # dj-rest-auth's create() does not hand the user back.
        user = super().perform_create(serializer)
        self._registered_user = user
        return user


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


class AdminPasswordChangeRedirectView(View):
    """Send the server-rendered "change my password" pages to the SPA (#1551, #1561).

    Mounted over ``/admin/password_change/`` and ``/admin/password_change/done/``
    ahead of the admin site, and over allauth's ``/accounts/password/change/``
    and ``/accounts/password/set/`` ahead of the allauth include (all in
    ``visiban/urls.py``), so a user changes or sets their own password on the
    SPA's Settings page, where every rule for a self-service change applies
    (current password, policy, token revocation, forced-change flag) and the
    forced-change flow runs. Every method redirects and nothing is read from
    the request, so a POST changes nothing; the target comes from settings
    only. Staff set other users' passwords through ``VisibanUserAdmin``.
    """

    def dispatch(self, request, *args, **kwargs):
        return HttpResponseRedirect(f"{settings.FRONTEND_URL.rstrip('/')}/settings")


@method_decorator(never_cache, name="dispatch")
class PasswordResetRedirectView(View):
    """Send allauth's server-rendered password-reset pages to the SPA (#1554).

    Mounted over ``/accounts/password/reset/``, ``.../reset/done/`` and
    ``.../reset/key/done/`` ahead of the allauth include (``visiban/urls.py``),
    so password reset has one implementation: the SPA's ``/forgot-password``
    and ``/reset-password/<uid>/<token>`` pages over the REST routes. Every
    method redirects, nothing is read from the request body or query string,
    and the destination is built only from ``FRONTEND_URL``. The routes keep
    allauth's URL names so ``reverse()`` and the pending-action middleware's
    exempt-view list (decided on the resolved view name) are unchanged.

    ``accounts.forms.VisibanResetPasswordKeyForm`` and the ``password_reset``
    signal receiver stay as defense in depth for a URLconf that mounts
    allauth's own views.
    """

    def dispatch(self, request, *args, **kwargs):
        return HttpResponseRedirect(f"{settings.FRONTEND_URL.rstrip('/')}/forgot-password")


@method_decorator(never_cache, name="dispatch")
class PasswordResetKeyRedirectView(PasswordResetRedirectView):
    """``/accounts/password/reset/key/<uidb36>-<key>/``: forward a well-formed link to the SPA.

    Reset emails sent earlier link here. The URL regex bounds ``uidb36`` and
    ``key``; they go to the SPA reset route unchanged, the same uid/token pair
    the REST confirm route redeems, so those links keep working. The response
    is never cached and sends ``Referrer-Policy: no-referrer`` so the key does
    not leak through a cache or the Referer header.
    """

    def dispatch(self, request, *args, **kwargs):
        response = HttpResponseRedirect(
            f"{settings.FRONTEND_URL.rstrip('/')}/reset-password/{kwargs['uidb36']}/{kwargs['key']}"
        )
        response["Referrer-Policy"] = "no-referrer"
        return response


@method_decorator(never_cache, name="dispatch")
class PasswordResetMalformedKeyRedirectView(PasswordResetRedirectView):
    """Any other ``/accounts/password/reset/key/...`` path (oversized or odd characters).

    Goes to ``/forgot-password`` and forwards no part of the path, so a
    malformed link never reaches allauth's stock page.
    """


class VisibanSignupView(AllauthSignupView):
    """allauth's HTML signup view, with the closed page replaced by a redirect (#1324).

    ``RegistrationAdapter.is_open_for_signup`` returns ``False`` in CLOSED and
    INVITE_ONLY modes, and allauth's ``CloseableSignupMixin.dispatch`` (GET and
    POST alike) then renders its stock, unstyled ``account/signup_closed.html``
    in-process: a dead-end in a SPA-only product. Same class as #1321/#1323,
    which the OAuth adapter fixes by raising from ``is_open_for_signup``.

    The redirect lives in the view instead of the adapter on purpose:
    ``is_open_for_signup`` on the account adapter is also a plain boolean query
    for allauth's headless endpoints and for the social adapter's default
    delegation, none of which catch ``ImmediateHttpResponse``. Raising there
    would turn a "no" into a 500 for them.

    Reuses the OAuth flow's codes so the SPA needs no change: ``signup_closed``
    for CLOSED, ``invite_required`` for INVITE_ONLY (an invite link is the only
    way in; REST invite signup goes through ``InviteRegisterView``).
    """

    def closed(self):
        from urllib.parse import urlencode

        from .models import SiteSetting, get_registration_mode

        # One read of the mode decides the code. INVITE_ONLY is the only mode
        # with its own message; any other reason for a closed result (CLOSED,
        # or a mode flipped between the adapter's read and this one) reports
        # signup_closed.
        mode = get_registration_mode()
        code = "invite_required" if mode == SiteSetting.RegistrationMode.INVITE_ONLY else "signup_closed"
        frontend_url = getattr(settings, "LOGIN_REDIRECT_URL", None) or "/"
        separator = "&" if "?" in frontend_url else "?"
        return HttpResponseRedirect(f"{frontend_url}{separator}{urlencode({'auth_error': code})}")


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

    Since #1314, case 1 is normally pre-empted upstream:
    ``SocialRegistrationAdapter.pre_social_login`` runs before
    ``process_auto_signup_email`` and redirects a collision with an active
    account to ``account_exists`` / ``account_exists_provider`` (and one with
    only deactivated accounts to ``oauth_failed``). This view stays as the
    defense-in-depth safety net for case 2, for any collision the adapter's
    lookup does not catch, and for direct or stale-session navigation to
    this URL — do not delete it as dead code.

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

    # A server-rendered browser redirect, not an API operation: keep it out of
    # the published OpenAPI schema so the baseline roll at GA doesn't freeze it
    # as a public contract (#1736). EmailConfirmRedirectView is deliberately NOT
    # excluded: it has been in the schema since the v1.1.0 baseline, and
    # dropping it would be a REMOVED_OPERATION compat break.
    @extend_schema(exclude=True)
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

    def post(self, request, *args, **kwargs):
        """Adding an address or making one primary needs a recent password check.

        Both actions decide where account mail goes: "Make Primary" writes
        ``User.email``, and an added address, even unverified, is one that
        password reset looks accounts up by. So they get the same rule as
        ``PATCH /api/v1/auth/me/`` (``accounts.credentials.
        email_change_requires_current_password``): an account with a usable
        password re-enters it first. allauth's reauthentication flow does the
        asking: ``ReauthenticationRequired`` is turned into a redirect to
        ``/accounts/reauthenticate/`` by ``AccountMiddleware`` and the action
        resumes once the password is confirmed. An account with no usable
        password has no reauthentication method (allauth would treat it as
        always recent), so it needs a recent provider sign-in to the account
        recorded in this session instead, the same rule as the API
        (``accounts.credentials.email_change_requires_recent_login``, #1932);
        without one the action is refused with an error message and nothing is
        added or changed.

        Not enabled through ``ACCOUNT_REAUTHENTICATION_REQUIRED``, which would
        also change other allauth flows; this gates only the two actions on
        this page. Connecting a sign-in provider has its own gate with the same
        rule, in ``accounts.adapter.SocialRegistrationAdapter.pre_social_login``
        (``_require_recent_authentication``).
        """
        if "action_add" in request.POST or "action_primary" in request.POST:
            if request.user.has_usable_password():
                from allauth.account.internal.flows.reauthentication import (
                    raise_if_reauthentication_required,
                )

                raise_if_reauthentication_required(request)
            elif not credentials.session_recently_signed_in_by_provider(request, request.user):
                get_adapter(request).add_message(
                    request,
                    messages.ERROR,
                    message=credentials.EMAIL_CHANGE_RECENT_LOGIN_REQUIRED_MESSAGE,
                )
                return HttpResponseRedirect(self.get_success_url())
        return super().post(request, *args, **kwargs)

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
