"""Sample board gallery endpoints and the date-shift import option (#1452)."""

import datetime
import io
import json
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import SCOPE_READ, SCOPE_WRITE, PersonalAccessToken, User
from boards.models import Board, Card, CardMovement, CustomFieldValue
from boards.services import sample_boards
from boards.services.date_shift import shift_board_dates
from boards.views.import_export import BoardImportThrottle

LIST_URL = "/api/v1/boards/samples/"


def _detail(sample_id):
    return f"{LIST_URL}{sample_id}/"


class SampleEndpointTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="gallery", password="pass")
        self.client.force_authenticate(self.user)

    def test_list_matches_the_manifest_in_gallery_order(self):
        resp = self.client.get(LIST_URL)
        self.assertEqual(resp.status_code, 200)
        manifest = sample_boards.list_samples()
        self.assertEqual(resp.json(), manifest)
        self.assertEqual([s["order"] for s in resp.json()], sorted(s["order"] for s in resp.json()))
        self.assertEqual(resp.json()[0]["id"], "sales_overlay")
        self.assertEqual(resp["Cache-Control"], "private, max-age=3600")

    def test_list_does_not_expose_paths_or_hashes(self):
        for entry in self.client.get(LIST_URL).json():
            self.assertNotIn("file", entry)
            self.assertNotIn("sha256", entry)

    def test_detail_returns_the_file_bytes_with_a_strong_etag(self):
        entry, body = sample_boards.get_sample("simple_kanban")
        resp = self.client.get(_detail("simple_kanban"))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content, body)
        self.assertEqual(resp["Content-Type"], "application/json")
        self.assertEqual(resp["ETag"], f'"{entry["sha256"]}"')
        self.assertEqual(resp["Cache-Control"], "private, max-age=3600")

    def test_if_none_match_returns_304_without_a_body(self):
        etag = self.client.get(_detail("simple_kanban"))["ETag"]
        for header in (etag, f"W/{etag}", f'"other", {etag}'):
            with self.subTest(header):
                resp = self.client.get(_detail("simple_kanban"), HTTP_IF_NONE_MATCH=header)
                self.assertEqual(resp.status_code, 304)
                self.assertEqual(resp.content, b"")
                self.assertEqual(resp["ETag"], etag)

    def test_304_does_not_read_the_file(self):
        etag = self.client.get(_detail("simple_kanban"))["ETag"]
        with mock.patch.object(sample_boards, "read_body", side_effect=AssertionError("read")):
            self.assertEqual(self.client.get(_detail("simple_kanban"), HTTP_IF_NONE_MATCH=etag).status_code, 304)

    def test_a_stale_etag_gets_the_full_body(self):
        resp = self.client.get(_detail("simple_kanban"), HTTP_IF_NONE_MATCH='"stale"')
        self.assertEqual(resp.status_code, 200)

    def test_unknown_id_is_404(self):
        self.assertEqual(self.client.get(_detail("nope")).status_code, 404)

    def test_ids_outside_the_allowlist_never_reach_the_filesystem(self):
        for bad in ("..%2Fmanifest", "../manifest", "manifest.json", "Simple_Kanban", "simple-kanban", "%00"):
            with self.subTest(bad):
                self.assertEqual(self.client.get(f"{LIST_URL}{bad}/").status_code, 404)

    def test_manifest_is_not_a_sample_id(self):
        self.assertEqual(self.client.get(_detail("manifest")).status_code, 404)

    def test_every_manifest_id_is_served(self):
        for s in sample_boards.list_samples():
            with self.subTest(s["id"]):
                self.assertEqual(self.client.get(_detail(s["id"])).status_code, 200)

    def test_samples_route_is_not_swallowed_as_a_board_pk(self):
        self.assertEqual(self.client.get(LIST_URL).status_code, 200)

    def test_anonymous_is_401_on_both(self):
        anon = APIClient()
        self.assertEqual(anon.get(LIST_URL).status_code, 401)
        self.assertEqual(anon.get(_detail("simple_kanban")).status_code, 401)

    def test_pending_password_change_is_403_on_both(self):
        self.user.must_change_password = True
        self.user.save(update_fields=["must_change_password"])
        self.assertEqual(self.client.get(LIST_URL).status_code, 403)
        self.assertEqual(self.client.get(_detail("simple_kanban")).status_code, 403)

    def test_pending_username_change_is_403_on_both(self):
        self.user.must_change_username = True
        self.user.save(update_fields=["must_change_username"])
        self.assertEqual(self.client.get(LIST_URL).status_code, 403)
        self.assertEqual(self.client.get(_detail("simple_kanban")).status_code, 403)

    def test_read_only_methods(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method):
                self.assertEqual(getattr(self.client, method)(LIST_URL).status_code, 405)
                self.assertEqual(getattr(self.client, method)(_detail("simple_kanban")).status_code, 405)


class SampleEndpointTokenScopeTests(TestCase):
    """GET is a read: a read-scoped token can browse and fetch, a write-only one cannot."""

    def setUp(self):
        self.user = User.objects.create_user(username="patuser", password="pass")

    def _get(self, scopes, url):
        _, raw = PersonalAccessToken.generate(self.user, "t", scopes=scopes)
        return APIClient().get(url, HTTP_AUTHORIZATION=f"Token {raw}").status_code

    def test_read_scope_allows_both(self):
        self.assertEqual(self._get([SCOPE_READ], LIST_URL), 200)
        self.assertEqual(self._get([SCOPE_READ], _detail("simple_kanban")), 200)

    def test_write_scope_alone_does_not_satisfy_read(self):
        self.assertEqual(self._get([SCOPE_WRITE], LIST_URL), 403)
        self.assertEqual(self._get([SCOPE_WRITE], _detail("simple_kanban")), 403)

    def test_empty_scopes_are_denied(self):
        self.assertEqual(self._get([], _detail("simple_kanban")), 403)


class SampleImportDateShiftTests(TestCase):
    def setUp(self):
        patcher = mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        for i in range(1, 6):
            User.objects.create_user(username=f"demo{i}", password="pass")
        self.client.force_authenticate(self.user)

    def _post(self, sample_id, options=None):
        _, body = sample_boards.get_sample(sample_id)
        f = io.BytesIO(body)
        f.name = f"{sample_id}.json"
        payload = {"file": f}
        if options is not None:
            payload["options"] = json.dumps(options)
        return self.client.post("/api/v1/boards/import/", payload, format="multipart")

    def test_import_without_the_option_is_unchanged(self):
        resp = self._post("simple_kanban")
        self.assertEqual(resp.status_code, 201)
        self.assertNotIn("shift_dates_from", resp.data["import_summary"]["options_applied"])
        due = sorted(Card.objects.filter(board_id=resp.data["id"], due_date__isnull=False).values_list("due_date", flat=True))
        raw = sorted(c["due_date"] for c in json.loads(sample_boards.get_sample("simple_kanban")[1])["cards"] if c["due_date"])
        self.assertEqual([d.isoformat() for d in due], raw)

    def test_shift_moves_every_date_by_the_same_whole_days(self):
        entry, body = sample_boards.get_sample("customer_support")
        anchor = datetime.date.fromisoformat(entry["date_anchor"])
        days = (timezone.localdate() - anchor).days
        raw = json.loads(body)
        resp = self._post("customer_support", {"shift_dates_from": entry["date_anchor"]})
        self.assertEqual(resp.status_code, 201, resp.data)
        board = Board.objects.get(pk=resp.data["id"])
        delta = datetime.timedelta(days=days)

        due = {c.title: c.due_date for c in Card.objects.filter(board=board)}
        for c in raw["cards"]:
            expected = datetime.date.fromisoformat(c["due_date"]) + delta if c["due_date"] else None
            self.assertEqual(due[c["title"]], expected, c["title"])

        sla = {
            v.card.title: v.value
            for v in CustomFieldValue.objects.filter(card__board=board, field_definition__name="SLA due")
        }
        for c in raw["cards"]:
            if "SLA due" in c["custom_field_values"]:
                want = (datetime.date.fromisoformat(c["custom_field_values"]["SLA due"]) + delta).isoformat()
                self.assertEqual(sla[c["title"]], want, c["title"])

        moved = max(CardMovement.objects.filter(card__board=board).values_list("moved_at", flat=True))
        raw_latest = max(
            m["moved_at"] for c in raw["cards"] for m in c["movements"]
        )
        self.assertEqual(moved.date(), datetime.datetime.fromisoformat(raw_latest).date() + delta)

    def test_shift_leaves_most_cards_not_overdue(self):
        entry, _ = sample_boards.get_sample("sales_pipeline")
        resp = self._post("sales_pipeline", {"shift_dates_from": entry["date_anchor"]})
        board = Board.objects.get(pk=resp.data["id"])
        today = timezone.localdate()
        dated = Card.objects.filter(board=board, due_date__isnull=False)
        overdue = dated.filter(due_date__lt=today).count()
        self.assertLess(overdue, dated.count() * 0.5)

    def test_option_is_echoed_in_options_applied(self):
        entry, _ = sample_boards.get_sample("simple_kanban")
        resp = self._post("simple_kanban", {"shift_dates_from": entry["date_anchor"]})
        self.assertEqual(resp.data["import_summary"]["options_applied"]["shift_dates_from"], entry["date_anchor"])
        self.assertEqual(resp.json()["import_summary"]["options_applied"]["shift_dates_from"], entry["date_anchor"])

    def test_option_reaches_the_persisted_board_created_event_as_json(self):
        from boards.models import BoardEvent
        entry, _ = sample_boards.get_sample("simple_kanban")
        resp = self._post("simple_kanban", {"shift_dates_from": entry["date_anchor"]})
        event = BoardEvent.objects.filter(board_id=resp.data["id"]).order_by("-id").first()
        self.assertEqual(event.data["import_options"]["shift_dates_from"], entry["date_anchor"])

    def test_future_date_is_rejected(self):
        tomorrow = (timezone.localdate() + datetime.timedelta(days=1)).isoformat()
        resp = self._post("simple_kanban", {"shift_dates_from": tomorrow})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("future", resp.data["detail"])

    def test_implausibly_old_date_is_rejected(self):
        resp = self._post("simple_kanban", {"shift_dates_from": "1999-01-01"})
        self.assertEqual(resp.status_code, 400)

    def test_malformed_date_is_rejected(self):
        for bad in ("not-a-date", 20260315, True):
            with self.subTest(bad):
                self.assertEqual(self._post("simple_kanban", {"shift_dates_from": bad}).status_code, 400)

    def _post_raw(self, data, shift=True):
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "x.json"
        payload = {"file": f}
        if shift:
            payload["options"] = json.dumps({"shift_dates_from": "2026-03-15"})
        return self.client.post("/api/v1/boards/import/", payload, format="multipart")

    def _base(self, **card):
        return {
            "name": "B", "columns": [{"name": "To Do", "position": 0}], "swimlanes": [{"name": "L"}],
            "cards": [{"title": "t", "column": "To Do", "swimlane": "L", **card}],
        }

    def test_the_shift_never_changes_how_a_crafted_file_is_answered(self):
        """Some crafted files already crash the importer's own validators with or
        without the option (tracked separately). The shift must add no failure of
        its own and must leave unparseable or overflowing values untouched."""
        self.client.raise_request_exception = False
        for card in (
            {"due_date": "2024-02-30"}, {"due_date": "9999-12-31"},
            {"archived_at": "9999-12-31T23:59:59+00:00"}, {"archived_at": "2024-13-45T00:00:00Z"},
            {"comments": 5}, {"comments": [{"text": "x", "created_at": "2024-13-45T00:00:00Z"}]},
        ):
            with self.subTest(card):
                plain = self._post_raw(self._base(**card), shift=False).status_code
                shifted = self._post_raw(self._base(**card)).status_code
                self.assertEqual(shifted, plain)

    def test_overflowing_due_date_imports_unchanged_with_the_shift(self):
        resp = self._post_raw(self._base(due_date="9999-12-31"))
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(Card.objects.get(board_id=resp.data["id"]).due_date, datetime.date(9999, 12, 31))

    def test_non_container_shapes_in_definitions_do_not_500(self):
        self.client.raise_request_exception = False
        for patch in ({"custom_fields": 5}, {"swimlane_custom_fields": 7}):
            with self.subTest(patch):
                shifted = self._post_raw({**self._base(), **patch}).status_code
                plain = self._post_raw({**self._base(), **patch}, shift=False).status_code
                self.assertEqual(shifted, plain)

    def test_csv_import_refuses_the_option(self):
        f = io.BytesIO(b"Title,Column,Swimlane\nA,To Do,Main\n")
        f.name = "x.csv"
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": f, "options": json.dumps({"shift_dates_from": "2026-03-15"})},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("shift_dates_from", resp.data["detail"])


class ShiftBoardDatesUnitTests(SimpleTestCase):
    def _board(self):
        return {
            "custom_fields": [{"name": "Due", "field_type": "date"}, {"name": "Note", "field_type": "text"}],
            "swimlane_custom_fields": [{"name": "Renewal", "field_type": "date"}],
            "swimlanes": [{"name": "A", "custom_field_values": {"Renewal": "2026-03-01"}}],
            "cards": [{
                "title": "t", "due_date": "2026-03-10", "archived_at": "2026-03-11T08:00:00+00:00",
                "created_at": "2026-01-01T12:00:00+00:00",
                "custom_field_values": {"Due": "2026-03-12", "Note": "2026-03-12"},
                "comments": [{"created_at": "2026-02-01T00:00:00+00:00"}],
                "movements": [{"moved_at": "2026-02-02T00:00:00+00:00"}],
                "activities": [{"created_at": "2026-02-03T00:00:00+00:00"}],
            }],
        }

    def test_shifts_dates_and_timestamps_and_only_date_typed_custom_values(self):
        data = shift_board_dates(self._board(), 30)
        card = data["cards"][0]
        self.assertEqual(card["due_date"], "2026-04-09")
        self.assertEqual(card["archived_at"], "2026-04-10T08:00:00+00:00")
        self.assertEqual(card["created_at"], "2026-01-31T12:00:00+00:00")
        self.assertEqual(card["custom_field_values"], {"Due": "2026-04-11", "Note": "2026-03-12"})
        self.assertEqual(card["comments"][0]["created_at"], "2026-03-03T00:00:00+00:00")
        self.assertEqual(card["movements"][0]["moved_at"], "2026-03-04T00:00:00+00:00")
        self.assertEqual(card["activities"][0]["created_at"], "2026-03-05T00:00:00+00:00")
        self.assertEqual(data["swimlanes"][0]["custom_field_values"], {"Renewal": "2026-03-31"})

    def test_zero_days_changes_nothing(self):
        self.assertEqual(shift_board_dates(self._board(), 0), self._board())

    def test_malformed_and_missing_values_are_left_for_the_validators(self):
        board = {"cards": [{"title": "t", "due_date": "garbage", "comments": [{"created_at": 5}], "movements": None}]}
        shift_board_dates(board, 10)
        self.assertEqual(board["cards"][0]["due_date"], "garbage")
        self.assertEqual(board["cards"][0]["comments"][0]["created_at"], 5)

    def test_impossible_and_overflowing_dates_are_left_alone(self):
        board = {"cards": [{"due_date": "2024-02-30", "archived_at": "9999-12-31T23:59:59+00:00",
                            "created_at": "2024-13-45T00:00:00Z"}]}
        shift_board_dates(board, 400)
        self.assertEqual(board["cards"][0], {"due_date": "2024-02-30", "archived_at": "9999-12-31T23:59:59+00:00",
                                             "created_at": "2024-13-45T00:00:00Z"})

    def test_non_dict_shapes_do_not_raise(self):
        shift_board_dates({"cards": [{"comments": 5, "movements": "x"}], "custom_fields": 5,
                           "swimlane_custom_fields": 7, "swimlanes": 3}, 10)
        shift_board_dates({"cards": ["x", None], "swimlanes": [1], "custom_fields": "bad"}, 10)


class SampleFetchCompressionTests(SimpleTestCase):
    """Each sample is 240-560 KB raw, ~21-36 KB gzipped, so the proxy in front of
    /api/ must compress application/json. Pin it in every shipped nginx config
    (Compose dev, Compose prod, Helm) so dropping it fails here, not as a slow gallery."""

    REPO_ROOT = Path(__file__).resolve().parents[3]
    CONFIGS = (
        "nginx/app.conf.template",
        "nginx/app-http.conf.template",
        "helm/visiban/templates/frontend-configmap.yaml",
    )

    def test_proxy_configs_gzip_json(self):
        found = [self.REPO_ROOT / c for c in self.CONFIGS if (self.REPO_ROOT / c).exists()]
        if not found:
            self.skipTest("deployment configs are not part of the backend image")
        for path in found:
            with self.subTest(path.name):
                text = path.read_text()
                self.assertRegex(text, r"gzip\s+on;")
                self.assertRegex(text, r"gzip_types[^;]*application/json")
