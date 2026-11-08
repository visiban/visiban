"""A request charset that decodes to a lone surrogate is a 400, never a 500 (#2120).

Django honors ``charset=`` on the request ``Content-Type``. ``utf-7`` turns the
ASCII ``+2AA-`` into U+D800, which PostgreSQL cannot store, so before
``RequestCharsetMiddleware`` the query string, a multipart field and the Trello
importer all answered 500 on PostgreSQL (SQLite stores it silently, so these
tests assert the status, and the PostgreSQL run is the real proof).
"""
import json

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
        body = b'--b\r\nContent-Disposition: form-data; name="name"\r\n\r\n+2AA-\r\n--b--\r\n'
        resp = self.client.post(
            "/api/v1/boards/import/trello/?dry_run=true", data=body,
            content_type="multipart/form-data; boundary=b; charset=utf-7",
        )
        self.assertCharsetRefused(resp)
        self.assertEqual(Board.objects.count(), 1)

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
        self.assertLess(resp.status_code, 500, resp.content[:300])
