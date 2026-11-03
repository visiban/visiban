"""A lone UTF-16 surrogate in a JSON body is a 400, never a 500 (#2085).

``"\\ud800"`` is valid JSON but decodes to a ``str`` that UTF-8 cannot encode, so
psycopg raises ``UnicodeEncodeError`` (text) or ``DataError`` (jsonb) on
PostgreSQL. SQLite stores it without complaint, so these tests assert the 400
and the untouched row, not merely "no 500".

Bodies are sent as raw bytes with the ``\\ud800`` escape intact: a test client
that serializes a Python ``str`` holding a lone surrogate would fail on the
client side before the server saw anything.
"""
import json

from django.test import SimpleTestCase, TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, Card, Column, CustomFieldDefinition, SavedFilter, Swimlane
from visiban.parsers import first_lone_surrogate


class LoneSurrogateRestTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="sur-owner", password="pass")
        self.board = Board.objects.create(name="B", owner=self.user)
        self.col = Column.objects.create(board=self.board, name="Todo", position=0)
        self.lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.col, swimlane=self.lane,
            title="Keep me", created_by=self.user, position=0,
        )
        # No re-raise: an unhandled exception must show as the 500 it is.
        self.client = APIClient(raise_request_exception=False)
        self.client.force_authenticate(self.user)
        self.card_url = reverse(
            "board-card-detail", kwargs={"board_pk": self.board.pk, "pk": self.card.pk}
        )
        self.saved_filters_url = f"/api/v1/boards/{self.board.pk}/saved-filters/"
        self.custom_fields_url = f"/api/v1/boards/{self.board.pk}/custom-fields/"

    def _send(self, method, url, raw):
        return getattr(self.client, method)(url, data=raw.encode(), content_type="application/json")

    def assertRefused(self, resp, field=None):
        """A 400 JSON body: field-keyed when ``field`` is given, else a parse-error detail."""
        self.assertEqual(resp.status_code, 400, resp.content[:300])
        self.assertEqual(resp["Content-Type"], "application/json")
        body = resp.json()
        if field is None:
            self.assertEqual(list(body), ["detail"])
            self.assertTrue(body["detail"].startswith("JSON parse error - Surrogate characters"))
        else:
            self.assertEqual(list(body), [field])
            self.assertRegex(body[field][0], r"^Surrogate characters are not allowed: U\+D[89A-F][0-9A-F]{2}\.$")

    # -- reachable only through the parser: no CharField in front of them ------

    def test_surrogate_in_a_jsonfield_value_is_a_400(self):
        resp = self._send(
            "post", self.saved_filters_url,
            '{"name": "n", "state_json": {"search": "a\\ud800"}}',
        )
        self.assertRefused(resp, "state_json")
        self.assertFalse(SavedFilter.objects.exists())

    def test_surrogate_in_a_hand_read_request_data_string_is_a_400(self):
        resp = self._send(
            "post", self.saved_filters_url,
            '{"name": "a\\ud800", "state_json": {"search": "x"}}',
        )
        self.assertRefused(resp, "name")
        self.assertFalse(SavedFilter.objects.exists())

    def test_surrogate_in_a_list_of_choices_is_a_400(self):
        resp = self._send(
            "post", self.custom_fields_url,
            '{"name": "cf", "field_type": "dropdown", "choices": ["a\\ud800"]}',
        )
        self.assertRefused(resp, "choices")
        self.assertFalse(CustomFieldDefinition.objects.exists())

    def test_surrogate_in_an_object_key_is_a_400_without_echoing_it(self):
        self.assertRefused(self._send("patch", self.card_url, '{"a\\udc00": "x"}'))

    def test_surrogate_in_a_non_object_body_is_a_400(self):
        self.assertRefused(self._send("patch", self.card_url, '["\\ud800"]'))

    def test_surrogate_nested_deep_and_in_uppercase_escape_is_a_400(self):
        self.assertRefused(self._send("patch", self.card_url, '{"x": [[{"y": ["\\uDBFF"]}]]}'), "x")

    def test_reversed_pair_is_two_lone_surrogates(self):
        # Low then high is not a pair.
        self.assertRefused(self._send("patch", self.card_url, '{"x": "\\ude00\\ud83d"}'), "x")

    # -- already a field error from DRF's CharField; must stay one --------------

    def test_surrogate_in_a_card_title_stays_a_field_error(self):
        resp = self._send("patch", self.card_url, '{"title": "a\\ud800b"}')
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.json(), {"title": ["Surrogate characters are not allowed: U+D800."]}
        )
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Keep me")

    # -- valid input is untouched ------------------------------------------------

    def test_valid_surrogate_pair_is_stored_as_one_code_point(self):
        resp = self._send("patch", self.card_url, '{"title": "ok \\ud83d\\ude00 \\uD83D\\uDE00"}')
        self.assertEqual(resp.status_code, 200, resp.content[:300])
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "ok \U0001F600 \U0001F600")

    def test_valid_pair_in_a_jsonfield_value_is_stored(self):
        resp = self._send(
            "post", self.saved_filters_url,
            '{"name": "n", "state_json": {"search": "\\ud83d\\ude00"}}',
        )
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        self.assertEqual(SavedFilter.objects.get().state_json["search"], "\U0001F600")

    def test_raw_utf8_emoji_and_other_escapes_are_untouched(self):
        resp = self.client.patch(
            self.card_url,
            data='{"title": "\U0001F600 \\u00e9 \\u0041"}'.encode(),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content[:300])
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "\U0001F600 é A")

    def test_malformed_json_keeps_its_existing_parse_error(self):
        resp = self._send("patch", self.card_url, '{"title": ')
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(resp.json()["detail"].startswith("JSON parse error - "))

    # -- the echo is bounded --------------------------------------------------

    def test_an_oversized_or_markup_key_is_never_echoed(self):
        for key in ("k" * 200_000, "<script>alert(1)</script>", "a b", ""):
            with self.subTest(key=key[:20]):
                resp = self._send("patch", self.card_url, '{"%s": "\\ud800"}' % key)
                self.assertRefused(resp)
                self.assertLess(len(resp.content), 400)
                self.assertNotIn(b"<script>", resp.content)

    def test_a_short_plain_key_is_named(self):
        resp = self._send("patch", self.card_url, '{"nonsense": "\\ud800"}')
        self.assertRefused(resp, "nonsense")

    # -- charsets: a surrogate with no \\u escape in the bytes ---------------

    def test_utf7_raw_surrogate_is_a_400(self):
        # "+2AA-" is UTF-7 for U+D800; the bytes carry no "\\ud800" escape, so
        # only the encoding check keeps the prefilter from skipping the walk.
        resp = self.client.patch(
            self.card_url, data=b'{"title": "a+2AA-b"}',
            content_type="application/json; charset=utf-7",
        )
        self.assertRefused(resp, "title")
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Keep me")

    def test_utf16_escape_is_a_400(self):
        # In UTF-16 the escape is not the ASCII bytes the prefilter searches for.
        resp = self.client.patch(
            self.card_url, data='{"x": "\\ud800"}'.encode("utf-16"),
            content_type="application/json; charset=utf-16",
        )
        self.assertRefused(resp, "x")

    def test_utf16_valid_body_is_untouched(self):
        resp = self.client.patch(
            self.card_url, data='{"title": "\U0001F600"}'.encode("utf-16"),
            content_type="application/json; charset=utf-16",
        )
        self.assertEqual(resp.status_code, 200, resp.content[:300])

    # -- a JSON string holding JSON (multi-select values) ---------------------

    def test_surrogate_escape_inside_a_multi_select_value_is_a_400(self):
        definition = CustomFieldDefinition.objects.create(
            board=self.board, name="Platforms", field_type="multi_select",
            choices_json=["web", "ios"], position=0,
        )
        body = json.dumps({"custom_field_values": [
            {"field_definition": definition.pk, "value": '["\\ud800"]'},
        ]})
        self.assertIn("\\\\ud800", body)  # the surrogate escape survives the parser
        resp = self._send("patch", self.card_url, body)
        self.assertEqual(resp.status_code, 400, resp.content[:300])
        resp.content.decode("utf-8")
        self.assertIn("U+D800", json.dumps(resp.json()))
        self.assertFalse(self.card.custom_field_values.exists())


class ContainsLoneSurrogateTests(SimpleTestCase):
    def test_walks_keys_values_and_nesting(self):
        bad = "a\ud800"
        for value in (bad, [bad], {"k": bad}, {bad: 1}, [{"k": [bad]}]):
            with self.subTest(value=value):
                self.assertEqual(first_lone_surrogate(value), 0xD800)

    def test_clean_values(self):
        for value in ("\U0001F600", 1, None, True, [], {}, {"k": ["x", 2, None]}):
            with self.subTest(value=value):
                self.assertIsNone(first_lone_surrogate(value))

    def test_deeply_nested_value_does_not_recurse(self):
        value = "x"
        for _ in range(5000):
            value = [value]
        self.assertIsNone(first_lone_surrogate(value))
