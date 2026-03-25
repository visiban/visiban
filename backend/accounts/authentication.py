import hashlib

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .models import PAT_PREFIX, PersonalAccessToken


class PATAuthentication(BaseAuthentication):
    """Authenticate requests that carry a ``vbn_``-prefixed personal access token.

    The Authorization header format is identical to DRF's TokenAuthentication::

        Authorization: Token vbn_<40 hex chars>

    Only tokens beginning with ``vbn_`` are handled here; all other values fall
    through to the next authenticator in DEFAULT_AUTHENTICATION_CLASSES so that
    dj-rest-auth session tokens and the built-in TokenAuthentication continue to
    work unchanged.

    Token lookup is performed by SHA-256 hash — the raw value is never stored.
    """

    def authenticate_header(self, request):
        # Returning a non-None value tells DRF to use 401 (not 403) for
        # unauthenticated/failed-authentication responses on this view.
        return "Token"

    def authenticate(self, request):
        auth_header = request.META.get("HTTP_AUTHORIZATION", "")
        if not auth_header.startswith("Token "):
            return None

        raw_token = auth_header[6:].strip()
        if not raw_token.startswith(PAT_PREFIX):
            # Not a PAT — let the next authenticator try.
            return None

        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        try:
            pat = (
                PersonalAccessToken.objects
                .select_related("user")
                .get(token_hash=token_hash)
            )
        except PersonalAccessToken.DoesNotExist:
            raise AuthenticationFailed("Invalid or revoked token.")

        if pat.expires_at and pat.expires_at < timezone.now():
            raise AuthenticationFailed("Token has expired.")

        return (pat.user, pat)
