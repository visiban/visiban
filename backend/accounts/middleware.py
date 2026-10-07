"""Middleware for the accounts app."""

from .adapter import PENDING_INVITE_SESSION_KEY
from .registration_tokens import STASHABLE_PREFIXES

# Site invites, plus emailed single-use group (#1445) and board (#1444)
# invites, which also authorize OAuth signup on an invite-only site. The
# adapter decides which invites qualify; this is only the prefix gate, drawn
# from the same table the registration paths dispatch on.
_STASHABLE_PREFIXES = STASHABLE_PREFIXES


class OAuthInviteTokenMiddleware:
    """Stash an invite token in the Django session before an OAuth redirect.

    When the frontend appends ?invite_token=vbnl_xxx (or vbng_xxx / vbnb_xxx) to an OAuth login URL
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
            if raw_token and raw_token.startswith(_STASHABLE_PREFIXES):
                request.session[PENDING_INVITE_SESSION_KEY] = raw_token

        return self.get_response(request)

    @staticmethod
    def _is_oauth_login_path(path: str) -> bool:
        """Return True for allauth social login paths like /accounts/google/login/."""
        # Patterns: /accounts/<provider>/login/, and generic OIDC's
        # /accounts/oidc/<provider_id>/login/ (allauth nests OIDC apps under
        # an ``oidc/`` prefix — #1314 pointed the SPA's SSO button there).
        # We match broadly and let allauth handle 404s for invalid providers.
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[1] == "oidc":
            parts = [parts[0], parts[2], parts[3]]
        return (
            len(parts) == 3
            and parts[0] == "accounts"
            and parts[2] == "login"
        )
