from allauth.account.adapter import DefaultAccountAdapter
from rest_framework.exceptions import PermissionDenied

from .models import (
    SiteSetting,
    get_registration_mode,
    invalidate_registration_mode_cache,  # re-exported so tests can import it from here
)

__all__ = ["RegistrationAdapter", "invalidate_registration_mode_cache"]


class RegistrationAdapter(DefaultAccountAdapter):
    """Allauth adapter that honours the site-wide registration_mode setting."""

    def is_open_for_signup(self, request):
        # Block all self-registration (password and OAuth) unless the instance
        # is in 'open' mode. 'invite_only' is enforced separately at the
        # registration endpoint level; here we only gate the allauth/OAuth flow.
        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            return False
        if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
            # OAuth callbacks don't carry an invite token — block entirely.
            # InviteRegisterView handles token validation for REST registration.
            return False
        return super().is_open_for_signup(request)

    def save_user(self, request, user, form, commit=True):
        # Block REST registration when mode is CLOSED. INVITE_ONLY is handled
        # at the InviteRegisterView level so that token validation and user
        # creation happen atomically in a single transaction.
        mode = get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            raise PermissionDenied("Registration is closed.")
        return super().save_user(request, user, form, commit)
