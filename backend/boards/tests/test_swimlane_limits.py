"""Per-swimlane WIP and weight limits (#1150).

A swimlane (row) can carry its own ``wip_limit`` and ``weight_limit``, counted
over the row's ``limit_column_ids`` (``NULL``: every column not marked done)
and enforced per ``limit_enforcement`` (``NULL``: inherit the board flags, as a
column does). The rules pinned here:

* the same write paths as column limits: move, create, restore, a weight
  increase via PATCH, the Django admin, MCP (in ``mcp_server/tests``); board
  import restores them without enforcing;
* the override rules: ``block`` lets a board admin past with ``?force=true``,
  ``hard`` admits no override, weight has no hard mode;
* a move is checked against a row only when it adds to the row's counted
  total, so a move between two counted columns of the row never trips it,
  and entering through an uncounted column does;
* strictest wins (hard before block), the column first when equal;
* archived cards and cards in uncounted columns never count;
* a board with no row limits issues no extra query;
* a column delete prunes its id from every row's ``limit_column_ids``.

The exact 409 bodies are pinned in ``test_card_error_bodies.py``; the
concurrent move race in ``test_swimlane_limit_lock.py``.
"""

import io
import json
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import CardAdmin, SwimlaneAdmin
from boards.models import BoardMembership, Card, Column, Swimlane
from boards.services import cards as card_services
from boards.services.errors import (
    SwimlaneWeightLimitExceeded, SwimlaneWipHardBlocked, SwimlaneWipLimitExceeded,
    WipLimitExceeded,
)
from boards.tests.conftest import _make_board


class _RowFixture(TestCase):
    """Board: Backlog (counted by default), Doing, Done (``is_done``);
    swimlanes Alpha and Beta; an admin and a member."""

    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)

        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        # Board flags all off, so only a row's explicit mode enforces unless a
        # test turns a flag on.
        self.board = _make_board(
            self.admin, enforce_wip_limits=False, enforce_wip_hard=False,
            enforce_weight_limits=False,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER,
        )
        self.backlog = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True,
        )
        self.doing = Column.objects.create(
            board=self.board, name="Doing", position=1, allow_card_creation=True,
        )
        self.done = Column.objects.create(board=self.board, name="Done", position=2, is_done=True)
        self.alpha = Swimlane.objects.create(board=self.board, name="Alpha", position=0)
        self.beta = Swimlane.objects.create(board=self.board, name="Beta", position=1)

    # helpers ---------------------------------------------------------------

    def _limit(self, lane, *, wip=None, weight=None, mode="block", columns=None):
        lane.wip_limit = wip
        lane.weight_limit = weight
        lane.limit_enforcement = mode
        lane.limit_column_ids = columns
        lane.save()
        return lane

    def _card(self, column, lane, *, weight=1, archived=False, created_by=None, title="c"):
        return Card.objects.create(
            board=self.board, column=column, swimlane=lane, title=title,
            created_by=created_by or self.admin, weight=weight,
            position=Card.objects.filter(column=column, swimlane=lane).count(),
            archived_at=timezone.now() if archived else None,
        )

    def _move(self, user, card, column, lane, *, force=False):
        self.client.force_authenticate(user)
        url = f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/"
        if force:
            url += "?force=true"
        return self.client.post(
            url, {"column_id": column.pk, "swimlane_id": lane.pk, "position": 0}, format="json",
        )


# ---------------------------------------------------------------------------
# Move
# ---------------------------------------------------------------------------

class MoveIntoRowTests(_RowFixture):
    def test_block_refuses_at_the_limit_and_a_board_admin_may_force(self):
        self._limit(self.beta, wip=1)
        self._card(self.backlog, self.beta)
        mover = self._card(self.backlog, self.alpha, created_by=self.member)

        r = self._move(self.member, mover, self.backlog, self.beta)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "swimlane_wip_limit_exceeded")
        mover.refresh_from_db()
        self.assertEqual(mover.swimlane_id, self.alpha.pk)

        self.assertEqual(self._move(self.member, mover, self.backlog, self.beta, force=True).status_code, 403)
        self.assertEqual(self._move(self.admin, mover, self.backlog, self.beta, force=True).status_code, 200)
        mover.refresh_from_db()
        self.assertEqual(mover.swimlane_id, self.beta.pk)

    def test_under_the_limit_is_allowed(self):
        self._limit(self.beta, wip=2)
        self._card(self.backlog, self.beta)
        mover = self._card(self.backlog, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.doing, self.beta).status_code, 200)

    def test_hard_admits_no_override(self):
        self._limit(self.beta, wip=1, mode="hard")
        self._card(self.doing, self.beta)
        mover = self._card(self.backlog, self.alpha)
        r = self._move(self.admin, mover, self.backlog, self.beta, force=True)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "swimlane_wip_hard_blocked")

    def test_null_mode_inherits_the_board_flags(self):
        self._limit(self.beta, wip=1, mode=None)
        self._card(self.backlog, self.beta)
        mover = self._card(self.backlog, self.alpha)
        # Board flags off: the row limit is not enforced, as a column's isn't.
        self.assertEqual(self._move(self.admin, mover, self.backlog, self.beta).status_code, 200)

        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        other = self._card(self.backlog, self.alpha)
        r = self._move(self.admin, other, self.backlog, self.beta, force=True)
        self.assertEqual(r.json()["code"], "swimlane_wip_hard_blocked")

    def test_explicit_block_overrides_a_hard_board(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self._limit(self.beta, wip=1, mode="block")
        self._card(self.backlog, self.beta)
        mover = self._card(self.backlog, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.backlog, self.beta).json()["code"],
                         "swimlane_wip_limit_exceeded")
        self.assertEqual(self._move(self.admin, mover, self.backlog, self.beta, force=True).status_code, 200)

    def test_moves_between_counted_columns_of_the_row_never_trip_it(self):
        self._limit(self.alpha, wip=1, mode="hard")
        mover = self._card(self.backlog, self.alpha)
        self._card(self.doing, self.alpha)  # the row is now over: 2/1
        self.assertEqual(self._move(self.admin, mover, self.doing, self.alpha).status_code, 200)

    def test_entering_a_counted_column_from_an_uncounted_one_in_the_row_is_checked(self):
        # Only Doing counts; Backlog -> Doing inside the row adds to the total.
        self._limit(self.alpha, wip=1, columns=[self.doing.pk])
        self._card(self.doing, self.alpha)
        mover = self._card(self.backlog, self.alpha)
        r = self._move(self.admin, mover, self.doing, self.alpha)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "swimlane_wip_limit_exceeded")

    def test_reopening_a_done_card_inside_the_row_is_checked(self):
        # NULL columns: Done does not count, so Done -> Doing enters the limit.
        self._limit(self.alpha, wip=1)
        self._card(self.doing, self.alpha)
        mover = self._card(self.done, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.doing, self.alpha).status_code, 409)

    def test_moving_into_an_uncounted_column_is_never_checked(self):
        self._limit(self.beta, wip=1)
        self._card(self.backlog, self.beta)
        mover = self._card(self.backlog, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.done, self.beta).status_code, 200)

    def test_cards_in_uncounted_columns_and_archived_cards_do_not_count(self):
        self._limit(self.beta, wip=1, columns=[self.doing.pk])
        self._card(self.backlog, self.beta)
        self._card(self.doing, self.beta, archived=True)
        mover = self._card(self.backlog, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.doing, self.beta).status_code, 200)

    def test_a_swimlane_only_move_ignores_the_column_limit(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.backlog.wip_limit = 1
        self.backlog.save(update_fields=["wip_limit"])
        mover = self._card(self.backlog, self.alpha)
        self._card(self.backlog, self.beta)  # column over its limit now
        self.assertEqual(self._move(self.admin, mover, self.backlog, self.beta).status_code, 200)

    def test_weight_limit_on_move(self):
        self._limit(self.beta, weight=4)
        self._card(self.doing, self.beta, weight=3)
        mover = self._card(self.backlog, self.alpha, weight=2)
        r = self._move(self.admin, mover, self.doing, self.beta)
        self.assertEqual(r.json()["code"], "swimlane_weight_limit_exceeded")

    def test_hard_mode_leaves_weight_a_block(self):
        self._limit(self.beta, weight=1, mode="hard")
        self._card(self.doing, self.beta)
        mover = self._card(self.backlog, self.alpha)
        self.assertEqual(self._move(self.admin, mover, self.doing, self.beta).status_code, 409)
        self.assertEqual(self._move(self.admin, mover, self.doing, self.beta, force=True).status_code, 200)


class StrictestWinsTests(_RowFixture):
    def setUp(self):
        super().setUp()
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.doing.wip_limit = 1
        self.doing.save(update_fields=["wip_limit"])
        self._card(self.doing, self.beta)
        self.mover = self._card(self.backlog, self.alpha)

    def test_a_hard_row_beats_a_soft_column(self):
        self._limit(self.beta, wip=1, mode="hard")
        r = self._move(self.admin, self.mover, self.doing, self.beta, force=True)
        self.assertEqual(r.json()["code"], "swimlane_wip_hard_blocked")

    def test_equal_strictness_reports_the_column(self):
        self._limit(self.beta, wip=1, mode="block")
        r = self._move(self.admin, self.mover, self.doing, self.beta)
        self.assertEqual(r.json()["code"], "wip_limit_exceeded")

    def test_one_force_overrides_both_soft_limits(self):
        self._limit(self.beta, wip=1, mode="block")
        self.assertEqual(
            self._move(self.admin, self.mover, self.doing, self.beta, force=True).status_code, 200,
        )


# ---------------------------------------------------------------------------
# Create, restore, PATCH weight
# ---------------------------------------------------------------------------

class NonMovePathTests(_RowFixture):
    def _create(self, user, column, lane, *, weight=None, force=False):
        self.client.force_authenticate(user)
        body = {"title": "new", "column": column.pk, "swimlane": lane.pk}
        if weight is not None:
            body["weight"] = weight
        url = f"/api/v1/boards/{self.board.pk}/cards/" + ("?force=true" if force else "")
        return self.client.post(url, body, format="json")

    def test_create_into_a_full_row_is_refused_and_writes_nothing(self):
        self._limit(self.beta, wip=1)
        self._card(self.doing, self.beta)
        r = self._create(self.member, self.backlog, self.beta)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "swimlane_wip_limit_exceeded")
        self.assertFalse(Card.objects.filter(title="new").exists())
        self.assertEqual(self._create(self.admin, self.backlog, self.beta, force=True).status_code, 201)

    def test_create_into_an_uncounted_column_is_allowed(self):
        self._limit(self.beta, wip=1, columns=[self.doing.pk])
        self._card(self.doing, self.beta)
        self.assertEqual(self._create(self.member, self.backlog, self.beta).status_code, 201)

    def test_restore_into_a_full_row_is_refused(self):
        self._limit(self.beta, wip=1, mode="hard")
        archived = self._card(self.backlog, self.beta, archived=True)
        self._card(self.doing, self.beta)
        self.client.force_authenticate(self.admin)
        r = self.client.post(f"/api/v1/boards/{self.board.pk}/cards/{archived.pk}/unarchive/?force=true")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "swimlane_wip_hard_blocked")
        archived.refresh_from_db()
        self.assertIsNotNone(archived.archived_at)

    def test_raising_weight_in_a_counted_column_checks_the_row(self):
        self._limit(self.alpha, weight=5)
        card = self._card(self.backlog, self.alpha, weight=2, created_by=self.member)
        self._card(self.doing, self.alpha, weight=2)
        self.client.force_authenticate(self.member)
        url = f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/"
        r = self.client.patch(url, {"weight": 4}, format="json")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json(), {
            "code": "swimlane_weight_limit_exceeded", "column_name": "Backlog",
            "swimlane_name": "Alpha", "current_weight": 2, "weight_limit": 5, "card_weight": 4,
        })
        # Exactly reaching it, or lowering, is allowed; WIP is never checked.
        self.assertEqual(self.client.patch(url, {"weight": 3}, format="json").status_code, 200)
        self.assertEqual(self.client.patch(url, {"weight": 1}, format="json").status_code, 200)

    def test_raising_weight_in_an_uncounted_column_is_not_checked(self):
        self._limit(self.alpha, weight=1)
        card = self._card(self.done, self.alpha, weight=1)
        self._card(self.doing, self.alpha, weight=1)
        self.client.force_authenticate(self.admin)
        r = self.client.patch(f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/", {"weight": 9}, format="json")
        self.assertEqual(r.status_code, 200, r.content)


# ---------------------------------------------------------------------------
# The helper directly: query budget and lock order
# ---------------------------------------------------------------------------

class HelperTests(_RowFixture):
    def test_a_row_without_limits_issues_no_queries(self):
        with self.assertNumQueries(0):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=self.alpha,
            )

    def test_a_move_between_counted_columns_issues_no_queries(self):
        self._limit(self.alpha, wip=1)
        with self.assertNumQueries(0):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=1, weight=1),
                role="member", swimlane=self.alpha, source=(self.backlog, self.alpha.pk),
                check_column=False,
            )

    def test_source_by_column_id_reads_is_done(self):
        self._limit(self.alpha, wip=1)
        self._card(self.doing, self.alpha)
        # Backlog counts (not done), so Backlog -> Doing inside the row is not an entry.
        card_services.enforce_column_limits(
            board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
            role="member", swimlane=self.alpha, source=(self.backlog.pk, self.alpha.pk),
            check_column=False,
        )
        # Done does not, so Done -> Doing is.
        with self.assertRaises(SwimlaneWipLimitExceeded):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=self.alpha, source=(self.done.pk, self.alpha.pk),
                check_column=False,
            )

    def test_locks_the_column_then_the_swimlane_no_key(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.doing.wip_limit = 5
        self.doing.save(update_fields=["wip_limit"])
        self._limit(self.beta, wip=5)
        with CaptureQueriesContext(connection) as ctx:
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=self.beta,
            )
        tables = [
            ("columns" if '"columns"' in q["sql"].split("WHERE")[0] else "swimlanes")
            for q in ctx.captured_queries
            if q["sql"].lstrip().startswith("SELECT") and (
                'FROM "columns"' in q["sql"] or 'FROM "swimlanes"' in q["sql"]
            ) and "COUNT" not in q["sql"].upper()
        ]
        self.assertEqual(tables[:2], ["columns", "swimlanes"])

    def test_the_locked_swimlane_row_is_what_is_enforced(self):
        # A settings save that committed after the caller read the swimlane
        # is seen: the helper re-reads the row under its lock.
        self._limit(self.beta, wip=5)
        stale = Swimlane.objects.get(pk=self.beta.pk)
        Swimlane.objects.filter(pk=self.beta.pk).update(wip_limit=1)
        self._card(self.doing, self.beta)
        with self.assertRaises(SwimlaneWipLimitExceeded):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=stale,
            )

    def test_weight_error_and_hard_error_classes(self):
        self._limit(self.beta, wip=1, weight=1, mode="hard")
        self._card(self.doing, self.beta)
        with self.assertRaises(SwimlaneWipHardBlocked):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="site_admin", force=True, swimlane=self.beta,
            )
        with self.assertRaises(SwimlaneWeightLimitExceeded):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=self.beta, check_wip=False,
            )


# ---------------------------------------------------------------------------
# Settings API
# ---------------------------------------------------------------------------

class SwimlaneSettingsApiTests(_RowFixture):
    def _url(self, lane=None):
        lane = lane or self.alpha
        return f"/api/v1/boards/{self.board.pk}/swimlanes/{lane.pk}/"

    def _patch(self, user, body, lane=None):
        self.client.force_authenticate(user)
        return self.client.patch(self._url(lane), body, format="json")

    def test_defaults_are_null_for_every_role(self):
        for user in (self.admin, self.member):
            self.client.force_authenticate(user)
            data = self.client.get(self._url()).json()
            self.assertEqual(
                {k: data[k] for k in ("wip_limit", "weight_limit", "limit_enforcement", "limit_column_ids")},
                {"wip_limit": None, "weight_limit": None, "limit_enforcement": None, "limit_column_ids": None},
            )

    def test_admin_sets_limits_ids_stored_sorted_and_deduplicated(self):
        r = self._patch(self.admin, {
            "wip_limit": 3, "weight_limit": 10, "limit_enforcement": "hard",
            "limit_column_ids": [self.doing.pk, self.backlog.pk, self.doing.pk],
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["limit_column_ids"], sorted([self.backlog.pk, self.doing.pk]))
        self.alpha.refresh_from_db()
        self.assertEqual(
            (self.alpha.wip_limit, self.alpha.weight_limit, self.alpha.limit_enforcement),
            (3, 10, "hard"),
        )
        # And clears them again.
        r = self._patch(self.admin, {
            "wip_limit": None, "weight_limit": None, "limit_enforcement": None,
            "limit_column_ids": None,
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.alpha.refresh_from_db()
        self.assertIsNone(self.alpha.limit_column_ids)

    def test_member_cannot_change_limits(self):
        self.assertEqual(self._patch(self.member, {"wip_limit": 3}).status_code, 403)
        self.alpha.refresh_from_db()
        self.assertIsNone(self.alpha.wip_limit)

    def test_invalid_values_are_400(self):
        other_board = _make_board(self.admin, name="Other")
        foreign = Column.objects.create(board=other_board, name="Elsewhere", position=0)
        for body in (
            {"wip_limit": 0},
            {"weight_limit": -1},
            {"limit_enforcement": "warn"},
            {"limit_column_ids": []},
            {"limit_column_ids": [foreign.pk]},
            {"limit_column_ids": [987654]},
            {"limit_column_ids": "x"},
        ):
            with self.subTest(body=body):
                self.assertEqual(self._patch(self.admin, body).status_code, 400)
        # A foreign id and a missing id get the same message (IDOR).
        a = self._patch(self.admin, {"limit_column_ids": [foreign.pk]}).json()
        b = self._patch(self.admin, {"limit_column_ids": [foreign.pk + 100000]}).json()
        self.assertEqual(
            a["limit_column_ids"][0].split(":")[0], b["limit_column_ids"][0].split(":")[0],
        )

    def test_a_column_deleted_before_the_save_takes_its_lock_is_400(self):
        from boards.views import swimlanes as views

        real = views.lock_board_and_row_or_404

        def delete_then_lock(*args, **kwargs):
            Column.objects.filter(pk=self.doing.pk).delete()
            return real(*args, **kwargs)

        with patch.object(views, "lock_board_and_row_or_404", side_effect=delete_then_lock):
            r = self._patch(self.admin, {"limit_column_ids": [self.doing.pk]})
        self.assertEqual(r.status_code, 400, r.content)
        self.alpha.refresh_from_db()
        self.assertIsNone(self.alpha.limit_column_ids)

    def test_settings_save_broadcasts_the_new_fields(self):
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            r = self._patch(self.admin, {"wip_limit": 4, "limit_column_ids": [self.doing.pk]})
        self.assertEqual(r.status_code, 200, r.content)
        calls = [c for c in self.broadcast.call_args_list if c.args[1] == "swimlane.updated"]
        self.assertEqual(len(calls), 1)
        payload = calls[0].args[2]
        self.assertEqual(payload["wip_limit"], 4)
        self.assertEqual(payload["limit_column_ids"], [self.doing.pk])
        self.assertIn("limit_enforcement", payload)

    def test_create_accepts_limits(self):
        self.client.force_authenticate(self.admin)
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/swimlanes/",
            {"name": "Gamma", "wip_limit": 2, "limit_enforcement": "block"}, format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["wip_limit"], 2)

    def test_board_full_carries_the_fields(self):
        self._limit(self.alpha, wip=2, columns=[self.doing.pk])
        self.client.force_authenticate(self.member)
        lanes = self.client.get(f"/api/v1/boards/{self.board.pk}/full/").json()["swimlanes"]
        alpha = next(lane for lane in lanes if lane["id"] == self.alpha.pk)
        self.assertEqual((alpha["wip_limit"], alpha["limit_column_ids"]), (2, [self.doing.pk]))


# ---------------------------------------------------------------------------
# Column delete cleanup
# ---------------------------------------------------------------------------

class ColumnDeleteCleanupTests(_RowFixture):
    def test_rest_delete_prunes_the_id_and_an_emptied_list_becomes_null(self):
        self._limit(self.alpha, wip=2, columns=[self.backlog.pk, self.doing.pk])
        self._limit(self.beta, wip=2, columns=[self.doing.pk])
        self.client.force_authenticate(self.admin)
        r = self.client.delete(f"/api/v1/boards/{self.board.pk}/columns/{self.doing.pk}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.alpha.refresh_from_db()
        self.beta.refresh_from_db()
        self.assertEqual(self.alpha.limit_column_ids, [self.backlog.pk])
        self.assertIsNone(self.beta.limit_column_ids)
        # The limit itself is kept.
        self.assertEqual(self.beta.wip_limit, 2)

    def test_admin_bulk_delete_prunes_too(self):
        self._limit(self.alpha, wip=2, columns=[self.backlog.pk, self.done.pk])
        from boards.admin import ColumnAdmin
        from django.test import RequestFactory

        request = RequestFactory().post("/")
        request.user = self.admin
        ColumnAdmin(Column, AdminSite()).delete_queryset(request, Column.objects.filter(pk=self.done.pk))
        self.alpha.refresh_from_db()
        self.assertEqual(self.alpha.limit_column_ids, [self.backlog.pk])

    def test_other_boards_lanes_are_untouched(self):
        other = _make_board(self.admin, name="Other")
        doing_pk = self.doing.pk
        lane = Swimlane.objects.create(
            board=other, name="X", position=0, limit_column_ids=[doing_pk],
        )
        self.doing.delete()
        lane.refresh_from_db()
        self.assertEqual(lane.limit_column_ids, [doing_pk])

    def test_board_delete_still_works(self):
        self._limit(self.alpha, wip=2, columns=[self.doing.pk])
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.delete(f"/api/v1/boards/{self.board.pk}/").status_code, 204)
        self.assertFalse(Swimlane.objects.filter(pk=self.alpha.pk).exists())


# ---------------------------------------------------------------------------
# Export / import round trip — import never enforces
# ---------------------------------------------------------------------------

class ImportExportTests(_RowFixture):
    def _import(self, data):
        upload = io.BytesIO(json.dumps(data).encode("utf-8"))
        upload.name = "board.json"
        self.client.force_authenticate(self.admin)
        return self.client.post("/api/v1/boards/import/", {"file": upload}, format="multipart")

    def test_round_trip_over_limit_restores_limits_and_every_card(self):
        self._limit(self.alpha, wip=1, weight=2, mode="hard", columns=[self.doing.pk])
        for _ in range(3):
            self._card(self.doing, self.alpha, weight=2)
        self.client.force_authenticate(self.admin)
        exported = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(exported.status_code, 200)
        lane = next(s for s in exported.json()["swimlanes"] if s["name"] == "Alpha")
        self.assertEqual(
            {k: lane[k] for k in ("wip_limit", "weight_limit", "limit_enforcement", "limit_columns")},
            {"wip_limit": 1, "weight_limit": 2, "limit_enforcement": "hard", "limit_columns": ["Doing"]},
        )
        beta = next(s for s in exported.json()["swimlanes"] if s["name"] == "Beta")
        self.assertIsNone(beta["limit_columns"])

        r = self._import(exported.json())
        self.assertEqual(r.status_code, 201, r.content)
        imported = Swimlane.objects.get(board_id=r.data["id"], name="Alpha")
        doing = Column.objects.get(board_id=r.data["id"], name="Doing")
        self.assertEqual(
            (imported.wip_limit, imported.weight_limit, imported.limit_enforcement, imported.limit_column_ids),
            (1, 2, "hard", [doing.pk]),
        )
        self.assertEqual(Card.objects.filter(swimlane=imported).count(), 3)

    def _payload(self, **lane):
        return {
            "name": "Imported",
            "columns": [{"name": "Doing", "position": 0, "allow_card_creation": True}],
            "swimlanes": [{"name": "General", "position": 0, **lane}],
            "cards": [],
        }

    def test_invalid_limit_values_are_400(self):
        for lane in (
            {"wip_limit": 0}, {"weight_limit": "3"}, {"limit_enforcement": "warn"},
            {"limit_columns": []}, {"limit_columns": ["Nope"]}, {"limit_columns": "Doing"},
        ):
            with self.subTest(lane=lane):
                self.assertEqual(self._import(self._payload(**lane)).status_code, 400)

    def test_a_file_without_the_keys_imports_with_no_limits(self):
        r = self._import(self._payload())
        self.assertEqual(r.status_code, 201, r.content)
        lane = Swimlane.objects.get(board_id=r.data["id"])
        self.assertEqual((lane.wip_limit, lane.limit_column_ids), (None, None))


# ---------------------------------------------------------------------------
# Django admin
# ---------------------------------------------------------------------------

class AdminTests(_RowFixture):
    def _card_form(self, instance, **overrides):
        data = {
            "board": self.board.pk, "column": instance.column_id, "swimlane": instance.swimlane_id,
            "title": instance.title, "description": "", "priority": "medium",
            "weight": instance.weight, "position": instance.position,
            "created_by": self.admin.pk, "version": 1,
        }
        data.update(overrides)
        form_class = CardAdmin(Card, AdminSite()).get_form(None, obj=instance)
        return form_class(data=data, instance=instance)

    def test_card_form_refuses_a_swimlane_change_into_a_full_row(self):
        self._limit(self.beta, wip=1, mode="hard")
        self._card(self.backlog, self.beta)
        card = self._card(self.backlog, self.alpha)
        form = self._card_form(card, swimlane=self.beta.pk)
        self.assertFalse(form.is_valid())
        self.assertIn('Swimlane "Beta"', " ".join(form.non_field_errors()))

    def test_card_form_checks_column_weight_when_also_changing_swimlane(self):
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.backlog.weight_limit = 3
        self.backlog.save(update_fields=["weight_limit"])
        card = self._card(self.backlog, self.alpha, weight=1)
        self._card(self.backlog, self.beta, weight=2)
        form = self._card_form(card, swimlane=self.beta.pk, weight=2)
        self.assertFalse(form.is_valid())
        self.assertIn('Column "Backlog"', " ".join(form.non_field_errors()))

    def _lane_form(self, **overrides):
        data = {
            "board": self.board.pk, "name": self.alpha.name, "contact_email": "", "notes": "",
            "position": 0, "color": self.alpha.color,
        }
        data.update(overrides)
        form_class = SwimlaneAdmin(Swimlane, AdminSite()).get_form(None, obj=self.alpha)
        return form_class(data=data, instance=self.alpha)

    def test_swimlane_form_validates_and_normalizes_column_ids(self):
        form = self._lane_form(limit_column_ids=json.dumps([self.doing.pk, self.backlog.pk]))
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.cleaned_data["limit_column_ids"], sorted([self.backlog.pk, self.doing.pk]))
        foreign = Column.objects.create(
            board=_make_board(self.admin, name="Other"), name="Elsewhere", position=0,
        )
        for bad in ([foreign.pk], [], ["x"], {"a": 1}):
            with self.subTest(bad=bad):
                form = self._lane_form(limit_column_ids=json.dumps(bad))
                self.assertFalse(form.is_valid())
                self.assertIn("limit_column_ids", form.errors)


class ColumnLimitBehaviorUnchangedTests(_RowFixture):
    """A board that never sets a row limit gets exactly the pre-#1150 column errors."""

    def test_column_soft_limit_body_and_class(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.doing.wip_limit = 1
        self.doing.save(update_fields=["wip_limit"])
        self._card(self.doing, self.beta)
        with self.assertRaises(WipLimitExceeded):
            card_services.enforce_column_limits(
                board=self.board, column=self.doing, card=SimpleNamespace(pk=None, weight=1),
                role="member", swimlane=self.alpha,
            )
