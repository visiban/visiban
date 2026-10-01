from django.conf import settings

from allauth.account.adapter import get_adapter
from allauth.account.forms import SignupForm
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


class VisibanPasswordResetForm(AllAuthPasswordResetForm):
    """Password reset form that:
    - Uses FRONTEND_URL instead of reversing a Django auth URL.
    - Sends a real set-password link to an account with no usable password
      whose address is *verified* (#1314). This is the "genuinely stuck"
      recovery path: someone who signed up with a provider they can no longer
      reach proves they own the inbox, sets a password, and logs in. Before
      #1314 such accounts only ever got the "sign in with your provider"
      email, which left that person with no way back in at all.
    - Still sends that alternate email (and no link) to a password-less
      account whose address was never verified: there, receiving mail at the
      address proves nothing about who owns the account — an IdP can assert
      an address it never checked — so a link would hand the account to
      whoever controls that inbox.
    """

    def save(self, request, **kwargs):
        kwargs.setdefault("url_generator", _frontend_url_generator)

        email = self.cleaned_data["email"]
        adapter = get_adapter(request)

        # Partition users: those with a usable password — or a verified
        # address — get the standard reset email; the rest get an alternate
        # email that directs them back to their OAuth provider.
        users_with_password = []
        for user in self.users:
            if user.has_usable_password() or _has_verified_email(user, email):
                users_with_password.append(user)
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

        # Replace self.users so that super().save() only processes accounts
        # with usable passwords.
        original_users = self.users
        self.users = users_with_password
        try:
            return super().save(request, **kwargs)
        finally:
            self.users = original_users
