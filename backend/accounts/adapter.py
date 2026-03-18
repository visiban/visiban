from allauth.account.adapter import DefaultAccountAdapter
from django.core.cache import cache
from rest_framework.exceptions import PermissionDenied

from .models import (
    REGISTRATION_MODE_CACHE_KEY,
    REGISTRATION_MODE_CACHE_TTL,
    SiteSetting,
    invalidate_registration_mode_cache,  # re-exported so tests can import it from here
)

__all__ = ["RegistrationAdapter", "invalidate_registration_mode_cache"]


def _get_registration_mode() -> str:
    """Return registration_mode, using a short-lived cache to avoid a DB hit on every OAuth redirect."""
    mode = cache.get(REGISTRATION_MODE_CACHE_KEY)
    if mode is None:
        mode = SiteSetting.get().registration_mode
        cache.set(REGISTRATION_MODE_CACHE_KEY, mode, REGISTRATION_MODE_CACHE_TTL)
    return mode


class RegistrationAdapter(DefaultAccountAdapter):
    """Allauth adapter that honours the site-wide registration_mode setting."""

    def is_open_for_signup(self, request):
        # Block all self-registration (password and OAuth) unless the instance
        # is in 'open' mode. 'invite_only' is enforced separately at the
        # registration endpoint level; here we only gate the allauth/OAuth flow.
        mode = _get_registration_mode()
        if mode == SiteSetting.RegistrationMode.CLOSED:
            return False
        if mode == SiteSetting.RegistrationMode.INVITE_ONLY:
            # OAuth callbacks don't carry an invite token — block entirely.
            # The dj-rest-auth registration endpoint handles invite_only
            # with token validation in the serializer/view layer.
            return False
        return super().is_open_for_signup(request)

    def save_user(self, request, user, form, commit=True):
        # dj-rest-auth's RegisterView does not call is_open_for_signup before
        # invoking the serializer's save(), so we enforce the same check here.
        # This ensures the REST registration endpoint returns 403 when
        # registration is closed, consistent with allauth's headless and OAuth flows.
        if not self.is_open_for_signup(request):
            raise PermissionDenied("Registration is closed.")
        return super().save_user(request, user, form, commit)
