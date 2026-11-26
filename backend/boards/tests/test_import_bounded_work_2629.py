"""#2629: board import date shifting does bounded work."""
from django.test import SimpleTestCase

from boards.services.date_shift import shift_board_dates


class _CountingDict(dict):
    """A values dict that counts membership tests made against it."""

    lookups = 0

    def __contains__(self, key):
        type(self).lookups += 1
        return super().__contains__(key)


class ShiftBoundedWorkTests(SimpleTestCase):
    def test_bounded_work_per_row(self):
        _CountingDict.lookups = 0
        n_defs = 500
        data = {
            "custom_fields": [{"name": f"d{i}", "field_type": "date"} for i in range(n_defs)],
            "cards": [{"custom_field_values": _CountingDict({"d0": "2024-01-01"})} for _ in range(20)],
        }
        shift_board_dates(data, 3)
        self.assertEqual(data["cards"][0]["custom_field_values"]["d0"], "2024-01-04")
        self.assertLessEqual(_CountingDict.lookups, 20)

    def test_normal_file_output_unchanged(self):
        data = {
            "custom_fields": [
                {"name": "start", "field_type": "date"},
                {"name": "note", "field_type": "text"},
            ],
            "swimlane_custom_fields": [{"name": "go_live", "field_type": "date"}],
            "swimlanes": [{"custom_field_values": {"go_live": "2024-03-01", "other": "2024-03-01"}}],
            "cards": [
                {"custom_field_values": {"start": "2024-01-30", "note": "2024-01-30", "unknown": "x"}},
                {"custom_field_values": {"start": "not-a-date"}},
                {"custom_field_values": None},
                {},
            ],
        }
        shift_board_dates(data, 2)
        self.assertEqual(data["swimlanes"][0]["custom_field_values"], {"go_live": "2024-03-03", "other": "2024-03-01"})
        self.assertEqual(
            data["cards"][0]["custom_field_values"], {"start": "2024-02-01", "note": "2024-01-30", "unknown": "x"},
        )
        self.assertEqual(data["cards"][1]["custom_field_values"], {"start": "not-a-date"})
