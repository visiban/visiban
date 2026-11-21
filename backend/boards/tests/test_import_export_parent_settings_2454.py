"""Board export/import carries the parent-item names and the child-cards flag (#2454).

Import must apply the same rules as the API write: a name with a bidi override
or control character is refused, not stored.
"""

import json

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane

IMPORT_URL = "/api/v1/boards/import/"


def _file(data):
    return SimpleUploadedFile("b.json", json.dumps(data).encode(), content_type="application/json")


class ParentSettingsRoundTripTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="rt2454", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.board = Board.objects.create(
            name="Parents", owner=self.user, cards_can_have_children=True,
            parent_name_singular="Initiative", parent_name_plural="Initiatives",
        )
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=self.board, name="To Do", position=0)
        Swimlane.objects.create(board=self.board, name="General", position=0)

    def _export(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(resp.status_code, 200)
        return json.loads(resp.content)

    def _import(self, data):
        cache.clear()
        return self.client.post(IMPORT_URL, {"file": _file(data)}, format="multipart")

    def test_export_carries_the_three_settings(self):
        data = self._export()
        self.assertEqual(data["parent_name_singular"], "Initiative")
        self.assertEqual(data["parent_name_plural"], "Initiatives")
        self.assertIs(data["cards_can_have_children"], True)

    def test_round_trip_restores_them(self):
        resp = self._import(self._export())
        self.assertEqual(resp.status_code, 201, resp.content)
        new = Board.objects.get(pk=resp.json()["id"])
        self.assertEqual(new.parent_name_singular, "Initiative")
        self.assertEqual(new.parent_name_plural, "Initiatives")
        self.assertTrue(new.cards_can_have_children)

    def test_older_export_without_the_keys_keeps_defaults(self):
        data = self._export()
        for key in ("parent_name_singular", "parent_name_plural", "cards_can_have_children"):
            del data[key]
        resp = self._import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        new = Board.objects.get(pk=resp.json()["id"])
        self.assertEqual((new.parent_name_singular, new.parent_name_plural), ("", ""))
        self.assertFalse(new.cards_can_have_children)

    def test_name_is_stripped_like_the_api_write(self):
        data = self._export()
        data["parent_name_singular"] = "  Epic  "
        resp = self._import(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Board.objects.get(pk=resp.json()["id"]).parent_name_singular, "Epic")

    def test_invalid_names_are_refused(self):
        bad = {
            "bidi override": "Ini‮tiative",
            "zero width": "Ini​tiative",
            "control char": "Ini\x07tiative",
            "too long": "x" * 25,
        }
        for key in ("parent_name_singular", "parent_name_plural"):
            for label, value in bad.items():
                with self.subTest(key=key, case=label):
                    data = self._export()
                    data[key] = value
                    before = Board.objects.count()
                    resp = self._import(data)
                    self.assertEqual(resp.status_code, 400, resp.content)
                    self.assertIn(f"'{key}'", resp.json()["detail"])
                    self.assertEqual(Board.objects.count(), before)

    def test_wrong_types_are_refused(self):
        for key, value in (
            ("parent_name_singular", 5),
            ("parent_name_plural", ["x"]),
            ("cards_can_have_children", "true"),
            ("cards_can_have_children", 1),
        ):
            with self.subTest(key=key, value=value):
                data = self._export()
                data[key] = value
                resp = self._import(data)
                self.assertEqual(resp.status_code, 400, resp.content)
                self.assertIn(f"'{key}'", resp.json()["detail"])

    def test_api_write_and_import_share_the_rule(self):
        """The same value the PATCH refuses, the import refuses."""
        resp = self.client.patch(
            f"/api/v1/boards/{self.board.id}/", {"parent_name_singular": "A‮B"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)
