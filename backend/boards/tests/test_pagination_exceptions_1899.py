"""Unit coverage for ``visiban.pagination`` and ``visiban.exceptions`` (#1899).

The HTTP-level behavior is exercised through the list endpoints; these tests pin
the classes themselves at their boundaries (limit clamp, offset bounds, invalid
or hand-built cursors, the allowed-ordering allowlist, capped-history N-1/N/N+1,
and the exact body shape of ``CodedValidationError``).
"""

from django.test import RequestFactory, SimpleTestCase
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from visiban.exceptions import INVALID_QUERY_PARAM, CodedValidationError
from visiban.pagination import (
    TOTAL_COUNT_HEADER,
    TRUNCATED_HEADER,
    CardQueryCursorPagination,
    OffsetCountPagination,
    capped_history,
    set_count_headers,
)


def _request(query=""):
    return Request(RequestFactory().get(f"/x/{query}"))


class OffsetCountPaginationTests(SimpleTestCase):
    def setUp(self):
        self.paginator = OffsetCountPagination()
        self.rows = list(range(500))

    def _page(self, query):
        request = _request(query)
        page = self.paginator.paginate_queryset(self.rows, request, view=APIView())
        return self.paginator.get_paginated_response(page).data

    def test_defaults_to_50_rows_from_offset_zero(self):
        data = self._page("")
        self.assertEqual((data["count"], data["offset"], data["page_size"]), (500, 0, 50))
        self.assertEqual(data["results"], self.rows[:50])

    def test_page_size_is_clamped_to_200(self):
        for requested, expected in (("199", 199), ("200", 200), ("201", 200), ("100000", 200)):
            with self.subTest(requested=requested):
                self.assertEqual(self._page(f"?page_size={requested}")["page_size"], expected)

    def test_offset_selects_the_window_and_past_the_end_is_empty(self):
        self.assertEqual(self._page("?offset=450&page_size=100")["results"], self.rows[450:])
        past = self._page("?offset=500")
        self.assertEqual((past["count"], past["results"]), (500, []))

    def test_envelope_keys_are_the_documented_contract(self):
        self.assertEqual(set(self._page("")), {"count", "offset", "page_size", "results"})
        schema = self.paginator.get_paginated_response_schema({"type": "array"})
        self.assertEqual(sorted(schema["required"]), ["count", "offset", "page_size", "results"])


class CardQueryCursorPaginationTests(SimpleTestCase):
    def setUp(self):
        self.paginator = CardQueryCursorPagination()

    def _decode(self, cursor):
        from urllib.parse import quote

        return self.paginator.decode_cursor(_request(f"?cursor={quote(cursor)}"))

    def test_garbled_cursor_is_the_coded_400_not_a_404(self):
        with self.assertRaises(CodedValidationError) as caught:
            self.paginator.decode_cursor(_request("?cursor=%%%not-base64"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(caught.exception.detail["code"], INVALID_QUERY_PARAM)

    def test_hand_built_cursor_with_a_non_datetime_position_is_refused(self):
        import base64

        raw = base64.b64encode(b"p=notadate").decode()
        with self.assertRaises(CodedValidationError):
            self._decode(raw)

    def test_hand_built_cursor_with_an_unstorable_utc_offset_is_refused(self):
        # ``%2B`` is the cursor's own encoding of ``+``; a raw ``+`` would decode as a space.
        import base64

        for position, refused in (
            ("2026-01-01T00:00:00%2B15:59", False),
            ("2026-01-01T00:00:00%2B16:00", True),
        ):
            with self.subTest(position=position):
                raw = base64.b64encode(f"p={position}".encode()).decode()
                if refused:
                    with self.assertRaises(CodedValidationError):
                        self._decode(raw)
                else:
                    self.assertIsNotNone(self._decode(raw))

    def test_absent_cursor_decodes_to_none(self):
        self.assertIsNone(self.paginator.decode_cursor(_request("")))

    def test_ordering_is_an_allowlist_with_a_matching_direction_tiebreaker(self):
        for requested, expected in (
            ("updated_at", ("updated_at", "id")),
            ("-updated_at", ("-updated_at", "-id")),
            ("created_at", ("created_at", "id")),
            ("-created_at", ("-created_at", "-id")),
            ("due_date", ("-updated_at", "-id")),  # nullable: deliberately not allowed
            ("title", ("-updated_at", "-id")),
            ("", ("-updated_at", "-id")),
        ):
            with self.subTest(requested=requested):
                request = _request(f"?ordering={requested}")
                self.assertEqual(self.paginator.get_ordering(request, None, None), expected)
        self.assertEqual(self.paginator.get_ordering(_request(""), None, None), ("-updated_at", "-id"))

    def test_envelope_shape_and_last_page_cursor(self):
        self.paginator.get_next_link = lambda: None
        self.assertEqual(
            self.paginator.get_paginated_response([1]).data, {"results": [1], "next_cursor": None}
        )
        self.paginator.get_next_link = lambda: "http://t/x/?cursor=abc&page_size=2"
        self.assertEqual(self.paginator.get_paginated_response([1]).data["next_cursor"], "abc")


class CappedHistoryTests(SimpleTestCase):
    """N-1, N and N+1 around the cap: one row past the cap tells capped from complete."""

    class _Rows(list):
        counted = 0

        def order_by(self):
            return self

        def count(self):
            type(self).counted += 1
            return len(self)

    def test_below_at_and_above_the_cap(self):
        cap = 5
        for size, expected_rows, expected_total in ((4, 4, 4), (5, 5, 5), (6, 5, 6)):
            with self.subTest(size=size):
                rows, total = capped_history(self._Rows(range(size)), cap)
                self.assertEqual((len(rows), total), (expected_rows, expected_total))

    def test_an_uncapped_list_runs_no_count(self):
        self._Rows.counted = 0
        capped_history(self._Rows(range(5)), 5)
        self.assertEqual(self._Rows.counted, 0)
        capped_history(self._Rows(range(9)), 5)
        self.assertEqual(self._Rows.counted, 1)

    def test_count_headers_flag_truncation_only_when_rows_are_missing(self):
        for returned, total, truncated in ((5, 5, "false"), (5, 6, "true"), (0, 0, "false")):
            with self.subTest(returned=returned, total=total):
                response = set_count_headers(Response(), total=total, returned=returned)
                self.assertEqual(response[TOTAL_COUNT_HEADER], str(total))
                self.assertEqual(response[TRUNCATED_HEADER], truncated)


class CodedValidationErrorTests(SimpleTestCase):
    def test_body_is_exactly_code_and_detail_as_plain_strings(self):
        error = CodedValidationError("relation_exists", "Already linked.")
        self.assertEqual(error.status_code, 400)
        self.assertEqual(dict(error.detail), {"code": "relation_exists", "detail": "Already linked."})
        self.assertIsInstance(error.detail["code"], str)
        self.assertIsInstance(error.detail["detail"], str)
        self.assertEqual(error.get_codes(), {"code": "relation_exists", "detail": "relation_exists"})

    def test_it_is_not_a_serializer_validation_error(self):
        """Deliberate: ``ValidationError`` would be re-wrapped into lists by
        ``Serializer.run_validation`` and break ``body.code === "..."`` clients."""
        from rest_framework.exceptions import APIException, ValidationError

        self.assertTrue(issubclass(CodedValidationError, APIException))
        self.assertFalse(issubclass(CodedValidationError, ValidationError))
