"""Date and number custom-field values are stored in one canonical form (#2218).

``parse_date`` accepts more than ``YYYY-MM-DD`` and ``Decimal`` more than
JavaScript's ``Number()``; the write path now stores one spelling, and
migration 0102 rewrites rows stored before it.
"""
import importlib
from unittest.mock import patch

from django.apps import apps
from django.test import TestCase
from rest_framework.test import APIClient

from boards.models import (
    CustomFieldDefinition, CustomFieldValue, SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from boards.serializers import _normalize_custom_field_value, canonical_number_text
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

T = CustomFieldDefinition.FieldType
migration = importlib.import_module("boards.migrations.0102_canonicalize_custom_field_values")

DATE_CASES = {
    "2026-01-05": "2026-01-05",
    "20260105": "2026-01-05",
    "2026-1-5": "2026-01-05",
    "2026-01-5": "2026-01-05",
    "2026-W02-1": "2026-01-05",
    "2026W021": "2026-01-05",
    "2026-W02": "2026-01-05",
    "2026W02": "2026-01-05",
    "２０２６-01-05": "2026-01-05",  # full-width digits
}
NUMBER_CASES = {
    "42": "42",
    "1.50": "1.50",
    "1e3": "1e3",
    "+5": "+5",
    "-0.25": "-0.25",
    "1_000": "1000",
    "1_000.50": "1000.50",
    "١٢": "12",  # Arabic-Indic digits
}


def _def(field_type):
    return CustomFieldDefinition(name="F", field_type=field_type)


class NormalizerCanonicalFormTests(TestCase):
    def test_dates_are_stored_as_yyyy_mm_dd(self):
        for raw, expected in DATE_CASES.items():
            with self.subTest(raw=raw):
                self.assertEqual(_normalize_custom_field_value(_def(T.DATE), raw), expected)

    def test_numbers_keep_their_spelling_unless_number_cannot_read_it(self):
        for raw, expected in NUMBER_CASES.items():
            with self.subTest(raw=raw):
                self.assertEqual(_normalize_custom_field_value(_def(T.NUMBER), raw), expected)

    def test_rejections_are_unchanged(self):
        from rest_framework import serializers

        for field_type, raw in ((T.DATE, "2026-13-01"), (T.DATE, "next week"),
                                (T.NUMBER, "NaN"), (T.NUMBER, "1,000")):
            with self.subTest(raw=raw), self.assertRaises(serializers.ValidationError):
                _normalize_custom_field_value(_def(field_type), raw)

    def test_migration_copies_agree_with_the_write_path(self):
        for raw, expected in DATE_CASES.items():
            with self.subTest(raw=raw):
                self.assertEqual(migration.canonical_date(raw), expected)
        import decimal

        for raw, expected in NUMBER_CASES.items():
            with self.subTest(raw=raw):
                self.assertEqual(migration.canonical_number(raw), expected)
                self.assertEqual(canonical_number_text(raw, decimal.Decimal(raw)), expected)
        self.assertIsNone(migration.canonical_date("2026-13-01"))
        self.assertIsNone(migration.canonical_number("NaN"))


class CardWriteCanonicalTests(TestCase):
    def setUp(self):
        self.admin = _make_user("cf2218_admin")
        self.board = _make_board(self.admin, name="CF2218")
        column = _make_column(self.board, "Todo", 0, allow_card_creation=True)
        lane = _make_swimlane(self.board, "General", 0)
        self.card = _make_card(column, lane, title="Card")
        self.date = CustomFieldDefinition.objects.create(
            board=self.board, name="Due", field_type=T.DATE, position=0
        )
        self.number = CustomFieldDefinition.objects.create(
            board=self.board, name="Count", field_type=T.NUMBER, position=1
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_patch_stores_and_returns_the_canonical_string(self):
        with patch("boards.broadcast.broadcast_board_event"):
            r = self.client.patch(
                f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
                {"custom_field_values": [
                    {"field_definition": self.date.id, "value": "20260105"},
                    {"field_definition": self.number.id, "value": "1_000"},
                ]},
                format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        returned = {e["field_definition"]: e["value"] for e in r.data["custom_field_values"]}
        # Still a string on the wire (backward-compatible type).
        self.assertEqual(returned, {self.date.id: "2026-01-05", self.number.id: "1000"})
        stored = dict(CustomFieldValue.objects.values_list("field_definition_id", "value"))
        self.assertEqual(stored, {self.date.id: "2026-01-05", self.number.id: "1000"})

    def test_rewriting_an_equivalent_spelling_is_not_a_change(self):
        """Same day, other spelling: the change diff sees equal strings now."""
        from boards.signals import custom_field_value_changed

        CustomFieldValue.objects.create(card=self.card, field_definition=self.date, value="2026-01-05")
        changes = []

        def receiver(sender, **kwargs):
            changes.append(kwargs)

        custom_field_value_changed.connect(receiver)
        try:
            with patch("boards.broadcast.broadcast_board_event"), \
                 self.captureOnCommitCallbacks(execute=True):
                for spelling in ("2026-W02-1", "2026-01-06"):
                    r = self.client.patch(
                        f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
                        {"custom_field_values": [{"field_definition": self.date.id, "value": spelling}]},
                        format="json",
                    )
                    self.assertEqual(r.status_code, 200, r.content)
        finally:
            custom_field_value_changed.disconnect(receiver)
        # Only the real change (to the 6th) is announced.
        self.assertEqual(len(changes), 1, changes)


class CanonicalizeMigrationTests(TestCase):
    def setUp(self):
        owner = _make_user("cf2218_mig")
        self.board = _make_board(owner, name="CF2218 mig")
        column = _make_column(self.board, "Todo", 0)
        self.lane = _make_swimlane(self.board, "General", 0)
        self.cards = [_make_card(column, self.lane, title=f"C{i}") for i in range(4)]
        self.date = CustomFieldDefinition.objects.create(
            board=self.board, name="Due", field_type=T.DATE, position=0
        )
        self.number = CustomFieldDefinition.objects.create(
            board=self.board, name="Count", field_type=T.NUMBER, position=1
        )
        self.text = CustomFieldDefinition.objects.create(
            board=self.board, name="Notes", field_type=T.TEXT, position=2
        )
        self.lane_date = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Start", field_type=T.DATE, position=0
        )

    def _value(self, card, definition, value):
        return CustomFieldValue.objects.create(card=card, field_definition=definition, value=value)

    def _run(self):
        migration.canonicalize_values(apps, None)

    def test_rewrites_non_canonical_rows_and_leaves_the_rest(self):
        rows = [
            self._value(self.cards[0], self.date, "20260105"),
            self._value(self.cards[1], self.date, "2026-W02"),
            self._value(self.cards[2], self.date, "2026-03-01"),
            self._value(self.cards[3], self.date, "not a date"),  # unreadable: kept
            self._value(self.cards[0], self.number, "1_000"),
            self._value(self.cards[1], self.number, "1.50"),
            self._value(self.cards[0], self.text, "20260105"),  # text: never touched
        ]
        lane_row = SwimlaneCustomFieldValue.objects.create(
            swimlane=self.lane, field_definition=self.lane_date, value="2026-1-5"
        )
        self._run()
        for row in rows:
            row.refresh_from_db()
        lane_row.refresh_from_db()
        self.assertEqual(
            [r.value for r in rows],
            ["2026-01-05", "2026-01-05", "2026-03-01", "not a date", "1000", "1.50", "20260105"],
        )
        self.assertEqual(lane_row.value, "2026-01-05")

    def test_is_idempotent_and_conditional_on_the_value_read(self):
        row = self._value(self.cards[0], self.date, "20260105")
        self._run()
        self._run()
        row.refresh_from_db()
        self.assertEqual(row.value, "2026-01-05")

        # A write that lands between the read and the update keeps its value.
        other = self._value(self.cards[1], self.date, "20260106")
        real = migration.canonical_date

        def racing(text):
            CustomFieldValue.objects.filter(pk=other.pk).update(value="2027-02-02")
            return real(text)

        with patch.object(migration, "canonical_date", racing):
            migration._rewrite(
                CustomFieldValue, "date", ~migration_q(), migration.canonical_date
            )
        other.refresh_from_db()
        self.assertEqual(other.value, "2027-02-02")


def migration_q():
    from django.db.models import Q

    return Q(value__regex=migration._CANONICAL_DATE)
