import logging

from allauth.account.adapter import DefaultAccountAdapter
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from django.db import transaction
from django.conf import settings as django_settings
from django.http import HttpResponseRedirect
from rest_framework.exceptions import PermissionDenied

from .invite_utils import InviteTokenError, consume_invite_token, validate_invite_token
from .models import (
    SiteSetting,
    get_registration_mode,
    invalidate_registration_mode_cache,  # re-exported so tests can import it from here
)

logger = logging.getLogger(__name__)

__all__ = [
    "RegistrationAdapter",
    "SocialRegistrationAdapter",
    "invalidate_registration_mode_cache",
]

# Session key used to pass an invite token through the OAuth redirect flow.
# The frontend appends ?invite_token=vbnl_xxx to the OAuth login URL; middleware
# stashes it here before redirecting to the IdP. The SocialRegistrationAdapter
# reads it on the callback to decide whether signup is permitted.
PENDING_INVITE_SESSION_KEY = "pending_invite_token"


class RegistrationAdapter(DefaultAccountAdapter):
    """Allauth account adapter that honours the site-wide registration_mode setting."""

    def is_open_for_signup(self, request):
        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            return False
        if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
            # REST registration is handled by InviteRegisterView which validates
            # the token itself; the account adapter blocks all other signup paths
            # (e.g. allauth's built-in signup form). OAuth signup is handled by
            # the SocialRegistrationAdapter below.
            return False
        return super().is_open_for_signup(request)

    def save_user(self, request, user, form, commit=True):
        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            raise PermissionDenied("Registration is closed.")
        return super().save_user(request, user, form, commit)

    def get_email_confirmation_url(self, request, emailconfirmation):
        """Build the email-confirmation link pointing at the frontend SPA.

        Allauth's default implementation reverses account_confirm_email (a
        Django HTML view that requires a template). Visiban has no server-side
        templates — the SPA handles confirmation via POST /verify-email/. We
        redirect the browser to a frontend route that performs that API call.
        """
        frontend_url = (getattr(django_settings, "LOGIN_REDIRECT_URL", None) or "http://localhost:5173").rstrip("/")
        return f"{frontend_url}/confirm-email/{emailconfirmation.key}"


class SocialRegistrationAdapter(DefaultSocialAccountAdapter):
    """Allauth social adapter that allows OAuth signup with a valid invite token.

    Registration mode and authentication method are orthogonal:
    - OPEN: anyone can sign up via OAuth (no token required)
    - INVITE_ONLY: OAuth signup permitted only when a valid invite token is
      present in the Django session (stashed before the IdP redirect)
    - CLOSED: no new signups via OAuth; existing users can still log in
      (allauth only calls is_open_for_signup for new social accounts)
    """

    def is_open_for_signup(self, request, sociallogin):
        mode = get_registration_mode()

        if mode == SiteSetting.RegistrationMode.OPEN:
            return True

        if mode == SiteSetting.RegistrationMode.CLOSED:
            return False

        # INVITE_ONLY — check for a pending invite token in the session.
        raw_token = request.session.get(PENDING_INVITE_SESSION_KEY, "")
        if not raw_token:
            # No token — redirect to frontend with an error instead of rendering
            # allauth's signup_closed template (which is meaningless for an SPA).
            self._redirect_with_error(request, "invite_required")
            return False  # pragma: no cover — _redirect_with_error raises

        # Validate the token inside a transaction so select_for_update works.
        try:
            with transaction.atomic():
                validate_invite_token(raw_token)
        except InviteTokenError as exc:
            # Token is invalid/expired — clean up the session and redirect
            # with a specific error code.
            request.session.pop(PENDING_INVITE_SESSION_KEY, None)
            error_code = {
                "invite_missing": "invite_required",
                "invite_invalid": "invite_invalid",
                "invite_expired": "invite_expired",
            }.get(exc.code, "invite_invalid")
            self._redirect_with_error(request, error_code)
            return False  # pragma: no cover — _redirect_with_error raises

        return True

    @staticmethod
    def _redirect_with_error(request, error_code):
        """Redirect to the frontend with an auth_error query parameter.

        Raises ImmediateHttpResponse so allauth aborts the current flow
        and returns the redirect directly, bypassing the signup_closed template.
        """
        frontend_url = getattr(django_settings, "LOGIN_REDIRECT_URL", "/")
        separator = "&" if "?" in frontend_url else "?"
        redirect_url = f"{frontend_url}{separator}auth_error={error_code}"
        raise ImmediateHttpResponse(HttpResponseRedirect(redirect_url))

    def save_user(self, request, sociallogin, form=None):
        """After user creation, consume the invite token if in INVITE_ONLY mode."""
        user = super().save_user(request, sociallogin, form)

        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
            raw_token = request.session.pop(PENDING_INVITE_SESSION_KEY, "")
            if raw_token:
                try:
                    link = validate_invite_token(raw_token)
                    consume_invite_token(link)
                except InviteTokenError:
                    # Token was valid in is_open_for_signup but became invalid
                    # between then and now (race condition with another consumer).
                    # The user was already created — log the anomaly but don't
                    # roll back, as the user passed the gate check.
                    logger.warning(
                        "Invite token consumed between signup check and save_user "
                        "(possible race condition). User %s was created without "
                        "consuming a token.",
                        user.pk,
                    )

        return user

    def get_connect_redirect_url(self, request, socialaccount):
        """Redirect to the frontend after connecting a social account."""
        from django.conf import settings
        return getattr(settings, "LOGIN_REDIRECT_URL", "/")
