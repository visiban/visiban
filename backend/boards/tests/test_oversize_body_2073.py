"""Upload-limit errors raised outside a parser answer a JSON 400 (#2073).

``RequestDataTooBig`` from a ``request.body`` read outside a parser (DRF does
that read for a JSON/urlencoded body once the stream was touched earlier) and ``TooManyFieldsSent`` for a query string
(raised while Django parses ``request.GET``) are handled by the project
``EXCEPTION_HANDLER``, so every view answers ``application/json`` like the
schema documents, and the ``django.security.*`` log line is kept.
"""

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
    def test_any_view_reading_request_body_is_covered_without_opt_in(self):
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
