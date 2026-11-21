"""Strict parsing of the provider email-verified flag (#2201)."""
from types import SimpleNamespace

from django.test import SimpleTestCase

from accounts.adapter import idp_email_is_verified


class IdpEmailIsVerifiedTests(SimpleTestCase):
    def test_boolean_true_is_verified(self):
        self.assertTrue(idp_email_is_verified(SimpleNamespace(verified=True)))

    def test_non_boolean_values_are_unverified(self):
        for value in ("false", "False", "true", "0", "1", "", 0, 1, None, False, [], {}):
            with self.subTest(value=value):
                self.assertFalse(idp_email_is_verified(SimpleNamespace(verified=value)))

    def test_absent_attribute_is_unverified(self):
        self.assertFalse(idp_email_is_verified(SimpleNamespace()))

    def test_absent_address_is_unverified(self):
        self.assertFalse(idp_email_is_verified(None))
