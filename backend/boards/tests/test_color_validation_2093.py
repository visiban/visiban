"""#2093 - one hex rule for ``color`` on every write path."""
import io
import json
from types import SimpleNamespace

from django.core.cache import cache
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Label, Swimlane
from boards.utils import create_template_columns
from groups.models import Group, GroupLabel, GroupMembership
from visiban.colors import normalize_hex_color

BAD = ["red", "#12345", "#GGGGGG", "", "#1234567", "rgb(1,2,3)"]


class NormalizeHexColorTests(SimpleTestCase):
    def test_accepts_six_digit_hex_unchanged(self):
        self.assertEqual(normalize_hex_color("#aAbB09"), "#aAbB09")

    def test_expands_three_digit_hex_keeping_case(self):
        self.assertEqual(normalize_hex_color("#abc"), "#aabbcc")
        self.assertEqual(normalize_hex_color("#ABC"), "#AABBCC")

    def test_rejects_everything_else(self):
        for value in BAD + [None, 5, True, "abcdef"]:
            with self.subTest(value=value):
                self.assertIsNone(normalize_hex_color(value))


class _BoardApiBase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="c2093", password="x")
        self.board = Board.objects.create(name="B", owner=self.user)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.base = f"/api/v1/boards/{self.board.id}"


class _ColorApiMixin:
    """Shared create/update cases; subclasses provide url, factory, extra."""

    def _create_body(self, color):
        return {"name": "New", "color": color, **self.extra}

    def test_create_expands_short_hex(self):
        r = self.client.post(self.url, self._create_body("#abc"), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["color"], "#aabbcc")

    def test_create_accepts_full_hex(self):
        r = self.client.post(self.url, self._create_body("#12aBef"), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["color"], "#12aBef")

    def test_create_rejects_non_hex(self):
        for bad in BAD:
            with self.subTest(color=bad):
                r = self.client.post(self.url, self._create_body(bad), format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("color", r.json())

    def test_patch_rejects_non_hex_and_keeps_stored_value(self):
        obj = self.make("#112233")
        for bad in BAD:
            with self.subTest(color=bad):
                r = self.client.patch(f"{self.url}{obj.id}/", {"color": bad}, format="json")
                self.assertEqual(r.status_code, 400, r.content)
        obj.refresh_from_db()
        self.assertEqual(obj.color, "#112233")

    def test_patch_expands_short_hex(self):
        obj = self.make("#112233")
        r = self.client.patch(f"{self.url}{obj.id}/", {"color": "#f0a"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        obj.refresh_from_db()
        self.assertEqual(obj.color, "#ff00aa")

    def test_legacy_value_resent_unchanged_succeeds(self):
        # A pre-validation row holding "red": a rename that resends the
        # current color (as SwimlaneRow does) must not start failing.
        obj = self.make("red")
        r = self.client.patch(f"{self.url}{obj.id}/", {"name": "Renamed", "color": "red"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        obj.refresh_from_db()
        self.assertEqual((obj.name, obj.color), ("Renamed", "red"))

    def test_legacy_value_changed_to_another_non_hex_is_rejected(self):
        obj = self.make("red")
        r = self.client.patch(f"{self.url}{obj.id}/", {"color": "blue"}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_legacy_value_listing_still_loads(self):
        self.make("red")
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200, r.content)


class ColumnColorTests(_ColorApiMixin, _BoardApiBase):
    extra = {}

    def setUp(self):
        super().setUp()
        self.url = f"{self.base}/columns/"

    def make(self, color):
        return Column.objects.create(board=self.board, name="Old", position=5, color=color)


class SwimlaneColorTests(_ColorApiMixin, _BoardApiBase):
    extra = {}

    def setUp(self):
        super().setUp()
        self.url = f"{self.base}/swimlanes/"

    def make(self, color):
        return Swimlane.objects.create(board=self.board, name="Old", position=5, color=color)


class LabelColorTests(_ColorApiMixin, _BoardApiBase):
    extra = {}

    def setUp(self):
        super().setUp()
        self.url = f"{self.base}/labels/"

    def make(self, color):
        return Label.objects.create(board=self.board, name="Old", color=color)


class GroupLabelColorTests(_ColorApiMixin, TestCase):
    extra = {}

    def setUp(self):
        self.user = User.objects.create_user(username="g2093", password="x")
        self.group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/groups/{self.group.id}/labels/"

    def make(self, color):
        return GroupLabel.objects.create(group=self.group, name="Old", color=color)


class TemplateApplyColorTests(TestCase):
    def test_non_hex_template_color_falls_back_and_short_hex_expands(self):
        owner = User.objects.create_user(username="t2093", password="x")
        board = Board.objects.create(name="B", owner=owner)
        template = SimpleNamespace(columns_json=[
            {"name": "a", "color": "red"},
            {"name": "b", "color": "#abc"},
            {"name": "c", "color": "#112233"},
            {"name": "d"},
        ])
        create_template_columns(board, template)
        colors = list(board.columns.order_by("position").values_list("color", flat=True))
        self.assertEqual(colors, ["#6B7280", "#aabbcc", "#112233", "#6B7280"])


class JsonImportColorTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="i2093", password="x")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _post(self, data, options=None):
        cache.clear()  # the import throttle is 10/hour
        f = io.BytesIO(json.dumps(data).encode("utf-8"))
        f.name = "board.json"
        body = {"file": f}
        if options:
            body["options"] = json.dumps(options)
        return self.client.post("/api/v1/boards/import/", body, format="multipart")

    def _data(self, **top):
        data = {
            "name": "Imp",
            "columns": [{"name": "c1", "color": "red"}, {"name": "c2", "color": "#abc"},
                        {"name": "c3", "color": "#112233"}, {"name": "c4"}],
            "swimlanes": [{"name": "s1", "color": "#12345"}, {"name": "s2"}],
            "labels": [{"name": "l1", "color": "blue"}, {"name": "l2", "color": "#f00"}, {"name": "l3"}],
            "cards": [],
        }
        data.update(top)
        return data

    def test_non_hex_falls_back_per_field_and_is_counted(self):
        r = self._post(self._data())
        self.assertEqual(r.status_code, 201, r.content)
        board = Board.objects.get(pk=r.json()["id"])
        cols = dict(board.columns.values_list("name", "color"))
        self.assertEqual(cols, {"c1": "#6B7280", "c2": "#aabbcc", "c3": "#112233", "c4": "#6B7280"})
        lanes = dict(board.swimlanes.values_list("name", "color"))
        self.assertEqual(lanes, {"s1": "#3B82F6", "s2": "#3B82F6"})
        labels = dict(board.labels.values_list("name", "color"))
        self.assertEqual(labels, {"l1": "#EAB308", "l2": "#ff0000", "l3": "#EAB308"})
        self.assertEqual(r.json()["import_summary"]["skipped"]["colors"], 3)

    def test_labels_option_off_does_not_count_label_colors(self):
        r = self._post(self._data(), options={"labels": False})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["import_summary"]["skipped"]["colors"], 2)

    def test_clean_import_reports_zero(self):
        r = self._post(self._data(columns=[{"name": "c"}], swimlanes=[{"name": "s"}], labels=[]))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["import_summary"]["skipped"]["colors"], 0)

    def test_over_length_color_stays_400(self):
        r = self._post(self._data(columns=[{"name": "c", "color": "#1234567"}]))
        self.assertEqual(r.status_code, 400, r.content)
