import logging

from allauth.account.adapter import DefaultAccountAdapter
from allauth.core.exceptions import ImmediateHttpResponse
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
from django.db import transaction
from django.conf import settings as django_settings
from django.http import HttpResponseRedirect
from rest_framework.exceptions import PermissionDenied

from visiban.authorization import principal_is_active

from .invite_utils import InviteTokenError
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


def account_lockout_cache_seed(site_domain: str, user) -> str:
    """The per-account ``login_failed`` key seed for ``user`` (#1206).

    Keyed on the primary key, not the username, so a renamed account keeps its
    bucket and two usernames differing only in case never share one. The
    ``#`` separator can never be produced by allauth's own submitted-string
    seed (``f"{domain}:{identifier}"``) — the domain is the same prefix and the
    next character differs — so no typed identifier, however crafted, can land
    in (and pre-exhaust or collide with) an account's bucket by string
    coincidence. allauth hashes the seed before it reaches the cache, so the
    pk is never stored in the clear either.
    """
    return f"{site_domain}#account:{user.pk}"


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

    Why the account key AND the username and email keys are cleared
    ------------------------------------------------------------------
    Since #1206, an attempt naming an existing account (by username or by a
    unique email) consumes one account-scoped bucket
    (``account_lockout_cache_seed``), so that is the key that normally holds
    the lockout. The string keys below are still cleared for the cases that
    fall back to allauth's default keying, and for buckets written before
    #1206. The history of why the string keys were needed:

    Even allauth's own recovery path above only clears the email-keyed
    bucket. That is incomplete here: ``ACCOUNT_LOGIN_METHODS = {"username",
    "email"}`` (visiban/settings.py) means that — under allauth's default
    keying — a login attempt, and therefore the lockout it can trip — is
    keyed on whichever identifier was actually submitted (see ``DefaultAccountAdapter._get_login_attempts_cache_key``:
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
    # The account-scoped key is the one every login attempt that names this
    # user now consumes (#1206 — see RegistrationAdapter.
    # _get_login_attempts_cache_key). The username/email string keys are still
    # cleared too: an email shared by several accounts resolves to none of
    # them and keeps allauth's submitted-string key, and buckets written before
    # the upgrade used the string keys.
    seeds = {account_lockout_cache_seed(site_domain, user)}
    seeds |= {f"{site_domain}:{value.lower()}" for value in (user.username, user.email) if value}
    for cache_key_seed in seeds:
        for rate in key_rates:
            cache.delete(get_cache_key(request, action="login_failed", rate=rate, key=cache_key_seed))

# Session key used to pass an invite token through the OAuth redirect flow.
# The frontend appends ?invite_token=vbnl_xxx (or an emailed group invite's
# vbng_xxx, #1445, or board invite's vbnb_xxx, #1444) to the OAuth login URL; middleware
# stashes it here before redirecting to the IdP. The SocialRegistrationAdapter
# reads it on the callback to decide whether signup is permitted.
PENDING_INVITE_SESSION_KEY = "pending_invite_token"


# InviteTokenError.code -> the ``auth_error`` the SPA understands.
_INVITE_ERROR_CODES = {
    "invite_missing": "invite_required",
    "invite_invalid": "invite_invalid",
    "invite_expired": "invite_expired",
    "invite_not_for_registration": "invite_not_for_registration",
}


def _validate_signup_token(raw_token: str):
    """Validate a pending OAuth invite token of any kind (#1445, #1444).

    Site invites (``vbnl_``) and emailed single-use group (``vbng_``) and board
    (``vbnb_``) invites all authorize signup in INVITE_ONLY mode; the prefix
    table in ``accounts.registration_tokens`` picks the validator. Must run
    inside ``transaction.atomic()`` — every validator locks the row.
    """
    from .registration_tokens import registration_token_kind

    return registration_token_kind(raw_token).validate(raw_token)


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

    def set_password(self, user, password) -> None:
        """Set and save the password, then run the shared finalize step.

        allauth's change, set and reset-from-key flows all store the password
        through this hook. The save and ``finalize_password_change`` share one
        transaction, so a failure in the finalize step rolls the new password
        back. Plain ``User.set_password`` is deliberately not wrapped (it also
        runs for login-timing equalization and hasher upgrades, which must not
        touch stored tokens or flags); only callers of this hook finalize.
        """
        from .credentials import finalize_password_change

        with transaction.atomic():
            super().set_password(user, password)
            finalize_password_change(user)

    def clean_username(self, username, shallow=False):
        """allauth's checks, plus: not another active account's email (#1221).

        The login resolver lets an exact username win over an email match, so
        a username equal to someone else's email address would intercept that
        person's email login. This is the one hook every allauth-driven signup
        goes through: dj-rest-auth's ``RegisterSerializer.validate_username``
        (REST signup, including invite signup), allauth's own signup form, and
        social signup.

        Social/SSO signup is deliberately *auto-adjusted*, not rejected:
        allauth's auto-signup calls this with the IdP-supplied username and,
        on a ``ValidationError``, blanks it and generates a fresh one (which
        never contains ``@``, so it can't collide with an email). The IdP user
        still gets an account and can still log in through the IdP; only the
        colliding name is refused — the same thing that already happens to an
        IdP username that is simply taken.

        Raised as allauth's own ``username_taken`` so the answer is identical
        to an ordinary clash and names no account. ``shallow`` calls (allauth's
        username generation, which must not hit the database per candidate)
        are left alone, as allauth leaves its own uniqueness check.
        """
        from .validators import username_collides_with_email

        username = super().clean_username(username, shallow=shallow)
        if not shallow and username_collides_with_email(username):
            raise self.validation_error("username_taken")
        return username

    # NOTE (#1312): the email-side collision check is deliberately NOT a
    # clean_email() override here, unlike clean_username() above.
    # RegistrationAdapter is the global ACCOUNT_ADAPTER (visiban/settings.py),
    # and get_adapter().clean_email() is called from every allauth flow that
    # collects a bare email address, not just signup: dj-rest-auth's
    # AllAuthPasswordResetForm.clean_email (POST /api/v1/auth/password/reset/)
    # and allauth's own AddEmailForm.clean_email (/accounts/email/) both go
    # through it too. For password reset, "an active account already holds
    # this email" is the expected, correct case, not a collision — rejecting
    # it there broke every password-reset request for a real user's own
    # address (caught by completeness-check before merge). The signup-only
    # check instead lives on accounts.forms.VisibanSignupForm.clean_email
    # (HTML signup, wired via ACCOUNT_FORMS) and
    # RegistrationSerializer.validate_email (REST signup) — see those for the
    # AddEmailForm carve-out rationale.

    def _get_login_attempts_cache_key(self, request, **credentials):
        """Key the per-account lockout on the ACCOUNT, not the typed identifier (#1206).

        allauth's default keys the ``login_failed`` "/key" bucket on the
        submitted string (``email`` if given, else ``username``, lowercased).
        Once email login works that gives one account two independent
        lockouts — 5 wrong passwords by username plus 5 by email — and a
        lockout tripped through one identifier would not stop attempts through
        the other. Resolving the identifier with the same rules the login
        backend uses (``accounts.backends.resolve_login_user``) collapses both
        onto one per-account key, whether or not the password is right.

        Identifiers that resolve to no account (unknown strings, and emails
        shared by several accounts — which cannot log in by email anyway) keep
        allauth's own submitted-string key, so an attacker still cannot bypass
        the rate limit by spraying unknown identifiers.

        This is an override of a private allauth method; it is the single
        place allauth computes this key (``pre_authenticate`` and allauth's own
        password-reset clear both call it), verified against 65.14.3.
        """
        from django.contrib.sites.shortcuts import get_current_site

        from .backends import resolve_login_user

        identifier = credentials.get("email", credentials.get("username", ""))
        user = resolve_login_user(identifier, request)
        if user is not None:
            return account_lockout_cache_seed(get_current_site(request).domain, user)
        return super()._get_login_attempts_cache_key(request, **credentials)

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
            # Redirect to the frontend instead of returning False directly:
            # returning False makes allauth raise SignupClosedException,
            # which renders allauth's own stock "account/signup_closed"
            # template in-process rather than redirecting to the frontend —
            # a UX dead-end (not a duplicate-account risk, since that
            # template has no form) of the same class as #1321's
            # socialaccount_signup case. Fixed for #1323, using the same
            # pattern as the INVITE_ONLY failure branch below.
            self._redirect_with_error(request, "signup_closed")
            return False  # pragma: no cover — _redirect_with_error raises

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
                _validate_signup_token(raw_token)
        except InviteTokenError as exc:
            # Token is invalid/expired — clean up the session and redirect
            # with a specific error code.
            request.session.pop(PENDING_INVITE_SESSION_KEY, None)
            self._redirect_with_error(request, _INVITE_ERROR_CODES.get(exc.code, "invite_invalid"))
            return False  # pragma: no cover — _redirect_with_error raises

        return True

    def pre_social_login(self, request, sociallogin):
        """Route an OAuth callback before allauth decides login vs. signup (#1314).

        This hook — not the signup path — is where the email-collision case is
        handled: allauth calls it for every callback, *before*
        ``is_open_for_signup``. So "you already have an account" wins over
        ``invite_expired`` / ``invite_required`` / signup-closed for free: a
        person who already has an account is never told they need an invite
        to create one.

        Two processes are handled; allauth's ``redirect`` process is left alone:

        - ``connect`` (an authenticated user adding a provider from Settings or
          the post-login prompt): refuse an identity that already belongs to a
          different account with ``provider_already_connected``. allauth itself
          would only add an invisible Django message and redirect.
        - ``login`` for an identity no account has yet, whose IdP email already
          belongs to one: see ``_handle_email_collision``.
        """
        from allauth.socialaccount.providers.base import AuthProcess

        from .social_connect import get_pending_connect_data, clear_pending_connect

        process = sociallogin.state.get("process")
        provider = sociallogin.account.provider

        if process == AuthProcess.CONNECT:
            if not request.user.is_authenticated:
                # allauth would bounce this to the connect redirect, which
                # would then claim "Connected." once someone signs in.
                self._redirect_with_error(request, "oauth_failed")
            pending = get_pending_connect_data(request, request.user)
            if pending and pending.get("provider") == provider:
                # The prompt is answered either way this attempt ends.
                clear_pending_connect(request)
                # While the prompt is pending, the only account of this
                # provider that may be connected is the one that tried to sign
                # in: on a shared browser, whatever provider session is live
                # when "Connect" is clicked may be someone else's (#1314).
                stashed_uid = pending.get("uid")
                if stashed_uid and str(sociallogin.account.uid) != str(stashed_uid):
                    raise ImmediateHttpResponse(HttpResponseRedirect(
                        self._settings_url(connect_error="connect_identity_mismatch", provider=provider)
                    ))
            if sociallogin.is_existing and sociallogin.user.pk != request.user.pk:
                raise ImmediateHttpResponse(HttpResponseRedirect(
                    self._settings_url(connect_error="provider_already_connected", provider=provider)
                ))
            return

        if process == AuthProcess.REDIRECT or sociallogin.is_existing:
            return

        self._handle_email_collision(request, sociallogin)

    def _handle_email_collision(self, request, sociallogin):
        """Send a new OAuth identity whose email is already taken back to login.

        Without this, allauth routes the collision to its HTML signup form,
        which #1321 could only turn into a generic ``oauth_failed``. The
        outcomes, in the order they are decided:

        - No account matches, or the IdP sent no email: return, and let allauth
          carry on (signup, or #1321's no-email fallback).
        - Every match is deactivated: generic ``oauth_failed``. Naming the
          state of an account nobody can use would reveal it, and offering to
          connect to it would be pointless.
        - The IdP *verified* the email, it belongs to exactly one active
          account, and that account has no password but another provider:
          ``account_exists_provider`` with ``via``. Only on a verified email —
          naming the provider an arbitrary typed-in address "signs in with"
          would disclose it to anyone who controls a lax IdP.
        - Anything else: ``account_exists``.

        Either ``account_exists*`` outcome stashes the attempted provider so
        the SPA can offer to connect it once the user has proven they own the
        account (``social_connect.stash_pending_connect``). The pending invite
        token (``PENDING_INVITE_SESSION_KEY``) is deliberately left in the
        session, and the SPA keeps its own invite/join state, so an
        in-flight invite survives the detour through the login page.
        """
        from .social_connect import find_accounts_for_email, stash_pending_connect

        # Pick the address the IdP calls primary, else the first verified one,
        # else the first listed. GitHub returns every address on the account
        # in API order (allauth does not sort them), so blindly taking [0]
        # could run the collision check — and the "verified" gate for
        # account_exists_provider — against a secondary, unverified address.
        addresses = list(sociallogin.email_addresses or [])
        first = (
            next((a for a in addresses if getattr(a, "primary", False)), None)
            or next((a for a in addresses if getattr(a, "verified", False)), None)
            or (addresses[0] if addresses else None)
        )
        email = getattr(first, "email", "") or ""
        if not email:
            return
        matches = list(find_accounts_for_email(email))
        if not matches:
            return
        # Shared inactive-account rule (#1517): a disabled account is never a
        # match, the same predicate every other entry point applies.
        active = [user for user in matches if principal_is_active(user)]
        if not active:
            self._redirect_with_error(request, "oauth_failed")

        provider = sociallogin.account.provider
        idp_verified = bool(getattr(first, "verified", False))
        # Stashed whether or not the IdP verified the email: the offer is only
        # ever shown after the user has signed in to the matched account, so
        # it discloses nothing, and some providers (allauth's GitLab provider)
        # never mark emails verified at all. What guards the offer is the
        # identity shown in it, the binding of the connect to this exact
        # provider account (uid), and dropping the stash on any other user's
        # sign-in — none of which depend on IdP verification. Verification
        # only gates naming the ``via`` provider before sign-in, below.
        stash_pending_connect(
            request, provider, [user.pk for user in active],
            identity=self._provider_identity(sociallogin, email),
            uid=str(sociallogin.account.uid or ""),
        )

        if idp_verified and len(active) == 1 and not active[0].has_usable_password():
            via = (
                active[0].socialaccount_set.exclude(provider=provider)
                .order_by("date_joined", "pk")
                .values_list("provider", flat=True)
                .first()
            )
            if via:
                self._redirect_with_error(request, "account_exists_provider", provider=provider, via=via)
        self._redirect_with_error(request, "account_exists", provider=provider)

    @staticmethod
    def _provider_identity(sociallogin, email: str) -> str:
        """How the provider names the account that tried, for the prompt.

        The provider-side username (GitHub/GitLab login) when it has one —
        the email alone is no help, because a collision means it is the
        victim's own address — else the email.
        """
        data = sociallogin.account.extra_data if isinstance(sociallogin.account.extra_data, dict) else {}
        for key in ("login", "username", "preferred_username"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:150]
        return email[:254]

    @staticmethod
    def _redirect_with_error(request, error_code, **params):
        """Redirect to the frontend with an auth_error query parameter.

        Raises ImmediateHttpResponse so allauth aborts the current flow
        and returns the redirect directly, bypassing the signup_closed template.
        Extra ``params`` (``provider``, ``via``) are appended URL-encoded.
        """
        from urllib.parse import urlencode

        frontend_url = getattr(django_settings, "LOGIN_REDIRECT_URL", "/")
        separator = "&" if "?" in frontend_url else "?"
        query = urlencode({"auth_error": error_code, **params})
        redirect_url = f"{frontend_url}{separator}{query}"
        raise ImmediateHttpResponse(HttpResponseRedirect(redirect_url))

    @staticmethod
    def _settings_url(**params) -> str:
        """The SPA Settings page, where a connect round trip reports back."""
        from urllib.parse import urlencode

        frontend_url = (getattr(django_settings, "LOGIN_REDIRECT_URL", None) or "/").rstrip("/")
        return f"{frontend_url}/settings?{urlencode(params)}"

    def save_user(self, request, sociallogin, form=None):
        """Create the OAuth account and redeem its invite in ONE transaction (#1489).

        Design choice: redemption is made atomic with user creation rather than
        consuming the token at gate time. ``is_open_for_signup`` runs before
        allauth may still abort the flow (provider error, email collision,
        signup form), so consuming there could burn a single-use invite with no
        account to show for it. Here, the user insert and the invite's
        validate-under-``select_for_update`` + redeem commit or roll back
        together: of two concurrent signups on one single-use token, the second
        blocks on the row lock, then sees the token spent, and its user row is
        rolled back, so a losing signup never leaves an account behind. This
        mirrors the REST registration path (``InviteRegisterView``).

        The failure is raised as ``ImmediateHttpResponse`` (redirect to the SPA
        with ``auth_error``) outside the atomic block, so the user sees a
        normal signup-refused page instead of a 500.
        """
        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            # An admin may have closed signups between the gate and here;
            # refuse with the code the gate uses. The pending token stays put.
            self._redirect_with_error(request, "signup_closed")
        if mode != SiteSetting.RegistrationMode.INVITE_ONLY:
            return super().save_user(request, sociallogin, form)

        # Popped even on failure: a refused token must not be retried.
        raw_token = request.session.pop(PENDING_INVITE_SESSION_KEY, "")
        error_code = None
        try:
            with transaction.atomic():
                user = super().save_user(request, sociallogin, form)
                if not raw_token:
                    # The gate requires a token, so reaching here without one
                    # means the session was lost mid-flow; fail closed.
                    raise InviteTokenError("invite_missing", "An invite link is required to register.")
                self._redeem_invite(raw_token, user)
        except InviteTokenError as exc:
            logger.warning(
                "OAuth signup refused at invite redemption (code=%s); account rolled back.",
                exc.code,
            )
            error_code = _INVITE_ERROR_CODES.get(exc.code, "invite_invalid")
        if error_code:
            self._redirect_with_error(request, error_code)
        return user

    @staticmethod
    def _redeem_invite(raw_token, user):
        """Validate (row-locked) and redeem the invite for the new OAuth account.

        Must run inside the ``transaction.atomic()`` that created ``user`` so the
        lock is held until the account commits and a refusal rolls it back.
        Raises ``InviteTokenError`` when the token was lost to a concurrent
        redemption, expired/revoked since the gate, or (multi-use site links)
        already redeemed with this email (#925).
        """
        from .registration_tokens import registration_token_kind

        kind = registration_token_kind(raw_token)
        invite = kind.validate(raw_token)
        kind.redeem(invite, user)

    def get_connect_redirect_url(self, request, socialaccount):
        """Redirect to the SPA's Settings page after connecting a social account.

        ``?connected=<provider>`` is how the Security tab learns the round trip
        succeeded (#1314); a refused connect never gets here — see
        ``pre_social_login``.
        """
        return self._settings_url(connected=socialaccount.provider)
