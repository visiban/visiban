"""#1507 — malformed values in a JSON import return 400, never 500.

One test per site listed in the issue: column/swimlane positions, numeric
upper bounds, nulls and wrong types on NOT NULL text/bool columns,
over-length strings, numeric timestamps, an unhashable custom-field name with
``shift_dates_from``, child-collection caps, the bounded echo of uploaded
values, and the write-block guard that backs the per-field checks.

The over-length and over-2^31 cases only raise DataError on PostgreSQL; the
per-field checks reject them before the database on every backend, so these
tests assert the same 400 under SQLite.
"""

import io
import json
import logging
from unittest import mock

from django.core.cache import cache
from django.db import DataError
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import (
    Board, BoardMembership, Card, CardActivity, CardChecklist, CardComment, CardMovement,
    Column, Label, Swimlane,
)
from boards.views import import_export

IMPORT_URL = "/api/v1/boards/import/"
INT_MAX = 2**31 - 1


def _card(**extra):
    return {"title": "t", "column": "c", "swimlane": "s", **extra}


def _payload(cards=None, **top):
    data = {
        "name": "B",
        "columns": [{"name": "c"}],
        "swimlanes": [{"name": "s"}],
        "cards": [_card()] if cards is None else cards,
    }
    data.update(top)
    return data


class JsonImportValueValidationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="imp1507", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _post(self, data, options=None, **extra):
        cache.clear()  # the import throttle is 10/hour
        f = io.BytesIO(json.dumps(data).encode("utf-8"))
        f.name = "board.json"
        body = {"file": f, **extra}
        if options is not None:
            body["options"] = json.dumps(options)
        return self.client.post(IMPORT_URL, body, format="multipart")

    def assert_400(self, data, detail, **kw):
        before = Board.objects.count()
        resp = self._post(data, **kw)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content[:500])
        self.assertEqual(resp.json(), {"detail": detail})
        self.assertEqual(Board.objects.count(), before, "a rejected import must leave no board behind")

    def assert_201(self, data, **kw):
        resp = self._post(data, **kw)
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content[:500])
        return Board.objects.get(pk=resp.json()["id"])

    # -- column / swimlane position ------------------------------------------

    def test_duplicate_explicit_column_position(self):
        cols = [{"name": "a", "position": 1}, {"name": "c", "position": 1}]
        self.assert_400(_payload(columns=cols), "Duplicate column positions: 1")

    def test_explicit_column_position_colliding_with_default_index(self):
        # Entry 1 has no position, so it defaults to 1 and collides with entry 0.
        cols = [{"name": "a", "position": 1}, {"name": "c"}]
        self.assert_400(_payload(columns=cols), "Duplicate column positions: 1")

    def test_column_position_type_null_and_range(self):
        for bad in ("1", None, 1.5, True, -1, [1]):
            with self.subTest(bad=bad):
                self.assert_400(
                    _payload(columns=[{"name": "c", "position": bad}]),
                    "Column at index 0: position must be a non-negative integer",
                )
        self.assert_400(
            _payload(columns=[{"name": "c", "position": INT_MAX + 1}]),
            f"Column at index 0: position must be at most {INT_MAX}",
        )

    def test_swimlane_position_type_null_and_range(self):
        for bad in ("1", None, -1):
            with self.subTest(bad=bad):
                self.assert_400(
                    _payload(swimlanes=[{"name": "s", "position": bad}]),
                    "Swimlane at index 0: position must be a non-negative integer",
                )
        self.assert_400(
            _payload(swimlanes=[{"name": "s", "position": INT_MAX + 1}]),
            f"Swimlane at index 0: position must be at most {INT_MAX}",
        )

    def test_swimlane_duplicate_positions_still_import(self):
        # Swimlane has no (board, position) constraint; accepted as before.
        lanes = [{"name": "s", "position": 0}, {"name": "t", "position": 0}]
        board = self.assert_201(_payload(swimlanes=lanes))
        self.assertEqual(board.swimlanes.count(), 2)

    def test_max_int_position_imports(self):
        board = self.assert_201(_payload(
            columns=[{"name": "c", "position": INT_MAX}], cards=[_card(position=INT_MAX, weight=INT_MAX)],
        ))
        self.assertEqual(board.columns.get().position, INT_MAX)

    # -- card weight / position, column limits --------------------------------

    def test_card_weight_and_position_upper_bound(self):
        for field in ("weight", "position"):
            with self.subTest(field=field):
                self.assert_400(
                    _payload(cards=[_card(**{field: INT_MAX + 1})]),
                    f"Card at index 0: {field} must be at most {INT_MAX}",
                )

    def test_card_weight_and_position_null(self):
        for field in ("weight", "position"):
            with self.subTest(field=field):
                self.assert_400(
                    _payload(cards=[_card(**{field: None})]),
                    f"Card at index 0: {field} must be a non-negative integer",
                )

    def test_column_limits_upper_bound(self):
        for field in ("wip_limit", "weight_limit"):
            with self.subTest(field=field):
                self.assert_400(
                    _payload(columns=[{"name": "c", field: INT_MAX + 1}]),
                    f"Column at index 0: {field} must be at most {INT_MAX}",
                )

    def test_column_limits_null_still_imports(self):
        board = self.assert_201(_payload(columns=[{"name": "c", "wip_limit": None, "weight_limit": None}]))
        self.assertIsNone(board.columns.get().wip_limit)

    # -- null / wrong-typed text and bool values -------------------------------

    def test_column_color_null_or_wrong_type(self):
        for bad in (None, 5, ["#fff"]):
            with self.subTest(bad=bad):
                self.assert_400(
                    _payload(columns=[{"name": "c", "color": bad}]),
                    "Column at index 0: 'color' must be a string",
                )

    def test_swimlane_text_fields_null_or_wrong_type(self):
        for field in ("color", "contact_email", "notes"):
            with self.subTest(field=field):
                self.assert_400(
                    _payload(swimlanes=[{"name": "s", field: None}]),
                    f"Swimlane at index 0: '{field}' must be a string",
                )

    def test_label_color_null(self):
        self.assert_400(
            _payload(labels=[{"name": "l", "color": None}]),
            "Label at index 0: 'color' must be a string",
        )

    def test_board_description_null(self):
        self.assert_400(_payload(description=None), "Board 'description' must be a string")

    def test_card_description_null(self):
        self.assert_400(
            _payload(cards=[_card(description=None)]),
            "Card at index 0: 'description' must be a string",
        )

    def test_comment_body_null(self):
        self.assert_400(
            _payload(cards=[_card(comments=[{"body": None}])]),
            "Card at index 0, comment at index 0: 'body' must be a string",
        )

    def test_checklist_text_null(self):
        self.assert_400(
            _payload(cards=[_card(checklist=[{"text": None}])]),
            "Card at index 0, checklist item at index 0: 'text' must be a string",
        )

    def test_movement_notes_null(self):
        self.assert_400(
            _payload(cards=[_card(movements=[{"notes": None}])]),
            "Card at index 0, movement at index 0: 'notes' must be a string",
        )

    def test_activity_values_null(self):
        for field in ("from_value", "to_value"):
            with self.subTest(field=field):
                act = {"event_type": "title_change", field: None}
                self.assert_400(
                    _payload(cards=[_card(activities=[act])]),
                    f"Card at index 0, activity at index 0: '{field}' must be a string",
                )

    def test_column_bools_must_be_bool(self):
        for field in ("is_done", "allow_card_creation"):
            for bad in (None, "yes", 1, [True]):
                with self.subTest(field=field, bad=bad):
                    self.assert_400(
                        _payload(columns=[{"name": "c", field: bad}]),
                        f"Column at index 0: '{field}' must be true or false",
                    )

    def test_checklist_is_checked_must_be_bool(self):
        for bad in (None, "yes", 0):
            with self.subTest(bad=bad):
                self.assert_400(
                    _payload(cards=[_card(checklist=[{"text": "x", "is_checked": bad}])]),
                    "Card at index 0, checklist item at index 0: 'is_checked' must be true or false",
                )

    def test_nul_byte_in_text_rejected(self):
        # PostgreSQL text cannot hold NUL; psycopg raises ValueError (a 500).
        self.assert_400(
            _payload(cards=[_card(description="a\x00b")]),
            "Card at index 0: 'description' must not contain NUL characters",
        )

    # -- over-length strings ---------------------------------------------------

    def test_over_length_names(self):
        cases = (
            ("columns", Column, "Column"),
            ("swimlanes", Swimlane, "Swimlane"),
            ("labels", Label, "Label"),
        )
        for key, model, label in cases:
            limit = model._meta.get_field("name").max_length
            with self.subTest(key=key):
                data = _payload(cards=[])
                data[key] = [{"name": "x" * (limit + 1)}]
                self.assert_400(data, f"{label} at index 0: 'name' must be at most {limit} characters")
                data[key] = [{"name": "x" * limit}]
                self.assert_201(data)

    def test_over_length_color(self):
        self.assert_400(
            _payload(columns=[{"name": "c", "color": "#1234567"}]),
            "Column at index 0: 'color' must be at most 7 characters",
        )

    def test_over_length_contact_email(self):
        limit = Swimlane._meta.get_field("contact_email").max_length
        self.assert_400(
            _payload(swimlanes=[{"name": "s", "contact_email": "a" * (limit + 1)}]),
            f"Swimlane at index 0: 'contact_email' must be at most {limit} characters",
        )

    def test_over_length_card_title(self):
        limit = Card._meta.get_field("title").max_length
        self.assert_400(
            _payload(cards=[_card(title="x" * (limit + 1))]),
            f"Card at index 0: 'title' must be at most {limit} characters",
        )

    def test_over_length_checklist_text_and_movement_notes(self):
        limit = CardChecklist._meta.get_field("text").max_length
        self.assert_400(
            _payload(cards=[_card(checklist=[{"text": "x" * (limit + 1)}])]),
            f"Card at index 0, checklist item at index 0: 'text' must be at most {limit} characters",
        )
        limit = CardMovement._meta.get_field("notes").max_length
        self.assert_400(
            _payload(cards=[_card(movements=[{"notes": "x" * (limit + 1)}])]),
            f"Card at index 0, movement at index 0: 'notes' must be at most {limit} characters",
        )

    def test_over_length_movement_column_name_text(self):
        limit = CardMovement._meta.get_field("from_column_name").max_length
        for field in ("from_column", "to_column", "from_swimlane", "to_swimlane"):
            with self.subTest(field=field):
                self.assert_400(
                    _payload(cards=[_card(movements=[{field: "x" * (limit + 1)}])]),
                    f"Card at index 0, movement at index 0: '{field}' must be at most {limit} characters",
                )

    def test_unmatched_movement_column_name_within_limit_still_imports(self):
        board = self.assert_201(_payload(cards=[_card(movements=[{"from_column": "Gone"}])]))
        self.assertEqual(CardMovement.objects.get(card__board=board).from_column_name, "Gone")

    def test_over_length_explicit_board_name(self):
        limit = Board._meta.get_field("name").max_length
        self.assert_400(_payload(), f"'name' must be at most {limit} characters", name="x" * (limit + 1))

    # -- timestamps passed as numbers -----------------------------------------

    def test_numeric_card_timestamps(self):
        self.assert_400(
            _payload(cards=[_card(due_date=20200101)]),
            "Card at index 0: invalid due_date: 20200101",
        )
        self.assert_400(
            _payload(cards=[_card(archived_at=20200101)]),
            "Card at index 0: invalid timestamp for 'archived_at': 20200101",
        )

    def test_numeric_child_timestamps(self):
        for child, label, key in (
            ("comments", "comment", "created_at"),
            ("movements", "movement", "moved_at"),
            ("activities", "activity", "created_at"),
        ):
            with self.subTest(child=child):
                entry = {"event_type": "title_change", key: 20200101}
                self.assert_400(
                    _payload(cards=[_card(**{child: [entry]})]),
                    f"Card at index 0, {label} at index 0: invalid '{key}': 20200101",
                )

    # -- shift_dates_from with an unhashable custom field name ----------------

    def test_shift_dates_with_unhashable_custom_field_name(self):
        data = _payload(custom_fields=[{"name": ["x"], "field_type": "date"}])
        before = Board.objects.count()
        resp = self._post(data, options={"shift_dates_from": "2026-03-15"})
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content[:500])
        self.assertTrue(resp.json()["detail"].startswith("'custom_fields' entry at index 0:"))
        self.assertEqual(Board.objects.count(), before)

    # -- child-collection caps --------------------------------------------------

    def test_label_cap(self):
        cap = import_export._IMPORT_MAX_LABELS
        labels = [{"name": f"l{i}"} for i in range(cap + 1)]
        self.assert_400(
            _payload(labels=labels),
            f"Import contains {cap + 1} labels, which exceeds the limit of {cap}.",
        )
        self.assert_201(_payload(labels=labels[:cap]))

    def test_label_refs_per_card_cap(self):
        cap = import_export._IMPORT_MAX_LABEL_REFS_PER_CARD
        self.assert_400(
            _payload(cards=[_card(labels=["l"] * (cap + 1))]),
            f"Card at index 0: 'labels' has more than {cap} entries",
        )

    def test_per_card_child_caps(self):
        for child, cap in import_export._IMPORT_MAX_CHILDREN_PER_CARD.items():
            with self.subTest(child=child):
                self.assert_400(
                    _payload(cards=[_card(**{child: [{}] * (cap + 1)})]),
                    f"Card at index 0: '{child}' has {cap + 1} entries; the limit is {cap}",
                )

    def test_per_card_child_cap_boundary_imports(self):
        cap = import_export._IMPORT_MAX_CHILDREN_PER_CARD["comments"]
        board = self.assert_201(_payload(cards=[_card(comments=[{"body": "x"}] * cap)]))
        self.assertEqual(CardComment.objects.filter(card__board=board).count(), cap)

    def test_total_child_rows_cap(self):
        with mock.patch.object(import_export, "_IMPORT_MAX_CHILD_ROWS", 3):
            cards = [_card(comments=[{}, {}]), _card(checklist=[{}, {}])]
            self.assert_400(
                _payload(cards=cards),
                "Import contains more than 3 comments, checklist items, movements and activities in total.",
            )

    # -- bounded echoes and the O(n^2) duplicate check ------------------------

    def test_invalid_timestamp_echo_is_bounded(self):
        resp = self._post(_payload(cards=[_card(due_date="x" * 100_000)]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        detail = resp.json()["detail"]
        self.assertTrue(detail.startswith("Card at index 0: invalid due_date: 'xxx"))
        self.assertLess(len(detail), 200)

    def test_undefined_column_echo_is_bounded(self):
        resp = self._post(_payload(cards=[_card(column="y" * 100_000)]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertLess(len(resp.json()["detail"]), 200)

    def test_duplicate_label_names_are_listed_bounded(self):
        labels = [{"name": f"label-{i}"} for i in range(150)] * 2
        resp = self._post(_payload(labels=labels))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        detail = resp.json()["detail"]
        self.assertTrue(detail.startswith("Import contains 300 labels"))
        labels = [{"name": f"label-{i}"} for i in range(10)] * 2
        self.assert_400(
            _payload(labels=labels),
            "Duplicate label names: label-0, label-1, label-2, label-3, label-4 (and 5 more)",
        )

    def test_custom_field_serializer_echo_is_bounded(self):
        resp = self._post(_payload(custom_fields=[{"name": "f", "field_type": "z" * 100_000}]))
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertLess(len(resp.json()["detail"]), 300)

    # -- defense-in-depth write guard -----------------------------------------

    def test_write_guard_turns_database_error_into_generic_400(self):
        def boom(*args, **kwargs):
            raise DataError("value too long for type character varying(255): SECRET-VALUE")

        before = (Board.objects.count(), BoardMembership.objects.count(), Column.objects.count())
        with mock.patch.object(Card.objects, "bulk_create", side_effect=boom), \
                self.assertLogs("boards.views.import_export", logging.WARNING) as logs:
            resp = self._post(_payload())
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(resp.json(), {"detail": "The import file contains a value that cannot be stored."})
        # The atomic block rolled back: board, membership and columns are gone.
        self.assertEqual(
            (Board.objects.count(), BoardMembership.objects.count(), Column.objects.count()), before,
        )
        self.assertNotIn("SECRET-VALUE", "\n".join(logs.output))
        self.assertIn("DataError", "\n".join(logs.output))

    def test_write_guard_catches_a_real_integrity_error(self):
        # With the per-field layer switched off, a duplicate column position
        # reaches the database's unique_together and must still be a 400.
        cols = [{"name": "a", "position": 0}, {"name": "c", "position": 0}]
        with mock.patch.object(import_export, "_validate_json_import_values", return_value=None), \
                self.assertLogs("boards.views.import_export", logging.WARNING):
            self.assert_400(_payload(columns=cols), "The import file contains a value that cannot be stored.")
        self.assertEqual(Column.objects.count(), 0)

    def test_write_guard_does_not_mask_programming_errors(self):
        self.client.raise_request_exception = True
        with mock.patch.object(Card.objects, "bulk_create", side_effect=KeyError("bug")):
            with self.assertRaises(KeyError):
                self._post(_payload())

    # -- backward compatibility -------------------------------------------------

    def test_export_import_round_trip(self):
        src = Board.objects.create(name="Src", description="Desc", owner=self.user)
        BoardMembership.objects.create(board=src, user=self.user, role=BoardMembership.Role.ADMIN)
        col = Column.objects.create(
            board=src, name="Todo", position=0, color="#111111", wip_limit=3, weight_limit=9,
            allow_card_creation=True,
        )
        done = Column.objects.create(board=src, name="Done", position=1, is_done=True)
        lane = Swimlane.objects.create(
            board=src, name="Lane", position=0, color="#222222",
            contact_email="lane@example.com", notes="notes",
        )
        label = Label.objects.create(board=src, name="bug", color="#ff0000")
        card = Card.objects.create(
            board=src, column=col, swimlane=lane, title="T", description="D", weight=5, position=2,
            created_by=self.user, due_date="2026-01-31",
        )
        card.labels.add(label)
        Card.objects.create(board=src, column=done, swimlane=lane, title="Old", created_by=self.user)
        Card.objects.filter(title="Old").update(archived_at="2026-01-01T00:00:00Z")
        CardComment.objects.create(card=card, author=self.user, body="hello")
        CardChecklist.objects.create(card=card, text="step", is_checked=True, position=0)
        CardMovement.objects.create(
            card=card, from_column=col, to_column=done, from_swimlane=lane, to_swimlane=lane,
            moved_by=self.user, notes="moved",
        )
        CardActivity.objects.create(
            card=card, event_type=CardActivity.EventType.TITLE_CHANGE,
            from_value="a", to_value="T", actor=self.user,
        )

        cache.clear()
        exported = self.client.get(f"/api/v1/boards/{src.id}/export/", {"format": "json"})
        self.assertEqual(exported.status_code, 200)
        f = io.BytesIO(exported.content)
        f.name = "export.json"
        cache.clear()
        resp = self.client.post(IMPORT_URL, {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content[:500])
        new = Board.objects.get(pk=resp.json()["id"])
        new_col = new.columns.get(name="Todo")
        self.assertEqual((new_col.wip_limit, new_col.weight_limit, new_col.color), (3, 9, "#111111"))
        self.assertTrue(new.columns.get(name="Done").is_done)
        self.assertEqual(new.swimlanes.get().contact_email, "lane@example.com")
        self.assertEqual(new.cards.count(), 2)
        new_card = new.cards.get(title="T")
        self.assertEqual((new_card.weight, new_card.position), (5, 2))
        self.assertEqual(list(new_card.labels.values_list("name", flat=True)), ["bug"])
        self.assertEqual(CardChecklist.objects.get(card=new_card).text, "step")
        self.assertEqual(CardMovement.objects.get(card=new_card).notes, "moved")
        self.assertIsNotNone(new.cards.get(title="Old").archived_at)
