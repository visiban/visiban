"""Tests for the shared username-format validator (#1120)."""

from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase
from rest_framework import serializers

from accounts.validators import (
    UsernameFormatValidator,
    is_valid_username_format,
    normalize_username_field_validators,
)


class IsValidUsernameFormatTests(SimpleTestCase):
    def test_accepts_plain_ascii(self):
        self.assertTrue(is_valid_username_format("demo_user.2+x@y-z"))

    def test_accepts_multilingual_bmp_characters(self):
        # Accented Latin, Cyrillic, CJK — all within the Basic Multilingual
        # Plane, all still supported.
        self.assertTrue(is_valid_username_format("Ìvan"))
        self.assertTrue(is_valid_username_format("Иван"))
        self.assertTrue(is_valid_username_format("田中"))

    def test_rejects_disallowed_ascii_characters(self):
        # Same as Django's own UnicodeUsernameValidator — spaces and most
        # punctuation were never allowed.
        self.assertFalse(is_valid_username_format("bad name!"))

    def test_rejects_astral_plane_character(self):
        # U+17521 needs a UTF-16 surrogate pair. Python's `\w` (and so
        # Django's own UnicodeUsernameValidator) accepts it, but a JSON
        # Schema / JavaScript regex evaluating a lone surrogate half against
        # `\w` does not (#1120 — the exact value backend-schema-fuzz wrote).
        self.assertFalse(is_valid_username_format("Ìx\U00017521"))

    def test_rejects_emoji(self):
        self.assertFalse(is_valid_username_format("wave\U0001f44b"))


class UsernameFormatValidatorTests(SimpleTestCase):
    def test_valid_value_passes_silently(self):
        UsernameFormatValidator()("demo_user")

    def test_invalid_value_raises_django_validation_error(self):
        with self.assertRaises(ValidationError):
            UsernameFormatValidator()("Ìx\U00017521")


class NormalizeUsernameFieldValidatorsTests(SimpleTestCase):
    """Regression test: backend-schema-fuzz PATCHed `/api/v1/auth/user/` with a
    BMP Unicode username ("¹iMö"). Django's UnicodeUsernameValidator legitimately
    accepts it (this app supports international usernames), but drf-spectacular
    surfaces that RegexValidator's `\\w`-based pattern verbatim as an OpenAPI
    `pattern`, which ECMA-262 regex engines treat as ASCII-only — so every
    subsequent read of that user failed schema conformance across every
    endpoint embedding it (auth/me, boards, cards, groups)."""

    def _username_field(self):
        field = serializers.CharField(
            max_length=150, validators=[UnicodeUsernameValidator()]
        )
        field.bind("username", None)
        return field

    def test_strips_unicode_username_validator(self):
        field = self._username_field()
        normalize_username_field_validators(field)
        self.assertFalse(
            any(isinstance(v, UnicodeUsernameValidator) for v in field.validators)
        )

    def test_adds_username_format_validator(self):
        field = self._username_field()
        normalize_username_field_validators(field)
        self.assertTrue(
            any(isinstance(v, UsernameFormatValidator) for v in field.validators)
        )

    def test_idempotent_does_not_duplicate_validator(self):
        field = self._username_field()
        normalize_username_field_validators(field)
        normalize_username_field_validators(field)
        count = sum(
            1 for v in field.validators if isinstance(v, UsernameFormatValidator)
        )
        self.assertEqual(count, 1)

    def test_preserves_other_validators(self):
        field = self._username_field()
        field.validators.append(len)  # arbitrary non-matching callable, preserved
        normalize_username_field_validators(field)
        self.assertIn(len, field.validators)
