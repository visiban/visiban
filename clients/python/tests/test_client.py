from __future__ import annotations

import unittest

from visiban_client import (
    Client,
    MemoryCursorStore,
    ProtocolError,
    ResyncUnsupported,
)
from visiban_client.cursor import CursorStore

from .helpers import ScriptedServer


class ConstructorTests(unittest.TestCase):
    def test_requires_token(self):
        with self.assertRaises(ValueError):
            Client("http://127.0.0.1:1", "")

    def test_rejects_non_http_scheme(self):
        with self.assertRaises(ValueError):
            Client("file:///etc/passwd", "vbn_x")

    def test_rejects_token_with_whitespace_without_echoing_it(self):
        for token in ("vbn_secret\n", "vbn secret", "vbn_\x00x"):
            with self.subTest(token), self.assertRaises(ValueError) as ctx:
                Client("http://127.0.0.1:1", token)
            self.assertNotIn("vbn", str(ctx.exception))

    def test_rejects_credentials_in_base_url_without_echoing_them(self):
        with self.assertRaises(ValueError) as ctx:
            Client("https://user:" + "hunter2" + "@example.com", "vbn_x")
        self.assertNotIn("hunter2", str(ctx.exception))
        with self.assertRaises(ValueError):
            Client("https://user@example.com", "vbn_x")

    def test_refuses_plain_http_to_remote_host(self):
        with self.assertRaises(ValueError):
            Client("http://example.com", "vbn_x")
        Client("http://example.com", "vbn_x", allow_insecure=True)
        Client("https://example.com", "vbn_x")

    def test_limit_and_overlap_validated(self):
        client = Client("http://127.0.0.1:1", "vbn_x")
        for kwargs in ({"limit": 0}, {"limit": 501}, {"overlap": -1}):
            with self.subTest(kwargs), self.assertRaises(ValueError):
                next(client.iter_events(1, **kwargs))


class TransportTests(unittest.TestCase):
    def test_memory_store_is_a_cursor_store(self):
        self.assertIsInstance(MemoryCursorStore(), CursorStore)

    def test_redirect_is_not_followed(self):
        # A redirect would re-send the Authorization header to another origin.
        with ScriptedServer([{"status": 302, "headers": {"Location": "http://127.0.0.1:9/x"}, "body": None}]) as s:
            client = Client(s.url, "vbn_x", sleep=lambda _s: None)
            with self.assertRaises(Exception) as ctx:
                list(client.iter_events(1))
            self.assertEqual(getattr(ctx.exception, "status", None), 302)
            self.assertEqual(len(s.requests), 1)

    def test_network_error_retries_then_raises(self):
        sleeps = []
        client = Client("http://127.0.0.1:1", "vbn_x", max_retries=2, jitter=False, sleep=sleeps.append)
        with self.assertRaises(Exception) as ctx:
            list(client.iter_events(1))
        self.assertEqual(sleeps, [0.5, 1.0])
        self.assertEqual(type(ctx.exception).__name__, "RetriesExhausted")

    def test_truncated_body_is_retried(self):
        sleeps = []
        ok = {"status": 200, "body": {"results": [{"id": 1}], "next_cursor": None}}
        with ScriptedServer([dict(ok, truncate=True), ok]) as s:
            items = list(Client(s.url, "vbn_x", jitter=False, sleep=sleeps.append).iter_events(1))
        self.assertEqual([i["id"] for i in items], [1])
        self.assertEqual(sleeps, [0.5])

    def test_truncated_error_body_is_retried_then_typed(self):
        sleeps = []
        bad = {"status": 500, "body": {"detail": "x"}, "truncate": True}
        with ScriptedServer([bad, bad]) as s:
            client = Client(s.url, "vbn_x", max_retries=1, jitter=False, sleep=sleeps.append)
            with self.assertRaises(Exception) as ctx:
                list(client.iter_events(1))
        self.assertEqual(type(ctx.exception).__name__, "RetriesExhausted")

    def test_invalid_json_success_body_is_a_protocol_error(self):
        with ScriptedServer([{"status": 200, "body": "not-a-page"}]) as s:
            with self.assertRaises(ProtocolError):
                list(Client(s.url, "vbn_x").iter_events(1))

    def test_backoff_is_capped(self):
        sleeps = []
        with ScriptedServer([{"status": 500, "body": None}] * 4) as s:
            client = Client(s.url, "vbn_x", max_retries=3, backoff_base=1, backoff_max=2, jitter=False, sleep=sleeps.append)
            with self.assertRaises(Exception):
                list(client.iter_events(1))
        self.assertEqual(sleeps, [1, 2, 2])

    def test_jittered_backoff_stays_in_bounds(self):
        sleeps = []
        with ScriptedServer([{"status": 500, "body": None}] * 3) as s:
            client = Client(s.url, "vbn_x", max_retries=2, backoff_base=1, sleep=sleeps.append)
            with self.assertRaises(Exception):
                list(client.iter_events(1))
        self.assertTrue(0.5 <= sleeps[0] <= 1.0 and 1.0 <= sleeps[1] <= 2.0, sleeps)

    def test_retry_after_is_capped(self):
        sleeps = []
        with ScriptedServer([{"status": 429, "headers": {"Retry-After": "9999"}, "body": None}, {"status": 200, "body": {"results": [], "next_cursor": None}}]) as s:
            client = Client(s.url, "vbn_x", backoff_max=7, sleep=sleeps.append)
            list(client.iter_events(1))
        self.assertEqual(sleeps, [7.0])


class ProtocolTests(unittest.TestCase):
    def _run(self, body, **kw):
        with ScriptedServer([{"status": 200, "body": body}]) as s:
            return list(Client(s.url, "vbn_x", sleep=lambda _s: None).iter_events(1, **kw))

    def test_bad_shapes(self):
        for body in (
            [],
            {"results": "x"},
            {"results": [], "next_cursor": "5"},
            {"results": [{"event": "no id"}], "next_cursor": None},
            {"results": [{"id": True}], "next_cursor": None},
        ):
            with self.subTest(body), self.assertRaises(ProtocolError):
                self._run(body)

    def test_resync_requires_resync_url(self):
        with ScriptedServer([{"status": 410, "body": {"code": "cursor_expired", "next_cursor": 4}}]) as s:
            with self.assertRaises(ProtocolError):
                list(Client(s.url, "vbn_x").iter_events(1, cursor=1))

    def test_resync_snapshot_must_be_object(self):
        gone = {"code": "cursor_expired", "next_cursor": 4, "resync_url": "http://x/api/v1/boards/1/full/"}
        with ScriptedServer([{"status": 410, "body": gone}, {"status": 200, "body": [1]}]) as s:
            with self.assertRaises(ProtocolError):
                list(Client(s.url, "vbn_x").iter_events(1, cursor=1))

    def test_unsupported_error_carries_resync_url(self):
        gone = {"code": "cursor_expired", "resync_url": "http://x/api/v1/boards/1/full/"}
        with ScriptedServer([{"status": 410, "body": gone}]) as s:
            with self.assertRaises(ResyncUnsupported) as ctx:
                list(Client(s.url, "vbn_x").iter_events(1, cursor=1))
        self.assertEqual(ctx.exception.resync_url, gone["resync_url"])

    def test_non_ascii_retry_after_does_not_crash(self):
        sleeps = []
        with ScriptedServer([{"status": 429, "headers": {"Retry-After": "\u00b2"}, "body": None}, {"status": 200, "body": {"results": [], "next_cursor": None}}]) as s:
            list(Client(s.url, "vbn_x", jitter=False, sleep=sleeps.append).iter_events(1))
        self.assertEqual(sleeps, [0.5])

    def test_repeated_410_gives_up(self):
        gone = {"code": "cursor_expired", "next_cursor": 4, "resync_url": "http://x/api/v1/boards/1/full/"}
        responses = [{"status": 410, "body": gone}, {"status": 200, "body": {"id": 1}}] * 4
        with ScriptedServer(responses) as s:
            seen = 0
            with self.assertRaises(ProtocolError):
                for _ in Client(s.url, "vbn_x").iter_events(1, cursor=1):
                    seen += 1
        self.assertEqual(seen, 3)

    def test_negative_resync_cursor_is_rejected(self):
        gone = {"code": "cursor_expired", "next_cursor": -1, "resync_url": "http://x/api/v1/boards/1/full/"}
        with ScriptedServer([{"status": 410, "body": gone}]) as s:
            with self.assertRaises(ProtocolError):
                list(Client(s.url, "vbn_x").iter_events(1, cursor=1))

    def test_non_cursor_expired_410_is_an_api_error(self):
        with ScriptedServer([{"status": 410, "body": {"detail": "gone", "code": "other"}}]) as s:
            with self.assertRaises(Exception) as ctx:
                list(Client(s.url, "vbn_x").iter_events(1))
        self.assertEqual(ctx.exception.status, 410)


if __name__ == "__main__":
    unittest.main()
