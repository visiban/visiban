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
    "clear_login_lockout",
    "invalidate_registration_mode_cache",
]


def clear_login_lockout(request, user) -> None:
    """Clear the per-account (``/key``-scoped) half of allauth's ``login_failed``
    rate limit for ``user`` — never the per-IP (``/ip``-scoped) half.

    Shared by two callers: the password-reset-confirm flow (#1203) and the
    site-admin "clear lockout" action, so both get identical, correct behavior
    instead of two slightly different reimplementations.

    Why this exists instead of allauth's own recovery path
    --------------------------------------------------------
    allauth ships exactly one way to clear this bucket early:
    ``allauth.account.internal.flows.password_reset.finalize_password_reset``,
    which iterates the user's ``EmailAddress`` rows and clears the bucket keyed
    on each one. Visiban's password-reset-confirm endpoint never runs it — it
    goes through dj-rest-auth's ``PasswordResetConfirmSerializer``, a thin
    wrapper around Django's plain ``SetPasswordForm``, which knows nothing
    about allauth's rate limiter at all (verified against the running code,
    #1199's review; this was the gap #1203 tracks).

    Why BOTH the username and the email key are cleared
    -----------------------------------------------------
    Even allauth's own recovery path above only clears the email-keyed
    bucket. That is incomplete here: ``ACCOUNT_LOGIN_METHODS = {"username",
    "email"}`` (visiban/settings.py) means a login attempt — and therefore the
    lockout it can trip — is keyed on whichever identifier was actually
    submitted (see ``DefaultAccountAdapter._get_login_attempts_cache_key``:
    email takes precedence over username only when both are present in the
    same call, otherwise whichever one was given). There is no record here of
    which identifier a locked-out attacker (or the legitimate user) used, so
    both keys are cleared unconditionally. Clearing a bucket that was never
    populated — e.g. this user has never been locked out under their email —
    is a no-op: deleting a cache key that doesn't exist is safe and costs
    nothing.

    Why this does NOT use allauth's public ``ratelimit.clear()``
    ----------------------------------------------------------------
    ``ACCOUNT_RATE_LIMITS["login_failed"]`` configures TWO rates —
    ``"10/m/ip,5/300s/key"`` (visiban/settings.py) — and allauth's
    ``ratelimit.clear(request, action=..., key=...)`` clears the cache bucket
    for *every* configured rate of that action in one call (confirmed against
    ``allauth.core.internal.ratelimit.clear`` in 65.14.3), computing the
    per-IP rate's cache key from ``request``'s OWN client IP regardless of the
    ``key`` argument passed in. Calling it here would therefore also delete
    the per-IP bucket for whoever is making *this* request — the resetting
    user's IP on a password reset, or the admin's IP on the admin unlock
    endpoint — as an undocumented side effect on every call, silently
    weakening the "10/m/ip" credential-stuffing protection that rate exists
    for. That's a real, separate control (see AllauthHtmlLoginPerIpThrottleTests
    in accounts/tests/test_password_reset.py) and clearing it here is never
    correct, so only the key-scoped rate(s) are targeted explicitly below —
    using allauth's own (non-underscored, but internal-module) cache-key
    builder to stay byte-identical with what ``pre_authenticate()`` wrote,
    rather than reimplementing the sha256 hashing ourselves.
    """
    # Deferred: this module is wired in as ACCOUNT_ADAPTER, which Django can
    # resolve while apps are still loading — importing django.contrib.sites
    # (get_current_site queries the Site model) at module level risks
    # AppRegistryNotReady at startup. The allauth imports are deferred
    # alongside it purely for locality: they are only ever used here.
    from allauth.account.app_settings import RATE_LIMITS as ACCOUNT_RATE_LIMITS_RUNTIME
    from allauth.core.internal.ratelimit import get_cache_key, parse_rates
    from django.contrib.sites.shortcuts import get_current_site
    from django.core.cache import cache

    key_rates = [
        rate for rate in parse_rates(ACCOUNT_RATE_LIMITS_RUNTIME.get("login_failed"))
        if rate.per == "key"
    ]
    if not key_rates:
        return

    site_domain = get_current_site(request).domain
    identifiers = {value.lower() for value in (user.username, user.email) if value}
    for identifier in identifiers:
        cache_key_seed = f"{site_domain}:{identifier}"
        for rate in key_rates:
            cache.delete(get_cache_key(request, action="login_failed", rate=rate, key=cache_key_seed))

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

    def get_client_ip(self, request) -> str:
        """Key allauth's per-IP rate limits on the same address DRF throttles on (#1180).

        allauth resolves the client itself (``ALLAUTH_TRUSTED_PROXY_COUNT``,
        default 0), which behind the bundled nginx means REMOTE_ADDR — the nginx
        pod — so every allauth ``ip`` rate-limit bucket (``login_failed``,
        signup, password reset, ...) was one bucket shared by every client.
        Delegating to ``visiban.utils.get_client_ip`` makes allauth honor the
        same ``NUM_PROXIES`` as the DRF throttles, so the two controls always
        agree on who the client is. The fallback address is never empty, so
        the base class's "unable to determine client IP" refusal cannot fire.
        """
        from visiban.utils import get_client_ip

        return get_client_ip(request)

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
                    # Pass the OAuth-provided email so multi-use invite redemption
                    # is rejected when the same address attempts to redeem the
                    # link twice (#925).
                    consume_invite_token(link, email=user.email)
                except InviteTokenError as exc:
                    # Two cases reach this branch:
                    #
                    # 1. Token race — the token became invalid between
                    #    is_open_for_signup and save_user.  The user already
                    #    passed the gate check, so we accept the signup and log
                    #    the anomaly (existing behaviour pre-#925).
                    # 2. Repeat-redemption (#925) — the unique constraint on
                    #    InviteLinkRedemption rejected a second redemption from
                    #    the same email.  The OAuth flow is not wrapped in a
                    #    rollback boundary the adapter controls, so the user is
                    #    already saved.  We log and continue; the link's
                    #    use_count is not incremented and no redemption row is
                    #    written, so the dedup remains correct for future
                    #    attempts.  This is best-effort enforcement on OAuth;
                    #    REST registration provides strict enforcement.
                    logger.warning(
                        "Invite token not consumed in save_user (code=%s, user=%s). "
                        "The user was created but the token was not marked used.",
                        exc.code,
                        user.pk,
                    )

        return user

    def get_connect_redirect_url(self, request, socialaccount):
        """Redirect to the frontend after connecting a social account."""
        from django.conf import settings
        return getattr(settings, "LOGIN_REDIRECT_URL", "/")
