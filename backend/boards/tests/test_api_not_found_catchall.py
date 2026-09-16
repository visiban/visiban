"""ApiNotFoundView — every /api/v1/ 404 must be JSON, never Django's raw 404 page (#1120).

`board-pk-nonnumeric-404` (merged just ahead of this branch) constrained the
board-scoped viewsets' `lookup_value_regex` to digits, so a non-numeric id no
longer reaches a view at all — it simply fails to match any URL pattern. When
nothing in `urlpatterns` matches, Django's own resolver renders the response
itself before any view runs: the *technical* 404 debug page when `DEBUG=True`
(true of the `backend-schema-fuzz` CI job), a bare `django 404.html`
otherwise. `handler404` only applies when `DEBUG=False`, so it can't fix the
`DEBUG=True` case this job actually runs under.

`ApiNotFoundView` (visiban/urls.py, registered dead last) closes that gap by
making sure something always matches under `/api/v1/`, so a malformed nested
id 404s the same way a well-formed-but-missing one does: a JSON
`{"detail": "Not found."}`, not an HTML page.
"""
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership


class ApiNotFoundCatchallTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="tester", password="pass")
        self.board = Board.objects.create(name="Board", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_nonnumeric_board_pk_404s_as_json(self):
        resp = self.client.get("/api/v1/boards/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp.json(), {"detail": "Not found."})

    def test_nonnumeric_nested_pk_404s_as_json(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/columns/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp.json(), {"detail": "Not found."})

    def test_entirely_unknown_v1_path_404s_as_json(self):
        resp = self.client.get("/api/v1/this-endpoint-does-not-exist/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp["Content-Type"], "application/json")

    def test_unmatched_path_with_embedded_newline_404s_as_json(self):
        # `.*` doesn't match `\n` without re.DOTALL, and Django's re_path()
        # rejects an inline `(?s)` flag (breaks reverse-resolution) and a
        # pre-compiled DOTALL pattern (breaks the startswith-slash system
        # check) equally — the catch-all pattern uses `[\s\S]*` instead
        # (#1120, found by an independent post-fix verification run: a
        # fuzzer-generated id with a literal embedded newline byte still
        # fell through to Django's raw HTML 404 even with the catch-all in
        # place, because the pattern silently failed to match at the newline).
        # A genuinely unmatched base path (not a real route with a garbled
        # id segment — those already match via `[^/.]+`'s character class,
        # newline included) so this actually exercises the catch-all's own
        # pattern. Percent-encoded so the test client's URL parsing preserves
        # the newline byte through to path matching, the way a real client's
        # request line does — an unencoded literal `\n` gets silently
        # stripped by the test client before it ever reaches the resolver.
        resp = self.client.get("/api/v1/no-such-endpoint%0Amore/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp.json(), {"detail": "Not found."})

    def test_unauthenticated_request_still_gets_a_plain_404(self):
        # No auth requirement (unlike UnsupportedVersionView): /api/v1/ mixes
        # authenticated and deliberately public routes (e.g. the anonymous
        # email-confirmation redirect at
        # /api/v1/auth/registration/account-confirm-email/<key>/), and an
        # anonymous caller who garbles one of those public paths must still
        # get a plain 404, not a 401 that breaks the public flow.
        anon_client = APIClient()
        resp = anon_client.get("/api/v1/boards/not-a-number/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp.json(), {"detail": "Not found."})

    def test_real_routes_are_unaffected(self):
        # Sanity: the catch-all must never shadow a real, matching route.
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)

    def test_catchall_excluded_from_openapi_schema(self):
        from drf_spectacular.generators import SchemaGenerator

        schema = SchemaGenerator().get_schema(request=None, public=True)
        for path in schema["paths"]:
            self.assertNotIn(".*", path, f"ApiNotFoundView's catch-all leaked into the schema: {path}")
