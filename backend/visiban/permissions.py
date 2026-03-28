"""Project-wide DRF permission classes."""

from rest_framework.permissions import BasePermission


class MustNotHavePendingPasswordChange(BasePermission):
    """Block all API access for users with a forced password-change flag set.

    This is a second line of enforcement behind the frontend ForceChangePasswordModal.
    Without it, a user (or an attacker with a stolen session) can bypass the modal
    entirely by calling any API endpoint directly.

    Views that must remain accessible despite the flag (i.e. ChangePasswordView)
    opt out by declaring permission_classes = [IsAuthenticated] without this class.
    All other views inherit it via DEFAULT_PERMISSION_CLASSES and must not override
    permission_classes with [IsAuthenticated] alone — doing so silently drops this gate.
    """

    message = "You must change your password before continuing."

    def has_permission(self, request, view):
        user = request.user
        # Unauthenticated requests: let IsAuthenticated handle them.
        if not user.is_authenticated:
            return True
        return not getattr(user, "must_change_password", False)
