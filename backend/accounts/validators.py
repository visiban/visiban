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
