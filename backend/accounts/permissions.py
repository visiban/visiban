from rest_framework.permissions import BasePermission

from .models import MCP_SCOPES, SCOPE_ADMIN, PersonalAccessToken


class IsSiteAdmin(BasePermission):
    """Grants access only to authenticated users with the site_admin flag set."""

    message = "You must be a site administrator to perform this action."

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.is_site_admin
        )


def _declares_site_admin_gate(view) -> bool:
    """True if the view gates on IsSiteAdmin (or a subclass of it).

    This is the second half of the admin-surface check. The first half — the
    ``/api/v1/admin/`` path prefix — lives in PATAuthentication. The two are a
    UNION, not alternatives, because each covers the other's blind spot: the
    prefix misses an admin-grade route registered through the enterprise URL
    extension point, and class introspection misses a route that gates on
    something other than IsSiteAdmin. A union can only ever deny more, so
    disagreement between them fails closed. ``test_pat_scopes.py`` asserts the
    two signals agree across the whole URLconf.
    """
    for perm in getattr(view, "permission_classes", None) or ():
        if isinstance(perm, type) and issubclass(perm, IsSiteAdmin):
            return True
    return False


class TokenHasScope(BasePermission):
    """Enforce per-view scope requirements for personal access tokens (#1110).

    Scope of responsibility — deliberately narrow:

    - The ``read``/``write``/``admin`` baseline is NOT enforced here. It runs in
      PATAuthentication, because ``permission_classes`` is overridden by almost
      every view in this codebase and a baseline declared here would be
      evaluated on nearly nothing. See that class's docstring.
    - What runs here is the part that must know about the view: an explicit
      ``required_scopes`` attribute (the ``mcp:*`` surface), plus the
      IsSiteAdmin half of the admin-surface union.

    That split is chosen by failure mode. If a view drops this class from its
    permission list, the effect is that a token needing an explicit scope can no
    longer reach it — closed, not open.

    ``required_scopes`` is ALL-of: every listed scope must be held. A single
    requirement is expressed as a one-element list.

    This permission is a no-op for session authentication and for DRF's built-in
    TokenAuthentication — ``request.auth`` is only a PersonalAccessToken when a
    ``vbn_`` token was presented, and ``force_authenticate(user)`` leaves it
    None. SPA traffic is completely unaffected.
    """

    message = "This token does not carry the scope required for this endpoint."

    def has_permission(self, request, view):
        auth = request.auth
        # isinstance, not getattr(auth, "scopes", None) — duck-typing here is
        # exactly the guard-degrades-to-no-check shape #1075 exists to remove.
        if not isinstance(auth, PersonalAccessToken):
            return True

        declared = getattr(view, "required_scopes", None)
        required = set(declared) if declared else set()

        if auth.scopes is None:
            # Legacy token: keeps full REST authority (hard backward-compat
            # requirement) but is NEVER accepted where an mcp:* scope is
            # required — an unscoped credential predates the agent surface and
            # cannot be assumed to have been issued for it.
            return not (required & MCP_SCOPES)

        if not auth.scopes:
            # Explicit empty allow-list: no authority anywhere.
            return False

        if _declares_site_admin_gate(view):
            required.add(SCOPE_ADMIN)

        # No implication between scopes: holding `admin` does not satisfy
        # `mcp:read`, holding `write` does not satisfy `read`.
        return required.issubset(set(auth.scopes))
