import hashlib

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .models import PAT_PREFIX, PersonalAccessToken


class InvalidPersonalAccessToken(Exception):
    """Raised by :func:`resolve_personal_access_token` when a PAT is unusable.

    Deliberately *not* a DRF ``AuthenticationFailed``: this helper is shared
    with the MCP ASGI transport (#511), which runs outside the DRF request
    cycle and must not depend on DRF exception handling to turn a failure into
    a response. Each caller translates this into its own protocol's 401.

    The ``detail`` is a generic, non-enumerable message by design — it never
    reveals whether a token was absent, revoked, expired, or belonged to a
    disabled account.
    """

    def __init__(self, detail):
        self.detail = detail
        super().__init__(detail)


def resolve_personal_access_token(raw_token):
    """Resolve a raw ``vbn_`` token to its ``PersonalAccessToken``.

    Shared by :class:`PATAuthentication` (the ``Token`` scheme, used by the
    REST API) and the MCP transport's ASGI middleware (the ``Bearer`` scheme,
    used at ``/mcp``) so that both credential paths enforce exactly the same
    expiry, active-user, and revocation rules. Keeping this in one function is
    what stops the two schemes from drifting apart — a second, independent
    implementation is how one of them silently misses a revocation check.

    Lookup is by SHA-256 hash; the raw value is never stored and never logged.
    Returns the token instance (``.user`` is already selected). Raises
    :class:`InvalidPersonalAccessToken` on any failure.
    """
    if not raw_token or not raw_token.startswith(PAT_PREFIX):
        raise InvalidPersonalAccessToken("Invalid or revoked token.")

    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    try:
        pat = (
            PersonalAccessToken.objects
            .select_related("user")
            .get(token_hash=token_hash)
        )
    except PersonalAccessToken.DoesNotExist:
        raise InvalidPersonalAccessToken("Invalid or revoked token.")

    if pat.expires_at and pat.expires_at < timezone.now():
        raise InvalidPersonalAccessToken("Token has expired.")

    if not pat.user.is_active:
        raise InvalidPersonalAccessToken("User account is disabled.")

    pat.last_used_at = timezone.now()
    pat.save(update_fields=["last_used_at"])

    return pat


class PATAuthentication(BaseAuthentication):
    """Authenticate requests that carry a ``vbn_``-prefixed personal access token.

    The Authorization header format is identical to DRF's TokenAuthentication::

        Authorization: Token vbn_<40 hex chars>

    Only tokens beginning with ``vbn_`` are handled here; all other values fall
    through to the next authenticator in DEFAULT_AUTHENTICATION_CLASSES so that
    dj-rest-auth session tokens and the built-in TokenAuthentication continue to
    work unchanged.

    This authenticator accepts the ``Token`` scheme only. The ``Bearer`` scheme
    is deliberately *not* accepted here even though ``/mcp`` accepts it (#511):
    broadening the scheme on this class would change the accepted header syntax
    for every DRF view in the product to benefit only MCP clients, which do not
    call the REST API. See ``docs/api/authentication.md``.

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

        try:
            pat = resolve_personal_access_token(raw_token)
        except InvalidPersonalAccessToken as exc:
            raise AuthenticationFailed(exc.detail)

        return (pat.user, pat)
