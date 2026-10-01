"""Connected sign-in providers: the email-collision landing path and the
"Connect {Provider}?" prompt that follows it (#1314).

Three pieces live here so the adapter, the serializer and the views share one
definition of each:

- ``find_accounts_for_email`` — the collision lookup ``SocialRegistrationAdapter.
  pre_social_login`` uses to decide between ``account_exists``,
  ``account_exists_provider`` and the generic ``oauth_failed``.
- the pending-connect session stash — what the post-login prompt reads.
- ``configured_provider_ids`` — which providers this instance can connect.
"""
from __future__ import annotations

import time

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models import Q

# Session key holding the provider a collided OAuth attempt tried to use.
# Server-owned on purpose: the prompt it drives is "shown once", and only a
# server-side record can make that hold across tabs and devices — a
# localStorage flag would re-show the prompt everywhere else.
PENDING_CONNECT_SESSION_KEY = "pending_connect_provider"

# The issue's contract: a collided attempt stays offerable for 10 minutes. Long
# enough to find a password or finish a round trip through the "via" provider;
# short enough that a prompt never appears for an attempt the user forgot.
PENDING_CONNECT_TTL_SECONDS = 10 * 60

# Provider ids the SPA knows how to render. ``oidc`` is the ``provider_id`` of
# the single generic OIDC app configured in settings.SOCIALACCOUNT_PROVIDERS,
# which is also what allauth stores in ``SocialAccount.provider`` for it.
KNOWN_PROVIDER_IDS = ("google", "github", "gitlab", "oidc")


def configured_provider_ids() -> list[str]:
    """Provider ids with credentials configured on this instance, in display order.

    Mirrors ``AuthProvidersView``: a provider without a ``client_id`` cannot
    complete a round trip, so it must never be offered as connectable.
    """
    providers = settings.SOCIALACCOUNT_PROVIDERS
    ids = [
        pid for pid in ("google", "github", "gitlab")
        if providers.get(pid, {}).get("APP", {}).get("client_id")
    ]
    oidc_apps = providers.get("openid_connect", {}).get("APPS", [])
    if oidc_apps and oidc_apps[0].get("client_id"):
        ids.append(oidc_apps[0].get("provider_id", "oidc"))
    return ids


def find_accounts_for_email(email: str):
    """Every account that answers to ``email``, ignoring case only.

    Deliberately NOT allauth's ``assess_unique_email``: that checks only
    ``EmailAddress`` rows with an exact match, so it misses admin-created users
    (``User.email`` set, no ``EmailAddress`` row) and any case variant. Both
    tables are checked here, case-insensitively — and nothing else is
    normalized: ``+tags`` and Gmail dots make genuinely different addresses,
    so stripping them would hand one person's account to another.

    Returns inactive accounts too; the caller decides what they mean (a
    deactivated match is never revealed — see the adapter).
    """
    from allauth.account.models import EmailAddress

    value = (email or "").strip()
    if not value:
        return get_user_model().objects.none()
    via_email_address = EmailAddress.objects.filter(email__iexact=value).values("user_id")
    return (
        get_user_model()
        .objects.filter(Q(email__iexact=value) | Q(pk__in=via_email_address))
        .distinct()
        .order_by("pk")
    )


def stash_pending_connect(
    request, provider: str, user_ids: list[int], identity: str = "", uid: str = ""
) -> None:
    """Remember that a collided OAuth attempt wanted to use ``provider``.

    ``user_ids`` are the active accounts the attempt collided with: the prompt
    is only ever offered to one of them (see ``clear_pending_connect_on_login``
    for the shared-browser case). ``identity`` is how the provider names the
    account that tried (its username, else its email) — the prompt shows it,
    so someone who sees an account they don't recognize can decline.
    ``uid`` is that provider account's id: the connect the prompt starts must
    come back with the *same* account (see ``pre_social_login``), so a
    different provider session live in a shared browser can't be attached.
    """
    request.session[PENDING_CONNECT_SESSION_KEY] = {
        "provider": provider,
        "identity": identity,
        "uid": uid,
        "user_ids": list(user_ids),
        "expires_at": time.time() + PENDING_CONNECT_TTL_SECONDS,
    }


def clear_pending_connect(request) -> None:
    session = getattr(request, "session", None)
    if session is not None:
        session.pop(PENDING_CONNECT_SESSION_KEY, None)


def clear_pending_connect_on_login(sender, request, user, **kwargs) -> None:
    """``user_logged_in`` receiver: drop a stash meant for someone else (#1314).

    The stash lives in the browser's session, which a shared or public
    browser hands from one person to the next. Django's login keeps session
    data across the key rotation, so without this a stash an attempt left
    behind would still be sitting there for whoever signs in next. Only the
    account(s) the attempt collided with may inherit it.
    """
    session = getattr(request, "session", None)
    if session is None:
        return
    data = session.get(PENDING_CONNECT_SESSION_KEY)
    if not isinstance(data, dict) or getattr(user, "pk", None) not in (data.get("user_ids") or []):
        session.pop(PENDING_CONNECT_SESSION_KEY, None)


def clear_pending_connect_on_logout(sender, request, user=None, **kwargs) -> None:
    """``user_logged_out`` receiver: a sign-out ends any pending prompt."""
    if request is not None:
        clear_pending_connect(request)


def get_pending_connect_data(request, user) -> dict | None:
    """The live stash for ``user``, or None.

    None when nothing is stashed, the stash expired (a closed tab just lets it
    lapse — nothing to clean up), it was stashed for a different account, or
    ``user`` has since connected that provider some other way.
    """
    session = getattr(request, "session", None)
    if session is None or user is None or not user.is_authenticated:
        return None
    data = session.get(PENDING_CONNECT_SESSION_KEY)
    if not isinstance(data, dict):
        return None
    provider = data.get("provider")
    try:
        expired = float(data.get("expires_at", 0)) < time.time()
    except (TypeError, ValueError):
        expired = True
    if expired or not isinstance(provider, str) or user.pk not in (data.get("user_ids") or []):
        return None
    if user.socialaccount_set.filter(provider=provider).exists():
        return None
    return data


def get_pending_connect_provider(request, user) -> str | None:
    """The provider to offer ``user`` a connect prompt for, or None."""
    data = get_pending_connect_data(request, user)
    return data["provider"] if data else None


def get_pending_connect(request, user) -> tuple[str, str] | tuple[None, None]:
    """``(provider, identity)`` for the prompt, or ``(None, None)``."""
    data = get_pending_connect_data(request, user)
    if not data:
        return None, None
    identity = data.get("identity")
    return data["provider"], identity if isinstance(identity, str) and identity else None


def social_account_email(account) -> str | None:
    """Best-effort email for a connected account, from the provider payload.

    Only ever shown back to the account's own owner (Settings → Security). The
    shape of ``extra_data`` is provider-specific; OIDC nests claims under
    ``userinfo`` in allauth 65.x.
    """
    data = account.extra_data if isinstance(account.extra_data, dict) else {}
    email = data.get("email")
    if not email and isinstance(data.get("userinfo"), dict):
        email = data["userinfo"].get("email")
    return email if isinstance(email, str) and email else None


def connected_accounts_status(user) -> list[dict]:
    """One row per configured provider (plus any connected but unconfigured).

    An account connected through a provider the operator has since removed is
    still a way the user *had* to sign in, and still counts toward "keep at
    least one" — so it is listed rather than silently hidden.
    """
    accounts = list(user.socialaccount_set.order_by("date_joined", "pk"))
    by_provider: dict[str, object] = {}
    for account in accounts:
        by_provider.setdefault(account.provider, account)
    order = configured_provider_ids()
    order += [pid for pid in by_provider if pid not in order]
    rows = []
    for pid in order:
        account = by_provider.get(pid)
        row = {"provider": pid, "connected": account is not None}
        if account is not None:
            row["email"] = social_account_email(account)
            row["connected_at"] = account.date_joined
        rows.append(row)
    return rows
