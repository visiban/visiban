"""Login-by-email support for the OSS password login (#1206).

The SPA login form has always said "Username or email", but OSS never
registered a backend that resolves an email address, so only the literal
``username`` matched. This module adds that resolution, and exposes the same
resolution to the per-account lockout (``accounts.adapter``) so that one
account has exactly one lockout no matter which identifier it is attacked by.

Resolution rules (``resolve_login_user``) — shared by the backend, the
lockout key, and the demo-mode carve-out so the three can never disagree:

1. **An exact username match wins.** Usernames may legally contain ``@``
   (``accounts.validators.USERNAME_PATTERN``), so an identifier that is some
   account's username is always treated as that username, never as another
   account's email. This matches ``ModelBackend``'s existing (case-sensitive)
   lookup exactly, so username logins behave byte-for-byte as before.
2. **Otherwise, a case-insensitive match on ``User.email``** — but only if it
   matches exactly ONE account. ``User.email`` is Django's stock
   ``AbstractUser.email``, which is *not* unique at the database level:
   registration and invites enforce uniqueness, but admin-created, SSO-
   provisioned, and pre-existing accounts can share an address. An ambiguous
   email therefore fails closed — no login, the same generic "Unable to log in
   with provided credentials." as a wrong password — rather than logging into
   whichever account's password happens to match (which is what allauth's own
   ``AuthenticationBackend`` does). A user whose email is ambiguous can still
   log in by username.
   Only *active* accounts are counted, so a deactivated duplicate does not
   make a live account's email ambiguous. Because rule 1 wins, a username
   equal to someone else's email (shadowing) or a second active account with
   the same email (duplication) would disable *their email login* — a denial
   of the convenience path, never a takeover. Since #1221 the write paths
   refuse to create either state (``accounts.validators.
   username_collides_with_email`` / ``email_collides_with_identifier``), but
   rows written before that, or by operator tooling, can still collide, so
   the fail-closed rule above stays; the affected user can always log in by
   username.
3. **Blank never matches** — a blank email is the "no email on file" value and
   must not resolve to every account without one.
"""

from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend


_REQUEST_CACHE_ATTR = "_visiban_login_user_resolutions"


def resolve_login_user(identifier, request=None):
    """Return the single account ``identifier`` names, or ``None``.

    See the module docstring for the precedence and fail-closed rules. Does
    not check the password or ``is_active`` — callers that authenticate do
    that; the lockout-key caller deliberately doesn't (a lockout must key on
    the account whether or not the attempt's password was right).

    One login request resolves the same identifier in up to three places (the
    lockout key, ``EmailBackend``, and the demo-mode carve-out). Passing
    ``request`` memoizes the answer on it, per identifier, so the lookup —
    including the unindexed ``email__iexact`` scan — runs once per request.
    """
    if not identifier or not isinstance(identifier, str):
        return None
    if request is None:
        return _resolve(identifier)
    cache = getattr(request, _REQUEST_CACHE_ATTR, None)
    if cache is None:
        cache = {}
        try:
            setattr(request, _REQUEST_CACHE_ATTR, cache)
        except AttributeError:
            return _resolve(identifier)
    if identifier not in cache:
        cache[identifier] = _resolve(identifier)
    return cache[identifier]


def _resolve(identifier):
    user_model = get_user_model()
    try:
        return user_model._default_manager.get_by_natural_key(identifier)
    except user_model.DoesNotExist:
        pass
    # [:2] is enough to tell "exactly one" from "ambiguous" without loading
    # every account that shares an address.
    # Only active accounts count toward "exactly one": a deactivated leftover
    # (re-provisioned employee, SSO duplicate) sharing an address must not
    # silently block the live account's email login. An inactive account
    # could not log in anyway (user_can_authenticate), so excluding it gives
    # up nothing.
    matches = list(
        user_model._default_manager.filter(email__iexact=identifier, is_active=True).exclude(email="")[:2]
    )
    return matches[0] if len(matches) == 1 else None


class EmailBackend(ModelBackend):
    """Authenticate by email address, for identifiers that are not a username.

    Registered AFTER ``django.contrib.auth.backends.ModelBackend`` in
    ``AUTHENTICATION_BACKENDS`` (visiban/settings.py), not instead of it:

    - ``ModelBackend`` stays first and stays listed so every existing session
      (whose ``BACKEND_SESSION_KEY`` names ``ModelBackend``) survives the
      upgrade — removing it from the list would log every user out.
    - Username logins are fully handled by ``ModelBackend`` as before; this
      backend declines any identifier that is an existing username (rule 1 of
      ``resolve_login_user``) instead of re-checking it.

    Accepts the identifier either as ``username`` (what the SPA and most API
    clients send — the request field name is unchanged for backward
    compatibility) or as ``email`` (dj-rest-auth's optional body field).

    Timing: every path that does not return a user runs exactly one password
    hash — the real one for a resolved account, a throwaway one otherwise —
    the same mitigation ``ModelBackend`` uses. Combined with ``ModelBackend``'s
    own one hash, every failed login costs the same two hashes whether the
    identifier was an unknown string, an ambiguous email, a known email, or a
    known username, so response time does not reveal which.
    """

    def authenticate(self, request, username=None, password=None, email=None, **kwargs):
        identifier = email if email else username
        if not identifier or password is None:
            return None
        user_model = get_user_model()
        user = resolve_login_user(identifier, request)
        if user is not None and username is not None and user.get_username() == identifier:
            # A username submitted via the `username` field — ModelBackend
            # already ruled on it. Run the throwaway hash anyway so this path
            # costs the same as the others.
            #
            # The `username is not None` guard matters: an identifier
            # submitted via the `email` field that happens to equal an
            # account's username (someone's username IS their email address)
            # resolves here too via resolve_login_user()'s rule 1, but
            # ModelBackend was never given a `username` kwarg to check it
            # against (Django's ModelBackend.authenticate() returns
            # immediately, with no hash, when `username` is None) — so
            # without this guard, this backend would defer to a check that
            # never ran and the login would always fail 400 in that case.
            user = None
        if user is None:
            user_model().set_password(password)
            return None
        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
