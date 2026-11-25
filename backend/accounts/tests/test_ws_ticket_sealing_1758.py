"""A tampered or truncated sealed credential must refuse the ticket (#1758).

``test_ws_ticket.py`` covers a tampered *raw ticket* (a cache miss). These
tests alter the cached payload behind a valid ticket, so the refusal has to
come from unsealing.
"""
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase

from accounts.models import User
from accounts.tests.ws_helpers import session_ticket
from accounts.ws_auth import (
    CREDENTIAL_PAT,
    CREDENTIAL_SESSION,
    CREDENTIAL_TOKEN,
    WS_TICKET_TTL,
    _consume_ws_ticket_payload,
    _resolve_ticket_user,
    _seal_credential,
    _ticket_cache_key,
    _unseal_credential,
    session_credential,
)

SESSION_KEY_VALUE = "abcdefghijklmnopqrstuvwxyz012345"


def _flip(value, index):
    """*value* with the character at *index* swapped for a different base64 one."""
    replacement = "A" if value[index] != "A" else "B"
    return value[:index] + replacement + value[index + 1:]


def _damaged(sealed_ref):
    """Altered and truncated copies of a sealed session key, by name."""
    return {
        "first character": _flip(sealed_ref, 0),
        "middle character": _flip(sealed_ref, len(sealed_ref) // 2),
        # Not the last character: its low base64 bits can be padding.
        "inside the MAC": _flip(sealed_ref, len(sealed_ref) - 8),
        "last character cut": sealed_ref[:-1],
        "second half cut": sealed_ref[: len(sealed_ref) // 2],
        "only the head": sealed_ref[:6],
        "extra tail": sealed_ref + "AAAA",
        "plaintext session key": SESSION_KEY_VALUE,
        "empty": "",
    }


class UnsealCredentialTests(SimpleTestCase):

    def test_round_trip(self):
        sealed = _seal_credential(session_credential(SESSION_KEY_VALUE))
        self.assertNotIn(SESSION_KEY_VALUE, repr(sealed))
        self.assertEqual(_unseal_credential(sealed), session_credential(SESSION_KEY_VALUE))
        for kind, ref in ((CREDENTIAL_PAT, 5), (CREDENTIAL_TOKEN, "digest")):
            with self.subTest(kind=kind):
                credential = {"kind": kind, "ref": ref}
                self.assertEqual(_unseal_credential(_seal_credential(credential)), credential)

    def test_tampered_or_truncated_sealed_ref_is_none(self):
        sealed = _seal_credential(session_credential(SESSION_KEY_VALUE))
        for name, value in _damaged(sealed["sealed_ref"]).items():
            with self.subTest(name):
                self.assertIsNone(_unseal_credential({**sealed, "sealed_ref": value}))

    def test_malformed_descriptor_is_none(self):
        for value in (
            None, "session", [], {},
            {"ref": 1},
            {"kind": "carrier-pigeon", "ref": 1},
            {"kind": CREDENTIAL_SESSION},
            {"kind": CREDENTIAL_SESSION, "ref": SESSION_KEY_VALUE},
            {"kind": CREDENTIAL_PAT},
            {"kind": CREDENTIAL_PAT, "ref": None},
            {"kind": CREDENTIAL_TOKEN, "ref": ""},
        ):
            with self.subTest(value=value):
                self.assertIsNone(_unseal_credential(value))


class DamagedTicketPayloadTests(TestCase):
    """The same damage, through ticket redemption."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="sealing", password="pass")

    def _ticket_with_payload(self, mutate):
        ticket, _ = session_ticket(self.user)
        key = _ticket_cache_key(ticket)
        cache.set(key, mutate(cache.get(key)), WS_TICKET_TTL)
        return ticket

    def test_untouched_payload_resolves(self):
        """Control: without it the refusals below could pass for any reason."""
        ticket = self._ticket_with_payload(lambda payload: payload)
        resolved = _resolve_ticket_user.func(ticket)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved[0].pk, self.user.pk)

    def test_damaged_sealed_ref_is_refused_and_the_ticket_is_spent(self):
        for name in _damaged("x" * 40):
            with self.subTest(name):
                def mutate(payload, name=name):
                    credential = payload["credential"]
                    sealed_ref = _damaged(credential["sealed_ref"])[name]
                    return {**payload, "credential": {**credential, "sealed_ref": sealed_ref}}

                ticket = self._ticket_with_payload(mutate)
                self.assertIsNone(_resolve_ticket_user.func(ticket))
                self.assertIsNone(_consume_ws_ticket_payload(ticket))

    def test_truncated_payload_is_refused(self):
        for missing in ("user_id", "credential"):
            with self.subTest(missing=missing):
                ticket = self._ticket_with_payload(
                    lambda payload: {k: v for k, v in payload.items() if k != missing}
                )
                self.assertIsNone(_resolve_ticket_user.func(ticket))
