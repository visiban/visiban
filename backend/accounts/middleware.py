"""Middleware for the accounts app."""

from .adapter import PENDING_INVITE_SESSION_KEY
from .models import INVITE_LINK_PREFIX


class OAuthInviteTokenMiddleware:
    """Stash an invite token in the Django session before an OAuth redirect.

    When the frontend appends ?invite_token=vbnl_xxx to an OAuth login URL
    (e.g. /accounts/google/login/?process=login&invite_token=vbnl_abc123),
    this middleware captures the token and stores it in the session so that
    it survives the round-trip through the IdP. The SocialRegistrationAdapter
    reads it from the session on the callback to decide whether signup is
    permitted in invite-only mode.

    Only runs on /accounts/*/login/ paths. The token is validated later by
    the adapter — this middleware only performs a format check (prefix).
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if self._is_oauth_login_path(request.path):
            raw_token = request.GET.get("invite_token", "")
            if raw_token and raw_token.startswith(INVITE_LINK_PREFIX):
                request.session[PENDING_INVITE_SESSION_KEY] = raw_token

        return self.get_response(request)

    @staticmethod
    def _is_oauth_login_path(path: str) -> bool:
        """Return True for allauth social login paths like /accounts/google/login/."""
        # Pattern: /accounts/<provider>/login/
        # We match broadly and let allauth handle 404s for invalid providers.
        parts = path.strip("/").split("/")
        return (
            len(parts) == 3
            and parts[0] == "accounts"
            and parts[2] == "login"
        )
