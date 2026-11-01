"""``purge_card_history`` erases retained movement history on request (#1797).

- Only history of deleted cards is matched unless ``--include-live-cards``.
- ``--card``, ``--board``, ``--since`` and ``--before`` combine with AND; a run
  with none of them is refused.
- Without ``--yes`` the command is a dry run that only reports a count.
- ``--actor`` must name an active superuser.
- The delete and its ``card_history.purged`` action-log entry share one
  transaction, and the entry records the selector and count, never a title.
"""

import datetime
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import AdminActionLog, User
from boards.models import Board, Card, CardBlock, CardMovement, Column, Swimlane

PURGED = AdminActionLog.Action.CARD_HISTORY_PURGED
SECRET_TITLE = "Layoffs plan 1797"
SECRET_NOTE = "confidential note 1797"


def _utc(*args):
    return datetime.datetime(*args, tzinfo=datetime.timezone.utc)


class PurgeCardHistoryTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser(username="root", password="pw-1797-x!")
        self.owner = User.objects.create_user(username="owner", password="pw-1797-x!")
        self.board = self._board("Alpha")
        self.other_board = self._board("Beta")

    # -- fixtures -------------------------------------------------------------

    def _board(self, name):
        board = Board.objects.create(name=name, owner=self.owner)
        Column.objects.create(board=board, name="To Do", position=0)
        Column.objects.create(board=board, name="Done", position=1)
        Swimlane.objects.create(board=board, name="General", position=0)
        return board

    def _card(self, board, title=SECRET_TITLE):
        return Card.objects.create(
            board=board, column=board.columns.order_by("position").first(),
            swimlane=board.swimlanes.first(), title=title,
            created_by=self.owner, position=0,
        )

    def _move(self, card, at):
        cols = list(card.board.columns.order_by("position"))
        movement = CardMovement.objects.create(
            card=card, from_column=cols[0], to_column=cols[1],
            moved_by=self.owner, notes=SECRET_NOTE,
        )
        # moved_at is auto_now_add; a queryset update is the only way to
        # backdate it (save() refuses to rewrite a movement).
        CardMovement.objects.filter(pk=movement.pk).update(moved_at=at)
        return movement.pk

    def _deleted_card_with_moves(self, board, *moments):
        card = self._card(board)
        uid = card.uid
        pks = [self._move(card, at) for at in moments]
        card.delete()
        self.assertEqual(
            CardMovement.objects.filter(pk__in=pks, card__isnull=True).count(), len(pks)
        )
        return uid, pks

    def _run(self, *args, actor="root"):
        out = StringIO()
        call_command("purge_card_history", "--actor", actor, *args, stdout=out)
        return out.getvalue()

    def _remaining(self, pks):
        return set(CardMovement.objects.filter(pk__in=pks).values_list("pk", flat=True))

    # -- refusals -------------------------------------------------------------

    def test_empty_selector_is_refused(self):
        _, pks = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        with self.assertRaisesMessage(CommandError, "without a selector"):
            self._run("--yes")
        self.assertEqual(self._remaining(pks), set(pks))
        self.assertFalse(AdminActionLog.objects.exists())

    def test_actor_must_be_an_active_superuser(self):
        uid, pks = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        User.objects.create_user(username="siteadmin", password="x", is_site_admin=True)
        User.objects.create_superuser(username="gone", password="x", is_active=False)
        for actor, message in (
            ("owner", "not an active superuser"),
            ("siteadmin", "not an active superuser"),
            ("gone", "not an active superuser"),
            ("nobody", "does not exist"),
        ):
            with self.subTest(actor=actor):
                with self.assertRaisesMessage(CommandError, message):
                    self._run("--card", uid, "--yes", actor=actor)
        self.assertEqual(self._remaining(pks), set(pks))
        self.assertFalse(AdminActionLog.objects.exists())

    def test_live_card_is_refused_without_the_flag(self):
        live = self._card(self.board)
        pk = self._move(live, _utc(2026, 1, 5))
        with self.assertRaisesMessage(CommandError, "still exists"):
            self._run("--card", live.uid, "--yes")
        self.assertEqual(self._remaining([pk]), {pk})

    def test_include_live_cards_still_matches_a_deleted_card_by_uid(self):
        # The flag widens the scope; a deleted card's rows (card NULL) are
        # matched through their card_uid snapshot, not the FK.
        uid, deleted = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 5), _utc(2026, 1, 6)
        )
        _, other = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        live_pk = self._move(self._card(self.board), _utc(2026, 1, 5))

        out = self._run("--card", uid, "--include-live-cards", "--yes")

        self.assertIn("Deleted 2 movement row(s)", out)
        self.assertEqual(self._remaining(deleted), set())
        self.assertEqual(self._remaining(other + [live_pk]), set(other + [live_pk]))
        entry = AdminActionLog.objects.get()
        self.assertEqual(entry.metadata["deleted_count"], 2)
        self.assertTrue(entry.metadata["selector"]["include_live_cards"])

    def test_live_cards_need_a_card_or_board_selector(self):
        live = self._card(self.board)
        pk = self._move(live, _utc(2026, 1, 5))
        for args in (["--before", "2030-01-01"], ["--since", "2000-01-01"]):
            with self.subTest(args=args):
                with self.assertRaisesMessage(CommandError, "needs --card or --board"):
                    self._run(*args, "--include-live-cards", "--yes")
        self.assertEqual(self._remaining([pk]), {pk})
        self.assertFalse(AdminActionLog.objects.exists())

    def test_date_only_selector_sweeps_deleted_cards_on_every_board(self):
        _, a = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        _, b = self._deleted_card_with_moves(self.other_board, _utc(2026, 1, 5))
        live_pk = self._move(self._card(self.board), _utc(2026, 1, 5))
        self._run("--before", "2026-02-01", "--yes")
        self.assertEqual(self._remaining(a + b + [live_pk]), {live_pk})

    def test_malformed_arguments_are_refused(self):
        for args, message in (
            (["--card", "short"], "16 hex"),
            (["--card", "zzzzzzzzzzzzzzzz"], "16 hex"),
            (["--board", "nope"], "no board"),
            (["--board", "999999"], "no board"),
            (["--board", "²"], "no board"),
            (["--board", "9" * 40], "no board"),
            (["--board", "g" * 16], "no board"),
            (["--since", "yesterday"], "--since must be"),
            (["--before", "2026-13-40"], "--before must be"),
            (["--since", "2026-02-01", "--before", "2026-01-01"], "earlier than"),
        ):
            with self.subTest(args=args):
                with self.assertRaisesMessage(CommandError, message):
                    self._run(*args, "--yes")

    # -- dry run --------------------------------------------------------------

    def test_dry_run_is_the_default_and_changes_nothing(self):
        uid, pks = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 5), _utc(2026, 1, 6)
        )
        out = self._run("--card", uid)
        self.assertIn("Dry run: would delete 2 movement row(s) of deleted cards", out)
        self.assertIn("1 card(s), 1 board(s)", out)
        self.assertNotIn(SECRET_TITLE, out)
        self.assertEqual(self._remaining(pks), set(pks))
        self.assertFalse(AdminActionLog.objects.exists())

    # -- selectors ------------------------------------------------------------

    def test_card_selector_deletes_only_that_deleted_card(self):
        uid, target = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 5), _utc(2026, 2, 5)
        )
        _, other = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        live_pk = self._move(self._card(self.board), _utc(2026, 1, 5))

        out = self._run("--card", uid, "--yes")

        self.assertIn("Deleted 2 movement row(s) of deleted cards", out)
        self.assertEqual(self._remaining(target), set())
        self.assertEqual(self._remaining(other + [live_pk]), set(other + [live_pk]))

    def test_board_selector_by_id_and_uid_leaves_live_cards(self):
        _, on_board = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        _, elsewhere = self._deleted_card_with_moves(self.other_board, _utc(2026, 1, 5))
        live_pk = self._move(self._card(self.board), _utc(2026, 1, 5))

        self._run("--board", str(self.board.pk), "--yes")
        self.assertEqual(self._remaining(on_board), set())
        self.assertEqual(self._remaining(elsewhere + [live_pk]), set(elsewhere + [live_pk]))

        self._run("--board", self.other_board.uid, "--yes")
        self.assertEqual(self._remaining(elsewhere), set())
        self.assertEqual(self._remaining([live_pk]), {live_pk})

    def test_date_range_is_since_inclusive_before_exclusive(self):
        _, (dec, jan1, jan31, feb1) = self._deleted_card_with_moves(
            self.board,
            _utc(2025, 12, 31, 23, 59),
            _utc(2026, 1, 1),
            _utc(2026, 1, 31, 23, 59),
            _utc(2026, 2, 1),
        )
        self._run("--since", "2026-01-01", "--before", "2026-02-01", "--yes")
        self.assertEqual(self._remaining([dec, jan1, jan31, feb1]), {dec, feb1})

    def test_datetime_with_offset_is_honored(self):
        _, (early, late) = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 1, 4), _utc(2026, 1, 1, 6)
        )
        # 2026-01-01T00:00-05:00 is 05:00 UTC.
        self._run("--before", "2026-01-01T00:00:00-05:00", "--yes")
        self.assertEqual(self._remaining([early, late]), {late})

    def test_selectors_combine_with_and(self):
        uid, (jan, feb) = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 5), _utc(2026, 2, 5)
        )
        _, other = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))

        self._run("--card", uid, "--board", self.other_board.uid, "--yes")
        self.assertEqual(self._remaining([jan, feb]), {jan, feb})

        self._run("--card", uid, "--board", str(self.board.pk), "--before", "2026-02-01", "--yes")
        self.assertEqual(self._remaining([jan, feb] + other), {feb, *other})

    def test_include_live_cards_extends_to_live_history(self):
        live = self._card(self.board)
        live_pk = self._move(live, _utc(2026, 1, 5))
        _, deleted = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))

        self._run("--card", live.uid, "--include-live-cards", "--yes")
        self.assertEqual(self._remaining([live_pk]), set())
        self.assertTrue(Card.objects.filter(pk=live.pk).exists())
        self.assertEqual(self._remaining(deleted), set(deleted))

        live_pk2 = self._move(live, _utc(2026, 1, 6))
        self._run("--board", str(self.board.pk), "--include-live-cards", "--yes")
        self.assertEqual(self._remaining(deleted + [live_pk2]), set())

    # -- audit entry ----------------------------------------------------------

    def test_purge_writes_one_entry_with_selector_and_count_only(self):
        uid, pks = self._deleted_card_with_moves(
            self.board, _utc(2026, 1, 5), _utc(2026, 1, 6)
        )
        self._run(
            "--card", uid, "--board", self.board.uid,
            "--since", "2026-01-01", "--before", "2026-02-01", "--yes",
        )

        entry = AdminActionLog.objects.get()
        self.assertEqual(entry.action, PURGED)
        self.assertEqual(entry.source, AdminActionLog.Source.CLI)
        self.assertEqual(entry.actor_id, self.root.pk)
        self.assertEqual(entry.actor_username, "root")
        self.assertEqual(
            entry.metadata,
            {
                "selector": {
                    "card_uid": uid,
                    "board_id": self.board.pk,
                    "board_uid": self.board.uid,
                    "since": "2026-01-01T00:00:00+00:00",
                    "before": "2026-02-01T00:00:00+00:00",
                    "include_live_cards": False,
                },
                "deleted_count": 2,
                "deleted_block_count": 0,
                # No feed rows in this fixture (#1816); the key is always written.
                "redacted_event_count": 0,
            },
        )
        blob = repr((entry.action, entry.actor_username, entry.metadata))
        self.assertNotIn(SECRET_TITLE, blob)
        self.assertNotIn(SECRET_NOTE, blob)

    def test_action_is_filterable_in_the_action_log_api(self):
        uid, _ = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        self._run("--card", uid, "--yes")
        AdminActionLog.record(
            action=AdminActionLog.Action.UPLOADS_DISABLED,
            source=AdminActionLog.Source.ADMIN_API,
        )
        site_admin = User.objects.create_user(
            username="siteadmin", password="pw-1797-x!", is_site_admin=True
        )
        client = APIClient()
        client.force_authenticate(site_admin)

        resp = client.get("/api/v1/admin/action-log/", {"action": PURGED})

        self.assertEqual(resp.status_code, 200, resp.content)
        results = resp.json()["results"]
        self.assertEqual([r["action"] for r in results], [PURGED])
        self.assertEqual(results[0]["actor_username"], "root")
        self.assertEqual(results[0]["source"], "cli")
        self.assertEqual(results[0]["metadata"]["deleted_count"], 1)
        self.assertNotIn(SECRET_TITLE, resp.content.decode())

    def test_include_live_cards_matches_a_live_row_without_a_uid_snapshot(self):
        # A row the previous release wrote mid-upgrade has a card but no
        # card_uid yet; --card must still find it through the card FK.
        live = self._card(self.board)
        pk = self._move(live, _utc(2026, 1, 5))
        CardMovement.objects.filter(pk=pk).update(card_uid="", card_title="")

        self._run("--card", live.uid, "--include-live-cards", "--yes")

        self.assertEqual(self._remaining([pk]), set())

    def test_no_match_records_nothing(self):
        out = self._run("--board", str(self.board.pk), "--yes")
        self.assertIn("nothing deleted, nothing recorded", out)
        self.assertFalse(AdminActionLog.objects.exists())

    def test_failed_log_write_deletes_nothing(self):
        uid, pks = self._deleted_card_with_moves(self.board, _utc(2026, 1, 5))
        with patch.object(AdminActionLog, "record", side_effect=RuntimeError("log down")):
            with self.assertRaises(RuntimeError):
                self._run("--card", uid, "--yes")
        self.assertEqual(self._remaining(pks), set(pks))
        self.assertFalse(AdminActionLog.objects.exists())


class PurgeCardBlockHistoryTests(TestCase):
    """Blocks of a deleted card keep its title and free text too (#1149)."""

    # The fixtures, borrowed without inheriting (and so re-running) the tests.
    setUp = PurgeCardHistoryTests.setUp
    _board = PurgeCardHistoryTests._board
    _card = PurgeCardHistoryTests._card
    _run = PurgeCardHistoryTests._run

    def _deleted_card_with_blocks(self, board, *moments):
        card = self._card(board)
        uid = card.uid
        pks = [
            CardBlock.objects.create(
                card=card, board=board, card_uid=card.uid, card_title=card.title,
                reason=SECRET_NOTE, resolution=SECRET_NOTE, blocked_at=at,
                unblocked_at=at + datetime.timedelta(hours=1),
            ).pk
            for at in moments
        ]
        card.delete()
        return uid, pks

    def test_card_purge_erases_blocks_with_their_reason(self):
        uid, block_pks = self._deleted_card_with_blocks(self.board, _utc(2026, 1, 5), _utc(2026, 1, 9))
        _, other_pks = self._deleted_card_with_blocks(self.other_board, _utc(2026, 1, 5))
        dry = self._run("--card", uid)
        self.assertIn("and 2 block row(s)", dry)
        self.assertEqual(CardBlock.objects.filter(pk__in=block_pks).count(), 2)
        out = self._run("--card", uid, "--yes")
        self.assertIn("Deleted 0 movement row(s) of deleted cards and 2 block row(s)", out)
        self.assertFalse(CardBlock.objects.filter(pk__in=block_pks).exists())
        self.assertEqual(CardBlock.objects.filter(pk__in=other_pks).count(), 1)
        entry = AdminActionLog.objects.get(action=AdminActionLog.Action.CARD_HISTORY_PURGED)
        self.assertEqual(entry.metadata["deleted_block_count"], 2)
        self.assertEqual(entry.metadata["deleted_count"], 0)
        self.assertNotIn(SECRET_NOTE, repr(entry.metadata))
        self.assertNotIn(SECRET_NOTE, out)

    def test_date_range_selects_blocks_by_blocked_at(self):
        _, pks = self._deleted_card_with_blocks(self.board, _utc(2026, 1, 5), _utc(2026, 3, 5))
        self._run("--board", str(self.board.pk), "--before", "2026-02-01", "--yes")
        self.assertEqual(list(CardBlock.objects.filter(pk__in=pks).values_list("pk", flat=True)), [pks[1]])

    def test_live_card_blocks_need_include_live_cards(self):
        card = self._card(self.board)
        block = CardBlock.objects.create(card=card, board=self.board, reason="Live", blocked_at=_utc(2026, 1, 5))
        self._run("--board", str(self.board.pk), "--yes")
        self.assertTrue(CardBlock.objects.filter(pk=block.pk).exists())
        self._run("--board", str(self.board.pk), "--include-live-cards", "--yes")
        self.assertFalse(CardBlock.objects.filter(pk=block.pk).exists())

