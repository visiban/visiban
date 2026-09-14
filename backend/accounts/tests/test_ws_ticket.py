"""Tests for the WebSocket ticket endpoint and ticket lifecycle (#1109).

Covers POST /api/v1/auth/ws-ticket/ (auth, PAT auth, response shape, throttle
scope) and the issue/consume primitives in accounts/ws_auth.py, including the
single-use guarantee under concurrent redemption.
"""
import threading
from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase, TransactionTestCase
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import PersonalAccessToken, User
from accounts.ws_auth import (
    WS_TICKET_TTL,
    _ticket_cache_key,
    consume_ws_ticket,
    issue_ws_ticket,
)

WS_TICKET_URL = "/api/v1/auth/ws-ticket/"


class WSTicketEndpointTests(APITestCase):
    """The endpoint must accept every REST credential, not just a session."""

    def setUp(self):
        self.client = APIClient()
        cache.clear()  # No stale throttle or ticket state from other tests.
        self.user = User.objects.create_user(username="ticketuser", password="pass")

    def test_unauthenticated_request_is_rejected(self):
        r = self.client.post(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_session_authenticated_user_gets_a_ticket(self):
        self.client.force_authenticate(self.user)
        r = self.client.post(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertIn("ticket", r.json())
        self.assertIn("expires_at", r.json())

    def test_pat_authenticated_client_gets_a_ticket(self):
        """The whole point of #1109 — a PAT holder can obtain a ticket."""
        _, raw = PersonalAccessToken.generate(self.user, "cli")
        r = self.client.post(WS_TICKET_URL, HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertTrue(r.json()["ticket"])

    def test_ticket_is_redeemable_for_the_issuing_user(self):
        self.client.force_authenticate(self.user)
        ticket = self.client.post(WS_TICKET_URL).json()["ticket"]
        self.assertEqual(consume_ws_ticket(ticket), self.user.id)

    def test_expires_at_is_a_parseable_timestamp_within_the_ttl(self):
        """Clients use this field to know when to re-request, so its value
        matters, not just its presence. The view hands DRF a raw datetime and
        relies on the renderer; this pins the rendered result."""
        from datetime import datetime

        from django.utils import timezone

        self.client.force_authenticate(self.user)
        body = self.client.post(WS_TICKET_URL).json()
        expires_at = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00"))
        delta = (expires_at - timezone.now()).total_seconds()
        self.assertGreater(delta, 0)
        self.assertLessEqual(delta, WS_TICKET_TTL)

    def test_each_request_returns_a_distinct_ticket(self):
        self.client.force_authenticate(self.user)
        first = self.client.post(WS_TICKET_URL).json()["ticket"]
        second = self.client.post(WS_TICKET_URL).json()["ticket"]
        self.assertNotEqual(first, second)

    def test_raw_ticket_is_not_stored_in_the_cache(self):
        """Only the SHA-256 digest is persisted — never the raw value."""
        self.client.force_authenticate(self.user)
        ticket = self.client.post(WS_TICKET_URL).json()["ticket"]
        self.assertIsNone(cache.get(f"ws_ticket:{ticket}"))
        self.assertIsNotNone(cache.get(_ticket_cache_key(ticket)))

    def test_pending_password_change_is_blocked(self):
        """A forced password change blocks the rest of the API — and realtime.

        Without this gate a user locked out of every REST endpoint would still
        have a side channel into live board data.
        """
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.client.force_authenticate(self.user)
        r = self.client.post(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_pending_username_change_is_blocked(self):
        self.user.must_change_username = True
        self.user.save(update_fields=["must_change_username"])
        self.client.force_authenticate(self.user)
        r = self.client.post(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_is_not_allowed(self):
        self.client.force_authenticate(self.user)
        r = self.client.get(WS_TICKET_URL)
        self.assertEqual(r.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_endpoint_is_throttled(self):
        """A scripted loop farming tickets must eventually get a 429.

        SimpleRateThrottle caches its parsed rate on the class, so patching
        get_rate() alone is not enough — the cached attributes are cleared too.
        Mirrors boards/tests/test_rate_limiting.py.
        """
        from accounts.views import WSTicketThrottle

        self.client.force_authenticate(self.user)
        cache.clear()

        with patch.object(WSTicketThrottle, "get_rate", return_value="3/min"):
            original = (
                getattr(WSTicketThrottle, "rate", None),
                getattr(WSTicketThrottle, "num_requests", None),
                getattr(WSTicketThrottle, "duration", None),
            )
            WSTicketThrottle.rate = None
            WSTicketThrottle.num_requests = None
            WSTicketThrottle.duration = None
            try:
                for i in range(3):
                    r = self.client.post(WS_TICKET_URL)
                    self.assertEqual(
                        r.status_code, status.HTTP_201_CREATED,
                        f"Request {i + 1} should succeed, got {r.status_code}",
                    )
                r = self.client.post(WS_TICKET_URL)
                self.assertEqual(r.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            finally:
                (
                    WSTicketThrottle.rate,
                    WSTicketThrottle.num_requests,
                    WSTicketThrottle.duration,
                ) = original

    def test_throttle_scope_is_registered_in_settings(self):
        """A scope with no configured rate silently throttles nothing."""
        from django.conf import settings

        from accounts.views import WSTicketThrottle

        self.assertEqual(WSTicketThrottle.scope, "ws_ticket")
        self.assertIn(
            "ws_ticket", settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        )


class WSTicketLifecycleTests(TestCase):
    """Issue/consume primitives: single use, expiry, and tampering."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="lifecycle", password="pass")

    def test_ticket_is_single_use(self):
        ticket, _ = issue_ws_ticket(self.user)
        self.assertEqual(consume_ws_ticket(ticket), self.user.id)
        self.assertIsNone(consume_ws_ticket(ticket))

    def test_expired_ticket_is_rejected(self):
        """An expired ticket is simply gone from the cache."""
        ticket, _ = issue_ws_ticket(self.user)
        cache.delete(_ticket_cache_key(ticket))
        self.assertIsNone(consume_ws_ticket(ticket))

    def test_tampered_ticket_is_rejected(self):
        ticket, _ = issue_ws_ticket(self.user)
        self.assertIsNone(consume_ws_ticket(ticket + "x"))
        # The real ticket is untouched by a failed attempt on a forged one.
        self.assertEqual(consume_ws_ticket(ticket), self.user.id)

    def test_unknown_and_empty_tickets_are_rejected(self):
        self.assertIsNone(consume_ws_ticket(""))
        self.assertIsNone(consume_ws_ticket(None))
        self.assertIsNone(consume_ws_ticket("never-issued"))

    def test_absurdly_long_ticket_is_rejected_without_hashing(self):
        self.assertIsNone(consume_ws_ticket("x" * 5000))

    def test_oversized_query_string_is_rejected_before_parsing(self):
        """Bound the raw bytes, not just the extracted value.

        The per-value cap fires only after parse_qs has already decoded and split
        the whole query string, so without this bound a hostile handshake could
        make the server do that work on a multi-megabyte input. Nginx's default
        header limits normally stop it first, but that backstop is gone when the
        ASGI server is reached directly.
        """
        from accounts.ws_auth import _MAX_QUERY_STRING_LENGTH, _extract_ticket

        oversized = b"ticket=x&" + (b"a=1&" * _MAX_QUERY_STRING_LENGTH)
        self.assertGreater(len(oversized), _MAX_QUERY_STRING_LENGTH)
        self.assertEqual(_extract_ticket(oversized), "")

    def test_query_string_at_the_bound_is_still_parsed(self):
        """The bound must not reject a legitimate handshake."""
        from accounts.ws_auth import _extract_ticket

        self.assertEqual(_extract_ticket(b"ticket=abc123"), "abc123")

    def test_repeated_ticket_param_uses_the_first_value(self):
        """Pin the precedence so a refactor cannot silently switch to the last
        value or join them — either would change which ticket gets spent."""
        from accounts.ws_auth import _extract_ticket

        self.assertEqual(_extract_ticket(b"ticket=first&ticket=second"), "first")

    def test_expires_at_reflects_the_configured_ttl(self):
        from django.utils import timezone

        _, expires_at = issue_ws_ticket(self.user)
        delta = (expires_at - timezone.now()).total_seconds()
        self.assertGreater(delta, 0)
        self.assertLessEqual(delta, WS_TICKET_TTL)


class WSTicketConcurrencyTests(TransactionTestCase):
    """Two simultaneous redemptions of one ticket: exactly one may win.

    A get-then-delete implementation that trusts the get() would let both
    through. The claim is gated on cache.delete()'s return value precisely so
    this test fails if anybody reverses that.
    """

    def test_only_one_of_two_concurrent_redemptions_succeeds(self):
        cache.clear()
        user = User.objects.create_user(username="racer", password="pass")
        ticket, _ = issue_ws_ticket(user)

        results = []
        lock = threading.Lock()
        barrier = threading.Barrier(2)

        def redeem():
            barrier.wait()  # Both threads redeem at the same instant.
            outcome = consume_ws_ticket(ticket)
            with lock:
                results.append(outcome)
            # Release the thread-local DB connection. Without this,
            # TransactionTestCase.teardown_databases() fails with
            # "database is being accessed by other users" on DROP.
            from django.db import connections as _conns
            _conns.close_all()

        threads = [threading.Thread(target=redeem) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        winners = [r for r in results if r == user.id]
        self.assertEqual(
            len(winners), 1, f"Expected exactly one winner, got: {results}"
        )
        self.assertEqual(results.count(None), 1)
