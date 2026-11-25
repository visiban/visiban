"""Direct unit tests for the invite recipient matching helpers (#1758).

``test_invite_recipient_binding.py`` covers these end to end and pins case,
whitespace and ``+tag`` handling through ``hash_recipient``. This file pins the
matching functions themselves, including what normalization does *not* fold:
every non-match here refuses the invite.
"""
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from accounts.models import User
from visiban.invite_recipient import (
    address_matches,
    hash_recipient,
    normalize_address,
    recipient_admits,
    signup_address_admits,
)

INVITED = "invitee@example.org"


def _link(address=INVITED):
    return SimpleNamespace(recipient_hash=hash_recipient(address))


class NormalizeAddressTests(SimpleTestCase):

    def test_strips_surrounding_whitespace_and_lowercases(self):
        self.assertEqual(normalize_address(" \t Invitee@EXAMPLE.org\r\n"), INVITED)

    def test_blank_and_absent_normalize_to_empty(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.assertEqual(normalize_address(value), "")

    def test_provider_specific_folding_is_not_applied(self):
        for value in ("in.vitee@example.org", "invitee+tag@example.org"):
            with self.subTest(value=value):
                self.assertEqual(normalize_address(value), value)

    def test_non_ascii_is_lowercased_but_not_case_folded_or_composed(self):
        self.assertEqual(normalize_address("ÉLODIE@Example.org"), "élodie@example.org")
        # lower(), not casefold(): sharp s stays distinct from "ss".
        self.assertEqual(normalize_address("straße@example.org"), "straße@example.org")
        # No Unicode normalization: a decomposed accent stays decomposed.
        self.assertNotEqual(normalize_address("élodie@example.org"), "élodie@example.org")


class AddressMatchesTests(SimpleTestCase):

    def test_any_matching_address_admits(self):
        stored = hash_recipient(INVITED)
        self.assertTrue(address_matches(stored, iter(["other@example.org", " INVITEE@example.org "])))

    def test_no_address_or_only_blank_addresses_refuses(self):
        stored = hash_recipient(INVITED)
        for addresses in ([], [""], [None], ["   "]):
            with self.subTest(addresses=addresses):
                self.assertFalse(address_matches(stored, addresses))

    def test_lookalike_addresses_refuse(self):
        stored = hash_recipient(INVITED)
        for address in (
            "invitee+tag@example.org",
            "in.vitee@example.org",
            "invitee@example.org.evil.test",
            "invіtee@example.org",  # Cyrillic i
            "invitee @example.org",
        ):
            with self.subTest(address=address):
                self.assertFalse(address_matches(stored, [address]))

    def test_plus_tagged_invite_does_not_admit_the_base_mailbox(self):
        stored = hash_recipient("invitee+tag@example.org")
        self.assertFalse(address_matches(stored, [INVITED]))
        self.assertTrue(address_matches(stored, ["Invitee+Tag@example.org"]))


class SignupAddressAdmitsTests(SimpleTestCase):

    def test_bound_link_admits_only_the_invited_address(self):
        self.assertTrue(signup_address_admits(_link(), " Invitee@Example.ORG "))
        self.assertFalse(signup_address_admits(_link(), "other@example.org"))

    def test_bound_link_refuses_an_absent_or_non_string_address(self):
        for address in (None, "", "   ", [INVITED], {"email": INVITED}, 1):
            with self.subTest(address=address):
                self.assertFalse(signup_address_admits(_link(), address))

    def test_empty_stored_hash_is_unbound(self):
        for stored in (None, ""):
            with self.subTest(stored=stored):
                self.assertTrue(signup_address_admits(SimpleNamespace(recipient_hash=stored), None))


class RecipientAdmitsTests(TestCase):

    def _user(self, email):
        return User.objects.create_user(username="recipient", password="x", email=email)

    def test_bound_link_admits_the_matching_account(self):
        user = self._user("Invitee@Example.org")
        self.assertTrue(recipient_admits(_link(), user, at_registration=True))

    def test_bound_link_refuses_another_account(self):
        user = self._user("other@example.org")
        self.assertFalse(recipient_admits(_link(), user, at_registration=True))

    def test_bound_link_refuses_an_account_with_no_address(self):
        user = self._user("")
        self.assertFalse(recipient_admits(_link(), user, at_registration=True))
