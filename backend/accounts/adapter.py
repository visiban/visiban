from allauth.account.adapter import DefaultAccountAdapter
from rest_framework.exceptions import PermissionDenied

from .models import SiteSetting


class RegistrationAdapter(DefaultAccountAdapter):
    """Allauth adapter that honours the site-wide registration toggle."""

    def is_open_for_signup(self, request):
        # Block all self-registration (password and OAuth) when the site admin
        # has enabled invite-only mode. Existing users are unaffected.
        if SiteSetting.get().require_invite_for_registration:
            return False
        return super().is_open_for_signup(request)

    def save_user(self, request, user, form, commit=True):
        # dj-rest-auth's RegisterView does not call is_open_for_signup before
        # invoking the serializer's save(), so we enforce the same check here.
        # This ensures the REST registration endpoint returns 403 when invite-only
        # mode is active, consistent with allauth's headless and OAuth flows.
        if not self.is_open_for_signup(request):
            raise PermissionDenied("Registration is closed.")
        return super().save_user(request, user, form, commit)
