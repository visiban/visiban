"""The invite-token kinds that can authorize registration on an INVITE_ONLY site.

One table, keyed on token prefix, replaces the per-call-site ``if group token
... else site token`` branches that #1445 added to the REST registration view,
the OAuth adapter and the OAuth middleware. With board invites (#1444) there
are three kinds, and three hand-written if/else chains is how a new kind gets
honored on one path and silently refused on another.

Each kind supplies:

- ``validate(raw_token)`` — return the invite row, row-locked; raise
  ``InviteTokenError`` if it cannot authorize a registration. Must run inside
  ``transaction.atomic()``.
- ``redeem(invite, user)`` — consume it for the account just created (and, for
  group/board invites, grant the membership). Raises ``InviteTokenError`` when
  the invite was lost to a concurrent redemption.

Site invites (``vbnl_``) are the fallback for any other string, as before: the
site validator answers an unknown token with ``invite_invalid``.

The kind modules are imported lazily: this module is imported by
``accounts.middleware`` and ``accounts.adapter``, which load before the
groups/boards apps are guaranteed ready.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class RegistrationTokenKind:
    name: str
    prefix: str
    validate: Callable[[str], Any]
    redeem: Callable[[Any, Any], None]


def _site_validate(raw_token):
    from .invite_utils import validate_invite_token

    return validate_invite_token(raw_token)


def _site_redeem(link, user):
    from .invite_utils import consume_invite_token

    # The account's email keys the per-address dedup on multi-use links (#925).
    consume_invite_token(link, email=user.email)


def _group_validate(raw_token):
    from groups.invite_registration import validate_group_registration_token

    return validate_group_registration_token(raw_token)


def _group_redeem(link, user):
    from groups.invite_registration import redeem_group_registration_token

    redeem_group_registration_token(link, user)


def _board_validate(raw_token):
    from boards.invites import validate_board_registration_token

    return validate_board_registration_token(raw_token)


def _board_redeem(link, user):
    from boards.invites import redeem_board_registration_token

    redeem_board_registration_token(link, user)


# Prefix literals rather than the model constants so importing this module
# never imports a model; ``accounts/tests`` pins them against the models.
SITE = RegistrationTokenKind("site", "vbnl_", _site_validate, _site_redeem)
GROUP = RegistrationTokenKind("group", "vbng_", _group_validate, _group_redeem)
BOARD = RegistrationTokenKind("board", "vbnb_", _board_validate, _board_redeem)

REGISTRATION_TOKEN_KINDS: tuple[RegistrationTokenKind, ...] = (SITE, GROUP, BOARD)

#: Prefixes the OAuth middleware may stash across the IdP round trip.
STASHABLE_PREFIXES: tuple[str, ...] = tuple(kind.prefix for kind in REGISTRATION_TOKEN_KINDS)


def registration_token_kind(raw_token: str) -> RegistrationTokenKind:
    """The kind for ``raw_token`` by prefix; the site kind for anything else."""
    token = (raw_token or "").strip()
    for kind in REGISTRATION_TOKEN_KINDS:
        if token.startswith(kind.prefix):
            return kind
    return SITE
