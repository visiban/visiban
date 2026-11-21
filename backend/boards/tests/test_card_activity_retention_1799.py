"""Deleted-card audit trail: activities retained, exported and imported (#1799, #1796, #1701, #720).

- #1799: hard-deleting a card keeps its ``CardActivity`` rows (``card`` SET_NULL,
  ``board`` / ``card_uid`` / ``card_title`` kept), the model refuses to rewrite
  or delete a row, the admin is view-only, and only a board delete or a
  ``purge_card_history`` run removes them. ``CardComment`` is card content and
  still goes with the card.
- #1796: the JSON export carries a deleted card's movements and activities in
  ``deleted_card_history``, and the JSON import restores them as retained rows
  of the new board; ``MOVEMENT_EXPORT_BACKENDS`` gets them only on opt-in.
- #1701 / #720: the hook is called with ``(board, queryset, request)`` and its
  rows carry ``imported_from_username``.
"""
import pytest
import importlib
import io
import json
from unittest.mock import MagicMock, patch

from django.contrib.admin.sites import site as admin_site
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection
from django.http import HttpResponse
from django.test import RequestFactory

from accounts.models import User
from boards.models import (
    AppendOnlyViolation, Board, CardActivity, CardComment, CardMovement,
)
from boards.tests.test_card_movement_retention import _BoardFixture
from boards.tests.test_import_history_attribution import URL as IMPORT_URL, _file

_migration_0120 = importlib.import_module(
    "boards.migrations.0120_backfill_cardactivity_board_snapshots"
)
_migration_0121 = importlib.import_module(
    "boards.migrations.0121_cardactivity_board_fk_not_valid"
)


class _Fixture(_BoardFixture):
    def _activity(self, card, **kw):
        kw.setdefault("event_type", CardActivity.EventType.TITLE_CHANGE)
        return CardActivity.objects.create(card=card, actor=self.owner, **kw)

    def _legacy_row(self, card):
        """A row an older release wrote with bulk_create: no board, empty snapshot."""
        act = CardActivity.objects.create(card=card, event_type="title_change")
        CardActivity.objects.filter(pk=act.pk).update(board=None, card_uid="", card_title="")
        return act

    def _export(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/export/", {"format": "json"})
        self.assertEqual(resp.status_code, 200, resp.content)
        return json.loads(resp.content)


class ActivityRetentionTests(_Fixture):
    def test_create_fills_board_and_card_snapshot(self):
        card = self._card("Snap")
        act = self._activity(card)
        act.refresh_from_db()
        self.assertEqual((act.board_id, act.card_uid, act.card_title), (self.board.pk, card.uid, "Snap"))

    def test_card_delete_keeps_activities_with_snapshot(self):
        card = self._card("Gone")
        uid = card.uid
        self._activity(card, from_value="a", to_value="b")
        self._delete_card(card)
        act = CardActivity.objects.get(card_uid=uid)
        self.assertIsNone(act.card_id)
        self.assertEqual((act.board_id, act.card_title, act.to_value), (self.board.pk, "Gone", "b"))

    def test_legacy_row_without_board_is_filled_on_card_delete(self):
        # A row an older release wrote: set_null_keeping_board fills it.
        card = self._card("Bulk")
        uid = card.uid
        self._legacy_row(card)
        self.assertTrue(CardActivity.objects.filter(card=card, board__isnull=True).exists())
        self._delete_card(card)
        act = CardActivity.objects.get(card__isnull=True)
        self.assertEqual((act.board_id, act.card_uid, act.card_title), (self.board.pk, uid, "Bulk"))

    def test_comments_are_card_content_and_go_with_the_card(self):
        card = self._card("Talk")
        resp = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/comments/", {"body": "hello"},
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self._delete_card(card)
        self.assertFalse(CardComment.objects.exists())
        # The record that a comment was posted is retained.
        self.assertTrue(
            CardActivity.objects.filter(card__isnull=True, event_type="comment_added").exists()
        )

    def test_rows_are_append_only(self):
        act = self._activity(self._card())
        act.to_value = "rewritten"
        with self.assertRaises(AppendOnlyViolation):
            act.save()
        with self.assertRaises(AppendOnlyViolation):
            act.delete()
        self.assertTrue(CardActivity.objects.filter(pk=act.pk).exists())

    def test_board_delete_removes_live_retained_and_unfilled_rows(self):
        gone, live = self._card("Gone"), self._card("Live")
        self._activity(gone)
        self._activity(live)
        self._legacy_row(live)
        self._delete_card(gone)
        resp = self.client.delete(f"/api/v1/boards/{self.board.pk}/")
        self.assertEqual(resp.status_code, 204, resp.content)
        self.assertFalse(CardActivity.objects.exists())
        connection.check_constraints()

    def test_admin_is_view_only_and_board_delete_needs_no_activity_permission(self):
        admin = admin_site._registry[CardActivity]
        request = RequestFactory().get("/")
        request.user = User.objects.create_superuser(username="root1799", password="pw-1799-x!")
        self.assertFalse(admin.has_add_permission(request))
        self.assertFalse(admin.has_change_permission(request))
        self.assertFalse(admin.has_delete_permission(request))
        self._activity(self._card())
        _, _, perms_needed, _ = admin_site._registry[Board].get_deleted_objects(
            Board.objects.filter(pk=self.board.pk), request,
        )
        self.assertNotIn(CardActivity._meta.verbose_name, perms_needed)

    def test_migration_0120_backfills_rows_in_batches(self):
        card = self._card("Old")
        for _ in range(3):
            self._legacy_row(card)
        with patch.object(_migration_0120, "BATCH_SIZE", 2):
            _migration_0120.backfill(django_apps(), None)
        self.assertFalse(CardActivity.objects.filter(board__isnull=True).exists())
        self.assertEqual(set(CardActivity.objects.values_list("card_uid", flat=True)), {card.uid})

    def test_migration_0121_board_fk_is_postgresql_only(self):
        """Off PostgreSQL 0118's db_constraint=False column gets no constraint (and
        0122's VALIDATE is a no-op), so the hand-written step must emit nothing."""
        editor = MagicMock()
        editor.connection.vendor = "sqlite"
        _migration_0121.add_not_valid(django_apps(), editor)
        _migration_0121.drop_not_valid(django_apps(), editor)
        editor.execute.assert_not_called()

    @pytest.mark.migrations  # asserts the FK constraint state the migration chain leaves behind
    def test_board_fk_added_not_valid_is_validated_after_the_backfill(self):
        """On PostgreSQL the migrated schema carries the FK 0121 added NOT VALID,
        and 0122 has validated it (``convalidated``): no row escapes the check."""
        if connection.vendor != "postgresql":
            self.skipTest("pg_constraint is PostgreSQL-only")
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT convalidated, confrelid::regclass::text FROM pg_constraint "
                "WHERE conname = %s AND contype = 'f'",
                [_migration_0121.CONSTRAINT],
            )
            row = cursor.fetchone()
        self.assertEqual(row, (True, "boards"))

    def test_purge_by_board_with_live_cards_finds_rows_without_a_board(self):
        live = self._card("Live")
        self._legacy_row(live)
        User.objects.create_superuser(username="root", password="pw-1799-x!")
        call_command(
            "purge_card_history", "--board", str(self.board.pk), "--include-live-cards",
            "--actor", "root", "--yes", stdout=io.StringIO(),
        )
        self.assertFalse(CardActivity.objects.filter(card=live).exists())

    def test_purge_erases_retained_activities_only(self):
        gone, live = self._card("Secret title"), self._card("Live")
        uid = gone.uid
        self._activity(gone)
        self._activity(live)
        self._delete_card(gone)
        User.objects.create_superuser(username="root", password="pw-1799-x!")
        out = io.StringIO()
        call_command(
            "purge_card_history", "--board", str(self.board.pk), "--actor", "root", "--yes", stdout=out,
        )
        self.assertIn("deleted 1 activity row(s)", out.getvalue())
        self.assertFalse(CardActivity.objects.filter(card_uid=uid).exists())
        self.assertTrue(CardActivity.objects.filter(card=live).exists())


class EveryActivityWriterRecordsSnapshotsTests(_Fixture):
    """Every writer sets board, card_uid and card_title at write time (#1799).

    A row without them is not moved by the admin's board move and, once it
    has a board, is skipped by the delete-time repair, so ``purge_card_history
    --card`` could not find it. Each case writes through a production path,
    checks the live row, hard-deletes the card, and purges it by UID.
    """

    def setUp(self):
        super().setUp()
        self.root = User.objects.create_superuser(username="root1799w", password="pw-1799-x!")

    def _assert_recorded_and_purgeable(self, card, event_type):
        uid, title = card.uid, card.title
        rows = CardActivity.objects.filter(card=card, event_type=event_type)
        self.assertTrue(rows.exists())
        self.assertEqual(
            set(rows.values_list("board_id", "card_uid", "card_title")),
            {(card.board_id, uid, title)},
        )
        self._delete_card(card)
        self.assertFalse(CardActivity.objects.filter(card__isnull=True, card_uid="").exists())
        out = io.StringIO()
        call_command(
            "purge_card_history", "--card", uid, "--actor", self.root.username, "--yes", stdout=out,
        )
        self.assertFalse(CardActivity.objects.filter(card_uid=uid).exists())
        self.assertFalse(CardActivity.objects.exists(), "a row escaped the purge by UID")

    def test_card_update_service_path(self):
        # services/cards.py update_card: the label / due-date / field bulk_create.
        card = self._card("Patched")
        resp = self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/",
            {"due_date": "2026-12-01", "priority": "high"}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self._assert_recorded_and_purgeable(card, CardActivity.EventType.DUE_DATE_CHANGE)

    def test_custom_field_service_path(self):
        from boards.models import CustomFieldDefinition
        from boards.services.custom_fields import apply_custom_field_values

        card = self._card("Fielded")
        definition = CustomFieldDefinition.objects.create(
            board=self.board, name="Region", field_type=CustomFieldDefinition.FieldType.TEXT,
        )
        apply_custom_field_values(card=card, pairs=[(definition, "EMEA")], actor=self.owner)
        self._assert_recorded_and_purgeable(card, CardActivity.EventType.CUSTOM_FIELD_CHANGED)

    def test_clear_viewer_assignees_command(self):
        from boards.models import BoardMembership, CardChecklist

        viewer = User.objects.create_user(username="viewer1799", password="pw-1799-x!")
        BoardMembership.objects.create(board=self.board, user=viewer, role="viewer")
        card = self._card("Cleared")
        Card = type(card)
        Card.objects.filter(pk=card.pk).update(assignee=viewer)
        card.refresh_from_db()
        # A checklist row exercises the card_id=-only branch (one lookup query).
        CardChecklist.objects.create(card=card, text="to-do", position=0, assignee=viewer)
        with patch("boards.broadcast.broadcast_board_event"), \
                self.captureOnCommitCallbacks(execute=True):
            call_command("clear_viewer_assignees", stdout=io.StringIO())
        self.assertEqual(
            CardActivity.objects.filter(card=card, event_type__in=[
                CardActivity.EventType.ASSIGNEE_CHANGE,
                CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED,
            ]).count(), 2,
        )
        self._assert_recorded_and_purgeable(card, CardActivity.EventType.CHECKLIST_ITEM_ASSIGNED)

    def test_bulk_create_with_card_id_only_resolves_cards_in_one_query(self):
        a, b = self._card("A"), self._card("B")
        objs = [
            CardActivity(card_id=a.pk, event_type="title_change"),
            CardActivity(card_id=b.pk, event_type="title_change"),
        ]
        with self.assertNumQueries(2):  # one card lookup, one INSERT
            CardActivity.objects.bulk_create(objs)
        self.assertEqual(
            set(CardActivity.objects.values_list("board_id", "card_uid", "card_title")),
            {(self.board.pk, a.uid, "A"), (self.board.pk, b.uid, "B")},
        )

    def test_bulk_create_with_cached_card_costs_no_extra_query(self):
        card = self._card("Cached")
        with self.assertNumQueries(1):
            CardActivity.objects.bulk_create([CardActivity(card=card, event_type="title_change")])

    def test_admin_board_move_fills_legacy_activity_snapshot(self):
        from django.contrib.admin.sites import AdminSite

        from boards.admin import CardAdmin
        from boards.models import BoardMembership, Card, Column, Swimlane
        from boards.tests.test_admin_broadcast import _DummyForm

        card = self._card("Travels")
        uid = card.uid
        self._legacy_row(card)
        b2 = Board.objects.create(name="B2", owner=self.owner)
        BoardMembership.objects.create(board=b2, user=self.owner, role="admin")
        col2 = Column.objects.create(board=b2, name="X", position=0)
        swim2 = Swimlane.objects.create(board=b2, name="Y", position=0)
        request = RequestFactory().post("/admin/")
        request.user = self.root
        card.board, card.column, card.swimlane = b2, col2, swim2
        with self.captureOnCommitCallbacks(execute=True):
            CardAdmin(Card, AdminSite()).save_model(request, card, _DummyForm(), change=True)
        self.assertEqual(
            list(CardActivity.objects.filter(card=card).values_list("board_id", "card_uid", "card_title")),
            [(b2.pk, uid, "Travels")],
        )
        resp = self.client.delete(f"/api/v1/boards/{b2.pk}/cards/{card.pk}/")
        self.assertEqual(resp.status_code, 204, resp.content)
        call_command(
            "purge_card_history", "--card", uid, "--actor", self.root.username, "--yes",
            stdout=io.StringIO(),
        )
        self.assertFalse(CardActivity.objects.exists())

    def test_purge_dry_run_counts_a_legacy_live_row_under_its_cards_board(self):
        # With --include-live-cards a live row with no board is matched through
        # its card; the dry run counts that board, not a phantom NULL one.
        live = self._card("Live")
        self._activity(live)
        self._legacy_row(live)
        out = io.StringIO()
        call_command(
            "purge_card_history", "--board", str(self.board.pk), "--include-live-cards",
            "--actor", self.root.username, stdout=out,
        )
        self.assertIn("2 activity row(s)", out.getvalue())
        self.assertIn("(1 card(s), 1 board(s))", out.getvalue())


def django_apps():
    from django.apps import apps
    return apps


class DeletedCardHistoryExportImportTests(_Fixture):
    def _deleted_card_with_history(self):
        card = self._card("Was here")
        self._move(card, self.col_done)
        self._activity(card, from_value="x", to_value="Was here")
        uid = card.uid
        self._delete_card(card)
        return uid

    def test_json_export_carries_deleted_card_history(self):
        live = self._card("Live")
        self._move(live, self.col_done)
        uid = self._deleted_card_with_history()
        data = self._export()
        [entry] = data["deleted_card_history"]
        self.assertEqual(
            (entry["card_uid"], entry["card_title"], list(entry)),
            (uid, "Was here", ["card_uid", "card_title", "movements", "activities"]),
        )
        # Same entry shape as a live card's lists.
        self.assertEqual(list(entry["movements"][0]), list(data["cards"][0]["movements"][0]))
        self.assertEqual(entry["movements"][-1]["to_column"], "Done")
        self.assertIn("Was here", [a["to_value"] for a in entry["activities"]])
        # The live card is not repeated in the section.
        self.assertNotIn(live.uid, [e["card_uid"] for e in data["deleted_card_history"]])

    def test_deleted_column_name_falls_back_to_snapshot(self):
        uid = self._deleted_card_with_history()
        self.col_done.delete()
        [entry] = self._export()["deleted_card_history"]
        self.assertEqual(entry["card_uid"], uid)
        self.assertEqual(entry["movements"][-1]["to_column"], "Done")

    def test_export_is_two_queries_whatever_the_number_of_deleted_cards(self):
        from boards.views.import_export import _deleted_card_history_export

        self._deleted_card_with_history()
        with self.assertNumQueries(2):
            _deleted_card_history_export(self.board)
        for _ in range(3):
            self._deleted_card_with_history()
        with self.assertNumQueries(2):
            self.assertEqual(len(_deleted_card_history_export(self.board)), 4)

    def test_round_trip_restores_retained_rows_on_the_new_board(self):
        uid = self._deleted_card_with_history()
        data = self._export()
        cache.clear()
        resp = self.client.post(IMPORT_URL, {"file": _file(data)}, format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        new_board = Board.objects.get(pk=resp.data["id"])
        mvs = CardMovement.objects.filter(board=new_board, card__isnull=True)
        acts = CardActivity.objects.filter(board=new_board, card__isnull=True)
        self.assertEqual({m.card_uid for m in mvs} | {a.card_uid for a in acts}, {uid})
        self.assertEqual(mvs.count(), len(data["deleted_card_history"][0]["movements"]))
        # Attributed to the importer, source name kept as text (Rule 5).
        self.assertEqual({m.moved_by_id for m in mvs}, {self.owner.pk})
        self.assertEqual({m.imported_from_username for m in mvs}, {"owner"})
        self.assertEqual(mvs.order_by("-moved_at").first().to_column.name, "Done")
        # And the new board's export carries them again.
        self.client.force_authenticate(self.owner)
        again = self.client.get(f"/api/v1/boards/{new_board.pk}/export/", {"format": "json"}).json()
        self.assertEqual([e["card_uid"] for e in again["deleted_card_history"]], [uid])

    def test_history_option_off_skips_and_counts_them(self):
        self._deleted_card_with_history()
        data = self._export()
        cache.clear()
        resp = self.client.post(
            IMPORT_URL,
            {"file": _file(data), "options": json.dumps({"history": False})},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertFalse(
            CardMovement.objects.filter(board_id=resp.data["id"], card__isnull=True).exists()
        )
        skipped = resp.data["import_summary"]["skipped"]
        [entry] = data["deleted_card_history"]
        self.assertEqual(skipped["movements"], len(entry["movements"]))
        self.assertEqual(skipped["activities"], len(entry["activities"]))

    def test_malformed_section_is_a_400(self):
        base = self._export()
        good = {"card_uid": "0123456789abcdef", "card_title": "t", "movements": [], "activities": []}
        cases = {
            "not a list": "x",
            "entry not an object": ["x"],
            "bad uid": [{**good, "card_uid": "NOT-A-UID"}],
            "uid not a string": [{**good, "card_uid": 5}],
            "title too long": [{**good, "card_title": "t" * 501}],
            "movements not a list": [{**good, "movements": {}}],
            "movement not an object": [{**good, "movements": ["x"]}],
            "bad timestamp": [{**good, "movements": [{"moved_at": "yesterday"}]}],
            "mover not a string": [{**good, "movements": [{"moved_by": ["a"]}]}],
            "actor not a string": [{**good, "activities": [{"actor": {"a": 1}}]}],
            "bad gate index": [{**good, "movements": [{"to_gates_passed": -1}]}],
            "too many movements": [{**good, "movements": [{}] * 2001}],
        }
        for name, section in cases.items():
            with self.subTest(name):
                cache.clear()
                resp = self.client.post(
                    IMPORT_URL, {"file": _file({**base, "deleted_card_history": section})},
                    format="multipart",
                )
                self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(Board.objects.count(), 1)


class MovementExportHookTests(_Fixture):
    """#720 (the call site), #1701 (the import marker) and #1796 (opt-in)."""

    def _call(self, backend):
        with patch("boards.hooks.MOVEMENT_EXPORT_BACKENDS", [backend]):
            resp = self.client.get(f"/api/v1/boards/{self.board.pk}/movements/?export=csv")
        self.assertEqual(resp.status_code, 200, resp.content)
        return backend.call_args.args

    def test_called_with_board_queryset_request_and_its_response_returned(self):
        self._move(self._card(), self.col_done)
        backend = MagicMock(return_value=HttpResponse("from backend"))
        with patch("boards.hooks.MOVEMENT_EXPORT_BACKENDS", [backend]):
            resp = self.client.get(f"/api/v1/boards/{self.board.pk}/movements/?export=csv")
        self.assertEqual(resp.content, b"from backend")
        board, queryset, request = backend.call_args.args
        self.assertEqual(board, self.board)
        self.assertEqual(request.query_params["export"], "csv")
        self.assertTrue(all(isinstance(m, CardMovement) for m in queryset))

    def test_rows_carry_the_imported_from_username_marker(self):
        card = self._card()
        CardMovement.objects.create(card=card, moved_by=self.owner, imported_from_username="alice")
        self._move(card, self.col_done)
        _, queryset, _ = self._call(MagicMock(return_value=HttpResponse("ok")))
        self.assertEqual(sorted(m.imported_from_username or "-" for m in queryset), ["-", "alice"])

    def test_deleted_card_rows_only_on_explicit_opt_in(self):
        live = self._card("Live")
        self._move(live, self.col_done)
        self._move(gone := self._card("Gone"), self.col_done)
        gone_uid = gone.uid
        self._delete_card(gone)
        for flag, expect_deleted in ((None, False), ("yes", False), (1, False), (True, True)):
            with self.subTest(flag=flag):
                backend = MagicMock(return_value=HttpResponse("ok"))
                backend.accepts_deleted_cards = flag
                _, queryset, _ = self._call(backend)
                deleted = [m for m in queryset if m.card_id is None]
                self.assertEqual(bool(deleted), expect_deleted)
                if expect_deleted:
                    self.assertEqual({m.card_uid for m in deleted}, {gone_uid})
                self.assertIn(live.pk, {m.card_id for m in queryset})

    def test_backend_without_the_attribute_gets_live_rows_only(self):
        # The absent-input case (#1075): a plain function, as enterprise
        # registers, has no accepts_deleted_cards at all.
        self._move(gone := self._card("Gone"), self.col_done)
        self._delete_card(gone)
        self._move(self._card("Live"), self.col_done)
        handed = []

        def backend(board, queryset, request):
            handed.extend(queryset)
            return HttpResponse("ok")

        self._call_plain(backend)
        self.assertTrue(handed)
        self.assertNotIn(None, {m.card_id for m in handed})

    def _call_plain(self, backend):
        with patch("boards.hooks.MOVEMENT_EXPORT_BACKENDS", [backend]):
            resp = self.client.get(f"/api/v1/boards/{self.board.pk}/movements/?export=csv")
        self.assertEqual(resp.status_code, 200, resp.content)
