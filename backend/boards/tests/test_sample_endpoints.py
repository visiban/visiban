"""Sample board gallery endpoints and the date-shift import option (#1452)."""

import datetime
import io
import json
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, TestCase, override_settings
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
        # Gallery order is the manifest's own order, and the featured sample leads it.
        self.assertEqual([s["id"] for s in resp.json()], [s["id"] for s in manifest])
        self.assertEqual(resp.json()[0]["id"], "software_development")
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

    def test_import_with_shifting_off_is_unchanged(self):
        # Without options a sample now shifts from its own date_anchor (#1949,
        # FileDateAnchorImportTests); shift_dates false keeps the file's dates.
        resp = self._post("simple_kanban", {"shift_dates": False})
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


class FileDateAnchorImportTests(TestCase):
    """#1949: a file's own top-level ``date_anchor`` shifts a raw JSON import.

    The gallery sends ``shift_dates_from``; choosing a sample file from disk
    or posting a curl-downloaded one sends nothing, so the importer reads the
    anchor from the file. An explicit option wins, ``shift_dates: false``
    opts out, and a file without the key imports exactly as before.
    """

    def setUp(self):
        patcher = mock.patch.object(BoardImportThrottle, "allow_request", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()
        self.user = User.objects.create_user(username="importer", password="pass")
        self.client.force_authenticate(self.user)
        self.client.raise_request_exception = False

    def _post(self, data, options=None, name="x.json"):
        f = io.BytesIO(data if isinstance(data, bytes) else json.dumps(data).encode())
        f.name = name
        payload = {"file": f}
        if options is not None:
            payload["options"] = json.dumps(options)
        return self.client.post("/api/v1/boards/import/", payload, format="multipart")

    def _file(self, anchor="2026-03-15", due="2026-03-20", **extra):
        data = {
            "name": "B", "columns": [{"name": "To Do", "position": 0}], "swimlanes": [{"name": "L"}],
            "custom_fields": [{"name": "Go-live", "field_type": "date"}],
            "cards": [{
                "title": "t", "column": "To Do", "swimlane": "L", "due_date": due,
                "custom_field_values": {"Go-live": due},
            }],
            **extra,
        }
        if anchor is not None:
            data["date_anchor"] = anchor
        return data

    def _due(self, resp):
        self.assertEqual(resp.status_code, 201, getattr(resp, "data", None))
        return Card.objects.get(board_id=resp.data["id"]).due_date

    def _shifted(self, date, anchor):
        days = (timezone.localdate() - datetime.date.fromisoformat(anchor)).days
        return datetime.date.fromisoformat(date) + datetime.timedelta(days=days)

    def test_anchored_file_without_options_is_shifted_from_its_anchor(self):
        resp = self._post(self._file())
        self.assertEqual(self._due(resp), self._shifted("2026-03-20", "2026-03-15"))
        value = CustomFieldValue.objects.get(card__board_id=resp.data["id"]).value
        self.assertEqual(value, self._shifted("2026-03-20", "2026-03-15").isoformat())
        # Reported as the anchor the dates moved from, in the response and the event.
        self.assertEqual(resp.data["import_summary"]["options_applied"]["shift_dates_from"], "2026-03-15")
        self.assertNotIn("shift_dates", resp.data["import_summary"]["options_applied"])
        from boards.models import BoardEvent
        event = BoardEvent.objects.filter(board_id=resp.data["id"]).order_by("-id").first()
        self.assertEqual(event.data["import_options"]["shift_dates_from"], "2026-03-15")

    def test_include_options_alone_still_use_the_anchor(self):
        resp = self._post(self._file(), {"labels": False})
        self.assertEqual(self._due(resp), self._shifted("2026-03-20", "2026-03-15"))

    def test_shift_dates_true_is_the_default_made_explicit(self):
        resp = self._post(self._file(), {"shift_dates": True})
        self.assertEqual(self._due(resp), self._shifted("2026-03-20", "2026-03-15"))
        self.assertIs(resp.data["import_summary"]["options_applied"]["shift_dates"], True)

    def test_explicit_shift_dates_from_wins_over_the_file_anchor(self):
        explicit = (timezone.localdate() - datetime.timedelta(days=7)).isoformat()
        resp = self._post(self._file(anchor="2026-01-01"), {"shift_dates_from": explicit})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 27))
        self.assertEqual(resp.data["import_summary"]["options_applied"]["shift_dates_from"], explicit)

    def test_explicit_option_wins_even_over_an_invalid_anchor(self):
        explicit = (timezone.localdate() - datetime.timedelta(days=7)).isoformat()
        resp = self._post(self._file(anchor="garbage"), {"shift_dates_from": explicit})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 27))

    def test_shift_dates_false_imports_the_dates_as_written(self):
        resp = self._post(self._file(), {"shift_dates": False})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 20))
        applied = resp.data["import_summary"]["options_applied"]
        self.assertNotIn("shift_dates_from", applied)
        self.assertIs(applied["shift_dates"], False)

    def test_shift_dates_false_skips_validating_the_anchor(self):
        for anchor in ("garbage", None, "2999-01-01"):
            with self.subTest(anchor):
                data = self._file()
                data["date_anchor"] = anchor
                self.assertEqual(self._due(self._post(data, {"shift_dates": False})), datetime.date(2026, 3, 20))

    def test_file_without_an_anchor_is_untouched(self):
        for options in (None, {}, {"shift_dates": True}, {"labels": False}):
            with self.subTest(options):
                resp = self._post(self._file(anchor=None), options)
                self.assertEqual(self._due(resp), datetime.date(2026, 3, 20))
                self.assertNotIn("shift_dates_from", resp.data["import_summary"]["options_applied"])

    def test_contradiction_with_shift_dates_from_is_rejected(self):
        resp = self._post(self._file(), {"shift_dates": False, "shift_dates_from": "2026-03-15"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(
            resp.data["detail"], "Invalid 'options': Import option shift_dates_from requires 'shift_dates'.",
        )
        self.assertFalse(Board.objects.exists())

    def test_shift_dates_must_be_a_json_boolean(self):
        for bad in ("false", 0, None):
            with self.subTest(bad):
                resp = self._post(self._file(), {"shift_dates": bad})
                self.assertEqual(resp.status_code, 400)
                self.assertIn("shift_dates", resp.data["detail"])

    def test_invalid_anchor_is_a_400_that_names_the_opt_out(self):
        tomorrow = (timezone.localdate() + datetime.timedelta(days=1)).isoformat()
        for anchor, why in (
            (tomorrow, "date_anchor cannot be in the future."),
            ("1999-01-01", "date_anchor cannot be more than 10 years ago."),
            ("garbage", "Date has wrong format."),
            ("2026-02-30", "Date has wrong format."),
            ("", "Date has wrong format."),
        ):
            with self.subTest(anchor):
                data = self._file()
                data["date_anchor"] = anchor  # set directly: _file(anchor=None) omits the key
                resp = self._post(data)
                self.assertEqual(resp.status_code, 400)
                self.assertIn(f"The file's 'date_anchor' is invalid: {why}", resp.data["detail"])
                self.assertIn("shift_dates as false", resp.data["detail"])
        self.assertFalse(Board.objects.exists())

    def test_a_non_string_anchor_is_no_anchor(self):
        """Only a string is an anchor, matching the dialog that offers the opt-out."""
        for anchor in (None, 20260315, ["2026-03-15"], {"d": "2026-03-15"}, True):
            with self.subTest(anchor):
                data = self._file()
                data["date_anchor"] = anchor
                resp = self._post(data)
                self.assertEqual(self._due(resp), datetime.date(2026, 3, 20))
                self.assertNotIn("shift_dates_from", resp.data["import_summary"]["options_applied"])

    def test_shipped_sample_files_carry_the_manifest_anchor(self):
        for entry in sample_boards.list_samples():
            with self.subTest(entry["id"]):
                _, body = sample_boards.get_sample(entry["id"])
                self.assertEqual(json.loads(body)["date_anchor"], entry["date_anchor"])

    def test_a_downloaded_sample_file_is_dated_around_today(self):
        """The reported path: a sample file imported with no options, as from disk or curl."""
        entry, body = sample_boards.get_sample("sales_pipeline")
        raw = json.loads(body)
        resp = self._post(body, name=entry["file"])
        self.assertEqual(resp.status_code, 201, resp.data)
        delta = timezone.localdate() - datetime.date.fromisoformat(entry["date_anchor"])
        due = {c.title: c.due_date for c in Card.objects.filter(board_id=resp.data["id"])}
        for c in raw["cards"]:
            if c["due_date"]:
                self.assertEqual(due[c["title"]], datetime.date.fromisoformat(c["due_date"]) + delta, c["title"])

    def test_csv_import_refuses_shift_dates(self):
        for options in ({"shift_dates": False}, {"shift_dates_to": "2026-06-01"}):
            with self.subTest(options):
                resp = self._post(b"Title,Column,Swimlane\nA,To Do,Main\n", options, name="x.csv")
                self.assertEqual(resp.status_code, 400)
                self.assertIn(next(iter(options)), resp.data["detail"])

    # -- shift_dates_to (#1949) ------------------------------------------------

    def test_shift_dates_to_dates_the_board_around_that_day(self):
        resp = self._post(self._file(), {"shift_dates_to": "2026-06-01"})
        # 2026-03-15 -> 2026-06-01 is 78 days; the card's 2026-03-20 moves with it.
        self.assertEqual(self._due(resp), datetime.date(2026, 6, 6))
        value = CustomFieldValue.objects.get(card__board_id=resp.data["id"]).value
        self.assertEqual(value, "2026-06-06")
        applied = resp.data["import_summary"]["options_applied"]
        self.assertEqual(applied["shift_dates_to"], "2026-06-01")
        self.assertEqual(applied["shift_dates_from"], "2026-03-15")
        from boards.models import BoardEvent
        event = BoardEvent.objects.filter(board_id=resp.data["id"]).order_by("-id").first()
        self.assertEqual(event.data["import_options"]["shift_dates_to"], "2026-06-01")

    def test_shift_dates_to_may_be_before_the_anchor(self):
        resp = self._post(self._file(), {"shift_dates_to": "2026-03-05"})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 10))

    def test_default_target_is_the_utc_date(self):
        # 23:30 UTC on 1 July is already 13:30 on 2 July in Kiritimati (UTC+14),
        # so localdate() and the UTC date differ: the target must be the UTC day.
        # (Settings pin TIME_ZONE to UTC, which alone could not tell them apart.)
        frozen = datetime.datetime(2026, 7, 1, 23, 30, tzinfo=datetime.timezone.utc)
        with override_settings(TIME_ZONE="Pacific/Kiritimati"), \
                mock.patch("django.utils.timezone.now", return_value=frozen):
            self.assertEqual(timezone.localdate(), datetime.date(2026, 7, 2))
            resp = self._post(self._file())
        # 2026-03-15 -> 2026-07-01 is 108 days.
        self.assertEqual(self._due(resp), datetime.date(2026, 7, 6))
        self.assertNotIn("shift_dates_to", resp.data["import_summary"]["options_applied"])

    def test_explicit_shift_dates_from_wins_and_shift_dates_to_still_applies(self):
        resp = self._post(
            self._file(anchor="2026-01-01"), {"shift_dates_from": "2026-03-01", "shift_dates_to": "2026-03-11"},
        )
        # From the explicit 2026-03-01 (not the file's 2026-01-01) to 2026-03-11: +10 days.
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 30))

    def test_shift_dates_to_also_applies_to_an_explicit_source_without_an_anchor(self):
        resp = self._post(
            self._file(anchor=None), {"shift_dates_from": "2026-03-01", "shift_dates_to": "2026-03-11"},
        )
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 30))

    def test_opt_out_ignores_shift_dates_to(self):
        resp = self._post(self._file(), {"shift_dates": False, "shift_dates_to": "2026-06-01"})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 20))
        applied = resp.data["import_summary"]["options_applied"]
        self.assertNotIn("shift_dates_to", applied)
        self.assertNotIn("shift_dates_from", applied)

    def test_shift_dates_to_leaves_a_file_without_an_anchor_untouched(self):
        resp = self._post(self._file(anchor=None), {"shift_dates_to": "2026-06-01"})
        self.assertEqual(self._due(resp), datetime.date(2026, 3, 20))
        self.assertNotIn("shift_dates_to", resp.data["import_summary"]["options_applied"])

    def test_malformed_or_out_of_range_shift_dates_to_is_a_400(self):
        tomorrow = (timezone.now().date() + datetime.timedelta(days=1)).isoformat()
        for bad, why in (
            ("garbage", "Date has wrong format."),
            ("2026-02-30", "Date has wrong format."),
            (20260601, "Date has wrong format."),
            (None, "This field may not be null."),
            (tomorrow, "shift_dates_to cannot be in the future."),
            ("1999-01-01", "shift_dates_to cannot be more than 10 years ago."),
        ):
            with self.subTest(bad):
                resp = self._post(self._file(), {"shift_dates_to": bad})
                self.assertEqual(resp.status_code, 400)
                self.assertIn("'shift_dates_to'", resp.data["detail"])
                self.assertIn(why, resp.data["detail"])
        self.assertFalse(Board.objects.exists())


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
                "activities": [
                    {"created_at": "2026-02-03T00:00:00+00:00"},
                    {"event_type": "due_date_change", "from_value": "", "to_value": "2026-03-10",
                     "created_at": "2026-02-04T00:00:00+00:00"},
                    {"event_type": "title_change", "from_value": "2026-03-10", "to_value": "x"},
                ],
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
        # History agrees with the shifted card; an empty "from" and other event types are untouched.
        self.assertEqual(card["activities"][1]["from_value"], "")
        self.assertEqual(card["activities"][1]["to_value"], card["due_date"])
        self.assertEqual(card["activities"][2]["from_value"], "2026-03-10")
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
    """Each sample is 265-560 KB raw, ~30-60 KB gzipped at nginx's default level, so the proxy in front of
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


class NginxConnectSrcPolicyTests(SimpleTestCase):
    """The Compose nginx templates scope CSP connect-src to the app origin (#1879).

    Pinned next to the other shipped-config checks so a bare ws:/wss: scheme
    source cannot be reintroduced unnoticed.
    """

    REPO_ROOT = Path(__file__).resolve().parents[3]
    EXPECTED = {
        "nginx/app.conf.template": "wss",
        "nginx/app-http.conf.template": "ws",
    }

    def test_connect_src_names_the_app_origin(self):
        import re

        for rel, scheme in self.EXPECTED.items():
            path = self.REPO_ROOT / rel
            if not path.exists():
                self.skipTest("deployment configs are not part of the backend image")
            with self.subTest(rel):
                m = re.search(r"Content-Security-Policy[^\n]*connect-src ([^;]*);", path.read_text())
                self.assertIsNotNone(m)
                sources = m.group(1).split()
                self.assertEqual(
                    sources,
                    ["'self'", f"{scheme}://${{DOMAIN}}", f"{scheme}://${{DOMAIN}}:*"],
                )


class FrontendImageHeaderParityTests(SimpleTestCase):
    """The frontend image's default nginx config matches the bundled templates (#1994).

    ``frontend/nginx.default.conf`` is installed as ``conf.d/default.conf`` by both
    frontend Dockerfiles, so running the image on its own sends the same response
    headers as the bundled templates. Only the templated connect-src host list may
    differ; any other drift fails here.
    """

    REPO_ROOT = Path(__file__).resolve().parents[3]
    IMAGE_CONF = "frontend/nginx.default.conf"
    TEMPLATE = "nginx/app-http.conf.template"
    HEADERS = ("X-Frame-Options", "X-Content-Type-Options", "Content-Security-Policy")

    @classmethod
    def _header(cls, text, name):
        import re

        m = re.search(rf'^\s*add_header\s+{name}\s+(.*?)\s*;\s*$', text, re.M)
        if not m:
            return None
        return re.sub(r"connect-src[^;]*", "connect-src X", m.group(1).replace('"', ""))

    def _read(self, rel):
        path = self.REPO_ROOT / rel
        if not path.exists():
            self.skipTest("deployment configs are not part of the backend image")
        return path.read_text()

    def test_image_config_headers_match_bundled_template(self):
        image, template = self._read(self.IMAGE_CONF), self._read(self.TEMPLATE)
        for name in self.HEADERS:
            with self.subTest(name):
                self.assertIsNotNone(self._header(template, name))
                self.assertEqual(self._header(image, name), self._header(template, name))

    def test_headers_are_server_level(self):
        import re

        image = self._read(self.IMAGE_CONF)
        for block in re.findall(r"^\s*location\b[^{]*\{([^}]*)\}", image, re.M):
            self.assertNotIn("add_header", block)

    def test_both_dockerfiles_install_the_image_config(self):
        self._read(self.IMAGE_CONF)
        for rel in ("frontend/Dockerfile", "frontend/Dockerfile.prod"):
            with self.subTest(rel):
                self.assertRegex(
                    self._read(rel),
                    r"(?m)^COPY\s+nginx\.default\.conf\s+/etc/nginx/conf\.d/default\.conf",
                )


class SampleTypeContractTests(SimpleTestCase):
    """The TS ``SampleBoardInclude`` union must list exactly the values the API can send (#1452)."""

    def test_ts_includes_union_matches_the_serializer_choices(self):
        import re
        from boards.views.samples import SampleBoardSummarySerializer

        types_ts = Path(__file__).resolve().parents[3] / "frontend/src/types/index.ts"
        if not types_ts.exists():
            self.skipTest("frontend sources are not part of the backend image")
        m = re.search(r"export type SampleBoardInclude =([^;]+);", types_ts.read_text())
        self.assertIsNotNone(m, "SampleBoardInclude not found in frontend/src/types/index.ts")
        ts_values = set(re.findall(r"'([a-z]+)'", m.group(1)))
        choices = set(SampleBoardSummarySerializer().fields["includes"].child.choices)
        self.assertEqual(ts_values, choices)
        for entry in sample_boards.list_samples():
            self.assertLessEqual(set(entry["includes"]), choices, entry["id"])
