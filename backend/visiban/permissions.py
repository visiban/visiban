"""Project-wide DRF permission classes.

The account-state predicates and gates live in ``visiban.authorization`` so
that every transport evaluates the same objects (#1517). The predicates are
re-exported here because existing callers import them from this module.
"""

from rest_framework.permissions import BasePermission

from visiban.authorization import (  # noqa: F401 — re-exported for existing importers
    PENDING_PASSWORD_CHANGE,
    PENDING_USERNAME_CHANGE,
    has_pending_account_action,
    has_pending_password_change,
    has_pending_username_change,
)


class MustNotHavePendingPasswordChange(BasePermission):
    """Block all API access for users with a forced password-change flag set.

    This is a second line of enforcement behind the frontend ForceChangePasswordModal.
    Without it, a user (or an attacker with a stolen session) can bypass the modal
    entirely by calling any API endpoint directly.

    Views that must remain accessible despite the flag (i.e. ChangePasswordView)
    opt out by declaring permission_classes = [IsAuthenticated] without this class.
    All other views inherit it via DEFAULT_PERMISSION_CLASSES and must not override
    permission_classes with [IsAuthenticated] alone — doing so silently drops this gate.
    ``accounts/tests/test_auth_entry_points.py`` fails for a view that does so
    without an allowlist entry giving the reason (#1517).

    Delegates to the shared gate, so REST, MCP and the WebSocket consumers
    apply one predicate and one message. No ``code`` attribute: DRF's default
    (``permission_denied``) is what this class has always emitted, and is the
    code the shared gate records.
    """

    gate = PENDING_PASSWORD_CHANGE
    message = PENDING_PASSWORD_CHANGE.message

    def has_permission(self, request, view):
        user = request.user
        # Unauthenticated requests: let IsAuthenticated handle them.
        if not user.is_authenticated:
            return True
        return not self.gate.blocks(user)


class MustNotHavePendingUsernameChange(BasePermission):
    """Block all API access for users with a forced username-change flag set.

    Mirrors MustNotHavePendingPasswordChange. Views that must remain accessible
    despite the flag (ChooseUsernameView, ChangePasswordView) opt out by
    declaring their own explicit permission_classes without this class.
    """

    gate = PENDING_USERNAME_CHANGE
    # DRF uses `code` in the error response detail dict, giving API/PAT
    # clients a machine-readable signal so they can detect and resolve the
    # condition programmatically.
    message = PENDING_USERNAME_CHANGE.message
    code = PENDING_USERNAME_CHANGE.code

    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return True
        return not self.gate.blocks(user)
