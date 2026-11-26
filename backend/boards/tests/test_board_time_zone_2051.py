"""Board time zone for flow-metric days and weeks (#2051).

A board may set ``time_zone`` (an IANA name). Flow metrics then date their
days, ISO weeks, ``from_date``/``to_date`` and the cumulative-flow ``?date=``
drill-down in that zone. Durations and the rolling sample window stay elapsed
time. ``null`` (the default) is the ADR's UTC rule, byte for byte: the
existing flow suites pin the numbers, and ``UtcBoardUnchangedTests`` pins that
null and an explicit ``UTC`` serve identical bytes.
"""
import datetime
import zoneinfo
from unittest import mock

from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, CardMovement
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import METRICS, EndpointFixture, FlowFixture, GroupingFixture

UTC = datetime.timezone.utc
LA = zoneinfo.ZoneInfo("America/Los_Angeles")


def at(*args):
    return datetime.datetime(*args, tzinfo=UTC)


class ZoneRangeTests(FlowFixture):
    def test_zone_is_required_so_a_caller_cannot_default_to_utc(self):
        # #2633: a forgotten zone must fail loudly, not bucket in UTC.
        with self.assertRaises(TypeError):
            fm.rolling_range(7, now=at(2026, 7, 15))
        with self.assertRaises(TypeError):
            fm.date_range(datetime.date(2026, 7, 1), datetime.date(2026, 7, 2), now=at(2026, 8, 1))
        with self.assertRaises(TypeError):
            fm.cumulative_flow_cards(None, datetime.date(2026, 7, 1))

    def test_rolling_range_buckets_local_days_and_keeps_the_elapsed_window(self):
        # 03:00Z on July 15 is still July 14 in Los Angeles.
        now = at(2026, 7, 15, 3, 0)
        utc, local = fm.rolling_range(7, now=now, zone=UTC), fm.rolling_range(7, now=now, zone=LA)
        self.assertEqual((utc.first_day, utc.last_day), (datetime.date(2026, 7, 8), datetime.date(2026, 7, 14)))
        self.assertEqual((local.first_day, local.last_day), (datetime.date(2026, 7, 7), datetime.date(2026, 7, 13)))
        self.assertEqual((local.start, local.end), (utc.start, utc.end))

    def test_date_range_opens_at_local_midnight(self):
        r = fm.date_range(datetime.date(2026, 7, 1), datetime.date(2026, 7, 2), now=at(2026, 8, 1), zone=LA)
        self.assertEqual((r.start, r.end), (at(2026, 7, 1, 7), at(2026, 7, 3, 7)))
        self.assertEqual(r.start.tzinfo, UTC)

    def test_a_dst_day_is_23_or_25_hours(self):
        for day, hours in ((datetime.date(2026, 3, 8), 23), (datetime.date(2026, 11, 1), 25)):
            with self.subTest(day=day):
                r = fm.date_range(day, day, now=at(2027, 1, 1), zone=LA)
                self.assertEqual(r.end - r.start, datetime.timedelta(hours=hours))

    def test_a_skipped_midnight_opens_the_day_at_its_first_instant(self):
        # Chile springs forward at 00:00 on 2026-09-06: the day starts at 01:00 -03.
        santiago = zoneinfo.ZoneInfo("America/Santiago")
        opens = fm._midnight(datetime.date(2026, 9, 6), santiago)
        self.assertEqual(opens, at(2026, 9, 6, 4))
        self.assertEqual(opens.astimezone(santiago).date(), datetime.date(2026, 9, 6))
        self.assertEqual((opens - datetime.timedelta(seconds=1)).astimezone(santiago).date(), datetime.date(2026, 9, 5))

    def test_zone_of_reads_the_board_and_falls_back_to_utc(self):
        self.assertIs(fm.zone_of(self.board), UTC)
        self.board.time_zone = "America/Los_Angeles"
        self.assertEqual(fm.zone_of(self.board), LA)
        # A name the tz database lost after it was stored: UTC, not a 500.
        self.board.time_zone = "Gone/Zone"
        with self.assertLogs("boards.services.flow_metrics", "WARNING") as logs:
            self.assertIs(fm.zone_of(self.board), UTC)
        self.assertNotIn("Gone/Zone", logs.output[0])

    def test_throughput_and_cumulative_flow_bucket_by_local_date(self):
        # Done at 03:00Z on July 10: July 10 in UTC, July 9 in Los Angeles.
        card = self.path(self.backlog, 20, self.doing, 10)
        self.row(card, self.doing, self.done, 0)
        CardMovement.objects.filter(card=card, to_column=self.done).update(moved_at=at(2026, 7, 10, 3))
        flow = self.flow()
        for zone, day in ((UTC, "2026-07-10"), (LA, "2026-07-09")):
            with self.subTest(zone=str(zone)):
                r = fm.date_range(datetime.date(2026, 7, 8), datetime.date(2026, 7, 11), now=self.now, zone=zone)
                counts = {s["start"]: s["count"] for s in fm.throughput(flow, r, period="day")["samples"]}
                self.assertEqual(counts[day], 1)
                self.assertEqual(sum(counts.values()), 1)
                cfd = {row["date"]: row["counts"][self.done.uid] for row in fm.cumulative_flow(flow, r)["days"]}
                previous = (datetime.date.fromisoformat(day) - datetime.timedelta(days=1)).isoformat()
                self.assertEqual((cfd[previous], cfd[day]), (0, 1))
                drill = fm.cumulative_flow_cards(flow, datetime.date.fromisoformat(day), zone=zone)
                done = next(c for c in drill["columns"] if c["column_uid"] == self.done.uid)
                self.assertEqual(done["card_uids"], [card.uid])


class TimeZoneEndpointTests(EndpointFixture):
    def set_zone(self, name):
        Board.objects.filter(pk=self.board.pk).update(time_zone=name)
        self.board.refresh_from_db()

    def test_endpoints_date_days_in_the_board_zone(self):
        card = self.path(self.backlog, 20, self.doing, 10)
        self.row(card, self.doing, self.done, 5)
        CardMovement.objects.filter(card=card, to_column=self.done).update(moved_at=at(2026, 11, 10, 3))
        params = {"period": "day", "from_date": "2026-11-08", "to_date": "2026-11-11"}
        for name, day in ((None, "2026-11-10"), ("America/Los_Angeles", "2026-11-09")):
            with self.subTest(zone=name):
                self.set_zone(name)
                samples = self.client.get(self.url("throughput"), params).json()["samples"]
                self.assertEqual([s["start"] for s in samples if s["count"]], [day])

    def test_drill_down_lists_a_card_done_late_in_the_local_day(self):
        # 03:00Z on D+1 is 19:00 or 20:00 on D in Los Angeles: the card is
        # done by the end of local day D, though not by UTC midnight of D+1.
        day = (self.now - datetime.timedelta(days=10)).date()
        card = self.path(self.backlog, 30, self.doing, 20)
        self.row(card, self.doing, self.done, 5)
        done_at = at(day.year, day.month, day.day, 3) + datetime.timedelta(days=1)
        CardMovement.objects.filter(card=card, to_column=self.done).update(moved_at=done_at)
        Card = type(card)
        Card.objects.filter(pk=card.pk).update(column=self.done)
        self.set_zone("America/Los_Angeles")
        body = self.client.get(self.url("cumulative-flow"), {"date": day.isoformat()}).json()
        done = next(c for c in body["columns"] if c["column_uid"] == self.done.uid)
        self.assertIn(card.uid, done["card_uids"])

    def test_drill_down_today_is_the_board_zones_today(self):
        # Pin "now" at 03:00Z: still yesterday in Los Angeles, so the UTC
        # yesterday is the Los Angeles today and is refused there.
        now = at(2026, 11, 20, 3)
        self.set_zone("America/Los_Angeles")
        with mock.patch("boards.views.analytics.timezone.now", return_value=now):
            refused = self.client.get(self.url("cumulative-flow"), {"date": "2026-11-19"})
            accepted = self.client.get(self.url("cumulative-flow"), {"date": "2026-11-18"})
        self.assertEqual(refused.status_code, 400, refused.content)
        self.assertIn("America/Los_Angeles day before today", refused.json()["detail"])
        self.assertEqual(accepted.status_code, 200, accepted.content)

    def test_drill_down_refusal_names_the_resolved_zone_not_the_stored_text(self):
        # A stored name the tz database lacks buckets in UTC, and the message
        # must say UTC rather than echo the stored text.
        type(self.board).objects.filter(pk=self.board.pk).update(time_zone="Mars/Olympus_Mons")
        now = at(2026, 11, 20, 3)
        with mock.patch("boards.views.analytics.timezone.now", return_value=now):
            refused = self.client.get(self.url("cumulative-flow"), {"date": "2026-11-20"})
        self.assertEqual(refused.status_code, 400, refused.content)
        detail = refused.json()["detail"]
        self.assertIn("whole UTC day before today", detail)
        self.assertNotIn("Mars", detail)

    def test_to_date_defaults_to_the_board_zones_today(self):
        self.set_zone("America/Los_Angeles")
        with mock.patch("boards.views.analytics.timezone.now", return_value=at(2026, 11, 20, 3)):
            samples = self.client.get(self.url("throughput"), {"period": "day", "from_date": "2026-11-17"}).json()
        # to_date = Nov 19 (LA today); whole days stop at Nov 18 (LA yesterday).
        self.assertEqual([s["start"] for s in samples["samples"]], ["2026-11-17", "2026-11-18"])


class UtcBoardUnchangedTests(EndpointFixture):
    """A board with no zone serves exactly the bytes an explicit UTC board does (1.0 contract)."""

    def test_null_and_utc_serve_identical_bytes(self):
        live = self.path(self.backlog, 40, self.doing, 12)
        done = self.path(self.backlog, 30, self.doing, 9, self.done, 3)
        archived = self.path(self.backlog, 25, self.review, 8, self.done, 2, archived=1)
        CardMovement.objects.filter(card=done, to_column=self.done).update(
            moved_at=datetime.datetime.combine(self.ago(3).date(), datetime.time(23, 30), tzinfo=UTC),
        )
        self.assertTrue(live and archived)
        queries = ({}, {"days": "7"}, {"period": "day"}, {"from_date": self.ago(20).date().isoformat()})
        drill = {"date": self.ago(3).date().isoformat()}

        def responses():
            out = []
            for metric in METRICS:
                for query in queries:
                    out.append(self.client.get(self.url(metric), query).content)
            out.append(self.client.get(self.url("cumulative-flow"), drill).content)
            out.append(self.client.get(f"/api/v1/boards/{self.board.pk}/analytics/").content)
            return out

        frozen = self.now
        with mock.patch("django.utils.timezone.now", return_value=frozen):
            unset = responses()
            Board.objects.filter(pk=self.board.pk).update(time_zone="UTC")
            explicit = responses()
            Board.objects.filter(pk=self.board.pk).update(time_zone="Pacific/Kiritimati")
            shifted = responses()
        self.assertEqual(unset, explicit)
        # Not vacuous: a zone 14 hours ahead moves at least one bucket.
        self.assertNotEqual(unset, shifted)


class TimeZoneSerializerTests(EndpointFixture):
    def patch(self, value, user=None):
        client = self.client if user is None else APIClient()
        if user is not None:
            client.force_authenticate(user)
        return client.patch(f"/api/v1/boards/{self.board.pk}/", {"time_zone": value}, format="json")

    def test_defaults_to_null_on_both_board_payloads(self):
        self.assertIsNone(self.client.get(f"/api/v1/boards/{self.board.pk}/").json()["time_zone"])
        self.assertIsNone(self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()["time_zone"])

    def test_admin_sets_and_clears_it(self):
        resp = self.patch("Europe/Berlin")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["time_zone"], "Europe/Berlin")
        self.assertEqual(self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()["time_zone"], "Europe/Berlin")
        for cleared in (None, ""):
            with self.subTest(cleared=cleared):
                resp = self.patch(cleared)
                self.assertEqual(resp.status_code, 200, resp.content)
                self.assertIsNone(resp.json()["time_zone"])
        self.assertEqual(self.patch("UTC").json()["time_zone"], "UTC")

    def test_rejects_names_outside_the_tz_database(self):
        for bad in ("Mars/Olympus", "localtime", "America", "europe/berlin", "../../etc/passwd",
                    "/usr/share/zoneinfo/UTC", "Etc/../UTC", "x" * 65, 5):
            with self.subTest(bad=bad):
                self.assertEqual(self.patch(bad).status_code, 400)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.time_zone)

    def test_non_zone_files_in_the_zoneinfo_dir_are_refused(self):
        # Debian-based CI images ship /usr/share/zoneinfo/localtime, which
        # available_timezones() returns; a macOS dev box does not (#2051).
        from unittest import mock

        from boards import serializers as board_serializers

        board_serializers._available_time_zones.cache_clear()
        self.addCleanup(board_serializers._available_time_zones.cache_clear)
        with mock.patch.object(
            board_serializers.zoneinfo, "available_timezones",
            return_value={"UTC", "Europe/Berlin", "localtime", "posixrules"},
        ):
            for bad in ("localtime", "posixrules"):
                with self.subTest(bad=bad):
                    self.assertEqual(self.patch(bad).status_code, 400)
            self.assertEqual(self.patch("Europe/Berlin").status_code, 200)

    def test_member_and_viewer_cannot_set_it(self):
        for role in ("member", "viewer"):
            with self.subTest(role=role):
                user = User.objects.create_user(username=f"tz_{role}", password="pw")
                BoardMembership.objects.create(board=self.board, user=user, role=role)
                self.assertEqual(self.patch("Europe/Berlin", user=user).status_code, 403)
                self.board.refresh_from_db()
                self.assertIsNone(self.board.time_zone)

    def test_full_payload_does_not_write_it(self):
        resp = self.client.patch(f"/api/v1/boards/{self.board.pk}/full/", {"time_zone": "Europe/Berlin"}, format="json")
        self.assertIn(resp.status_code, (400, 403, 405), resp.content)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.time_zone)


class TimeZoneGroupingTests(GroupingFixture):
    def test_a_completion_before_local_midnight_does_not_rank_its_group(self):
        # 03:00Z on the first day is the previous evening in Los Angeles, before
        # the range opens at local midnight, so the lane is not active in it.
        day = (self.now - datetime.timedelta(days=10)).date()
        card = self.card(self.done, created=40, lane=self.other_lane)
        self.row(card, None, self.backlog, 40)
        self.row(card, self.backlog, self.doing, 30)
        self.row(card, self.doing, self.done, 20)
        CardMovement.objects.filter(card=card, to_column=self.done).update(moved_at=at(day.year, day.month, day.day, 3))
        Board.objects.filter(pk=self.board.pk).update(time_zone="America/Los_Angeles")
        body = self.get(
            "throughput", group_by="swimlane", from_date=day.isoformat(),
            to_date=(day + datetime.timedelta(days=3)).isoformat(),
        )
        keys = [g["key"] for g in body["grouping"]["groups"]]
        self.assertNotIn(str(self.other_lane.id), keys)
