"""Functional rate limit (429) tests (#412).

Verifies that a throttled endpoint returns 429 after the limit is exceeded.
Uses the share_link scope with a temporarily lowered rate so the test runs
quickly without needing hundreds of requests.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership


class ShareLinkRateLimitTests(TestCase):
    """Covers #412: hitting a throttled endpoint repeatedly returns 429."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner_rl", password="pass")
        self.board = Board.objects.create(name="Rate Board", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        # Enable share token so the endpoint has something to serve
        import uuid
        self.board.share_token = uuid.uuid4()
        self.board.save(update_fields=["share_token"])
        self.url = f"/api/share/{self.board.share_token}/"
        self.client = APIClient()

    def test_returns_429_after_exceeding_rate_limit(self):
        """After exceeding the rate limit, subsequent requests get 429.

        SimpleRateThrottle caches its parsed rate at the class level, so
        override_settings alone is not sufficient. We patch get_rate()
        on the ShareLinkThrottle class to return a very low limit.
        """
        from django.core.cache import cache
        from boards.views import ShareLinkThrottle

        cache.clear()  # Ensure no stale throttle state from other tests

        with patch.object(ShareLinkThrottle, "get_rate", return_value="3/min"):
            # Also clear the cached rate/num_requests/duration on the class
            # so the patched get_rate() is actually called.
            original_rate = getattr(ShareLinkThrottle, "rate", None)
            original_num = getattr(ShareLinkThrottle, "num_requests", None)
            original_dur = getattr(ShareLinkThrottle, "duration", None)
            ShareLinkThrottle.rate = None
            ShareLinkThrottle.num_requests = None
            ShareLinkThrottle.duration = None
            try:
                # The first 3 requests should succeed (200)
                for i in range(3):
                    r = self.client.get(self.url)
                    self.assertEqual(
                        r.status_code, status.HTTP_200_OK,
                        f"Request {i+1} should succeed but got {r.status_code}",
                    )

                # The 4th request should be throttled
                r = self.client.get(self.url)
                self.assertEqual(r.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            finally:
                ShareLinkThrottle.rate = original_rate
                ShareLinkThrottle.num_requests = original_num
                ShareLinkThrottle.duration = original_dur


class AnonRateLimitWiringTests(TestCase):
    """Verify that default throttle classes are properly configured."""

    def test_anon_throttle_in_default_classes(self):
        from django.conf import settings
        classes = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_CLASSES", [])
        self.assertIn("rest_framework.throttling.AnonRateThrottle", classes)

    def test_user_throttle_in_default_classes(self):
        from django.conf import settings
        classes = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_CLASSES", [])
        self.assertIn("rest_framework.throttling.UserRateThrottle", classes)

    def test_share_link_rate_is_configured(self):
        from django.conf import settings
        rates = settings.REST_FRAMEWORK.get("DEFAULT_THROTTLE_RATES", {})
        self.assertIn("share_link", rates)

    def test_share_board_view_has_throttle_class(self):
        from boards.views import ShareBoardView, ShareLinkThrottle
        self.assertIn(ShareLinkThrottle, ShareBoardView.throttle_classes)
