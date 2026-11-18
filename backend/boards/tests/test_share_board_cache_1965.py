"""The public share-link board body is cached briefly and never outlives the link (#1965)."""
from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "share-1965"}}


@override_settings(CACHES=LOCMEM, SHARE_BOARD_CACHE_TTL_SECONDS=60)
class ShareBoardCacheTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.admin = User.objects.create_user(username="a1965", password="pw")
        self.board = Board.objects.create(name="Shared", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        self.col = Column.objects.create(board=self.board, name="Todo", position=0)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane, title="Original",
            created_by=self.admin, position=0,
        )
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.admin)
        self.token = self.admin_client.post(f"/api/v1/boards/{self.board.id}/share/").data["share_token"]
        self.anon = APIClient()
        self.url = f"/api/share/{self.token}/"
        cache.clear()

    def _titles(self, r):
        return [c["title"] for c in r.json()["cards"]]

    def test_second_hit_is_served_from_cache(self):
        first = self.anon.get(self.url)
        self.assertEqual(first.status_code, 200)
        with CaptureQueriesContext(connection) as ctx:
            second = self.anon.get(self.url)
        self.assertEqual(second.json(), first.json())
        # Only the token lookup (board + joined enabler, membership check): no
        # card, column, swimlane or label queries.
        self.assertFalse([q for q in ctx.captured_queries if '"cards"' in q["sql"] or '"columns"' in q["sql"]])

    def test_card_change_through_the_api_invalidates(self):
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Original"])
        with self.captureOnCommitCallbacks(execute=True):
            r = self.admin_client.patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/", {"title": "Renamed"}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Renamed"])

    def test_board_event_invalidates(self):
        from boards.broadcast import broadcast_board_event
        self.anon.get(self.url)
        Card.objects.filter(pk=self.card.pk).update(title="Direct")
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Original"])  # bounded by TTL only
        broadcast_board_event(self.board.pk, "card.updated", {})
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Direct"])

    def test_other_boards_event_does_not_invalidate(self):
        from boards.broadcast import broadcast_board_event
        self.anon.get(self.url)
        Card.objects.filter(pk=self.card.pk).update(title="Direct")
        broadcast_board_event(self.board.pk + 999, "card.updated", {})
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Original"])

    def test_revoke_is_immediate_with_warm_cache(self):
        self.assertEqual(self.anon.get(self.url).status_code, 200)
        self.admin_client.delete(f"/api/v1/boards/{self.board.id}/share/")
        self.assertEqual(self.anon.get(self.url).status_code, 404)

    def test_rotation_retires_the_old_token_with_warm_cache(self):
        self.anon.get(self.url)
        new = self.admin_client.post(f"/api/v1/boards/{self.board.id}/share/").data["share_token"]
        # POST always issues a fresh UUID, so a same-token result is a bug, not
        # a case to skip.
        self.assertNotEqual(new, self.token)
        self.assertEqual(self.anon.get(self.url).status_code, 404)
        self.assertEqual(self.anon.get(f"/api/share/{new}/").status_code, 200)

    def test_expiry_is_immediate_with_warm_cache(self):
        self.assertEqual(self.anon.get(self.url).status_code, 200)
        Board.objects.filter(pk=self.board.pk).update(share_token_expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.anon.get(self.url).status_code, 410)

    def test_enabler_deactivated_is_immediate_with_warm_cache(self):
        self.assertEqual(self.anon.get(self.url).status_code, 200)
        User.objects.filter(pk=self.admin.pk).update(is_active=False)
        self.assertEqual(self.anon.get(self.url).status_code, 404)

    def test_cache_key_never_holds_the_raw_token(self):
        self.anon.get(self.url)
        from django.core.cache import caches
        keys = list(caches["default"]._cache.keys())  # locmem internals
        self.assertTrue(any("share_board_body" in k for k in keys))
        self.assertFalse(any(self.token in k or self.token.replace("-", "") in k for k in keys))

    @override_settings(SHARE_BOARD_CACHE_TTL_SECONDS=0)
    def test_ttl_zero_disables_caching(self):
        self.anon.get(self.url)
        Card.objects.filter(pk=self.card.pk).update(title="Direct")
        self.assertEqual(self._titles(self.anon.get(self.url)), ["Direct"])

    def test_stale_board_name_is_not_cached_under_the_new_version(self):
        """The board row is re-read on a miss, so a rename between the token
        lookup and the version read cannot be cached under the newer version."""
        from boards.views import share as share_view
        real = share_view.share_cache.get_or_build

        def rename_then_build(board, token_hash, build):
            Board.objects.filter(pk=board.pk).update(name="Renamed")
            return real(board, token_hash, build)

        with patch.object(share_view.share_cache, "get_or_build", rename_then_build):
            first = self.anon.get(self.url)
        self.assertEqual(first.json()["name"], "Renamed")
        self.assertEqual(self.anon.get(self.url).json()["name"], "Renamed")


@override_settings(CACHES=LOCMEM, SHARE_BOARD_CACHE_TTL_SECONDS=60)
class ShareBoardCacheFailOpenTests(TestCase):
    """A cache outage or a bad TTL setting never fails a request or a write."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.admin = User.objects.create_user(username="f1965", password="pw")
        self.board = Board.objects.create(name="Shared", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        self.col = Column.objects.create(board=self.board, name="Todo", position=0)
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane, title="Original",
            created_by=self.admin, position=0,
        )
        self.admin_client = APIClient()
        self.admin_client.force_authenticate(self.admin)
        token = self.admin_client.post(f"/api/v1/boards/{self.board.id}/share/").data["share_token"]
        self.anon = APIClient()
        self.url = f"/api/share/{token}/"
        cache.clear()

    def _titles(self, r):
        return [c["title"] for c in r.json()["cards"]]

    @staticmethod
    def _failing(method):
        """Wrap ``cache.<method>`` to raise only for share-cache keys.

        The throttle and session layers use the same cache; failing all of it
        would test them, not the share cache's fail-open path.
        """
        real = getattr(cache, method)

        def wrapper(key, *args, **kwargs):
            if str(key).startswith("share_board_"):
                raise RuntimeError("cache down")
            return real(key, *args, **kwargs)

        return wrapper

    def test_cache_get_raising_serves_fresh_data(self):
        with patch.object(cache, "get", self._failing("get")):
            r = self.anon.get(self.url)
            Card.objects.filter(pk=self.card.pk).update(title="Direct")
            r2 = self.anon.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._titles(r), ["Original"])
        self.assertEqual(self._titles(r2), ["Direct"])

    def test_cache_set_raising_serves_fresh_data(self):
        with patch.object(cache, "set", self._failing("set")):
            r = self.anon.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._titles(r), ["Original"])

    def test_version_bump_raising_does_not_fail_the_write(self):
        from boards.services.share_cache import bump_board_version
        with patch.object(cache, "set", self._failing("set")):
            bump_board_version(self.board.pk)  # must not raise
            with self.captureOnCommitCallbacks(execute=True):
                r = self.admin_client.patch(
                    f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/", {"title": "Renamed"}, format="json",
                )
        self.assertEqual(r.status_code, 200, r.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Renamed")

    def test_bad_ttl_values_fall_back_or_disable(self):
        from boards.services import share_cache
        with override_settings(SHARE_BOARD_CACHE_TTL_SECONDS="abc"):
            self.assertEqual(share_cache._ttl(), share_cache.DEFAULT_TTL_SECONDS)
            self.assertEqual(self.anon.get(self.url).status_code, 200)
        with override_settings(SHARE_BOARD_CACHE_TTL_SECONDS=None):
            self.assertEqual(share_cache._ttl(), share_cache.DEFAULT_TTL_SECONDS)
        # A negative value is "not positive", which disables caching like 0.
        with override_settings(SHARE_BOARD_CACHE_TTL_SECONDS=-5):
            self.anon.get(self.url)
            Card.objects.filter(pk=self.card.pk).update(title="Direct")
            self.assertEqual(self._titles(self.anon.get(self.url)), ["Direct"])
