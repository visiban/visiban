"""Shared username-format validation (#1120).

One definition, reused everywhere a username is written, instead of a
regex duplicated across the model's default `UnicodeUsernameValidator`, a
hand-rolled `re.match` in `ChooseUsernameView`, and no charset check at all
in `RegistrationSerializer`/`AdminCreateUserSerializer` — the gap that let
`backend-schema-fuzz` PATCH `/api/v1/auth/user/` with a username containing
an astral-plane code point (outside the Basic Multilingual Plane). Python's
`\\w` — and so Django's own `UnicodeUsernameValidator` — accepts it, but any
consumer that treats the response as UTF-16 (the JSON Schema conformance
check in `backend-schema-fuzz`, and the JS frontend itself, since neither
speaks Python's native-codepoint string model) does not: a stored
astral-plane username broke the documented `CurrentUser.username`/
`BoardUser.username` schema on every subsequent read of that user, across
every endpoint that embeds them (board membership, group ownership,
checklist item authorship, ...) for the rest of the run.
"""

import re

from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.exceptions import ValidationError as DjangoValidationError

USERNAME_PATTERN = re.compile(r"^[\w.@+-]+$", re.UNICODE)
USERNAME_FORMAT_MESSAGE = (
    "Enter a valid username. This value may contain only letters, numbers, "
    "and @/./+/-/_ characters."
)


def is_valid_username_format(value: str) -> bool:
    """Django's own username charset, minus code points outside the BMP.

    A code point at or above U+10000 needs a UTF-16 surrogate pair; a
    consumer that validates a surrogate half against `\\w` on its own (as
    JSON Schema / JavaScript regexes do by default) will reject it even
    though Python's `re` — operating on whole code points — accepts it.
    """
    return bool(USERNAME_PATTERN.match(value)) and all(ord(char) <= 0xFFFF for char in value)


USERNAME_TAKEN_MESSAGE = "That username is already taken."


def is_username_taken(username: str, exclude_pk=None) -> bool:
    """Whether another account already holds ``username``, ignoring case.

    The one uniqueness rule for every endpoint where a user picks their own
    username — ``POST /auth/choose-username/`` and ``PATCH /auth/me/`` (and
    dj-rest-auth's ``/auth/user/``) — so the two can't drift (#1273: PATCH
    once relied on the model's exact-match ``unique=True`` alone, which lets
    ``Alice`` through next to ``alice`` until the ``unique_username_ci`` DB
    index rejects it as an unhandled IntegrityError). ``exclude_pk`` is the
    requesting user, so re-casing your own name (``alice`` -> ``Alice``) is
    not a collision with yourself.
    """
    from django.contrib.auth import get_user_model  # deferred: app registry
    from django.db.models import CharField, Value
    from django.db.models.functions import Lower

    # Compare on Lower(username), not ``username__iexact``: on PostgreSQL
    # iexact compiles to UPPER(...) = UPPER(...), which cannot use the
    # unique_username_ci functional index on Lower("username") (migration
    # 0021) and would sequentially scan users on every profile save. The
    # candidate is lowered by the database too (not Python's str.lower), so
    # both sides use the same case mapping as the index itself.
    qs = (
        get_user_model()
        .objects.annotate(username_lower=Lower("username"))
        .filter(username_lower=Lower(Value(username, output_field=CharField())))
    )
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.exists()


EMAIL_TAKEN_MESSAGE = "That email address is already in use."


def _other_accounts(exclude_pk):
    from django.contrib.auth import get_user_model  # deferred: app registry

    qs = get_user_model().objects.all()
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs


def username_collides_with_email(username, exclude_pk=None) -> bool:
    """Whether ``username`` equals another ACTIVE account's email, ignoring case (#1221).

    Why this exists: the login backend (``accounts.backends.resolve_login_user``)
    tries an exact username match before a case-insensitive email match, so an
    account whose username is someone else's email address intercepts that
    person's email login (denial of the email-login path, never a takeover).
    Every path where a username is chosen calls this so that state can't be
    created.

    Mirrors the resolver so the check can't be sidestepped: surrounding
    whitespace is ignored (DRF's ``CharField`` strips the login identifier
    before it reaches the backend), case is ignored (``email__iexact``, which
    uses the ``user_email_upper_idx`` index on PostgreSQL), a blank email never
    matches, and only active accounts count — an inactive account's email is
    never resolved by the backend, so there is nothing to protect there.
    ``exclude_pk`` is the account being changed: a username equal to your
    *own* email (very common) is not a collision.
    """
    value = (username or "").strip()
    if not value:
        return False
    return (
        _other_accounts(exclude_pk)
        .filter(is_active=True, email__iexact=value)
        .exclude(email="")
        .exists()
    )


def email_collides_with_identifier(email, exclude_pk=None) -> bool:
    """Whether ``email`` equals another account's username or active email, ignoring case (#1221).

    The email-side counterpart of ``username_collides_with_email``:

    - Another ACTIVE account holding the same email makes it ambiguous, and
      the resolver fails closed on an ambiguous email — so writing a
      duplicate would switch off the existing holder's email login (or, if
      that holder is later reactivated, both). Inactive holders are ignored,
      exactly as the resolver ignores them.
    - Another account's username equal to this email always wins in the
      resolver (rule 1 checks usernames of every account, active or not), so
      this address could never log in *this* account either. Rejecting it
      keeps usernames and emails one namespace.

    Whitespace and case are normalized the same way as the resolver sees
    them; ``exclude_pk`` is the account being changed.
    """
    from django.db.models import CharField, Q, Value
    from django.db.models.functions import Lower

    value = (email or "").strip()
    if not value:
        return False
    return (
        _other_accounts(exclude_pk)
        .annotate(username_lower=Lower("username"))
        .filter(
            Q(username_lower=Lower(Value(value, output_field=CharField())))
            | (Q(is_active=True, email__iexact=value) & ~Q(email=""))
        )
        .exists()
    )


class UsernameFormatValidator:
    """DRF/Django field validator wrapping `is_valid_username_format`."""

    message = USERNAME_FORMAT_MESSAGE
    code = "invalid_username"

    def __call__(self, value):
        if not is_valid_username_format(value):
            raise DjangoValidationError(self.message, code=self.code)

    def __eq__(self, other):
        return isinstance(other, UsernameFormatValidator)


def normalize_username_field_validators(field):
    """Swap a serializer's auto-attached `UnicodeUsernameValidator` for `UsernameFormatValidator`.

    `AbstractUser.username` carries Django's `UnicodeUsernameValidator` (a
    `RegexValidator`) by default, and any ModelSerializer field built from it
    inherits that validator. drf-spectacular surfaces `RegexValidator.regex.pattern`
    verbatim as the OpenAPI `pattern` keyword — but the same regex string means
    different things in the two engines: Python's `re` treats `\\w` as Unicode-aware,
    so this app intentionally accepts international usernames (see
    accounts/tests/test_validators.py), while JSON Schema's `pattern` keyword uses
    ECMA-262 semantics where `\\w` is ASCII-only. A legitimately-accepted Unicode
    username (e.g. "田中") therefore fails schema conformance on every subsequent
    read — this broke `backend-schema-fuzz` on every endpoint that embeds a user
    (auth/me, boards, cards, groups).

    `UsernameFormatValidator` already re-implements the identical charset check
    (plus the astral-plane exclusion from #1120), so dropping the RegexValidator
    instance here loses no write-side validation coverage.
    """
    field.validators = [
        v for v in field.validators if not isinstance(v, UnicodeUsernameValidator)
    ]
    if not any(isinstance(v, UsernameFormatValidator) for v in field.validators):
        field.validators.append(UsernameFormatValidator())
