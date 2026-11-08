"""Origin validation on WebSocket handshakes through the real ASGI stack."""
import asyncio

from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.conf import settings
from django.test import TransactionTestCase, override_settings

from accounts.models import User
from accounts.tests.ws_helpers import handshake, session_ticket
from boards.models import Board, BoardMembership


def _connect(path, origin=None):
    from visiban import asgi

    headers = [(b"origin", origin.encode())] if origin else []

    async def run():
        comm = WebsocketCommunicator(asgi.application, path, headers=headers)
        connected, detail = await handshake(comm)
        if connected:
            await comm.disconnect()
        return connected, detail

    return asyncio.run(run())


@override_settings(
    ALLOWED_HOSTS=["app.example.com"],
    CORS_ALLOWED_ORIGINS=["https://app.example.com", "http://localhost:5173"],
    CSRF_TRUSTED_ORIGINS=["https://app.example.com"],
)
class WSOriginValidationTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="origin_user", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )

    def _path(self):
        ticket, _ = session_ticket(self.user)
        return f"/ws/boards/{self.board.id}/?ticket={ticket}"

    def test_mismatched_origin_is_refused(self):
        ok, _ = _connect(self._path(), origin="https://evil.example.org")
        self.assertFalse(ok)

    def test_sibling_subdomain_origin_is_refused(self):
        ok, _ = _connect(self._path(), origin="https://user.app.example.com")
        self.assertFalse(ok)

    def test_null_origin_is_refused(self):
        ok, _ = _connect(self._path(), origin="null")
        self.assertFalse(ok)

    def test_missing_origin_with_valid_ticket_is_accepted(self):
        ok, _ = _connect(self._path())
        self.assertTrue(ok)

    def test_configured_spa_origin_is_accepted(self):
        ok, _ = _connect(self._path(), origin="https://app.example.com")
        self.assertTrue(ok)

    def test_dev_origin_from_cors_list_is_accepted(self):
        ok, _ = _connect(self._path(), origin="http://localhost:5173")
        self.assertTrue(ok)

    def test_origin_matching_allowed_hosts_is_accepted(self):
        ok, _ = _connect(self._path(), origin="http://app.example.com")
        self.assertTrue(ok)


def _connect_raw(path, headers):
    from visiban import asgi

    async def run():
        comm = WebsocketCommunicator(asgi.application, path, headers=headers)
        connected, detail = await handshake(comm)
        if connected:
            await comm.disconnect()
        return connected, detail

    return asyncio.run(run())


@override_settings(
    ALLOWED_HOSTS=["app.example.com"],
    CORS_ALLOWED_ORIGINS=["https://app.example.com"],
    CSRF_TRUSTED_ORIGINS=["https://app.example.com"],
)
class WSOriginEdgeCaseTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="origin_edge", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(
            board=self.board, user=self.user, role=BoardMembership.Role.ADMIN
        )

    def _ticket_path(self):
        ticket, _ = session_ticket(self.user)
        return f"/ws/boards/{self.board.id}/?ticket={ticket}"

    def _assert_refused_without_consuming(self, headers):
        path = self._ticket_path()
        ok, code = _connect_raw(path, headers)
        self.assertFalse(ok)
        self.assertEqual(code, 403)
        # The ticket was not spent: the same URL still connects without Origin.
        ok, _ = _connect_raw(path, [])
        self.assertTrue(ok)

    def test_mismatched_origin_closes_403_and_keeps_ticket(self):
        self._assert_refused_without_consuming([(b"origin", b"https://evil.example.org")])

    def test_userinfo_origin_refused(self):
        self._assert_refused_without_consuming([(b"origin", b"https://x@app.example.com")])

    def test_origin_with_path_refused(self):
        self._assert_refused_without_consuming([(b"origin", b"https://app.example.com/x")])

    def test_duplicate_origin_headers_refused(self):
        self._assert_refused_without_consuming(
            [(b"origin", b"https://app.example.com"), (b"origin", b"https://app.example.com")]
        )

    def test_port_mismatch_matches_on_host_only(self):
        """Pinned: the ALLOWED_HOSTS fallback compares the host, not the port."""
        ok, _ = _connect_raw(self._ticket_path(), [(b"origin", b"https://app.example.com:8443")])
        self.assertTrue(ok)

    def test_missing_origin_with_session_cookie_is_accepted(self):
        """Pinned: no Origin falls through to auth (session cookie works)."""
        from accounts.tests.ws_helpers import login_session

        key = login_session(self.user)
        cookie = f"{settings.SESSION_COOKIE_NAME}={key}".encode()
        ok, _ = _connect_raw(f"/ws/boards/{self.board.id}/", [(b"cookie", cookie)])
        self.assertTrue(ok)

    @override_settings(ALLOWED_HOSTS=[".example.com"])
    def test_leading_dot_allowed_hosts_is_not_applied(self):
        """A leading-dot ALLOWED_HOSTS entry no longer matches an Origin host (#1697)."""
        self._assert_refused_without_consuming([(b"origin", b"https://user.example.com")])

    @override_settings(ALLOWED_HOSTS=["*"])
    def test_wildcard_allowed_hosts_is_not_applied(self):
        """'*' no longer matches an Origin host (#1697)."""
        self._assert_refused_without_consuming([(b"origin", b"https://anything.test")])

    @override_settings(
        ALLOWED_HOSTS=["*", ".example.com", "exact.example.com"],
        CORS_ALLOWED_ORIGINS=[],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_exact_host_still_matches_beside_patterns(self):
        for origin in (b"http://exact.example.com", b"https://exact.example.com:8443"):
            ok, _ = _connect_raw(self._ticket_path(), [(b"origin", origin)])
            self.assertTrue(ok, origin)

    @override_settings(ALLOWED_HOSTS=["*.example.com"])
    def test_embedded_wildcard_allowed_hosts_is_not_applied(self):
        self._assert_refused_without_consuming([(b"origin", b"https://*.example.com")])

    @override_settings(
        ALLOWED_HOSTS=["*"],
        CORS_ALLOWED_ORIGINS=["https://boards.example.org"],
        CSRF_TRUSTED_ORIGINS=[],
    )
    def test_wildcard_install_with_listed_origin_connects(self):
        ok, _ = _connect_raw(self._ticket_path(), [(b"origin", b"https://boards.example.org")])
        self.assertTrue(ok)
        self._assert_refused_without_consuming([(b"origin", b"https://other.example.org")])

    @override_settings(
        ALLOWED_HOSTS=["*"], CORS_ALLOWED_ORIGINS=[], CSRF_TRUSTED_ORIGINS=["https://csrf.example.org"]
    )
    def test_wildcard_install_with_csrf_origin_connects(self):
        ok, _ = _connect_raw(self._ticket_path(), [(b"origin", b"https://csrf.example.org")])
        self.assertTrue(ok)

    @override_settings(ALLOWED_HOSTS=["[::1]"], CORS_ALLOWED_ORIGINS=[], CSRF_TRUSTED_ORIGINS=[])
    def test_exact_bracketed_ipv6_host_matches_ignoring_port(self):
        ok, _ = _connect_raw(self._ticket_path(), [(b"origin", b"http://[::1]:5173")])
        self.assertTrue(ok)

    def test_uppercase_origin_host_matches_exact_host(self):
        ok, _ = _connect_raw(self._ticket_path(), [(b"origin", b"HTTPS://APP.EXAMPLE.COM")])
        self.assertTrue(ok)

    @override_settings(ALLOWED_HOSTS=["", "app.example.com"])
    def test_empty_allowed_hosts_entry_is_ignored(self):
        self._assert_refused_without_consuming([(b"origin", b"https://other.example.org")])

    @override_settings(
        ALLOWED_HOSTS=["[.example.com]", "[*]"], CORS_ALLOWED_ORIGINS=[], CSRF_TRUSTED_ORIGINS=[]
    )
    def test_bracketed_pattern_entries_are_not_applied(self):
        self._assert_refused_without_consuming([(b"origin", b"https://user.example.com")])
        self._assert_refused_without_consuming([(b"origin", b"https://anything.test")])
