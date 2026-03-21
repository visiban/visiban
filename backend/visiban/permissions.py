"""Project-wide DRF permission classes."""

from rest_framework.permissions import BasePermission


class MustNotHavePendingPasswordChange(BasePermission):
    """Block all API access for users with a forced password-change flag set.

    This is a second line of enforcement behind the frontend ForceChangePasswordModal.
    Without it, a user (or an attacker with a stolen session) can bypass the modal
    entirely by calling any API endpoint directly.

    Views that must remain accessible despite the flag (i.e. ChangePasswordView)
    should declare their own explicit permission_classes = [IsAuthenticated] to
    opt out of this class. All other views inherit it via DEFAULT_PERMISSION_CLASSES.
    """

    message = "You must change your password before continuing."

    def has_permission(self, request, view):
        user = request.user
        # Unauthenticated requests: let IsAuthenticated handle them.
        if not user.is_authenticated:
            return True
        return not getattr(user, "must_change_password", False)
