import hashlib

from django.db import DatabaseError
from django.utils import timezone
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import SAFE_METHODS

from .models import (
    MCP_SCOPES,
    PAT_PREFIX,
    SCOPE_ADMIN,
    SCOPE_MCP_READ,
    SCOPE_READ,
    SCOPE_WRITE,
    PersonalAccessToken,
)

# Every site-administration endpoint lives under this prefix (accounts/urls.py).
ADMIN_API_PREFIX = "/api/v1/admin/"

# The PAT management endpoints themselves. A scoped token must never be able to
# mint or revoke tokens: without this rule a `read`-only token can POST itself a
# new token carrying `admin`, and the entire scope model collapses to "full
# authority" (#1110).
PAT_MANAGEMENT_PREFIX = "/api/v1/auth/tokens/"

# Methods we recognise. Anything else (an exotic or spoofed verb) resolves to no
# baseline at all, which denies scoped tokens rather than waving them through —
# the fail-closed-on-absent-input rule from #1075.
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

LEGACY_SCOPE_LABEL = "legacy"


def baseline_scopes_for(path: str, method: str):
    """Return the scopes a *scoped* PAT must hold for this path and method.

    Returns a set of required scopes (ALL of which must be held), or ``None``
    to mean "deny" — an unrecognised HTTP method has no safe default.

    Requirements COMPOSE rather than replace: an unsafe request to an admin
    route needs ``{admin, write}``, because the vocabulary is non-hierarchical.
    ``admin`` is a grant over a *surface*; ``read``/``write`` are grants over a
    *verb*. Holding one has never implied the other and must not start to.

    Note this deliberately reasons only about ``request.path`` and
    ``request.method`` — no view, no serializer, no permission class. That is
    what lets the check live in the authenticator (see PATAuthentication), which
    is the only layer in this codebase a view cannot opt out of.
    """
    if method in SAFE_METHODS:
        required = {SCOPE_READ}
    elif method in _UNSAFE_METHODS:
        required = {SCOPE_WRITE}
    else:
        return None

    if path.startswith(ADMIN_API_PREFIX):
        required.add(SCOPE_ADMIN)

    return required


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

    This function establishes IDENTITY only — it deliberately does not record
    usage. Usage is recorded by :func:`record_token_usage` *after* the caller's
    scope check passes (#1110), so that ``last_used_scope`` can never claim an
    authority the request was denied. Every caller must call it on success.
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

    return pat


def record_token_usage(pat, presented_scope: str) -> None:
    """Stamp last_used_at and the scope actually satisfied, in one UPDATE.

    A single write, not two: the PAT hot path already pays for one UPDATE per
    authenticated request and must not gain another. ``presented_scope`` is the
    requirement this request actually met — never a constant, so the audit trail
    distinguishes a read from a write from an admin call.

    Raises :class:`InvalidPersonalAccessToken` if the row has disappeared since
    it was resolved. That is a real race, not a theoretical one: a concurrent
    ``DELETE /auth/tokens/{id}/``, a password change (which revokes every token),
    or an admin deactivation can land between the SELECT and this UPDATE. Django
    raises ``DatabaseError`` when ``update_fields`` matches no rows, which would
    surface as a 500 on what is really a revoked credential — so it is
    translated into the same generic failure every other revocation path uses.
    """
    pat.last_used_at = timezone.now()
    pat.last_used_scope = (presented_scope or "")[:64]
    try:
        pat.save(update_fields=["last_used_at", "last_used_scope"])
    except DatabaseError:
        raise InvalidPersonalAccessToken("Invalid or revoked token.")


def enforce_mcp_scope(pat, required_scope: str = SCOPE_MCP_READ) -> str:
    """Authorize a personal access token for the MCP transport (#1110).

    Separate from the REST baseline because the two surfaces share credentials
    but not authority: a token that may read every board over REST has not
    thereby been authorized to drive an agent, and vice versa.

    A LEGACY token (scopes IS NULL) is rejected here even though it carries
    full REST authority. That is the one place legacy authority deliberately
    stops: an unscoped token predates the agent surface entirely, so nobody who
    issued one consented to it being used this way.

    Raises :class:`InvalidPersonalAccessToken` so the ASGI caller can render it
    in its own protocol envelope without importing DRF exception machinery.
    """
    if pat.scopes is None:
        raise InvalidPersonalAccessToken(
            "This token predates MCP scopes. Create a new token with the "
            f"'{required_scope}' scope."
        )
    if required_scope not in set(pat.scopes):
        raise InvalidPersonalAccessToken(
            f"This token is missing the required scope: {required_scope}."
        )
    return required_scope


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

    **Why the baseline scope check lives here and not in a permission class**
    (#1110): 33 of the 34 view classes in this backend declare an explicit
    ``permission_classes`` list — a deliberate convention (#989) that means
    ``DEFAULT_PERMISSION_CLASSES`` is inherited by essentially nothing. A scope
    gate added there alone would be evaluated on zero endpoints and no test
    would fail. Authentication has no such opt-out: the only views that clear
    ``authentication_classes`` are the four deliberately anonymous ones (the
    share-board endpoint, the email-confirm redirect, and the two health
    probes), none of which can be reached with a token. Mixing authorization
    into authentication is a smell, so it is contained: this check reads
    nothing but the path and the method, and the per-view ``required_scopes``
    surface stays in the TokenHasScope permission class, where being dropped
    fails closed instead of open.
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

        # The token is valid; the question from here is authority, not identity,
        # so failures are 403 (PermissionDenied) and never 401 — a client that
        # retries a 401 with fresh credentials would loop forever on a scope
        # problem no credential refresh can fix.
        presented_scope = self._enforce_baseline_scopes(request, pat)
        record_token_usage(pat, presented_scope)

        return (pat.user, pat)

    @staticmethod
    def _enforce_baseline_scopes(request, pat) -> str:
        """Apply the path/method scope baseline; return the scope label to audit.

        Never logs or returns anything derived from the raw token value.
        """
        scopes = pat.scopes

        if scopes is None:
            # Legacy token: byte-for-byte today's REST behavior. The mcp:*
            # surface is closed to it, but that is enforced by TokenHasScope —
            # no REST route requires an mcp scope.
            return LEGACY_SCOPE_LABEL

        if not scopes:
            # Explicit empty allow-list: an affirmative grant of nothing.
            raise PermissionDenied("This token has no scopes and cannot be used.")

        path = request.path
        method = request.method or ""

        if path.startswith(PAT_MANAGEMENT_PREFIX) and method not in SAFE_METHODS:
            raise PermissionDenied(
                "Scoped tokens cannot create or revoke personal access tokens."
            )

        required = baseline_scopes_for(path, method)
        if required is None:
            raise PermissionDenied("Unsupported request method for a scoped token.")

        held = set(scopes)
        if not required.issubset(held):
            # Name the requirement, never the token's own scopes — the response
            # goes to whoever presented the credential, who may not be its owner.
            missing = ", ".join(sorted(required - held))
            raise PermissionDenied(
                f"This token is missing the required scope: {missing}."
            )

        # Record what was actually satisfied, not a constant.
        return " ".join(sorted(required))[:64]


__all__ = [
    "ADMIN_API_PREFIX",
    "InvalidPersonalAccessToken",
    "LEGACY_SCOPE_LABEL",
    "MCP_SCOPES",
    "PAT_MANAGEMENT_PREFIX",
    "PATAuthentication",
    "baseline_scopes_for",
    "enforce_mcp_scope",
    "record_token_usage",
    "resolve_personal_access_token",
]
