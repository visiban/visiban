"""A form body over Django's upload limits answers a JSON 400 (#2072).

Django enforces ``DATA_UPLOAD_MAX_NUMBER_FILES``, ``DATA_UPLOAD_MAX_NUMBER_FIELDS``
and ``DATA_UPLOAD_MAX_MEMORY_SIZE`` while it parses a form body, by raising
``TooManyFilesSent``, ``TooManyFieldsSent`` and ``RequestDataTooBig``. All three
are ``SuspiciousOperation``s, not the ``MultiPartParserError`` DRF's
``MultiPartParser`` converts into a ``ParseError``, so they used to escape DRF
and reach Django's own 400 handler, which answers ``text/html``. Every
body-reading operation documents its 400 as ``application/json``, so
``backend-schema-fuzz`` flagged the undocumented content type.

``visiban.parsers`` catches them in the parser and raises ``ParseError``, which
DRF renders as ``{"detail": "..."}``. These tests pin that on the default parser
list (board, column, swimlane and card PATCH) and on the import actions that pin
their own ``parser_classes``, and pin that small form bodies and JSON bodies are
parsed as before.
"""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.exceptions import ParseError
from rest_framework.parsers import JSONParser
from rest_framework.settings import api_settings
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Card, Column, Swimlane
from boards.views.import_export import BoardImportExportMixin
from visiban.parsers import LimitedFormParser, LimitedMultiPartParser

TOO_MANY_FILES = 150  # DATA_UPLOAD_MAX_NUMBER_FILES defaults to 100


def _files(n):
    """``n`` one-byte file parts under distinct keys."""
    return {f"f{i}": SimpleUploadedFile(f"f{i}.txt", b"x") for i in range(n)}


class FormBodyLimitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(username="fbl-owner", password="pass")
        cls.board = Board.objects.create(name="B", owner=cls.user)
        BoardMembership.objects.create(
            board=cls.board, user=cls.user, role=BoardMembership.Role.ADMIN,
        )
        cls.col = Column.objects.create(board=cls.board, name="C", position=0)
        cls.swim = Swimlane.objects.create(board=cls.board, name="S", position=0)
        cls.card = Card.objects.create(
            board=cls.board, column=cls.col, swimlane=cls.swim, title="x",
        )
        b = cls.board.id
        cls.patch_urls = {
            "board": f"/api/v1/boards/{b}/",
            "column": f"/api/v1/boards/{b}/columns/{cls.col.id}/",
            "swimlane": f"/api/v1/boards/{b}/swimlanes/{cls.swim.id}/",
            "card": f"/api/v1/boards/{b}/cards/{cls.card.id}/",
        }

    def setUp(self):
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)

    def assert_json_400(self, response, label):
        self.assertEqual(response.status_code, 400, (label, response.content[:300]))
        self.assertEqual(response["Content-Type"], "application/json", label)
        body = response.json()
        self.assertEqual(list(body), ["detail"], label)
        self.assertIsInstance(body["detail"], str, label)
        return body["detail"]

    def test_too_many_file_parts_on_patch_is_a_json_400(self):
        for label, url in self.patch_urls.items():
            with self.subTest(label):
                r = self.client.patch(url, _files(TOO_MANY_FILES), format="multipart")
                detail = self.assert_json_400(r, label)
                self.assertIn("DATA_UPLOAD_MAX_NUMBER_FILES", detail)

    def test_too_many_file_parts_on_pinned_import_actions_is_a_json_400(self):
        for url in ("/api/v1/boards/import/", "/api/v1/boards/import/trello/?dry_run=true"):
            with self.subTest(url):
                r = self.client.post(url, _files(TOO_MANY_FILES), format="multipart")
                detail = self.assert_json_400(r, url)
                self.assertIn("DATA_UPLOAD_MAX_NUMBER_FILES", detail)

    def test_limit_is_parsed_inside_the_session_csrf_check_too(self):
        # A session-authenticated POST runs CSRF validation, which reads
        # request.POST and so parses the body inside authentication, before
        # the view. The ParseError must still be the answer, not a 403/HTML.
        client = APIClient(enforce_csrf_checks=True, raise_request_exception=False)
        self.assertTrue(client.login(username="fbl-owner", password="pass"))
        token = "a" * 32
        client.cookies["csrftoken"] = token
        r = client.post(
            "/api/v1/boards/", _files(TOO_MANY_FILES), format="multipart",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertIn("DATA_UPLOAD_MAX_NUMBER_FILES", self.assert_json_400(r, "session"))

    def test_django_security_log_line_is_kept(self):
        # Operators alerting on django.security.* still see the probe.
        with self.assertLogs("django.security.TooManyFilesSent", "ERROR") as logs:
            r = self.client.patch(
                self.patch_urls["swimlane"], _files(TOO_MANY_FILES), format="multipart",
            )
        self.assert_json_400(r, "log")
        self.assertEqual(len(logs.records), 1)
        self.assertIn("DATA_UPLOAD_MAX_NUMBER_FILES", logs.records[0].getMessage())
        self.assertEqual(logs.records[0].status_code, 400)

    @override_settings(DATA_UPLOAD_MAX_NUMBER_FIELDS=10)
    def test_too_many_multipart_fields_is_a_json_400(self):
        fields = {f"k{i}": "v" for i in range(20)}
        r = self.client.patch(self.patch_urls["swimlane"], fields, format="multipart")
        self.assertIn("DATA_UPLOAD_MAX_NUMBER_FIELDS", self.assert_json_400(r, "multipart"))

    @override_settings(DATA_UPLOAD_MAX_NUMBER_FIELDS=10)
    def test_too_many_urlencoded_fields_is_a_json_400(self):
        body = "&".join(f"k{i}=v" for i in range(20))
        r = self.client.generic(
            "PATCH", self.patch_urls["swimlane"], body,
            content_type="application/x-www-form-urlencoded",
        )
        self.assertIn("DATA_UPLOAD_MAX_NUMBER_FIELDS", self.assert_json_400(r, "urlencoded"))

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_oversize_multipart_field_is_a_json_400(self):
        # A non-file field counts against DATA_UPLOAD_MAX_MEMORY_SIZE inside
        # Django's multipart parser; file parts do not.
        r = self.client.patch(self.patch_urls["swimlane"], {"name": "x" * 5000}, format="multipart")
        self.assertIn("DATA_UPLOAD_MAX_MEMORY_SIZE", self.assert_json_400(r, "multipart"))

    def test_small_multipart_body_is_still_parsed(self):
        r = self.client.patch(self.patch_urls["swimlane"], {"name": "Renamed"}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.swim.refresh_from_db()
        self.assertEqual(self.swim.name, "Renamed")

    def test_small_urlencoded_body_is_still_parsed(self):
        r = self.client.generic(
            "PATCH", self.patch_urls["column"], "name=Doing",
            content_type="application/x-www-form-urlencoded",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.col.refresh_from_db()
        self.assertEqual(self.col.name, "Doing")

    def test_json_body_is_still_parsed(self):
        r = self.client.patch(self.patch_urls["board"], {"name": "Renamed board"}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.board.refresh_from_db()
        self.assertEqual(self.board.name, "Renamed board")

    def test_malformed_multipart_keeps_drf_parse_error(self):
        # A body that is not multipart at all is still DRF's own ParseError path.
        r = self.client.generic(
            "PATCH", self.patch_urls["swimlane"], b"not multipart",
            content_type="multipart/form-data",  # no boundary
        )
        self.assertIn("Multipart form parse error", self.assert_json_400(r, "malformed"))


class ParserWiringTests(SimpleTestCase):
    """The accepted media types are unchanged; only the error is."""

    def test_default_parsers_are_the_limited_subclasses_in_drf_order(self):
        self.assertEqual(
            [p for p in api_settings.DEFAULT_PARSER_CLASSES],
            [JSONParser, LimitedFormParser, LimitedMultiPartParser],
        )
        self.assertEqual(
            [p.media_type for p in api_settings.DEFAULT_PARSER_CLASSES],
            ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"],
        )

    def test_no_routed_view_pins_drf_s_raw_form_parsers(self):
        # A pin of DRF's own FormParser/MultiPartParser silently brings the
        # HTML 400 back for that view. Walks every routed DRF view and, for a
        # viewset, every routed action (an @action may pin its own).
        from django.urls import URLPattern, URLResolver, get_resolver
        from rest_framework.parsers import FormParser, MultiPartParser

        def walk(patterns):
            for entry in patterns:
                if isinstance(entry, URLResolver):
                    yield from walk(entry.url_patterns)
                elif isinstance(entry, URLPattern):
                    yield entry.callback

        raw = (FormParser, MultiPartParser)
        offenders, checked = [], 0
        for callback in walk(get_resolver().url_patterns):
            cls = getattr(callback, "cls", None)
            if cls is None:
                continue
            actions = getattr(callback, "actions", None) or {}
            sources = {cls.__name__: cls.parser_classes}
            for action_name in set(actions.values()):
                handler = getattr(cls, action_name, None)
                pinned = getattr(handler, "kwargs", {}).get("parser_classes")
                if pinned is not None:
                    sources[f"{cls.__name__}.{action_name}"] = pinned
            for where, parsers in sources.items():
                checked += 1
                offenders += [(where, p.__name__) for p in parsers if p in raw]
        self.assertGreater(checked, 50)  # the walk really reached the API
        self.assertEqual(offenders, [])

    def test_import_actions_pin_the_limited_multipart_parser(self):
        for name in ("import_board", "import_trello"):
            with self.subTest(name):
                kwargs = getattr(BoardImportExportMixin, name).kwargs
                self.assertEqual(kwargs["parser_classes"], [LimitedMultiPartParser])

    def test_parse_error_is_raised_from_the_django_exception(self):
        # The original exception stays on __cause__ for debugging and logs.
        from io import BytesIO

        from django.core.exceptions import TooManyFieldsSent

        with override_settings(DATA_UPLOAD_MAX_NUMBER_FIELDS=1):
            with self.assertRaises(ParseError) as ctx:
                LimitedFormParser().parse(BytesIO(b"a=1&b=2&c=3"), parser_context={})
        self.assertIsInstance(ctx.exception.__cause__, TooManyFieldsSent)
