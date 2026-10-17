"""Emailed invites are bound to the address they were sent to (#1678).

A board invite (``vbnb_``) or group invite (``vbng_``) minted by a send-invite
endpoint stores ``recipient_hash``: a keyed hash of the address it was emailed
to. Redemption, on every path (the join endpoints, REST registration and
OAuth signup), compares that hash with the redeeming account's addresses and
refuses the invite when none match. A shareable link (``delivery=link``) has no
recipient and stores NULL, so it keeps its "link, not email" behavior: anyone
holding it may use it.

What is stored
--------------
``HMAC-SHA256(key derived from SECRET_KEY, normalized address)`` via Django's
``salted_hmac`` with a dedicated salt, as 64 hex characters. A plain digest of
an address could be reversed by hashing candidate addresses; a keyed one cannot
without the server key. The plaintext address is never stored or logged.

Normalization is ``strip().lower()`` — the same rule the site-invite dedup
uses (``accounts.invite_utils._normalize_email_for_dedup``), so an address
typed with different capitalization still matches. Provider-specific folding
(dots, ``+tags``) is deliberately not applied: they are different mailboxes.

Which of the redeemer's addresses count
---------------------------------------
- An existing account joining (``at_registration=False``): its **verified**
  allauth ``EmailAddress`` rows. Under ``EMAIL_VERIFICATION=optional`` or
  ``none`` the account's ``User.email`` counts as well, because those modes do
  not ask anyone to prove an address, and an admin-created account may have no
  ``EmailAddress`` row at all. Under ``mandatory``, only verified rows count;
  an unconfirmed pending address change never does.
- A new account at registration (``at_registration=True``): the signup
  address (``User.email``) and any verified row the signup created (an OAuth
  provider may report a verified address). Under ``mandatory`` the new account
  still has to confirm that address before it can sign in.

So the binding is as strong as the site's email verification setting: under
``mandatory`` it means "whoever controls the invited mailbox"; under
``optional`` / ``none`` it means "an account that claims the invited address".

Invites minted before #1678 have ``recipient_hash`` NULL and redeem exactly as
they did before, so upgrading breaks no invite already in someone's inbox.

Comparison also tries every key in Django's ``SECRET_KEY_FALLBACKS``. Visiban
does not expose that setting through an environment variable, so it only
applies when an operator sets it in a settings override; by default, changing
``DJANGO_SECRET_KEY`` makes pending emailed invites stop matching.
"""

from __future__ import annotations

import logging
from typing import Iterable

from django.conf import settings
from django.utils.crypto import constant_time_compare, salted_hmac

logger = logging.getLogger(__name__)

_KEY_SALT = "visiban.invite_recipient"

MISMATCH_CODE = "invite_recipient_mismatch"
# Neutral on purpose: it never names or hints at the invited address, only that
# this account is not the one the invite was sent to.
MISMATCH_DETAIL = (
    "This invite was sent to a different email address. Sign in with the "
    "account that uses that address, or ask for a new invite."
)
# The sign-up form's wording: there the person fixes it by typing the invited
# address, not by switching accounts.
REGISTRATION_MISMATCH_DETAIL = (
    "This invite was sent to a different email address. Sign up with the "
    "address the invite was sent to, or ask for a new invite."
)


def normalize_address(email: str | None) -> str:
    """Canonical form compared by the hash (see module docstring)."""
    return (email or "").strip().lower()


def _digest(normalized: str, secret) -> str:
    return salted_hmac(_KEY_SALT, normalized, secret=secret, algorithm="sha256").hexdigest()


def hash_recipient(email: str | None) -> str | None:
    """The value to store in ``recipient_hash`` for ``email``; None when blank."""
    normalized = normalize_address(email)
    if not normalized:
        return None
    return _digest(normalized, settings.SECRET_KEY)


def _keys():
    return [settings.SECRET_KEY, *getattr(settings, "SECRET_KEY_FALLBACKS", [])]


def address_matches(stored_hash: str, addresses: Iterable[str]) -> bool:
    """Whether any of ``addresses`` hashes to ``stored_hash``, in constant time per compare."""
    for address in addresses:
        normalized = normalize_address(address)
        if not normalized:
            continue
        for key in _keys():
            if constant_time_compare(stored_hash, _digest(normalized, key)):
                return True
    return False


def account_addresses(user, *, at_registration: bool = False) -> set[str]:
    """The addresses of ``user`` that may satisfy a bound invite (see module docstring)."""
    from allauth.account.models import EmailAddress

    from accounts.email_change import email_verification_mandatory

    addresses = set(
        EmailAddress.objects.filter(user=user, verified=True).values_list("email", flat=True)
    )
    if user.email and (at_registration or not email_verification_mandatory()):
        addresses.add(user.email)
    return addresses


def recipient_admits(link, user, *, at_registration: bool = False) -> bool:
    """True when ``link`` is unbound (NULL hash) or one of ``user``'s addresses matches it.

    Callers run this on the row they hold locked, before they consume it, so a
    refused redemption writes nothing and leaves the invite usable by the
    person it was sent to.
    """
    stored = getattr(link, "recipient_hash", None)
    if not stored:
        return True
    return address_matches(stored, account_addresses(user, at_registration=at_registration))


def signup_address_admits(link, address: str | None) -> bool:
    """``recipient_admits`` for a registration that has not created its account yet.

    The REST registration view asks this with the validated address once the
    whole form has passed validation, so a mismatch is refused (400) before
    any account exists. Redemption re-checks on the created account.
    """
    stored = getattr(link, "recipient_hash", None)
    if not stored:
        return True
    return address_matches(stored, [address] if isinstance(address, str) else [])


def require_recipient(link, user, *, at_registration: bool = False) -> None:
    """``recipient_admits`` or raise ``InviteTokenError(MISMATCH_CODE)``."""
    from accounts.invite_utils import InviteTokenError

    if not recipient_admits(link, user, at_registration=at_registration):
        logger.info(
            "Invite redemption refused: recipient mismatch. token=%s user_id=%s",
            getattr(link, "prefix", ""), getattr(user, "pk", None),
        )
        raise InviteTokenError(MISMATCH_CODE, MISMATCH_DETAIL)
