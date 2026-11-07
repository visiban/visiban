"""Upload-limit errors raised outside a parser answer a JSON 400 (#2073).

DRF 3.18 hands a JSON or urlencoded parser ``io.BytesIO(request.body)``, and
Django's ``request.body`` raises ``RequestDataTooBig`` for a body over
``DATA_UPLOAD_MAX_MEMORY_SIZE`` before any parser runs. ``TooManyFieldsSent``
is raised while Django parses a query string, also with no parser involved.
Both are ``SuspiciousOperation``s DRF does not handle, so they used to reach
Django's HTML 400. The project ``EXCEPTION_HANDLER`` now maps them to a
``ParseError`` (JSON 400) and keeps the ``django.security.*`` log line.
"""

import json

from django.conf import settings
from django.test import TestCase, override_settings
from rest_framework.response import Response
from rest_framework.test import APIClient, APIRequestFactory
from rest_framework.views import APIView

from accounts.models import User
from boards.models import Board, BoardMembership, Swimlane


class OutsideParserLimitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(username="osb-owner", password="pass")
        cls.board = Board.objects.create(name="B", owner=cls.user)
        BoardMembership.objects.create(
            board=cls.board,
            user=cls.user,
            role=BoardMembership.Role.ADMIN,
        )
        cls.swim = Swimlane.objects.create(board=cls.board, name="S", position=0)
        cls.swim_url = f"/api/v1/boards/{cls.board.id}/swimlanes/{cls.swim.id}/"

    def setUp(self):
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)

    def assert_json_400(self, response, setting):
        self.assertEqual(response.status_code, 400, response.content[:300])
        self.assertEqual(response["Content-Type"], "application/json")
        body = response.json()
        self.assertEqual(list(body), ["detail"])
        self.assertIn(setting, body["detail"])

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_oversize_json_patch_on_real_route_is_a_json_400_and_logged(self):
        payload = json.dumps({"name": "x" * 5000})
        with self.assertLogs("django.security.RequestDataTooBig", "ERROR") as logs:
            r = self.client.patch(
                self.swim_url, payload, content_type="application/json"
            )
        self.assert_json_400(r, "DATA_UPLOAD_MAX_MEMORY_SIZE")
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].status_code, 400)

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_oversize_urlencoded_patch_on_real_route_is_a_json_400(self):
        r = self.client.patch(
            self.swim_url,
            "name=" + "x" * 5000,
            content_type="application/x-www-form-urlencoded",
        )
        self.assert_json_400(r, "DATA_UPLOAD_MAX_MEMORY_SIZE")

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_oversize_json_post_on_real_route_is_a_json_400(self):
        url = f"/api/v1/boards/{self.board.id}/swimlanes/"
        payload = json.dumps({"name": "x" * 5000})
        r = self.client.post(url, payload, content_type="application/json")
        self.assert_json_400(r, "DATA_UPLOAD_MAX_MEMORY_SIZE")

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_without_the_handler_the_same_requests_answer_html(self):
        # Proves the tests above pin the handler and not some other layer.
        # DRF reloads its settings on the setting_changed signal.
        rest = {**settings.REST_FRAMEWORK}
        rest.pop("EXCEPTION_HANDLER")
        with override_settings(REST_FRAMEWORK=rest):
            r = self.client.patch(
                self.swim_url,
                json.dumps({"name": "x" * 5000}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 400)
        self.assertTrue(r["Content-Type"].startswith("text/html"), r["Content-Type"])

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_any_view_reading_request_body_is_covered_without_opt_in(self):
        # Mechanism test: the handler is global, so a view defined elsewhere
        # (an enterprise one) is covered with no opt-in. The real-route tests
        # above are the regression pins.
        # The handler is global (REST_FRAMEWORK["EXCEPTION_HANDLER"]), so a view
        # that is not in this repo (an enterprise one) is covered too.
        class ReadsBody(APIView):
            authentication_classes = []
            permission_classes = []

            def post(self, request):
                return Response({"n": len(request.body)})

        request = APIRequestFactory().post(
            "/x/",
            b"x" * 5000,
            content_type="application/octet-stream",
        )
        with self.assertLogs("django.security.RequestDataTooBig", "ERROR"):
            response = ReadsBody.as_view()(request)
        self.assertEqual(response.status_code, 400)
        self.assertIn("DATA_UPLOAD_MAX_MEMORY_SIZE", response.data["detail"])
        self.assertEqual(response.accepted_renderer.media_type, "application/json")

    @override_settings(DATA_UPLOAD_MAX_NUMBER_FIELDS=10)
    def test_too_many_query_params_is_a_json_400_and_logged(self):
        qs = "&".join(f"k{i}=v" for i in range(20))
        with self.assertLogs("django.security.TooManyFieldsSent", "ERROR") as logs:
            r = self.client.get(f"/api/v1/boards/?{qs}")
        self.assert_json_400(r, "DATA_UPLOAD_MAX_NUMBER_FIELDS")
        self.assertEqual(len(logs.records), 1)

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1000)
    def test_body_within_limit_and_other_errors_are_unchanged(self):
        r = self.client.patch(self.swim_url, {"name": "ok"}, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        r = self.client.patch(self.swim_url, "{bad", content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("JSON parse error", r.json()["detail"])
