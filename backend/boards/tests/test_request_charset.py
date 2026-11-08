"""A request charset that decodes to a lone surrogate is a 400, never a 500 (#2120).

Django honors ``charset=`` on the request ``Content-Type``. ``utf-7`` turns the
ASCII ``+2AA-`` into U+D800, which PostgreSQL cannot store, so before
``RequestCharsetMiddleware`` a multipart field (the Trello import) answered 500
on PostgreSQL, and under WSGI (the test client) so did the query string. Under
Daphne/ASGI the query string is always read as UTF-8, so only the form surfaces
are reachable in production. SQLite stores a surrogate silently, so these tests
assert the status, and the PostgreSQL run is the real proof.
"""
import codecs
import encodings
import encodings.aliases
import pkgutil
import json
from pathlib import Path

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, Card, Column, Swimlane


class RequestCharsetTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="cs-owner", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="Keep", created_by=self.user, position=0
        )
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)

    def assertCharsetRefused(self, resp):
        self.assertEqual(resp.status_code, 400, resp.content[:300])
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp.json(), {"detail": "Unsupported request charset. Use UTF-8."})

    def test_query_string_with_utf7_charset_is_400(self):
        resp = self.client.get(
            f"/api/v1/boards/{self.board.pk}/cards/?search=%2B2AA-",
            content_type="text/plain; charset=utf-7",
        )
        self.assertCharsetRefused(resp)

    def test_multipart_trello_import_with_utf7_charset_is_400(self):
        # The real file plus a "name" field of "+2AA-": without the guard the
        # board name reaches PostgreSQL as U+D800 and the confirm answers 500.
        fixture = (Path(__file__).parent / "fixtures" / "trello_export.json").read_bytes()
        body = (
            b'--b\r\nContent-Disposition: form-data; name="file"; filename="t.json"\r\n'
            b"Content-Type: application/json\r\n\r\n" + fixture + b"\r\n"
            b'--b\r\nContent-Disposition: form-data; name="name"\r\n\r\n+2AA-\r\n--b--\r\n'
        )
        resp = self.client.post(
            "/api/v1/boards/import/trello/?confirm=true", data=body,
            content_type="multipart/form-data; boundary=b; charset=utf-7",
        )
        self.assertCharsetRefused(resp)
        self.assertEqual(Board.objects.count(), 1)

    def test_urlencoded_body_with_utf7_charset_is_400(self):
        # An endpoint that really parses a form body. Without the guard this is
        # DRF's field-keyed "Surrogate characters are not allowed" 400, not this detail.
        resp = self.client.post(
            "/api/v1/boards/", data=b"name=%2B2AA-",
            content_type="application/x-www-form-urlencoded; charset=utf-7",
        )
        self.assertCharsetRefused(resp)

    def test_json_body_with_utf7_charset_is_400(self):
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/saved-filters/",
            data=json.dumps({"name": "+2AA-"}).encode(),
            content_type="application/json; charset=utf-7",
        )
        self.assertCharsetRefused(resp)

    def test_other_surrogate_producing_codec_is_refused(self):
        resp = self.client.get(
            f"/api/v1/boards/{self.board.pk}/cards/?search=x",
            content_type="text/plain; charset=unicode-escape",
        )
        self.assertCharsetRefused(resp)

    def test_utf8_and_latin1_charsets_still_work(self):
        for charset in ("utf-8", "UTF-8", "iso-8859-1", "windows-1252", "utf-16", "utf-32"):
            resp = self.client.get(
                f"/api/v1/boards/{self.board.pk}/cards/?search=Keep",
                content_type=f"text/plain; charset={charset}",
            )
            self.assertEqual(resp.status_code, 200, charset)

    def test_unknown_charset_is_ignored_by_django_and_allowed(self):
        resp = self.client.get(
            f"/api/v1/boards/{self.board.pk}/cards/?search=Keep",
            content_type="text/plain; charset=nonsense",
        )
        self.assertEqual(resp.status_code, 200)

    def test_no_charset_is_unaffected(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/cards/?search=%2B2AA-")
        self.assertEqual(resp.status_code, 200)

    def test_multipart_part_header_rfc2231_utf7_filename_is_not_a_500(self):
        # Django drops a part whose Content-Disposition param decodes to a
        # surrogate (its header parser cannot re-encode it); pin that so a
        # Django upgrade that stops doing so shows up here.
        body = (
            b'--b\r\nContent-Disposition: form-data; name="file"; filename*=utf-7\'\'%2B2AA-.json\r\n'
            b'Content-Type: application/json\r\n\r\n{}\r\n--b--\r\n'
        )
        resp = self.client.post(
            "/api/v1/boards/import/trello/?dry_run=true", data=body,
            content_type="multipart/form-data; boundary=b",
        )
        # The part is dropped, so the importer sees no file at all.
        self.assertEqual(resp.status_code, 400, resp.content[:300])
        self.assertEqual(resp.json(), {"detail": "No file provided."})

    def test_legacy_charsets_still_work(self):
        for charset in ("iso-8859-2", "windows-1251", "koi8-r", "shift_jis", "gbk"):
            resp = self.client.get(
                f"/api/v1/boards/{self.board.pk}/cards/?search=Keep",
                content_type=f"text/plain; charset={charset}",
            )
            self.assertEqual(resp.status_code, 200, charset)

    def test_unsafe_codec_aliases_are_refused(self):
        for charset in ("utf7", "u7", "UTF_7", "raw_unicode_escape", "unicode_escape"):
            resp = self.client.get(
                f"/api/v1/boards/{self.board.pk}/cards/?search=x",
                content_type=f"text/plain; charset={charset}",
            )
            self.assertCharsetRefused(resp)

    def test_non_text_codecs_are_refused(self):
        # Called directly: under WSGI Django itself raises while decoding the query string for these
        # while building the request, before any middleware runs, so only the
        # ASGI request (what production serves) reaches the guard with one.
        from django.http import HttpRequest

        from visiban.middleware import RequestCharsetMiddleware

        reached = []
        guard = RequestCharsetMiddleware(lambda request: reached.append(request))
        for charset in ("hex", "base64", "rot13", "zlib", "bz2", "uu", "quopri", "punycode", "idna", "undefined"):
            request = HttpRequest()
            request.encoding = charset
            resp = guard(request)
            self.assertEqual(resp.status_code, 400, charset)
        self.assertEqual(reached, [])


class AdmittedCodecSweepTests(TestCase):
    """No codec the middleware admits turns 1- or 2-byte input into a lone surrogate.

    A codec added by a future Python that does is not in the deny-list, so it
    fails here instead of reaching PostgreSQL as a 500.
    """

    def test_no_admitted_codec_yields_a_lone_surrogate(self):
        from visiban.middleware import _is_unsafe_request_codec

        names = set(encodings.aliases.aliases) | {
            m.name for m in pkgutil.iter_modules(encodings.__path__)
        }
        inputs = [bytes([a]) for a in range(256)]
        # Every lead byte against every third second byte plus the structural ones
        # (escape/shift markers, lead/trail ranges): 2.5x cheaper than the full 64k.
        seconds = sorted(set(range(0, 256, 3)) | {0x2B, 0x2D, 0x5C, 0x75, 0x7F, 0x80, 0xFE, 0xFF})
        inputs += [bytes([a, b]) for a in range(256) for b in seconds]
        admitted = 0
        for name in sorted(names):
            if _is_unsafe_request_codec(name):
                continue
            try:
                info = codecs.lookup(name)
            except LookupError:
                continue
            admitted += 1
            for raw in inputs:
                try:
                    text = raw.decode(info.name, "replace")
                except Exception:  # noqa: BLE001 - a raise is not a surrogate
                    break  # a codec that raises on input cannot be swept further
                self.assertFalse(
                    any("\ud800" <= ch <= "\udfff" for ch in text),
                    f"{name} decodes {raw!r} to a lone surrogate",
                )
        self.assertGreater(admitted, 80)
