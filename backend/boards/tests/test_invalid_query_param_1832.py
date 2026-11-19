"""Bad query parameters answer ``{detail, code: "invalid_query_param"}`` (#1832).

#1825 settled that shape for a refused query parameter. This pins every path
#1832 moved onto it, with exact bodies:

- 1.2-new 400s, converted outright: board events ``after``/``limit``,
  ``offset`` above 2^62 (``parse_offset``; a 500 in 1.1, field-keyed only in
  1.2 pre-releases), admin action-log ``action``, admin board-invite ``status``,
  and a malformed ``GET /cards/`` ``cursor`` (DRF's 404, or a 500 for a bad
  position).
- card timeline ``event_types``: ``{detail}`` since 1.1, ``code`` added.
- django-filter type errors: field-keyed since 1.1 on the board card list, so
  the field entry stays and ``detail``/``code`` are added beside it.

Each operation's declared 400 schema is also checked against the real bodies,
so the OpenAPI contract cannot drift from what the endpoints return.
"""
import base64

import jsonschema
from django.test import SimpleTestCase, TestCase
from drf_spectacular.generators import SchemaGenerator
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from accounts.models import AdminActionLog, User
from boards.broadcast import record_board_event
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane
from visiban.filters import CodedDjangoFilterBackend

CODE = "invalid_query_param"
HUGE = 10**30


def _coded(detail):
    return {"detail": detail, "code": CODE}


class InvalidQueryParamBodiesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user(username="iqp-owner", password="pass")
        cls.admin = User.objects.create_user(
            username="iqp-admin", password="pass", is_staff=True, is_superuser=True,
        )
        cls.board = Board.objects.create(name="B", owner=cls.user)
        BoardMembership.objects.create(board=cls.board, user=cls.user, role=BoardMembership.Role.ADMIN)
        cls.col = Column.objects.create(board=cls.board, name="C", position=0)
        cls.swim = Swimlane.objects.create(board=cls.board, name="S", position=0)
        cls.card = Card.objects.create(
            board=cls.board, column=cls.col, swimlane=cls.swim, title="x", assignee=cls.user,
        )
        CardMovement.objects.create(
            card=cls.card, to_column=cls.col, to_swimlane=cls.swim, moved_by=cls.user,
        )
        b = cls.board.id
        cls.urls = {
            "events": f"/api/v1/boards/{b}/events/",
            "card_list": f"/api/v1/boards/{b}/cards/",
            "archived": f"/api/v1/boards/{b}/cards/archived/",
            "timeline": f"/api/v1/boards/{b}/cards/{cls.card.id}/timeline/",
            "movements": f"/api/v1/boards/{b}/movements/",
            "card_query": "/api/v1/cards/",
            "action_log": "/api/v1/admin/action-log/",
            "board_invites": "/api/v1/admin/board-invite-links/",
        }

    def setUp(self):
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)

    def _get(self, name, params, user=None):
        if user is not None:
            self.client.force_authenticate(user)
        return self.client.get(self.urls[name], params)

    def assert_400(self, name, params, body, user=None):
        r = self._get(name, params, user)
        self.assertEqual(r.status_code, 400, (name, params, r.content))
        self.assertEqual(r.json(), body, (name, params))

    def assert_200(self, name, params, user=None):
        r = self._get(name, params, user)
        self.assertEqual(r.status_code, 200, (name, params, r.content))
        return r

    # --- 1.2-new: converted outright ---------------------------------------

    def test_events_after_and_limit(self):
        record_board_event(self.board.id, "card.updated", {"n": 1}, actor_id=self.user.pk)
        self.assert_400("events", {"after": "abc"}, _coded("after must be an integer event id."))
        self.assert_400("events", {"after": "-1"}, _coded("after must not be negative."))
        self.assert_400("events", {"limit": "x"}, _coded("limit must be an integer."))
        self.assert_400("events", {"limit": "0"}, _coded("limit must be between 1 and 500."))
        self.assert_400("events", {"limit": "501"}, _coded("limit must be between 1 and 500."))
        r = self.assert_200("events", {"after": "0", "limit": "500"})
        self.assertEqual(len(r.json()["results"]), 1)

    def test_offset_above_max_on_every_parse_offset_endpoint(self):
        body = _coded(f"offset must not exceed {2**62}.")
        for name in ("card_list", "archived", "timeline", "movements"):
            with self.subTest(name=name):
                self.assert_400(name, {"offset": HUGE}, body)
                self.assert_400(name, {"offset": 2**62 + 1}, body)
                self.assert_200(name, {"offset": 2**62})
                self.assert_200(name, {"offset": 0})

    def test_admin_action_log_action(self):
        self.assert_400(
            "action_log", {"action": "bogus"}, _coded("'bogus' is not a valid action."), user=self.admin,
        )
        self.assert_200("action_log", {"action": AdminActionLog.Action.values[0]}, user=self.admin)

    def test_admin_board_invite_status(self):
        self.assert_400(
            "board_invites", {"status": "bogus"}, _coded("'bogus' is not a valid status."), user=self.admin,
        )
        self.assert_200("board_invites", {"status": "all"}, user=self.admin)

    # --- {detail} since 1.1: code added ------------------------------------

    def test_timeline_event_types_adds_code(self):
        self.assert_400(
            "timeline", {"event_types": "move,bogus"},
            _coded(
                "Invalid event_types: bogus. "
                "Valid groups: attachment, checklist, comment, field, gate, move, system."
            ),
        )
        self.assert_200("timeline", {"event_types": "move"})

    # --- field-keyed since 1.1: field entry kept, detail/code added ---------

    def test_board_card_list_filter_errors_keep_field_key(self):
        self.assert_400(
            "card_list", {"assignee": "x"},
            {"assignee": ["Enter a number."], "detail": "assignee: Enter a number.", "code": CODE},
        )
        self.assert_400(
            "card_list", {"due_before": "x"},
            {"due_before": ["Enter a valid date."], "detail": "due_before: Enter a valid date.", "code": CODE},
        )
        r = self.assert_200("card_list", {"assignee": self.user.id, "due_before": "2099-01-01"})
        self.assertEqual(r.json(), [])
        r = self.assert_200("card_list", {"assignee": self.user.id})
        self.assertEqual([c["id"] for c in r.json()], [self.card.id])

    def test_card_query_filter_errors_keep_field_key(self):
        self.assert_400(
            "card_query", {"updated_since": "x"},
            {
                "updated_since": ["Enter a valid date/time."],
                "detail": "updated_since: Enter a valid date/time.",
                "code": CODE,
            },
        )
        r = self.assert_200("card_query", {"updated_since": "2000-01-01T00:00:00Z"})
        self.assertEqual([c["id"] for c in r.json()["results"]], [self.card.id])

    def test_card_query_bad_cursor(self):
        """A malformed or hand-built cursor is a coded 400, not DRF's 404 or a 500."""
        body = _coded("cursor is not a valid page cursor.")

        def enc(raw):
            return base64.b64encode(raw.encode()).decode()

        for cursor in (
            "garbage",                                   # not base64 -> DRF's 404 before
            enc("o=abc"),                                # bad offset token -> DRF's 404 before
            enc("r=x"),                                  # bad reverse token -> DRF's 404 before
            enc("p=notadate"),                           # position not a datetime -> 500 before
            enc("p=2026-13-45 00:00:00+00:00"),          # matches the format, invalid date
            enc("p=2026-01-01 00:00:00+17:52"),          # offset Postgres cannot store
        ):
            with self.subTest(cursor=cursor):
                self.assert_400("card_query", {"cursor": cursor}, body)

    def test_card_query_issued_cursor_still_pages(self):
        second = Card.objects.create(board=self.board, column=self.col, swimlane=self.swim, title="y")
        first = self.assert_200("card_query", {"page_size": 1}).json()
        self.assertIsNotNone(first["next_cursor"])
        page2 = self.assert_200("card_query", {"page_size": 1, "cursor": first["next_cursor"]}).json()
        seen = [first["results"][0]["id"], page2["results"][0]["id"]]
        self.assertEqual(sorted(seen), sorted([self.card.id, second.id]))

    def test_two_bad_filters_are_both_reported(self):
        r = self._get("card_list", {"assignee": "x", "due_before": "y"})
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertEqual(body["code"], CODE)
        self.assertEqual(body["assignee"], ["Enter a number."])
        self.assertEqual(body["due_before"], ["Enter a valid date."])
        self.assertIn("assignee: Enter a number.", body["detail"])
        self.assertIn("due_before: Enter a valid date.", body["detail"])

    def test_non_member_gets_404_not_a_400(self):
        """Board access is still resolved before any param is validated."""
        outsider = User.objects.create_user(username="iqp-out", password="pass")
        self.client.force_authenticate(outsider)
        for name, params in (
            ("events", {"after": "abc"}),
            ("card_list", {"offset": HUGE}),
            ("card_list", {"assignee": "x"}),
            ("archived", {"offset": HUGE}),
            ("timeline", {"event_types": "bogus"}),
        ):
            with self.subTest(name=name, params=params):
                self.assertEqual(self.client.get(self.urls[name], params).status_code, 404)

    # --- OpenAPI ------------------------------------------------------------

    def test_declared_400_schemas_match_the_real_bodies(self):
        schema = SchemaGenerator().get_schema(request=None, public=True)
        cases = {
            ("/api/v1/boards/{id}/events/", "events"): [{"after": "abc"}, {"limit": "0"}],
            ("/api/v1/boards/{board_pk}/cards/", "card_list"): [
                {"offset": HUGE}, {"assignee": "x"}, {"limit": "-1"},
            ],
            ("/api/v1/boards/{board_pk}/cards/archived/", "archived"): [{"offset": HUGE}],
            ("/api/v1/boards/{board_pk}/cards/{id}/timeline/", "timeline"): [
                {"offset": HUGE}, {"event_types": "bogus"},
            ],
            ("/api/v1/admin/action-log/", "action_log"): [{"action": "bogus"}],
            ("/api/v1/admin/board-invite-links/", "board_invites"): [{"status": "bogus"}],
            ("/api/v1/cards/", "card_query"): [{"cursor": "garbage"}, {"updated_since": "x"}],
        }
        for (path, name), param_sets in cases.items():
            body_schema = schema["paths"][path]["get"]["responses"]["400"]["content"][
                "application/json"]["schema"]
            # The declared schema requires detail and code, not just "an object".
            with self.assertRaises(jsonschema.ValidationError, msg=path):
                jsonschema.validate({"offset": "x"}, body_schema)
            user = self.admin if name in ("action_log", "board_invites") else self.user
            for params in param_sets:
                with self.subTest(path=path, params=params):
                    r = self._get(name, params, user)
                    self.assertEqual(r.status_code, 400, r.content)
                    jsonschema.validate(r.json(), body_schema)


class CodedDjangoFilterBackendUnitTests(SimpleTestCase):
    def test_non_dict_validation_error_passes_through_untouched(self):
        class _Raises(CodedDjangoFilterBackend):
            def get_filterset(self, request, queryset, view):
                raise ValidationError(["not a filterset error"])

        with self.assertRaises(ValidationError) as ctx:
            _Raises().filter_queryset(None, None, None)
        self.assertEqual(ctx.exception.detail, ["not a filterset error"])
