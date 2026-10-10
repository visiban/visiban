"""Side effects that follow a password being set through the web interface, the API or the Django admin (#1551).

A password can be set through several routes: the SPA's two REST change
endpoints, the REST reset-confirm endpoint, allauth's HTML change, set and
reset-by-key forms, and the Django admin password form. Each route calls the
helpers here in the same transaction as its password save, so the follow-up
work is the same on each of them and commits or rolls back with the password.
Registry Rule 3 in ``docs/development/security-invariants.md`` lists the
callers.

The helpers are deliberately not attached to ``User.set_password``: that method
also runs on throwaway, unsaved instances (``accounts.backends.EmailBackend``
hashes a password on one to equalize login timing), and those must not touch
any stored row.
"""

from __future__ import annotations

from django.db import transaction


def finalize_password_change(user):
    """Side effects every successful user-initiated password change must have.

    Shared by the routes listed in the module docstring through which a user
    sets their own password. Every caller runs it inside the same transaction as the
    password save, so the new password and these writes commit together. Its
    own ``atomic()`` block keeps its two writes together in any case.

    - Clears ``must_change_password``: choosing a new password is exactly what
      the forced-change flag asks for, whichever of those routes the user reached.
    - Revokes every Personal Access Token: ``PersonalAccessToken`` documents
      "all tokens are deleted when the password changes", and users are told
      rotating the password is how to cut off a leaked token (#406, #1110).

    ``must_change_username`` is left alone: a password change does not answer
    a username request. Idempotent, so a second call is harmless.
    """
    with transaction.atomic():
        user.must_change_password = False
        user.save(update_fields=["must_change_password"])
        user.personal_access_tokens.all().delete()


def revoke_auth_token(user):
    """Delete *user*'s DRF auth ``Token`` (the key minted at REST login).

    This helper is called on reset and on admin-set passwords. The SPA
    authenticates with its session cookie, not this key, and REST login mints a
    fresh one on the next sign-in.
    """
    from rest_framework.authtoken.models import Token

    Token.objects.filter(user_id=user.pk).delete()


def finalize_password_reset(user):
    """Side effects of a completed password reset (REST and HTML).

    A reset is a password change by whoever holds the reset link, so it gets
    the full self-service finalization plus the DRF ``Token`` revocation.
    """
    with transaction.atomic():
        finalize_password_change(user)
        revoke_auth_token(user)


def require_password_change_after_admin_set(user):
    """Side effects of an administrator setting another user's password.

    Every credential issued under the previous password is revoked. Sessions
    end on their own: the session auth hash is derived from the password hash.

    When the administrator set a usable password, they now know it, so the
    account owner must choose a new one before continuing (the same rule
    ``AdminUsersView.post`` applies to accounts it creates). When they instead
    disabled password sign-in, the flag is not set: it would make the owner
    create the password the administrator just removed. *user* must carry the
    stored (new) password hash.
    """
    with transaction.atomic():
        if user.has_usable_password():
            user.must_change_password = True
            user.save(update_fields=["must_change_password"])
        user.personal_access_tokens.all().delete()
        revoke_auth_token(user)
