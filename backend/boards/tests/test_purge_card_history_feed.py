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
from boards.management.commands.purge_card_history import (
    _CARD_CONTENT_KEYS, _EXTERNAL_REF_CONTENT_KEYS, _MOVEMENT_CONTENT_KEYS,
    redact_card_event_payload,
)
from boards.models import (
    BoardEvent, BoardMembership, Card, CardActivity, CardBlock, CardMovement,
    CustomFieldDefinition,
)
from boards.serializers import CardMovementSerializer, CardSerializer, ExternalRefSerializer
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

SECRET_REASON = "waiting on acquisition legal 1816"
SECRET_RESOLUTION = "legal cleared the deal 1816"


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

    def _legacy(self, board, card_id, event="card.updated", **extra):
        """A row in the shape the MCP tools wrote in 1.2 pre-releases (#1926).

        No uid; the integer card id, title and description at the top level.
        """
        data = {
            "id": card_id, "title": SECRET_TITLE, "description": SECRET_DESC,
            "column": {"id": 1, "name": "To Do"}, "labels": [], **extra,
        }
        if event == "card.moved" and "flat" not in extra:
            data = {"card": data, "movement": {"id": 1, "from_column": "To Do"}}
        data.pop("flat", None)
        return BoardEvent.objects.create(board_id=board.pk, event=event, data=data)

    def _card_id(self, uid):
        """The integer id the card's REST-shaped feed rows recorded."""
        row = next(r for r in self._rows(uid) if r.event == "card.created")
        return row.data["id"]

    def _assert_legacy_redacted(self, row, redacted=True):
        row.refresh_from_db()
        card = row.data.get("card", row.data)
        if redacted:
            self.assertIsNotNone(row.redacted_at)
            self.assertIsNone(card["title"])
            self.assertIsNone(card["description"])
            self.assertEqual(card["column"], {"id": 1, "name": "To Do"})
        else:
            self.assertIsNone(row.redacted_at)
            self.assertEqual(card["title"], SECRET_TITLE)

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
        same_board = self._card_lifecycle(self.board, title="Neighbor 1816")
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

    def test_legacy_id_only_rows_are_redacted_under_card(self):
        # A deleted card's id comes from its REST-shaped rows (uid + id).
        uid = self._card_lifecycle(self.board)
        card_id = self._card_id(uid)
        nested = self._legacy(self.board, card_id, event="card.moved")
        flat = self._legacy(self.board, card_id, event="card.moved", flat=True)
        elsewhere = self._legacy(self.other_board, card_id)
        other_card = self._legacy(self.board, card_id + 1000)

        out = self._run("--card", uid, "--yes")

        self.assertIn("redacted 7 change-feed event(s)", out)
        for row in (nested, flat, elsewhere):
            self._assert_legacy_redacted(row)
        self._assert_legacy_redacted(other_card, redacted=False)
        self.assertNotIn("Note:", out)

    def test_legacy_rows_of_a_live_card_are_redacted_with_include_live(self):
        uid = self._card_lifecycle(self.board, delete=False)
        legacy = self._legacy(self.board, Card.objects.get(uid=uid).pk)

        self._run("--card", uid, "--include-live-cards", "--yes")

        self._assert_legacy_redacted(legacy)

    def test_legacy_rows_are_redacted_under_deleted_only(self):
        uid = self._card_lifecycle(self.board)
        deleted_row = self._legacy(self.board, self._card_id(uid))
        live = self._card_lifecycle(self.board, delete=False, title="Live 1816")
        live_row = self._legacy(self.board, Card.objects.get(uid=live).pk)
        # No usable id: cannot be attributed, so it stays and is reported.
        no_id = BoardEvent.objects.create(
            board_id=self.board.pk, event="card.created",
            data={"id": "x", "title": "unattributable 1816"},
        )

        out = self._run("--since", "2000-01-01", "--yes")

        self._assert_legacy_redacted(deleted_row)
        self._assert_legacy_redacted(live_row, redacted=False)
        no_id.refresh_from_db()
        self.assertIsNone(no_id.redacted_at)
        self.assertEqual(no_id.data["title"], "unattributable 1816")
        self.assertIn("Note: 1 change-feed card event(s)", out)
        self.assertNotIn("unattributable", out)

    def test_legacy_rows_are_redacted_on_a_12_era_rerun(self):
        # 1.2 deleted the movements and left the feed; a rerun with --card
        # still finds the id, even from rows a previous run already redacted.
        uid = self._card_lifecycle(self.board)
        card_id = self._card_id(uid)
        CardMovement.objects.filter(card_uid=uid).delete()
        self._run("--card", uid, "--yes")
        legacy = self._legacy(self.board, card_id)

        out = self._run("--card", uid, "--yes")

        self.assertIn("Deleted 0 movement row(s) of deleted cards and 0 block row(s), and redacted 1", out)
        self._assert_legacy_redacted(legacy)

    def test_resolved_id_that_a_live_card_now_has_is_skipped(self):
        # A restore with a reset sequence can give a live card a deleted
        # card's id; a deleted-card purge must not touch the live card's rows.
        uid = self._card_lifecycle(self.board)
        reused = self._card_id(uid)
        Card.objects.create(
            id=reused, board=self.board, column=self._cols(self.board)[0],
            swimlane=self.board.swimlanes.get(), title="Live 1816", position=0,
        )
        legacy = self._legacy(self.board, reused)

        self._run("--card", uid, "--yes")

        self._assert_legacy_redacted(legacy, redacted=False)

    def test_board_follow_skips_a_resolved_id_that_a_live_card_now_has(self):
        # The --board twin of the test above: the follow resolves a deleted
        # card's id from its payloads, and must drop it once a live card has it.
        uid = self._card_lifecycle(self.board)
        reused = self._card_id(uid)
        Card.objects.create(
            id=reused, board=self.board, column=self._cols(self.board)[0],
            swimlane=self.board.swimlanes.get(), title="Live 1816", position=0,
        )
        # On another board, so only the follow could reach it.
        legacy = self._legacy(self.other_board, reused)

        self._run("--board", str(self.board.pk), "--yes")

        self._assert_legacy_redacted(legacy, redacted=False)
        self.assertTrue(all(
            r.redacted_at is not None for r in self._rows(uid) if r.event in CONTENT_EVENTS
        ))

    def test_board_follow_matches_ids_on_uidless_rows_only(self):
        # A row that carries a uid is attributed by its uid: an unselected
        # card's row is left alone even if its payload id equals a selected
        # card's id.
        uid = self._card_lifecycle(self.board)
        card_id = self._card_id(uid)
        unselected = BoardEvent.objects.create(
            board_id=self.other_board.pk, event="card.updated",
            data={"uid": "fedcba9876543210", "id": card_id, "title": SECRET_TITLE},
        )
        nested = BoardEvent.objects.create(
            board_id=self.other_board.pk, event="card.moved",
            data={"card": {"uid": "fedcba9876543210", "id": card_id, "title": SECRET_TITLE}},
        )
        legacy = self._legacy(self.other_board, card_id)

        for args in (
            ("--board", str(self.board.pk), "--yes"),
            ("--board", str(self.board.pk), "--include-live-cards", "--yes"),
        ):
            with self.subTest(args=args):
                self._run(*args)
                for row in (unselected, nested):
                    row.refresh_from_db()
                    self.assertIsNone(row.redacted_at)
                    card = row.data.get("card", row.data)
                    self.assertEqual(card["title"], SECRET_TITLE)
        # The selected card's own uid-less row on that board is followed.
        self._assert_legacy_redacted(legacy)

    def test_unresolvable_card_id_reports_every_uidless_row_in_scope(self):
        # A deleted card with no REST-shaped row has no known id: any
        # uid-less row on the board could be its, so all are reported.
        uid = "0123456789abcdef"
        self._legacy(self.board, 424242)
        self._legacy(self.board, 424243)
        self._legacy(self.other_board, 424244)

        out = self._run("--card", uid, "--board", str(self.board.pk))

        self.assertIn("redact 0 change-feed event(s)", out)
        self.assertIn("Note: 2 change-feed card event(s)", out)

    def test_board_selector_follows_a_card_moved_to_another_board(self):
        # The Django admin can move a card between boards; its movements
        # follow it (admin.py) but its feed rows keep the old board_id.
        uid = self._card_lifecycle(self.other_board, delete=False)
        stay = self._card_lifecycle(self.other_board, title="Stays on Beta 1816")
        card = Card.objects.get(uid=uid)
        todo = self._cols(self.board)[0]
        Card.objects.filter(pk=card.pk).update(
            board=self.board, column=todo, swimlane=self.board.swimlanes.get(),
        )
        CardMovement.objects.filter(card=card).update(board_id=self.board.pk)
        legacy = self._legacy(self.other_board, card.pk)
        card_id = card.pk
        Card.objects.get(pk=card_id).delete()
        stay_rows = self._snapshot(self._rows(stay))

        self._run("--board", str(self.board.pk), "--yes")

        rows = [r for r in self._rows(uid) if r.event in CONTENT_EVENTS]
        self.assertEqual({r.board_id for r in rows}, {self.other_board.pk})
        self.assertTrue(all(r.redacted_at is not None for r in rows))
        self._assert_legacy_redacted(legacy)
        self.assertEqual(self._snapshot(self._rows(stay)), stay_rows)

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

    def _card_moved_between_boards(self, source, target):
        """A deleted card with events on both boards and its movements on *target*.

        Moved in the Django admin, so its movements go with it (admin.py) and
        its earlier events keep *source*'s id; the edit afterward writes an
        event on *target*. Returns the uid.
        """
        uid = self._card_lifecycle(source, delete=False)
        card = Card.objects.get(uid=uid)
        Card.objects.filter(pk=card.pk).update(
            board=target, column=self._cols(target)[0], swimlane=target.swimlanes.get(),
        )
        CardMovement.objects.filter(card=card).update(board_id=target.pk)
        resp = self.client.patch(
            f"{self._base(target)}{card.pk}/", {"title": SECRET_TITLE}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        Card.objects.get(pk=card.pk).delete()
        return uid

    def _content_rows_on(self, uid, board):
        rows = [r for r in self._rows(uid) if r.event in CONTENT_EVENTS and r.board_id == board.pk]
        self.assertTrue(rows)
        return rows

    def test_card_with_board_stays_on_the_board_when_its_history_is_elsewhere(self):
        uid = self._card_moved_between_boards(self.board, self.other_board)
        movements = CardMovement.objects.filter(card_uid=uid, board_id=self.other_board.pk).count()
        self.assertGreater(movements, 0)
        beta = self._snapshot(self._content_rows_on(uid, self.other_board))

        self._run("--card", uid, "--board", str(self.board.pk), "--yes")

        self.assertTrue(all(
            r.redacted_at is not None for r in self._content_rows_on(uid, self.board)
        ))
        self.assertEqual(self._snapshot(self._content_rows_on(uid, self.other_board)), beta)
        self.assertEqual(CardMovement.objects.filter(card_uid=uid).count(), movements)

    def test_card_with_board_follows_the_card_when_its_history_is_on_the_board(self):
        uid = self._card_moved_between_boards(self.other_board, self.board)

        self._run("--card", uid, "--board", str(self.board.pk), "--yes")

        for board in (self.board, self.other_board):
            self.assertTrue(all(
                r.redacted_at is not None for r in self._content_rows_on(uid, board)
            ))
        self.assertFalse(CardMovement.objects.filter(card_uid=uid).exists())

    def test_card_with_board_does_not_follow_records_outside_the_date_bound(self):
        uid = self._card_moved_between_boards(self.other_board, self.board)
        CardMovement.objects.filter(card_uid=uid).update(moved_at=_utc(2026, 3, 5))
        BoardEvent.objects.filter(pk__in=[r.pk for r in self._rows(uid)]).update(
            created_at=_utc(2026, 1, 5),
        )
        beta = self._snapshot(self._content_rows_on(uid, self.other_board))

        self._run("--card", uid, "--board", str(self.board.pk), "--before", "2026-02-01", "--yes")

        self.assertTrue(all(
            r.redacted_at is not None for r in self._content_rows_on(uid, self.board)
        ))
        self.assertEqual(self._snapshot(self._content_rows_on(uid, self.other_board)), beta)
        self.assertTrue(CardMovement.objects.filter(card_uid=uid).exists())

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
        # Uid-less legacy rows too: 1 against 3, attributed without a query each.
        self._legacy(self.board, self._card_id(one))
        for uid in many:
            self._legacy(self.other_board, self._card_id(uid))
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


class BlockedStateTests(FeedRedactionBase):
    """The block reason (#1149) is card content like the title.

    ``card.updated`` from a block, and every later card payload while the card
    stays blocked, hold ``blocked_reason``. ``CardBlock`` holds the same text,
    so deleting that row and leaving the event would not erase it.
    """

    def _blocked_card(self, board):
        """Create and block a card via REST; move, archive and restore it while blocked.

        Returns ``(id, uid)``. The card is still blocked, so every event type
        that renders the whole card has been written with the reason in it.
        """
        todo, done = self._cols(board)
        lane = board.swimlanes.get()
        resp = self.client.post(
            self._base(board), {"column": todo.pk, "swimlane": lane.pk, "title": SECRET_TITLE},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        card_id, uid = resp.json()["id"], resp.json()["uid"]
        url = f"{self._base(board)}{card_id}/"
        resp = self.client.post(f"{url}block/", {"reason": SECRET_REASON}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        resp = self.client.post(
            f"{url}move/", {"column_id": done.pk, "swimlane_id": lane.pk, "position": 0},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        for action in ("archive", "unarchive"):
            resp = self.client.post(f"{url}{action}/")
            self.assertIn(resp.status_code, (200, 204), resp.content)
        return card_id, uid

    def _unblock_and_delete(self, board, card_id):
        url = f"{self._base(board)}{card_id}/"
        resp = self.client.post(f"{url}unblock/", {"resolution": SECRET_RESOLUTION}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(self.client.delete(url).status_code, 204)

    def test_reason_is_redacted_from_every_event_that_carries_it(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        rows = [r for r in self._rows(uid) if r.event in CONTENT_EVENTS]
        carrying = {r.event for r in rows if SECRET_REASON in repr(r.data)}
        # Pins the premise: if a writer stops or starts carrying the text,
        # this test should be re-read rather than pass for the wrong reason.
        self.assertEqual(carrying, {"card.updated", "card.moved", "card.unarchived"})
        self.assertNotIn(SECRET_RESOLUTION, repr(list(BoardEvent.objects.values_list("data", flat=True))))
        shapes = {r.pk: _key_shape(r.data) for r in rows}

        out = self._run("--card", uid, "--yes")

        self.assertIn("and 1 block row(s)", out)
        self.assertFalse(CardBlock.objects.filter(card_uid=uid).exists())
        for row in BoardEvent.objects.order_by("pk"):
            self.assertNotIn(SECRET_REASON, repr(row.data))
            self.assertNotIn(SECRET_RESOLUTION, repr(row.data))
        blocked_rows = 0
        for row in rows:
            row.refresh_from_db()
            self.assertEqual(_key_shape(row.data), shapes[row.pk])
            card = row.data["card"] if row.event == "card.moved" else row.data
            self.assertIsNone(card["blocked_reason"])
            # Only the text is content: that it was blocked, and when, stays.
            if card["blocked_at"] is not None:
                blocked_rows += 1
                self.assertTrue(card["is_blocked"])
        self.assertGreaterEqual(blocked_rows, 3)
        entry = AdminActionLog.objects.get(action=AdminActionLog.Action.CARD_HISTORY_PURGED)
        self.assertEqual(entry.metadata["deleted_block_count"], 1)
        self.assertEqual(entry.metadata["redacted_event_count"], len(rows))
        self.assertGreater(entry.metadata["deleted_count"], 0)
        self.assertNotIn(SECRET_REASON, repr(entry.metadata))
        self.assertNotIn(SECRET_REASON, out)

    def test_feed_api_no_longer_returns_the_reason(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        self._run("--card", uid, "--yes")
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/events/")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertNotIn(SECRET_REASON, resp.content.decode())

    def _block_only_card_moved_from_other_board(self):
        """A card blocked on Beta, then moved to Alpha in the admin, with no movement rows.

        Its block moves with it (admin.py) and its feed rows keep Beta's id.
        The movements are gone as after a 1.2 purge, so only the block row
        ties the card to Alpha.
        """
        card_id, uid = self._blocked_card(self.other_board)
        Card.objects.filter(pk=card_id).update(
            board=self.board, column=self._cols(self.board)[0], swimlane=self.board.swimlanes.get(),
        )
        CardBlock.objects.filter(card_id=card_id).update(board_id=self.board.pk)
        CardMovement.objects.filter(card_id=card_id).delete()
        return card_id, uid

    def _assert_all_redacted_on_other_board(self, uid):
        rows = [r for r in self._rows(uid) if r.event in CONTENT_EVENTS]
        self.assertTrue(rows)
        self.assertEqual({r.board_id for r in rows}, {self.other_board.pk})
        self.assertTrue(all(r.redacted_at is not None for r in rows))
        self.assertNotIn(SECRET_REASON, repr([r.data for r in rows]))

    def test_board_selector_follows_a_deleted_card_selected_only_by_its_block(self):
        card_id, uid = self._block_only_card_moved_from_other_board()
        stay = self._card_lifecycle(self.other_board, title="Stays on Beta 1816")
        stay_rows = self._snapshot(self._rows(stay))
        Card.objects.get(pk=card_id).delete()

        out = self._run("--board", str(self.board.pk), "--yes")

        self.assertIn("and 1 block row(s)", out)
        self.assertFalse(CardBlock.objects.filter(card_uid=uid).exists())
        self._assert_all_redacted_on_other_board(uid)
        self.assertEqual(self._snapshot(self._rows(stay)), stay_rows)

    def test_board_selector_follows_a_live_card_selected_only_by_its_block(self):
        card_id, uid = self._block_only_card_moved_from_other_board()
        legacy = self._legacy(self.other_board, card_id)

        self._run("--board", str(self.board.pk), "--include-live-cards", "--yes")

        self.assertFalse(CardBlock.objects.filter(card_id=card_id).exists())
        self._assert_all_redacted_on_other_board(uid)
        self._assert_legacy_redacted(legacy)

    def test_dry_run_reports_movements_blocks_and_events_and_changes_nothing(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        before = self._snapshot(self._rows(uid))
        movements = CardMovement.objects.filter(card_uid=uid).count()
        events = sum(1 for r in self._rows(uid) if r.event in CONTENT_EVENTS)

        out = self._run("--card", uid)

        self.assertIn(
            f"would delete {movements} movement row(s) of deleted cards and 1 block row(s)", out,
        )
        self.assertIn(f"redact {events} change-feed event(s)", out)
        self.assertEqual(self._snapshot(self._rows(uid)), before)
        self.assertEqual(CardBlock.objects.filter(card_uid=uid).count(), 1)
        self.assertFalse(AdminActionLog.objects.exists())

    def _deleted_block_row(self, board, uid):
        """A block row of a deleted card, with no movement row selected beside it."""
        return CardBlock.objects.create(
            card=None, board=board, card_uid=uid, reason=SECRET_REASON,
            blocked_at=_utc(2026, 1, 5),
        )

    def test_dry_run_counts_the_cards_and_boards_of_a_block_only_selection(self):
        self._deleted_block_row(self.board, "a" * 16)
        self._deleted_block_row(self.other_board, "b" * 16)
        # Two blocks of one card count it once.
        self._deleted_block_row(self.other_board, "b" * 16)

        board_out = self._run("--board", str(self.board.pk))
        dated_out = self._run("--before", "2026-02-01")

        self.assertIn("0 movement row(s) of deleted cards and 1 block row(s)", board_out)
        self.assertIn("(1 card(s), 1 board(s))", board_out)
        self.assertIn("0 movement row(s) of deleted cards and 3 block row(s)", dated_out)
        self.assertIn("(2 card(s), 2 board(s))", dated_out)

    def test_dry_run_counts_movements_and_blocks_together(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        # The same card through both tables, plus a card that only has a block.
        self.assertIn("(1 card(s), 1 board(s))", self._run("--card", uid))
        self._deleted_block_row(self.other_board, "c" * 16)
        self.assertIn("(2 card(s), 2 board(s))", self._run("--since", "2026-01-01"))

    def test_dry_run_query_count_does_not_grow_with_block_rows(self):
        self._deleted_block_row(self.board, "a" * 16)
        for uid in ("b" * 16, "c" * 16, "d" * 16):
            self._deleted_block_row(self.other_board, uid)
        with CaptureQueriesContext(connection) as small:
            self._run("--board", str(self.board.pk))
        with CaptureQueriesContext(connection) as large:
            out = self._run("--board", str(self.other_board.pk))
        self.assertIn("(3 card(s), 1 board(s))", out)
        self.assertEqual(len(large.captured_queries), len(small.captured_queries))

    def test_activity_trail_stays_on_a_live_card_and_goes_with_a_deleted_one(self):
        # The docs state this limit: the command never touches CardActivity.
        card_id, _uid = self._blocked_card(self.board)
        url = f"{self._base(self.board)}{card_id}/"
        resp = self.client.post(f"{url}unblock/", {"resolution": SECRET_RESOLUTION}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)

        self._run("--board", str(self.board.pk), "--include-live-cards", "--yes")

        self.assertFalse(CardBlock.objects.filter(card_id=card_id).exists())
        timeline = self.client.get(f"{url}timeline/")
        self.assertEqual(timeline.status_code, 200, timeline.content)
        self.assertIn(SECRET_REASON, timeline.content.decode())
        self.assertIn(SECRET_RESOLUTION, timeline.content.decode())

        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertFalse(CardActivity.objects.filter(card_id=card_id).exists())

    def test_failed_log_write_rolls_back_movements_blocks_and_events(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        before = self._snapshot(self._rows(uid))
        movements = CardMovement.objects.filter(card_uid=uid).count()
        self.assertGreater(movements, 0)

        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._run("--card", uid, "--yes")

        self.assertEqual(self._snapshot(self._rows(uid)), before)
        self.assertEqual(CardMovement.objects.filter(card_uid=uid).count(), movements)
        self.assertEqual(CardBlock.objects.filter(card_uid=uid).count(), 1)
        self.assertFalse(AdminActionLog.objects.exists())

    def test_rerun_after_a_block_only_purge_records_nothing(self):
        card_id, uid = self._blocked_card(self.board)
        self._unblock_and_delete(self.board, card_id)
        self._run("--card", uid, "--yes")
        entries = AdminActionLog.objects.count()
        out = self._run("--card", uid, "--yes")
        self.assertIn("nothing deleted, nothing recorded", out)
        self.assertEqual(AdminActionLog.objects.count(), entries)


class EveryPayloadFieldIsClassifiedTests(TestCase):
    """A new payload field must be decided on, not silently left readable.

    The redaction is a list of keys, so a free-text field added to a serializer
    would ship unredacted and nothing else would notice: #1149's
    ``blocked_reason`` did exactly that. A failure here means choosing. Text a
    user wrote goes in the command's ``*_CONTENT_KEYS``; anything else goes in
    the structure set below. Rows a purge already redacted are skipped on a
    re-run, so a new content key also needs a plan for those rows.
    """

    # Nulled by _redact_card with their own rules, not by _CARD_CONTENT_KEYS.
    CARD_NESTED_CONTENT = {"custom_field_values", "external_ref"}
    CARD_STRUCTURE = {
        "id", "uid", "column", "swimlane", "priority", "assignee", "assignee_id",
        "labels", "label_ids", "due_date", "weight", "position", "created_by",
        "created_at", "updated_at", "last_moved_at", "last_move_is_creation",
        "column_entered_at",
        "attachment_count", "checklist_total", "checklist_done", "is_stale",
        "archived_at", "version", "blocker_count", "is_blocked", "blocked_at",
        # #445: dates and user ids of open checklist items — structure, not user text.
        "checklist_open_due_dates", "checklist_open_assignee_ids",
    }
    MOVEMENT_STRUCTURE = {
        "id", "card_uid",
        "from_column", "from_column_name", "from_column_uid",
        "to_column", "to_column_name", "to_column_uid",
        "from_swimlane", "from_swimlane_name", "from_swimlane_uid",
        "to_swimlane", "to_swimlane_name", "to_swimlane_uid",
        "moved_by", "moved_at", "movement_type", "imported_from_username",
    }
    EXTERNAL_REF_STRUCTURE = {"provider"}

    def test_card_fields(self):
        self.assertEqual(
            set(CardSerializer.Meta.fields),
            self.CARD_STRUCTURE | self.CARD_NESTED_CONTENT | set(_CARD_CONTENT_KEYS),
        )

    def test_movement_fields(self):
        self.assertEqual(
            set(CardMovementSerializer.Meta.fields),
            self.MOVEMENT_STRUCTURE | set(_MOVEMENT_CONTENT_KEYS),
        )

    def test_external_ref_fields(self):
        self.assertEqual(
            set(ExternalRefSerializer().fields),
            self.EXTERNAL_REF_STRUCTURE | set(_EXTERNAL_REF_CONTENT_KEYS),
        )


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

    def test_block_reason_is_nulled_and_block_state_kept(self):
        at = "2026-11-01T00:00:00Z"
        card = {"uid": "u", "is_blocked": True, "blocked_at": at, "blocked_reason": "why"}
        redacted = {"uid": "u", "is_blocked": True, "blocked_at": at, "blocked_reason": None}
        self.assertEqual(redact_card_event_payload("card.updated", card), redacted)
        self.assertEqual(
            redact_card_event_payload("card.moved", {"card": card, "movement": {"notes": "n"}}),
            {"card": redacted, "movement": {"notes": None}},
        )
        # A row written before #1149 has no such key, and does not gain one.
        self.assertEqual(redact_card_event_payload("card.updated", {"uid": "u"}), {"uid": "u"})

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

    def test_sibling_positions_carry_no_content_and_are_kept(self):
        # #1890: ids, positions and versions only, so a purge leaves them as is.
        siblings = [{"id": 4, "position": 2, "version": 1}]
        self.assertEqual(
            redact_card_event_payload(
                "card.moved", {"card": {"uid": "u", "title": "t"}, "sibling_positions": siblings},
            ),
            {"card": {"uid": "u", "title": None}, "sibling_positions": siblings},
        )

    def test_flat_legacy_card_moved_is_redacted_as_a_card(self):
        # The MCP tools' create-at-position card.moved (1.2 pre-releases).
        self.assertEqual(
            redact_card_event_payload("card.moved", {"id": 3, "title": "t", "description": "d"}),
            {"id": 3, "title": None, "description": None},
        )
