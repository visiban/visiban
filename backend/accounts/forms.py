from django.conf import settings

from allauth.account.adapter import get_adapter
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


class VisibanPasswordResetForm(AllAuthPasswordResetForm):
    """Password reset form that:
    - Uses FRONTEND_URL instead of reversing a Django auth URL.
    - Sends an alternate email to OAuth-only accounts (no usable password)
      rather than silently creating password auth on their behalf.
    """

    def save(self, request, **kwargs):
        kwargs.setdefault("url_generator", _frontend_url_generator)

        email = self.cleaned_data["email"]
        adapter = get_adapter(request)

        # Partition users: those with a usable password get the standard
        # reset email; OAuth-only users get an alternate email that directs
        # them back to their OAuth provider.
        users_with_password = []
        for user in self.users:
            if user.has_usable_password():
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
