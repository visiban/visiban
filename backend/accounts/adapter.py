from allauth.account.adapter import DefaultAccountAdapter

from .models import SiteSetting


class RegistrationAdapter(DefaultAccountAdapter):
    """Allauth adapter that honours the site-wide registration toggle."""

    def is_open_for_signup(self, request):
        # Block all self-registration (password and OAuth) when the site admin
        # has enabled invite-only mode. Existing users are unaffected.
        if SiteSetting.get().require_invite_for_registration:
            return False
        return super().is_open_for_signup(request)
