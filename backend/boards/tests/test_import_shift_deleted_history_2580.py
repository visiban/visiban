"""#2580: ``shift_dates`` moves a file's ``deleted_card_history`` with the board.

Before the fix, live cards' history moved to the new dates and deleted cards'
history (card-less movements, activities, blocks, gate transitions) stayed on
the original ones, so Board History showed two timelines.
"""
import datetime as dt
import json

from django.core.cache import cache

from boards.models import Board, CardActivity, CardBlock, CardGateTransition, CardMovement
from boards.services.date_shift import shift_board_dates
from boards.tests.test_export_relations_history_2413 import IMPORT_URL, _file, _Fixture

DAYS = 10

# (model, datetime fields) of every dated card-less row an import writes.
DATED = (
    (CardMovement, ("moved_at",)),
    (CardActivity, ("created_at",)),
    (CardBlock, ("blocked_at", "unblocked_at")),
    (CardGateTransition, ("created_at",)),
)


class ShiftedImportMovesDeletedHistoryTests(_Fixture):
    def _import(self, data, **options):
        cache.clear()
        resp = self.client.post(
            IMPORT_URL, {"file": _file(data), "options": json.dumps(options)}, format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        return Board.objects.get(pk=resp.data["id"])

    def _rows(self, board):
        return {
            model.__name__: sorted(
                (
                    tuple(getattr(row, f) for f in fields)
                    for row in model.objects.filter(board=board, card__isnull=True)
                ),
                key=repr,
            )
            for model, fields in DATED
        }

    def test_every_dated_deleted_card_row_moves_by_the_same_offset(self):
        self._deleted_card(open_block=True)
        data = self.export_json()
        source = (dt.date.today() - dt.timedelta(days=200)).isoformat()
        target = (dt.date.today() - dt.timedelta(days=200 - DAYS)).isoformat()

        plain = self._rows(self._import(data, shift_dates=False))
        shifted = self._rows(self._import(data, shift_dates_from=source, shift_dates_to=target))

        delta = dt.timedelta(days=DAYS)
        for name, rows in plain.items():
            with self.subTest(name):
                self.assertTrue(rows, "the fixture must carry a row of every type")
                self.assertEqual(
                    shifted[name],
                    sorted((tuple(v and v + delta for v in row) for row in rows), key=repr),
                )


class ShiftDeletedHistoryValuesTests(_Fixture):
    def test_date_values_of_deleted_and_live_activities_move(self):
        def activities():
            return [
                {"event_type": "due_date_change", "from_value": "2026-01-01", "to_value": ""},
                {"event_type": "custom_field_changed", "item_text": "Go live",
                 "from_value": "2026-01-02", "to_value": "2026-01-03"},
                {"event_type": "planned_released", "from_value": "pulled", "to_value": "2026-01-04"},
                {"event_type": "title_change", "from_value": "2026-01-05", "to_value": "x"},
            ]

        data = {
            "custom_fields": [{"name": "Go live", "field_type": "date"}],
            "cards": [{"activities": activities()}],
            "deleted_card_history": [{"activities": activities()}],
        }
        shift_board_dates(data, 1)

        for owner in (data["cards"][0], data["deleted_card_history"][0]):
            self.assertEqual(
                [(a["from_value"], a["to_value"]) for a in owner["activities"]],
                [
                    ("2026-01-02", ""),
                    ("2026-01-03", "2026-01-04"),
                    ("pulled", "2026-01-05"),
                    ("2026-01-05", "x"),
                ],
            )

    def test_malformed_section_is_left_for_the_validator(self):
        for value in (None, "x", 5, {"a": 1}, [None, "x", {"movements": "x", "blocks": [1]}]):
            with self.subTest(value=value):
                data = {"deleted_card_history": value}
                shift_board_dates(data, 3)
                self.assertEqual(data, {"deleted_card_history": value})
