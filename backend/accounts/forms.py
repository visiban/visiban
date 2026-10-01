from django import forms
from django.conf import settings

from allauth.account.adapter import get_adapter
from allauth.account.forms import ResetPasswordForm, ResetPasswordKeyForm, SignupForm
from allauth.account.utils import user_pk_to_url_str
from dj_rest_auth.forms import AllAuthPasswordResetForm


# Provider labels used in the OAuth-only password-reset email.
_PROVIDER_LABELS: dict[str, str] = {
    "google": "Google",
    "github": "GitHub",
    "gitlab": "GitLab",
}


def _frontend_url_generator(request, user, temp_key: str) -> str:
    """Build the password-reset URL pointing at the frontend SPA.

    Replaces dj-rest-auth's default_url_generator which calls
    reverse('password_reset_confirm') — a Django built-in URL name that
    Visiban does not register. We generate the URL directly from FRONTEND_URL
    so the reset link lands on our ResetPasswordPage route.
    """
    uid = user_pk_to_url_str(user)
    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:5173").rstrip("/")
    return f"{frontend_url}/reset-password/{uid}/{temp_key}"


class VisibanSignupForm(SignupForm):
    """allauth's HTML signup form (``/accounts/signup/``), plus: no email
    another account already answers to (#1221, #1312).

    Wired via ``ACCOUNT_FORMS = {"signup": ...}`` (visiban/settings.py) rather
    than a ``RegistrationAdapter.clean_email`` override: ``ACCOUNT_ADAPTER``
    is global, and its ``clean_email`` hook is also called by
    ``AllAuthPasswordResetForm.clean_email`` (``POST
    /api/v1/auth/password/reset/``) and allauth's own
    ``AddEmailForm.clean_email`` (``/accounts/email/``). During a password
    reset, "an active account already holds this email" is the expected,
    correct case — the whole point of the request — so putting this check on
    the shared adapter hook rejected every password-reset request for a real
    user's own address (caught as a production regression before merge, see
    the NOTE on ``RegistrationAdapter`` in ``accounts/adapter.py``). A
    form-level override reaches only this one entry point.

    ``AddEmailForm`` (adding a *secondary* address to an already-authenticated
    account) is deliberately left unchecked too, on its own merits: it never
    writes ``User.email`` — the field ``resolve_login_user`` actually reads —
    so it cannot by itself create the state #1221 guards against. The write
    path that promotes a secondary address to primary already runs this check
    at the point it would reach ``User.email`` (see
    ``accounts.email_change.confirmation_would_collide``, and its own
    docstring: "confirming any other address (a signup address, or one added
    on allauth's own pages) keeps allauth's default behavior untouched").

    The REST signup path (dj-rest-auth's ``RegisterSerializer``, which never
    touches this form) gets the equivalent check on
    ``RegistrationSerializer.validate_email`` (accounts/serializers.py).
    """

    def clean_email(self):
        from .validators import email_collides_with_identifier

        email = super().clean_email()
        if email and email_collides_with_identifier(email):
            raise get_adapter().validation_error("email_taken")
        return email


def _has_verified_email(user, email: str) -> bool:
    """Whether ``user`` has proven they own ``email`` (a verified allauth row)."""
    from allauth.account.models import EmailAddress

    return EmailAddress.objects.filter(user=user, email__iexact=email, verified=True).exists()


def password_reset_still_allowed(user) -> bool:
    """Whether a reset link may set ``user``'s password *now* (#1314).

    A password-less account only ever gets a real reset link because it had a
    verified address (``VisibanPasswordResetForm``). Links stay valid for days,
    so that must still hold when the link is used — otherwise setting a
    password would hand the account to whoever holds a mailbox the account no
    longer vouches for. Accounts with a password are unaffected (resetting it
    moves no trust boundary).

    The one rule for every place a reset token is redeemed: the REST confirm
    endpoint (``VisibanPasswordResetConfirmSerializer``) and allauth's own HTML
    page (``VisibanResetPasswordKeyForm``) — both accept the same uid/token.

    The stricter rule — the link's *own* address must still be verified, not
    just some address — is enforced by the token itself (#1337, see
    ``accounts.tokens.VisibanPasswordResetTokenGenerator``), which both entry
    points check before reaching this. This remains as a direct, generator-
    independent statement of the #1314 minimum.
    """
    from allauth.account.models import EmailAddress

    if user is None or user.has_usable_password():
        return True
    return EmailAddress.objects.filter(user=user, verified=True).exists()


class VisibanResetPasswordKeyForm(ResetPasswordKeyForm):
    """allauth's HTML set-new-password form, with the #1314 use-time re-check."""

    def clean(self):
        cleaned = super().clean()
        if not password_reset_still_allowed(self.user):
            raise forms.ValidationError(
                "This password reset link is no longer valid. Request a new one."
            )
        return cleaned


class _ResetLinkGateMixin:
    """Who may receive a real reset link — one rule for every reset-request form.

    Shared by the REST form (``VisibanPasswordResetForm``) and allauth's own
    HTML reset-request page (``VisibanResetPasswordForm``) so the two can never
    apply different rules:

    - An account with a usable password gets the normal reset link.
    - An account with no usable password gets a real set-password link only
      when *the requested address* is verified on it (#1314). This is the
      recovery path for someone who can no longer reach the provider they
      signed up with.
    - Any other password-less account gets the alternate "sign in with your
      provider" email and no link.
    """

    def _gate_reset_users(self, request, email):
        """Send the alternate email where due; return the users who get a link."""
        adapter = get_adapter(request)
        link_users = []
        for user in self.users:
            if user.has_usable_password() or _has_verified_email(user, email):
                link_users.append(user)
            else:
                provider_names = [
                    _PROVIDER_LABELS.get(sa.provider, sa.provider)
                    for sa in user.socialaccount_set.all()
                ]
                provider_label = provider_names[0] if provider_names else "your social account"
                adapter.send_mail(
                    "account/email/password_reset_no_password",
                    email,
                    {"user": user, "provider": provider_label},
                )
        return link_users


class VisibanPasswordResetForm(_ResetLinkGateMixin, AllAuthPasswordResetForm):
    """REST reset-request form (``POST /api/v1/auth/password/reset/``).

    Uses FRONTEND_URL instead of reversing a Django auth URL, and decides who
    gets a link with ``_ResetLinkGateMixin``.
    """

    def save(self, request, **kwargs):
        kwargs.setdefault("url_generator", _frontend_url_generator)
        email = self.cleaned_data["email"]
        # Replace self.users so that super().save() only mails a link to the
        # accounts the gate allows.
        original_users = self.users
        self.users = self._gate_reset_users(request, email)
        try:
            return super().save(request, **kwargs)
        finally:
            self.users = original_users


class VisibanResetPasswordForm(_ResetLinkGateMixin, ResetPasswordForm):
    """allauth's own HTML reset-request page (``/accounts/password/reset/``).

    Wired via ``ACCOUNT_FORMS["reset_password"]`` so this page applies the same
    verified-address rule as the REST endpoint (#1314).
    """

    def save(self, request, **kwargs):
        email = self.cleaned_data["email"]
        original_users = self.users
        link_users = self._gate_reset_users(request, email)
        if original_users and not link_users:
            # Every matching account got the alternate email. Don't fall
            # through to allauth's "no account with this address" mail.
            return email
        self.users = link_users
        try:
            return super().save(request, **kwargs)
        finally:
            self.users = original_users
