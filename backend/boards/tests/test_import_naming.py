"""Default names for boards created by the JSON and CSV importers (#1446).

Both importers name the new board ``Imported: <name>`` and append the lowest
unused ``" - N"`` suffix when that name is already taken in the target scope
(the target group, or the caller's own ungrouped boards).
"""

import io
import json

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from boards.views.import_export import _imported_board_name
from groups.models import Group, GroupMembership

_URL = "/api/v1/boards/import/"
_CSV = "Title,Column,Swimlane\nFix login,To Do,General\n"


def _json_file(name="Roadmap", filename="board.json"):
    payload = {
        "name": name,
        "columns": [{"name": "To Do", "position": 0}],
        "swimlanes": [{"name": "General", "position": 0}],
        "cards": [],
    }
    f = io.BytesIO(json.dumps(payload).encode("utf-8"))
    f.name = filename
    return f


def _csv_file(filename="Q3 plan.csv"):
    f = io.BytesIO(_CSV.encode("utf-8"))
    f.name = filename
    return f


class ImportedBoardNameTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)

    def _post(self, file, **extra):
        resp = self.client.post(_URL, {"file": file, **extra}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.data)
        return resp.data["name"]

    # --- default names -------------------------------------------------

    def test_json_default_name_is_prefixed_file_name(self):
        self.assertEqual(self._post(_json_file("Template: Customer Success")),
                         "Imported: Template: Customer Success")

    def test_csv_default_name_is_prefixed_filename_stem(self):
        self.assertEqual(self._post(_csv_file("Q3 plan.csv")), "Imported: Q3 plan")

    def test_csv_only_last_extension_is_dropped(self):
        self.assertEqual(self._post(_csv_file("export.2026.csv")), "Imported: export.2026")

    # --- duplicates ----------------------------------------------------

    def test_json_duplicates_number_from_one(self):
        names = [self._post(_json_file("Roadmap")) for _ in range(4)]
        self.assertEqual(names, [
            "Imported: Roadmap",
            "Imported: Roadmap - 1",
            "Imported: Roadmap - 2",
            "Imported: Roadmap - 3",
        ])

    def test_csv_duplicates_number_from_one(self):
        names = [self._post(_csv_file("plan.csv")) for _ in range(3)]
        self.assertEqual(names, ["Imported: plan", "Imported: plan - 1", "Imported: plan - 2"])

    def test_json_and_csv_share_one_numbering(self):
        self.assertEqual(self._post(_json_file("plan")), "Imported: plan")
        self.assertEqual(self._post(_csv_file("plan.csv")), "Imported: plan - 1")

    def test_lowest_unused_number_fills_gaps(self):
        for name in ("Imported: Roadmap", "Imported: Roadmap - 1", "Imported: Roadmap - 3"):
            Board.objects.create(name=name, owner=self.user)
        self.assertEqual(self._post(_json_file("Roadmap")), "Imported: Roadmap - 2")

    def test_suffix_only_applies_when_base_is_taken(self):
        # A free base name wins even if suffixed siblings exist.
        Board.objects.create(name="Imported: Roadmap - 1", owner=self.user)
        self.assertEqual(self._post(_json_file("Roadmap")), "Imported: Roadmap")

    def test_case_differing_name_is_not_a_duplicate(self):
        Board.objects.create(name="imported: roadmap", owner=self.user)
        self.assertEqual(self._post(_json_file("Roadmap")), "Imported: Roadmap")

    # --- explicit name -------------------------------------------------

    def test_explicit_name_used_verbatim_for_json(self):
        Board.objects.create(name="Mine", owner=self.user)
        self.assertEqual(self._post(_json_file(), name="Mine"), "Mine")

    def test_explicit_name_used_verbatim_for_csv(self):
        self.assertEqual(self._post(_csv_file(), name="CSV Board"), "CSV Board")

    # --- scoping -------------------------------------------------------

    def _group(self, owner=None):
        group = Group.objects.create(name="Team", owner=owner or self.user)
        GroupMembership.objects.create(group=group, user=self.user, role=GroupMembership.Role.ADMIN)
        return group

    def test_group_scope_ignores_ungrouped_boards(self):
        Board.objects.create(name="Imported: Roadmap", owner=self.user)
        group = self._group()
        self.assertEqual(self._post(_json_file(), group_id=group.pk), "Imported: Roadmap")

    def test_group_scope_counts_other_members_boards(self):
        other = User.objects.create_user(username="other", password="pass")
        group = self._group(owner=other)
        Board.objects.create(name="Imported: Roadmap", owner=other, group=group)
        self.assertEqual(self._post(_json_file(), group_id=group.pk), "Imported: Roadmap - 1")

    def test_ungrouped_scope_ignores_group_boards(self):
        group = self._group()
        Board.objects.create(name="Imported: Roadmap", owner=self.user, group=group)
        self.assertEqual(self._post(_json_file()), "Imported: Roadmap")

    def test_ungrouped_scope_ignores_inaccessible_boards(self):
        other = User.objects.create_user(username="other", password="pass")
        Board.objects.create(name="Imported: Roadmap", owner=other)
        self.assertEqual(self._post(_json_file()), "Imported: Roadmap")

    def test_ungrouped_scope_counts_boards_shared_with_importer(self):
        # "My Boards" on the Dashboard lists every accessible ungrouped board,
        # including ones another user shared, so those collide visibly too.
        other = User.objects.create_user(username="other", password="pass")
        shared = Board.objects.create(name="Imported: Roadmap", owner=other)
        BoardMembership.objects.create(board=shared, user=self.user, role=BoardMembership.Role.VIEWER)
        self.assertEqual(self._post(_json_file()), "Imported: Roadmap - 1")

    def test_csv_group_scope_counts_group_boards(self):
        other = User.objects.create_user(username="other", password="pass")
        group = self._group(owner=other)
        Board.objects.create(name="Imported: plan", owner=other, group=group)
        self.assertEqual(self._post(_csv_file("plan.csv"), group_id=group.pk), "Imported: plan - 1")

    def test_csv_group_scope_ignores_ungrouped_boards(self):
        Board.objects.create(name="Imported: plan", owner=self.user)
        group = self._group()
        self.assertEqual(self._post(_csv_file("plan.csv"), group_id=group.pk), "Imported: plan")

    def test_csv_colon_in_filename_is_kept(self):
        # A colon is not a drive separator in an uploaded filename.
        self.assertEqual(self._post(_csv_file("A: notes.csv")), "Imported: A: notes")


class ImportedBoardNameHelperTests(TestCase):
    """Edge cases of the shared helper that the HTTP layer cannot easily reach."""

    def setUp(self):
        self.user = User.objects.create_user(username="helper", password="pass")
        self.max_length = Board._meta.get_field("name").max_length

    def test_empty_or_non_string_source_falls_back(self):
        for source in ("", "   ", "\x00", None, 42, ["x"]):
            with self.subTest(source=source):
                self.assertEqual(_imported_board_name(source, self.user, None), "Imported: Board")

    def test_nul_bytes_and_whitespace_are_stripped(self):
        self.assertEqual(_imported_board_name("  Road\x00map  ", self.user, None), "Imported: Roadmap")

    def test_control_characters_become_spaces(self):
        self.assertEqual(_imported_board_name("Road\nmap\t\r", self.user, None), "Imported: Road map")

    def test_long_name_truncated_to_max_length(self):
        name = _imported_board_name("x" * 400, self.user, None)
        self.assertEqual(len(name), self.max_length)
        self.assertTrue(name.startswith("Imported: x"))

    def test_long_name_duplicate_suffix_still_fits(self):
        first = _imported_board_name("x" * 400, self.user, None)
        Board.objects.create(name=first, owner=self.user)
        second = _imported_board_name("x" * 400, self.user, None)
        self.assertEqual(len(second), self.max_length)
        self.assertTrue(second.endswith(" - 1"))
        Board.objects.create(name=second, owner=self.user)
        self.assertTrue(_imported_board_name("x" * 400, self.user, None).endswith(" - 2"))

    def test_like_wildcards_in_name_are_literal(self):
        Board.objects.create(name="Imported: 100% done", owner=self.user)
        Board.objects.create(name="Imported: a_b", owner=self.user)
        self.assertEqual(_imported_board_name("100% done", self.user, None), "Imported: 100% done - 1")
        self.assertEqual(_imported_board_name("aXb", self.user, None), "Imported: aXb")
