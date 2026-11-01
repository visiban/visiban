"""``purge_card_history`` also redacts the board change feed (#1816).

The feed stores each broadcast payload verbatim, so ``card.created``,
``card.updated``, ``card.unarchived`` and ``card.moved`` rows hold a card's
title, description, custom field values and external reference (and the
movement's notes) long after the card and its movements are gone. A purge
that erased movements but left these rows would leave the title readable to
every board member through ``GET /boards/{id}/events/``.

These tests drive the real write paths (REST) so the rows hold the payloads
production writes, then check that a purge:

- nulls the content values of every card event type for the selected cards,
  keeping every key at every level (the event contract never removes a key);
- leaves other cards' and other boards' rows, and content-free rows such as
  ``card.deleted``, byte-for-byte unchanged;
- applies the same selector (card, board, date range, deleted-only) to rows;
- reports counts on a dry run and changes nothing;
- records the redaction count in the same audit entry, and rolls everything
  back when that entry cannot be written;
- shows the redacted values, and ``redacted_at``, through the feed API.
"""

import datetime
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import AdminActionLog, User
from boards.management.commands.purge_card_history import redact_card_event_payload
from boards.models import BoardEvent, BoardMembership, Card, CardMovement, CustomFieldDefinition
from boards.tests.conftest import (
    _make_board, _make_column, _make_membership, _make_swimlane, _make_user,
)

SECRET_TITLE = "Acquisition target 1816"
SECRET_TITLE_2 = "Acquisition target 1816 renamed"
SECRET_DESC = "board-only description 1816"
SECRET_NOTE = "move note 1816"
SECRET_VALUE = "codename-1816"
SECRET_REF = "acme/secret-repo#1816"
SECRET_URL = "https://gitlab.example.com/acme/secret-repo/-/merge_requests/1816"
SECRETS = (SECRET_TITLE, SECRET_TITLE_2, SECRET_DESC, SECRET_NOTE, SECRET_VALUE, SECRET_REF, SECRET_URL)

CONTENT_EVENTS = {"card.created", "card.updated", "card.unarchived", "card.moved"}


def _utc(*args):
    return datetime.datetime(*args, tzinfo=datetime.timezone.utc)


def _key_shape(value):
    """The nested key structure of a payload, with every leaf value dropped."""
    if isinstance(value, dict):
        return {k: _key_shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_key_shape(v) for v in value]
    return None


class FeedRedactionBase(TestCase):
    def setUp(self):
        # Suppress the channel layer; rows are still written by
        # record_board_event inside each request's transaction.
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

        self.root = User.objects.create_superuser(username="root", password="pw-1816-x!")
        self.owner = _make_user("feed_owner")
        self.board = self._board("Alpha")
        self.other_board = self._board("Beta")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _board(self, name):
        board = _make_board(self.owner, name=name)
        _make_column(board, "To Do", 0, allow_card_creation=True)
        _make_column(board, "Done", 1)
        _make_swimlane(board, "General", 0)
        CustomFieldDefinition.objects.create(
            board=board, name="Codename", field_type=CustomFieldDefinition.FieldType.TEXT,
        )
        return board

    def _cols(self, board):
        return list(board.columns.order_by("position"))

    def _base(self, board):
        return f"/api/v1/boards/{board.pk}/cards/"

    def _card_lifecycle(self, board, *, delete=True, title=SECRET_TITLE):
        """Create, edit, move, archive, restore and (optionally) delete a card via REST.

        Returns the card uid. Every content event type is written with every
        content field populated.
        """
        todo, done = self._cols(board)
        lane = board.swimlanes.get()
        field = board.custom_field_definitions.get()
        resp = self.client.post(
            self._base(board),
            {
                "column": todo.pk, "swimlane": lane.pk, "title": title,
                "description": SECRET_DESC,
                "custom_field_values": [{"field_definition": field.pk, "value": SECRET_VALUE}],
                "external_ref": {"provider": "gitlab", "ref": SECRET_REF, "url": SECRET_URL},
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        card_id, uid = resp.json()["id"], resp.json()["uid"]
        resp = self.client.patch(
            f"{self._base(board)}{card_id}/", {"title": SECRET_TITLE_2}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        resp = self.client.post(
            f"{self._base(board)}{card_id}/move/",
            {"column_id": done.pk, "swimlane_id": lane.pk, "position": 0},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        # A REST move records no notes; an imported movement does. Give the
        # stored movement object notes so their redaction is exercised too.
        moved = BoardEvent.objects.filter(event="card.moved").latest("pk")
        moved.data["movement"]["notes"] = SECRET_NOTE
        BoardEvent.objects.filter(pk=moved.pk).update(data=moved.data)
        for action in ("archive", "unarchive"):
            resp = self.client.post(f"{self._base(board)}{card_id}/{action}/")
            self.assertIn(resp.status_code, (200, 204), resp.content)
        if delete:
            resp = self.client.delete(f"{self._base(board)}{card_id}/")
            self.assertEqual(resp.status_code, 204, resp.content)
        return uid

    def _rows(self, uid):
        """Every feed row about card *uid*, in id order."""
        rows = []
        for row in BoardEvent.objects.order_by("pk"):
            data = row.data if isinstance(row.data, dict) else {}
            card = data.get("card") if isinstance(data.get("card"), dict) else data
            if uid in (card.get("uid"), data.get("card_uid")):
                rows.append(row)
        return rows

    def _snapshot(self, rows):
        return {row.pk: (row.event, row.data, row.redacted_at) for row in rows}

    def _run(self, *args):
        out = StringIO()
        call_command("purge_card_history", "--actor", "root", *args, stdout=out)
        return out.getvalue()


class RedactsEveryCardEventTypeTests(FeedRedactionBase):
    def test_every_content_event_of_the_card_is_redacted_with_keys_kept(self):
        uid = self._card_lifecycle(self.board)
        before = self._rows(uid)
        self.assertEqual(
            [r.event for r in before],
            ["card.created", "card.updated", "card.moved", "card.archived",
             "card.unarchived", "card.deleted"],
        )
        # Guard against a vacuous pass: the rows really hold the secrets.
        stored = repr([r.data for r in before])
        for secret in SECRETS:
            self.assertIn(secret, stored)
        shapes = {r.pk: _key_shape(r.data) for r in before}

        out = self._run("--card", uid, "--yes")

        self.assertIn("redacted 4 change-feed event(s)", out)
        after = {r.pk: r for r in self._rows(uid)}
        self.assertEqual(set(after), set(shapes), "a purge must not delete feed rows")
        for pk, row in after.items():
            with self.subTest(event=row.event):
                # Same keys at every level, values aside.
                self.assertEqual(_key_shape(row.data), shapes[pk])
                if row.event not in CONTENT_EVENTS:
                    self.assertIsNone(row.redacted_at)
                    continue
                self.assertIsNotNone(row.redacted_at)
                card = row.data["card"] if row.event == "card.moved" else row.data
                self.assertEqual(card["uid"], uid)
                self.assertIsNone(card["title"])
                self.assertIsNone(card["description"])
                self.assertEqual(
                    card["external_ref"], {"provider": "gitlab", "ref": None, "url": None}
                )
                self.assertEqual(len(card["custom_field_values"]), 1)
                self.assertIsNone(card["custom_field_values"][0]["value"])
                self.assertIsNotNone(card["custom_field_values"][0]["field_definition"])
                # Structure is not content and stays.
                self.assertIsNotNone(card["column"])
                self.assertIsNotNone(card["id"])
        moved = next(r for r in after.values() if r.event == "card.moved")
        self.assertIsNone(moved.data["movement"]["card_title"])
        self.assertIsNone(moved.data["movement"]["notes"])
        self.assertEqual(moved.data["movement"]["card_uid"], uid)
        self.assertIsNotNone(moved.data["movement"]["to_column_name"])
        remaining = repr([r.data for r in after.values()])
        for secret in SECRETS:
            self.assertNotIn(secret, remaining)

    def test_other_cards_and_boards_are_untouched(self):
        target = self._card_lifecycle(self.board)
        same_board = self._card_lifecycle(self.board, title="Neighbour 1816")
        other_board = self._card_lifecycle(self.other_board, title="Elsewhere 1816")
        untouched = self._snapshot(self._rows(same_board) + self._rows(other_board))
        self.assertTrue(untouched)

        self._run("--card", target, "--yes")

        self.assertEqual(
            self._snapshot(self._rows(same_board) + self._rows(other_board)), untouched
        )

    def test_feed_api_returns_the_redacted_rows(self):
        uid = self._card_lifecycle(self.board)
        member = _make_user("feed_member")
        _make_membership(self.board, member, BoardMembership.Role.MEMBER)
        client = APIClient()
        client.force_authenticate(member)

        self._run("--card", uid, "--yes")

        resp = client.get(f"/api/v1/boards/{self.board.pk}/events/")
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.content.decode()
        for secret in SECRETS:
            self.assertNotIn(secret, body)
        results = resp.json()["results"]
        by_event = {r["event"]: r for r in results}
        self.assertIsNone(by_event["card.created"]["data"]["title"])
        self.assertIsNone(by_event["card.moved"]["data"]["card"]["title"])
        self.assertIsNone(by_event["card.moved"]["data"]["movement"]["notes"])
        for row in results:
            self.assertIn("redacted_at", row)
            if row["event"] in CONTENT_EVENTS:
                self.assertIsNotNone(row["redacted_at"])
            else:
                self.assertIsNone(row["redacted_at"])


class SelectorTests(FeedRedactionBase):
    def test_board_selector_redacts_deleted_cards_and_leaves_live_ones(self):
        deleted = self._card_lifecycle(self.board)
        live = self._card_lifecycle(self.board, delete=False, title="Live 1816")
        elsewhere = self._card_lifecycle(self.other_board)
        kept = self._snapshot(self._rows(live) + self._rows(elsewhere))

        self._run("--board", str(self.board.pk), "--yes")

        self.assertTrue(all(
            r.redacted_at is not None for r in self._rows(deleted) if r.event in CONTENT_EVENTS
        ))
        self.assertEqual(self._snapshot(self._rows(live) + self._rows(elsewhere)), kept)

    def test_include_live_cards_redacts_a_live_card(self):
        live = self._card_lifecycle(self.board, delete=False)

        self._run("--card", live, "--include-live-cards", "--yes")

        rows = [r for r in self._rows(live) if r.event in CONTENT_EVENTS]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r.redacted_at is not None for r in rows))
        # The card itself is not touched: only the feed's copies.
        self.assertEqual(Card.objects.get(uid=live).title, SECRET_TITLE_2)

    def test_date_range_applies_to_the_event_time(self):
        uid = self._card_lifecycle(self.board)
        rows = [r for r in self._rows(uid) if r.event in CONTENT_EVENTS]
        old, new = rows[:2], rows[2:]
        BoardEvent.objects.filter(pk__in=[r.pk for r in old]).update(created_at=_utc(2026, 1, 5))
        BoardEvent.objects.filter(pk__in=[r.pk for r in new]).update(created_at=_utc(2026, 3, 5))

        self._run("--card", uid, "--before", "2026-02-01", "--yes")

        state = {r.pk: r.redacted_at for r in self._rows(uid)}
        self.assertTrue(all(state[r.pk] is not None for r in old))
        self.assertTrue(all(state[r.pk] is None for r in new))

        self._run("--card", uid, "--since", "2026-03-01", "--yes")
        state = {r.pk: r.redacted_at for r in self._rows(uid)}
        self.assertTrue(all(state[r.pk] is not None for r in new))

    def test_date_only_sweep_skips_rows_without_a_card_uid(self):
        # A row whose payload has no uid (as the MCP tools wrote before
        # 1.2.0 GA) cannot be shown to belong to a deleted card.
        legacy = BoardEvent.objects.create(
            board_id=self.board.pk, event="card.created",
            data={"id": 999999, "title": "legacy 1816"},
        )
        uid = self._card_lifecycle(self.board)

        self._run("--since", "2000-01-01", "--yes")

        legacy.refresh_from_db()
        self.assertIsNone(legacy.redacted_at)
        self.assertEqual(legacy.data["title"], "legacy 1816")
        self.assertTrue(all(
            r.redacted_at is not None for r in self._rows(uid) if r.event in CONTENT_EVENTS
        ))

    def test_feed_rows_are_redacted_after_movements_were_already_purged(self):
        # A card purged by the 1.2 command (movements only) still has its
        # feed rows matched on a re-run: events are selected on their own.
        uid = self._card_lifecycle(self.board)
        CardMovement.objects.filter(card_uid=uid).delete()

        out = self._run("--card", uid, "--yes")

        self.assertIn("Deleted 0 movement row(s) of deleted cards and 0 block row(s), and redacted 4", out)
        entry = AdminActionLog.objects.get()
        self.assertEqual(entry.metadata["deleted_count"], 0)
        self.assertEqual(entry.metadata["redacted_event_count"], 4)

    def test_rerun_skips_redacted_rows_and_records_nothing(self):
        uid = self._card_lifecycle(self.board)
        self._run("--card", uid, "--yes")
        first = self._snapshot(self._rows(uid))

        out = self._run("--card", uid, "--yes")

        self.assertIn("nothing deleted, nothing recorded", out)
        self.assertEqual(self._snapshot(self._rows(uid)), first)
        self.assertEqual(AdminActionLog.objects.count(), 1)


class DryRunAuditAndRollbackTests(FeedRedactionBase):
    def test_dry_run_reports_event_count_and_changes_nothing(self):
        uid = self._card_lifecycle(self.board)
        before = self._snapshot(self._rows(uid))

        out = self._run("--card", uid)

        movements = CardMovement.objects.filter(card_uid=uid).count()
        self.assertGreater(movements, 0)
        self.assertIn(f"would delete {movements} movement row(s) of deleted cards", out)
        self.assertIn("redact 4 change-feed event(s)", out)
        for secret in SECRETS:
            self.assertNotIn(secret, out)
        self.assertEqual(self._snapshot(self._rows(uid)), before)
        self.assertFalse(AdminActionLog.objects.exists())

    def test_audit_entry_records_the_redaction_count_and_no_content(self):
        uid = self._card_lifecycle(self.board)
        movements = CardMovement.objects.filter(card_uid=uid).count()

        self._run("--card", uid, "--yes")

        entry = AdminActionLog.objects.get()
        self.assertEqual(entry.action, AdminActionLog.Action.CARD_HISTORY_PURGED)
        self.assertEqual(entry.metadata["redacted_event_count"], 4)
        self.assertEqual(entry.metadata["deleted_count"], movements)
        blob = repr(entry.metadata)
        for secret in SECRETS:
            self.assertNotIn(secret, blob)

    def test_failed_log_write_leaves_feed_rows_and_movements_intact(self):
        uid = self._card_lifecycle(self.board)
        before = self._snapshot(self._rows(uid))
        movements = CardMovement.objects.filter(card_uid=uid).count()
        self.assertGreater(movements, 0)

        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._run("--card", uid, "--yes")

        self.assertEqual(self._snapshot(self._rows(uid)), before)
        self.assertEqual(CardMovement.objects.filter(card_uid=uid).count(), movements)
        self.assertFalse(AdminActionLog.objects.exists())

    def test_query_count_does_not_grow_with_matching_rows(self):
        # Rows are fetched and written in batches, never one query per row.
        one = self._card_lifecycle(self.board, title="one")
        many = [self._card_lifecycle(self.other_board, title=f"m{i}") for i in range(3)]
        with CaptureQueriesContext(connection) as small:
            self._run("--board", str(self.board.pk), "--yes")
        self.assertTrue(all(
            r.redacted_at is not None for r in self._rows(one) if r.event in CONTENT_EVENTS
        ))
        with CaptureQueriesContext(connection) as large:
            self._run("--board", str(self.other_board.pk), "--yes")
        self.assertEqual(
            sum(1 for r in BoardEvent.objects.filter(redacted_at__isnull=False)
                if (r.data.get("card") or r.data).get("uid") in many),
            12,
        )
        self.assertEqual(len(large.captured_queries), len(small.captured_queries))


class RedactPayloadUnitTests(TestCase):
    def test_unrecognized_shapes_are_returned_unchanged(self):
        for event, data in (
            ("card.created", None),
            ("card.created", ["not", "a", "dict"]),
            ("card.deleted", {"card_uid": "abc"}),
            ("column.updated", {"title": "x"}),
        ):
            with self.subTest(event=event, data=data):
                self.assertEqual(redact_card_event_payload(event, data), data)

    def test_reorder_without_movement_and_malformed_values(self):
        data = {"card": {
            "uid": "u", "title": "t", "custom_field_values": ["junk"], "external_ref": "x",
        }}
        self.assertEqual(
            redact_card_event_payload("card.moved", data),
            {"card": {
                "uid": "u", "title": None, "custom_field_values": [None], "external_ref": None,
            }},
        )
        # A card with no link keeps its null link.
        self.assertEqual(
            redact_card_event_payload("card.updated", {"external_ref": None}),
            {"external_ref": None},
        )
        # The input is not mutated.
        self.assertEqual(data["card"]["title"], "t")
