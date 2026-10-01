from django.contrib.auth.tokens import PasswordResetTokenGenerator


class VisibanPasswordResetTokenGenerator(PasswordResetTokenGenerator):
    """allauth's reset-token generator, plus: a password-less account's link is
    bound to the address it was sent to (#1337).

    Wired via ``ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR`` (visiban/settings.py),
    so it is the one generator behind every place a reset token is made or
    checked: both reset-request forms (``accounts.forms._ResetLinkGateMixin``)
    and both redemption entry points — ``POST /api/v1/auth/password/reset/confirm/``
    (dj-rest-auth's confirm serializer imports ``allauth.account.forms.
    default_token_generator``) and ``/accounts/password/reset/key/<uid>-<key>/``
    (allauth's ``UserTokenForm`` uses the same instance).

    Why: a password-less account only ever gets a real reset link for an
    address verified on it (#1314). Links stay valid for days, and the token
    used to encode only the user, so at use time the most anyone could ask was
    "does the account still have *a* verified address". If the address the
    link was mailed to stopped being verified meanwhile — e.g. its owner lost
    control of that mailbox and the account owner unverified or removed it —
    whoever holds the mailbox could still set the account's first password, as
    long as some *other* address on the account was verified.

    How: for an account with no usable password the hash also covers the set
    of addresses verified on it. The link is only ever issued while the target
    address is in that set, so "the set is unchanged at use time" implies "the
    target address is still verified" — no address needs to travel in the URL,
    the URL shape is unchanged, and no server-side record is kept. The cost is
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
        return value + "|verified:" + "|".join(_verified_addresses(user))


def _verified_addresses(user) -> list[str]:
    from allauth.account.models import EmailAddress

    emails = EmailAddress.objects.filter(user=user, verified=True).values_list("email", flat=True)
    return sorted({email.lower() for email in emails})
