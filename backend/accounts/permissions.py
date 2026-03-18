from rest_framework.permissions import BasePermission


class IsSiteAdmin(BasePermission):
    """Grants access only to authenticated users with the site_admin flag set."""

    message = "You must be a site administrator to perform this action."

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.is_site_admin
        )
