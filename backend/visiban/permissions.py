"""Project-wide DRF permission classes."""

from rest_framework.permissions import BasePermission


def has_pending_password_change(user) -> bool:
    """True if *user* carries the forced password-change flag.

    Single predicate shared by the DRF permission class below and the
    WebSocket entry points, so every transport applies the same account-state
    rule.
    """
    return bool(getattr(user, "must_change_password", False))


def has_pending_username_change(user) -> bool:
    """True if *user* carries the forced username-change flag (see above)."""
    return bool(getattr(user, "must_change_username", False))


def has_pending_account_action(user) -> bool:
    """True if *user* must complete a forced password or username change."""
    return has_pending_password_change(user) or has_pending_username_change(user)


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
        return not has_pending_password_change(user)


class MustNotHavePendingUsernameChange(BasePermission):
    """Block all API access for users with a forced username-change flag set.

    Mirrors MustNotHavePendingPasswordChange. Views that must remain accessible
    despite the flag (ChooseUsernameView, ChangePasswordView) opt out by
    declaring their own explicit permission_classes without this class.
    """

    # DRF uses `code` in the error response detail dict, giving API/PAT
    # clients a machine-readable signal so they can detect and resolve the
    # condition programmatically.
    message = "You must choose a new username before continuing."
    code = "must_change_username"

    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return True
        return not has_pending_username_change(user)
