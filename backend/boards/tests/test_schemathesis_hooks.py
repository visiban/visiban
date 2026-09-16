"""Tests for schemathesis_hooks (#1120).

The hook seeds real board/card/etc ids into schemathesis's path-parameter
generation so the `backend-schema-fuzz` job exercises real 200-path logic
instead of mostly 404s. Covers both halves: `_load_real_ids()` (the DB
lookups, including its graceful-degradation-to-None behavior) and
`map_path_parameters()` (the hook itself, which only overrides a parameter
when both a mapping and a real value exist).
"""
import importlib
from types import SimpleNamespace

from django.test import TestCase

from accounts.models import PersonalAccessToken
from boards.models import BoardMembership, CardChecklist, CardComment, Label
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user


def _fake_context(path):
    return SimpleNamespace(operation=SimpleNamespace(path=path))


def _hooks():
    # Imported lazily (not at module scope) because `schemathesis_hooks` runs a
    # DB query at import time (`_IDS = _load_real_ids()`, module.py:151) — fine
    # under `st run`, which loads it once at process startup, but pytest-django
    # blocks DB access during test collection, before any test's transaction
    # is open. Deferring the import into a TestCase method (already inside a
    # DB-allowed transaction) sidesteps that; `importlib` caches it either way,
    # so this costs nothing beyond the first call in the whole test run.
    return importlib.import_module("schemathesis_hooks")


class LoadRealIdsTests(TestCase):
    def test_returns_all_none_when_no_demo_board_exists(self):
        ids = _hooks()._load_real_ids()

        self.assertEqual(
            ids,
            {
                "board_pk": None,
                "column_id": None,
                "swimlane_id": None,
                "label_id": None,
                "card_id": None,
                "checklist_item_id": None,
                "comment_id": None,
                "member_user_id": None,
                "pat_id": None,
            },
        )

    def test_populates_board_and_direct_children(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        label = Label.objects.create(board=board, name="Bug")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["board_pk"], board.id)
        self.assertEqual(ids["column_id"], column.id)
        self.assertEqual(ids["swimlane_id"], swimlane.id)
        self.assertEqual(ids["label_id"], label.id)
        # No card exists yet — degrades to None rather than raising.
        self.assertIsNone(ids["card_id"])
        self.assertIsNone(ids["checklist_item_id"])
        self.assertIsNone(ids["comment_id"])

    def test_prefers_a_card_with_both_checklist_item_and_comment(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        # Bare card — would be picked by the fallback `.order_by("id").first()`
        # if the preferred lookup didn't filter it out.
        _make_card(column, swimlane, title="Bare Card")
        rich_card = _make_card(column, swimlane, title="Rich Card")
        item = CardChecklist.objects.create(card=rich_card, text="Do the thing")
        comment = CardComment.objects.create(card=rich_card, author=owner, body="Looks good")

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["card_id"], rich_card.id)
        self.assertEqual(ids["checklist_item_id"], item.id)
        self.assertEqual(ids["comment_id"], comment.id)

    def test_falls_back_to_any_card_when_none_has_both(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        column = _make_column(board)
        swimlane = _make_swimlane(board)
        card = _make_card(column, swimlane)

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["card_id"], card.id)
        self.assertIsNone(ids["checklist_item_id"])
        self.assertIsNone(ids["comment_id"])

    def test_member_user_id_excludes_the_owner(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        other = _make_user()
        BoardMembership.objects.create(board=board, user=other, role=BoardMembership.Role.MEMBER)

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["member_user_id"], other.id)

    def test_pat_id_prefers_the_non_owner_members_token(self):
        owner = _make_user()
        board = _make_board(owner, name="Visiban Demo Board")
        other = _make_user()
        BoardMembership.objects.create(board=board, user=other, role=BoardMembership.Role.MEMBER)
        PersonalAccessToken.generate(owner, "owner-token")
        _, raw = PersonalAccessToken.generate(other, "member-token")
        expected = PersonalAccessToken.objects.get(user=other).id

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["pat_id"], expected)

    def test_pat_id_falls_back_to_owner_token_when_no_other_member(self):
        owner = _make_user()
        _make_board(owner, name="Visiban Demo Board")
        PersonalAccessToken.generate(owner, "owner-token")
        expected = PersonalAccessToken.objects.get(user=owner).id

        ids = _hooks()._load_real_ids()

        self.assertEqual(ids["pat_id"], expected)


class MapPathParametersTests(TestCase):
    def setUp(self):
        # `_IDS` is computed once at module import time (against an empty DB
        # during test collection) — tests exercise `map_path_parameters`
        # directly against a controlled substitute rather than relying on it.
        hooks = _hooks()
        self._original_ids = hooks._IDS
        hooks._IDS = {"board_pk": 7, "card_id": None}
        self.addCleanup(setattr, hooks, "_IDS", self._original_ids)

    def test_passes_through_when_operation_is_none(self):
        context = SimpleNamespace(operation=None)
        params = {"id": "whatever"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, params)

    def test_passes_through_when_path_parameters_empty(self):
        context = _fake_context("/api/v1/boards/{id}/")

        result = _hooks().map_path_parameters(context, {})

        self.assertEqual(result, {})

    def test_passes_through_for_an_unmapped_path(self):
        context = _fake_context("/api/v1/groups/{id}/")
        params = {"id": "some-generated-value"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, params)

    def test_overrides_a_mapped_parameter_with_a_real_value(self):
        context = _fake_context("/api/v1/boards/{id}/")
        params = {"id": "some-generated-value"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"id": 7})

    def test_leaves_parameter_untouched_when_real_value_is_none(self):
        # card_id maps to None in this test's substitute _IDS.
        context = _fake_context("/api/v1/boards/{board_pk}/cards/{id}/")
        params = {"board_pk": "generated-board", "id": "generated-card"}

        result = _hooks().map_path_parameters(context, params)

        self.assertEqual(result, {"board_pk": 7, "id": "generated-card"})

    def test_does_not_add_a_param_absent_from_the_generated_set(self):
        # Schemathesis may generate only a subset of a path's declared
        # parameters (e.g. while exploring malformed input) — the hook must
        # not invent keys that were not already present.
        context = _fake_context("/api/v1/boards/{id}/")

        result = _hooks().map_path_parameters(context, {})

        self.assertEqual(result, {})
