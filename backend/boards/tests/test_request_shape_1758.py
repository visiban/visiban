"""Direct unit tests for the integer guards in ``visiban.request_shape`` (#1758).

``test_invalid_query_param_1832.py`` covers ``parse_offset``'s refusal through
the endpoints; this file pins the exact boundaries of the three helpers.
"""
from types import SimpleNamespace

from django.test import SimpleTestCase
from rest_framework.exceptions import ValidationError

from visiban.exceptions import INVALID_QUERY_PARAM, CodedValidationError
from visiban.request_shape import (
    MAX_DB_INT,
    MAX_OFFSET,
    coerce_int_id,
    id_in_db_range,
    parse_offset,
)


def _request(**params):
    return SimpleNamespace(query_params=params)


class IdInDbRangeTests(SimpleTestCase):

    def test_boundaries(self):
        self.assertEqual(MAX_DB_INT, 2**63 - 1)
        for value, expected in (
            (-1, False), (0, True), (1, True),
            (MAX_DB_INT - 1, True), (MAX_DB_INT, True), (MAX_DB_INT + 1, False),
        ):
            with self.subTest(value=value):
                self.assertIs(id_in_db_range(value), expected)


class CoerceIntIdTests(SimpleTestCase):

    def test_ints_and_digit_strings_in_range_are_returned_as_int(self):
        for value, expected in (
            (0, 0), (7, 7), ("7", 7), ("007", 7),
            (MAX_DB_INT, MAX_DB_INT), (str(MAX_DB_INT), MAX_DB_INT),
        ):
            with self.subTest(value=value):
                self.assertEqual(coerce_int_id(value), expected)

    def test_everything_else_is_a_field_keyed_400(self):
        for value in (
            -1, MAX_DB_INT + 1, str(MAX_DB_INT + 1), True, False, 1.0, None,
            [1], {"id": 1}, "", "abc", "-1", "+1", " 1", "1.0",
            "²", "١",  # superscript two, Arabic-Indic one: isdigit() but not ASCII
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError) as ctx:
                    coerce_int_id(value, field="user_id")
                self.assertEqual(list(ctx.exception.detail), ["user_id"])

    def test_default_field_name(self):
        with self.assertRaises(ValidationError) as ctx:
            coerce_int_id("abc")
        self.assertEqual(list(ctx.exception.detail), ["id"])


class ParseOffsetTests(SimpleTestCase):

    def test_boundaries_around_max_offset(self):
        self.assertEqual(MAX_OFFSET, 2**62)
        for value in (MAX_OFFSET - 1, MAX_OFFSET):
            with self.subTest(value=value):
                self.assertEqual(parse_offset(_request(offset=str(value))), value)
        with self.assertRaises(CodedValidationError) as ctx:
            parse_offset(_request(offset=str(MAX_OFFSET + 1)))
        self.assertEqual(ctx.exception.detail["code"], INVALID_QUERY_PARAM)

    def test_lenient_values_are_zero(self):
        self.assertEqual(parse_offset(_request()), 0)
        for raw in ("", "abc", "1.5", "-1", str(-MAX_OFFSET - 1), "0"):
            with self.subTest(raw=raw):
                self.assertEqual(parse_offset(_request(offset=raw)), 0)

    def test_custom_param_name_is_read_and_named_in_the_error(self):
        self.assertEqual(parse_offset(_request(skip="3", offset="9"), param="skip"), 3)
        with self.assertRaises(CodedValidationError) as ctx:
            parse_offset(_request(skip=str(MAX_OFFSET + 1)), param="skip")
        self.assertIn("skip", str(ctx.exception.detail["detail"]))
