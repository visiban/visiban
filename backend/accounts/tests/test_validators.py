"""Tests for the shared username-format validator (#1120)."""

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from accounts.validators import UsernameFormatValidator, is_valid_username_format


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
