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

from django.http import JsonResponse
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from visiban.middleware import _is_unsafe_request_codec


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


# Canonical names of every codec CPython 3.11 ships (``codecs.lookup(n).name`` for
# each ``encodings`` module and alias). Each was classified for #2120: the
# surrogate-producing and raising text codecs and the non-text codecs are in
# ``_UNSAFE_REQUEST_CODECS`` or fail ``"".encode()``; all the rest were swept below.
_CLASSIFIED_CODECS = frozenset({
    'ascii', 'base64', 'big5', 'big5hkscs', 'bz2', 'charmap', 'cp037', 'cp1006', 'cp1026',
    'cp1125', 'cp1140', 'cp1250', 'cp1251', 'cp1252', 'cp1253', 'cp1254', 'cp1255', 'cp1256',
    'cp1257', 'cp1258', 'cp273', 'cp424', 'cp437', 'cp500', 'cp720', 'cp737', 'cp775', 'cp850',
    'cp852', 'cp855', 'cp856', 'cp857', 'cp858', 'cp860', 'cp861', 'cp862', 'cp863', 'cp864',
    'cp865', 'cp866', 'cp869', 'cp874', 'cp875', 'cp932', 'cp949', 'cp950', 'euc_jis_2004',
    'euc_jisx0213', 'euc_jp', 'euc_kr', 'gb18030', 'gb2312', 'gbk', 'hex', 'hp-roman8', 'hz',
    'idna', 'iso2022_jp', 'iso2022_jp_1', 'iso2022_jp_2', 'iso2022_jp_2004', 'iso2022_jp_3',
    'iso2022_jp_ext', 'iso2022_kr', 'iso8859-1', 'iso8859-10', 'iso8859-11', 'iso8859-13',
    'iso8859-14', 'iso8859-15', 'iso8859-16', 'iso8859-2', 'iso8859-3', 'iso8859-4',
    'iso8859-5', 'iso8859-6', 'iso8859-7', 'iso8859-8', 'iso8859-9', 'johab', 'koi8-r',
    'koi8-t', 'koi8-u', 'kz1048', 'mac-arabic', 'mac-croatian', 'mac-cyrillic', 'mac-farsi',
    'mac-greek', 'mac-iceland', 'mac-latin2', 'mac-roman', 'mac-romanian', 'mac-turkish',
    'palmos', 'ptcp154', 'punycode', 'quopri', 'raw-unicode-escape', 'rot-13', 'shift_jis',
    'shift_jis_2004', 'shift_jisx0213', 'tis-620', 'undefined', 'unicode-escape', 'utf-16',
    'utf-16-be', 'utf-16-le', 'utf-32', 'utf-32-be', 'utf-32-le', 'utf-7', 'utf-8', 'utf-8-sig',
    'uu', 'zlib'
})


def _all_canonical_codec_names():
    names = set(encodings.aliases.aliases) | {m.name for m in pkgutil.iter_modules(encodings.__path__)}
    found = set()
    for name in names:
        try:
            found.add(codecs.lookup(name).name)
        except LookupError:
            pass  # a module that is not a registered codec
    return found


class AdmittedCodecSweepTests(TestCase):
    """What actually guards the admitted codecs against a lone surrogate (#2120).

    The four known surrogate producers need 5+ bytes (``+2AA-``, ``\\ud800``), so a
    1- or 2-byte sweep cannot find them; they are held by the deny-list and
    proven bad by ``test_the_known_bad_codecs_are_detected``. The sweep covers the
    rest on short inputs. The real guard against a codec a future Python adds is
    ``test_every_codec_is_classified``: it fails until the next person decides
    whether the new codec belongs in ``_UNSAFE_REQUEST_CODECS``.
    """

    def test_the_known_bad_codecs_are_detected(self):
        for raw, name in ((b"+2AA-", "utf-7"), (b"\\ud800", "unicode-escape"),
                          (b"\\ud800", "raw-unicode-escape"), (b"a-rc4g", "punycode")):
            text = raw.decode(name, "replace")
            self.assertTrue(any("\ud800" <= ch <= "\udfff" for ch in text), name)
            self.assertTrue(_is_unsafe_request_codec(name), name)

    def test_every_codec_is_classified(self):
        unknown = sorted(_all_canonical_codec_names() - _CLASSIFIED_CODECS)
        self.assertEqual(
            unknown, [],
            "New codec(s) in this Python. Decode multi-byte inputs (including escape "
            "forms like '\\\\ud800' and shifted forms like '+2AA-') with errors='replace'; if "
            "any yields a surrogate or raises, add the canonical name to "
            "_UNSAFE_REQUEST_CODECS in visiban/middleware.py. Then add it to "
            "_CLASSIFIED_CODECS here.",
        )

    def test_no_admitted_codec_yields_a_lone_surrogate_or_raises_on_short_input(self):
        inputs = [bytes([a]) for a in range(256)]
        # Every lead byte against every third second byte plus the structural ones
        # (escape/shift markers, lead/trail ranges): cheaper than the full 64k.
        seconds = sorted(set(range(0, 256, 3)) | {0x2B, 0x2D, 0x5C, 0x75, 0x7F, 0x80, 0xFE, 0xFF})
        inputs += [bytes([a, b]) for a in range(256) for b in seconds]
        admitted = 0
        for name in sorted(_all_canonical_codec_names()):
            if _is_unsafe_request_codec(name):
                continue
            admitted += 1
            for raw in inputs:
                # No try/except: a codec that raises here would be a 500 in Django.
                text = raw.decode(name, "replace")
                self.assertFalse(
                    any("\ud800" <= ch <= "\udfff" for ch in text),
                    f"{name} decodes {raw!r} to a lone surrogate",
                )
        self.assertGreater(admitted, 80)


class PartFilenameCodecTests(TestCase):
    """A part's RFC 2231 ``filename*`` codec that is not a text codec is a 400, not a 500 (#2151).

    ``LookupError`` used to escape Django's multipart header parser for
    ``hex``/``base64``. Covers every multipart endpoint: the two pinned import
    actions, the card attachment upload and (default parser) a board PATCH.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="pf-owner", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(board=self.board, name="Todo", position=0)
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=col, swimlane=lane, title="Keep", created_by=self.user, position=0
        )
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)
        self.urls = {
            "trello": "/api/v1/boards/import/trello/?dry_run=true",
            "import": "/api/v1/boards/import/",
            "attachment": f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/attachments/",
            "board_patch": f"/api/v1/boards/{self.board.pk}/",
        }

    @staticmethod
    def body(codec, name="%41.json"):
        return (
            f"--b\r\nContent-Disposition: form-data; name=\"file\"; filename*={codec}''{name}\r\n"
            "Content-Type: application/json\r\n\r\n{}\r\n--b--\r\n"
        ).encode()

    def send(self, client, key, codec, **extra):
        method = client.patch if key == "board_patch" else client.post
        return method(
            self.urls[key], data=self.body(codec),
            content_type="multipart/form-data; boundary=b", **extra,
        )

    def test_non_text_codec_is_a_400_on_every_multipart_endpoint(self):
        for key in self.urls:
            for codec in ("hex", "base64", "rot13", "zlib"):
                with self.subTest(endpoint=key, codec=codec):
                    resp = self.send(self.client, key, codec)
                    self.assertEqual(resp.status_code, 400, resp.content[:300])
                    self.assertEqual(resp["Content-Type"], "application/json")
                    self.assertEqual(list(resp.json()), ["detail"])
                    self.assertNotIn(codec, resp.json()["detail"])

    def test_surrogate_and_raising_codecs_are_not_a_500(self):
        for key in self.urls:
            for codec in ("utf-7", "punycode", "undefined"):
                with self.subTest(endpoint=key, codec=codec):
                    resp = self.send(self.client, key, codec)
                    # Django drops the part; the file endpoints then see no file,
                    # while a board PATCH has nothing to reject and succeeds.
                    self.assertEqual(resp.status_code, 200 if key == "board_patch" else 400, resp.content[:300])

    def test_unknown_codec_name_is_not_a_500(self):
        for key in self.urls:
            with self.subTest(endpoint=key):
                resp = self.send(self.client, key, "nonsense")
                self.assertLess(resp.status_code, 500, resp.content[:300])

    def test_valid_utf8_filename_star_still_works(self):
        fixture = (Path(__file__).parent / "fixtures" / "trello_export.json").read_bytes()
        body = (
            b"--b\r\nContent-Disposition: form-data; name=\"file\"; filename*=utf-8''%41.json\r\n"
            b"Content-Type: application/json\r\n\r\n" + fixture + b"\r\n--b--\r\n"
        )
        resp = self.client.post(
            self.urls["trello"], data=body, content_type="multipart/form-data; boundary=b",
        )
        self.assertEqual(resp.status_code, 200, resp.content[:300])

    def _factory_request(self, codec):
        from django.test import RequestFactory

        return RequestFactory().post(
            "/x/", data=self.body(codec), content_type="multipart/form-data; boundary=b",
        )

    def test_django_level_body_read_drops_the_part_instead_of_raising(self):
        # Drives the middleware directly: a Django-level read of request.POST/FILES
        # (admin or allauth views; DRF routes its own reads through its parser)
        # must see an empty body, not the LookupError.
        from visiban.middleware import RequestCharsetMiddleware

        seen = {}

        def get_response(request):
            seen["post"], seen["files"] = dict(request.POST), dict(request.FILES)
            return JsonResponse({})

        resp = RequestCharsetMiddleware(get_response)(self._factory_request("hex"))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(seen, {"post": {}, "files": {}})

    def test_django_level_read_without_the_guard_raises_lookup_error(self):
        # Proves the test above discriminates: the bare request does raise.
        with self.assertRaises(LookupError):
            self._factory_request("hex").POST

    def test_key_and_index_errors_still_propagate(self):
        from visiban.middleware import _drop_unusable_part_charsets

        for exc in (KeyError("k"), IndexError("i")):
            with self.subTest(exc=type(exc).__name__):
                def boom(META, post_data, exc=exc):
                    raise exc

                request = self._factory_request("utf-8")
                request.parse_file_upload = boom  # the original the wrapper wraps
                _drop_unusable_part_charsets(request)
                with self.assertRaises(type(exc)):
                    request.POST
