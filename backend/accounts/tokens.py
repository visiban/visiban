import json
import secrets

from django.contrib.auth.tokens import PasswordResetTokenGenerator

# Separates allauth's hash value from the verified-address suffix. NUL cannot
# occur in an email address (allauth's validators reject control characters),
# and the suffix itself is JSON, so no address can blur the boundary between
# allauth's trailing "|".join(emails) and the suffix, or between two verified
# addresses (#1337 security-review: "a|b" vs {"a", "b"}).
_SUFFIX_SEPARATOR = "\x00verified:"


class VisibanPasswordResetTokenGenerator(PasswordResetTokenGenerator):
    """allauth's reset-token generator, plus: a password-less account's link is
    bound to the address it was sent to (#1337).

    Wired via ``ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR`` (visiban/settings.py),
    so it is the one generator behind every place a reset token is checked:
    ``POST /api/v1/auth/password/reset/confirm/`` (dj-rest-auth's confirm
    serializer imports ``allauth.account.forms.default_token_generator``) and
    ``/accounts/password/reset/key/<uid>-<key>/`` (allauth's ``UserTokenForm``
    uses the same instance). ``accounts.checks`` fails startup if a later
    settings include (e.g. the enterprise one) replaces it.

    Why: a password-less account only ever gets a real reset link for an
    address verified on it (#1314). Links stay valid for days, and the token
    used to encode only the user, so at use time the most anyone could ask was
    "does the account still have *a* verified address". If the address the
    link was mailed to stopped being verified meanwhile — e.g. its owner lost
    control of that mailbox and the account owner unverified or removed it —
    whoever holds the mailbox could still set the account's first password, as
    long as some *other* address on the account was verified.

    How: for an account with no usable password the hash also covers the set
    of addresses verified on it. A link is only ever issued when its address is
    in that set (``AddressBoundTokenGenerator`` checks this against the very
    set it hashes), so "the set is unchanged at use time" implies "the target
    address is still verified" — no address needs to travel in the URL, the
    URL shape is unchanged, and no server-side record is kept. The cost is
    over-invalidation: any change to which addresses are verified voids
    outstanding links for that account, which a re-request fixes. allauth's
    own hash already voids them on any address being added or removed.

    Accounts with a usable password get *exactly* allauth's hash, so their
    outstanding links are unaffected. ``user.password`` is part of Django's
    base hash, so ``has_usable_password()`` cannot differ between when a token
    is made and when it is checked without the token failing anyway.
    """

    def _make_hash_value(self, user, timestamp):
        # Imported lazily: allauth.account.forms instantiates the generator named
        # by ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR at import time, so importing
        # it at module level here would be circular. Delegating (rather than
        # copying allauth's logic) keeps usable-password tokens byte-identical
        # to allauth's across allauth upgrades.
        from allauth.account.forms import EmailAwarePasswordResetTokenGenerator

        value = EmailAwarePasswordResetTokenGenerator()._make_hash_value(user, timestamp)
        if user.has_usable_password():
            return value
        return value + verified_suffix(self._verified_addresses(user))

    def _verified_addresses(self, user) -> list[str]:
        from allauth.account.models import EmailAddress

        emails = EmailAddress.objects.filter(user=user, verified=True).values_list("email", flat=True)
        return sorted({email.lower() for email in emails})


class AddressBoundTokenGenerator(VisibanPasswordResetTokenGenerator):
    """Mints a link for one specific address; used only when *sending* a link.

    ``_ResetLinkGateMixin`` decides a password-less account may get a link
    because the requested address is verified, but the token is minted later,
    in a separate query. If the address were unverified in between, the token
    would be bound to a verified set that no longer contains it — and stay
    redeemable from that mailbox. So the membership check is repeated here,
    against the exact set being hashed: when the address is missing, the hash
    gets a random component and the mailed token can never validate. The user
    sees a dead link and re-requests; that only happens inside the race.

    Redemption uses the plain ``VisibanPasswordResetTokenGenerator`` (it does
    not know the address); for an address that *is* in the set both produce
    the same hash.
    """

    def __init__(self, address: str):
        super().__init__()
        self.address = (address or "").lower()

    def _make_hash_value(self, user, timestamp):
        value = super()._make_hash_value(user, timestamp)
        if user.has_usable_password():
            return value
        # Recompute from the suffix just hashed, not a fresh query, so the check
        # and the hash cannot disagree.
        verified = json.loads(value.rsplit(_SUFFIX_SEPARATOR, 1)[1])
        if self.address not in verified:
            return value + "\x00unbound:" + secrets.token_hex(16)
        return value


def verified_suffix(verified: list[str]) -> str:
    """Unambiguous encoding of the verified-address set appended to the hash."""
    return _SUFFIX_SEPARATOR + json.dumps(sorted(verified))
