"""WIP and weight limits on the non-move write paths (#1428).

Before #1428 the limits were checked only by ``move_card``; card create,
restore from archive, a PATCH that raises ``weight``, and the Django admin all
bypassed them, including under hard WIP mode. These tests pin that each path
now applies the move path's rule through the shared
``boards.services.cards.enforce_column_limits``:

* the same 409 bodies (``wip_limit_exceeded`` / ``wip_hard_blocked`` /
  ``weight_limit_exceeded``),
* the same override rule: ``?force=true`` lets a board admin past a *soft*
  limit, a member gets 403, and hard mode blocks every role,
* archived cards never count, and a column exactly at its limit blocks while
  one under it does not.

The by-design exemption — board import restores a board as exported, over its
limits or not — is pinned here too (decision on #1428), since it is the one
path a future "enforce everywhere" change could break by accident.

The move path's own tests live beside this file in ``test_wip_enforcement.py``
and ``test_weight_enforcement.py`` and are unchanged by #1428.
"""

import io
import json
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.test import RequestFactory, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import CardAdmin, CardAdminForm
from boards.models import BoardMembership, Card, CardMovement, Column, Swimlane
from boards.services import cards as card_services
from boards.services.errors import WipHardBlocked
from boards.tests.conftest import _make_board


class _LimitFixture(TestCase):
    """Board with an admin and a member, a limited column and a free column."""

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()
        self.addCleanup(self._broadcast_patcher.stop)

        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin", password="pass")
        self.member = User.objects.create_user(username="member", password="pass")
        self.board = _make_board(
            self.admin, enforce_wip_limits=True, enforce_weight_limits=True,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER,
        )
        self.free = Column.objects.create(
            board=self.board, name="Backlog", position=0, allow_card_creation=True,
        )
        self.limited = Column.objects.create(
            board=self.board, name="Doing", position=1, wip_limit=2,
            allow_card_creation=True,
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="General", position=0)

    def _card(self, column, *, weight=1, archived=False, created_by=None, title="c"):
        return Card.objects.create(
            board=self.board, column=column, swimlane=self.swimlane, title=title,
            created_by=created_by or self.admin, weight=weight,
            position=Card.objects.filter(column=column).count(),
            archived_at=timezone.now() if archived else None,
        )

    def _fill(self, column, n, *, weight=1):
        for i in range(n):
            self._card(column, weight=weight, title=f"filler {i}")

    def _active(self, column):
        return Card.objects.filter(column=column, archived_at__isnull=True).count()

    def _set_hard(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])

    def _set_weight_limit(self, column, limit):
        column.weight_limit = limit
        column.save(update_fields=["weight_limit"])


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------

class CreateEnforcementTests(_LimitFixture):
    def _create(self, user, column, *, force=False, weight=None):
        self.client.force_authenticate(user)
        body = {"title": "new", "column": column.pk, "swimlane": self.swimlane.pk}
        if weight is not None:
            body["weight"] = weight
        url = f"/api/v1/boards/{self.board.pk}/cards/"
        if force:
            url += "?force=true"
        return self.client.post(url, body, format="json")

    def test_soft_wip_at_limit_returns_move_shaped_409_and_writes_nothing(self):
        self._fill(self.limited, 2)
        r = self._create(self.member, self.limited)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json(), {
            "code": "wip_limit_exceeded", "column_name": "Doing",
            "current_count": 2, "wip_limit": 2,
        })
        self.assertEqual(self._active(self.limited), 2)
        # The rollback covers the audit row too.
        self.assertFalse(CardMovement.objects.filter(notes="Card created").exists())

    def test_under_limit_is_allowed(self):
        self._fill(self.limited, 1)
        r = self._create(self.member, self.limited)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._active(self.limited), 2)

    def test_archived_cards_do_not_count(self):
        self._fill(self.limited, 1)
        self._card(self.limited, archived=True)
        self._card(self.limited, archived=True)
        r = self._create(self.member, self.limited)
        self.assertEqual(r.status_code, 201, r.content)

    def test_admin_can_force_soft_limit(self):
        self._fill(self.limited, 2)
        r = self._create(self.admin, self.limited, force=True)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._active(self.limited), 3)

    def test_member_cannot_force(self):
        self._fill(self.limited, 2)
        r = self._create(self.member, self.limited, force=True)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(r.json(), {"detail": "Only board admins can override a WIP limit."})
        self.assertEqual(self._active(self.limited), 2)

    def test_hard_mode_blocks_admin_even_with_force(self):
        self._set_hard()
        self._fill(self.limited, 2)
        r = self._create(self.admin, self.limited, force=True)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json(), {
            "detail": "WIP limit enforced — move blocked.", "code": "wip_hard_blocked",
            "column_name": "Doing", "current_count": 2, "wip_limit": 2,
        })
        self.assertEqual(self._active(self.limited), 2)

    def test_hard_mode_applies_with_soft_enforcement_off(self):
        self.board.enforce_wip_limits = False
        self.board.save(update_fields=["enforce_wip_limits"])
        self._set_hard()
        self._fill(self.limited, 2)
        r = self._create(self.member, self.limited)
        self.assertEqual(r.json()["code"], "wip_hard_blocked")

    def test_enforcement_off_allows_over_limit(self):
        self.board.enforce_wip_limits = False
        self.board.save(update_fields=["enforce_wip_limits"])
        self._fill(self.limited, 2)
        self.assertEqual(self._create(self.member, self.limited).status_code, 201)

    def test_weight_limit_on_create(self):
        self._set_weight_limit(self.free, 5)
        self._fill(self.free, 1, weight=3)
        r = self._create(self.member, self.free, weight=3)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json(), {
            "code": "weight_limit_exceeded", "column_name": "Backlog",
            "current_weight": 3, "weight_limit": 5, "card_weight": 3,
        })
        # Exactly reaching the limit is allowed (move uses `>`).
        self.assertEqual(self._create(self.member, self.free, weight=2).status_code, 201)

    def test_admin_can_force_weight_member_cannot(self):
        self._set_weight_limit(self.free, 1)
        self._fill(self.free, 1)
        r = self._create(self.member, self.free, force=True)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json(), {"detail": "Only board admins can override a weight limit."})
        self.assertEqual(self._create(self.admin, self.free, force=True).status_code, 201)

    def test_allow_card_creation_still_checked_first(self):
        self.limited.allow_card_creation = False
        self.limited.save(update_fields=["allow_card_creation"])
        self._fill(self.limited, 2)
        r = self._create(self.member, self.limited)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json(), {"column": "Card creation is not allowed in this column."})


# ---------------------------------------------------------------------------
# Restore from archive
# ---------------------------------------------------------------------------

class RestoreEnforcementTests(_LimitFixture):
    def _restore(self, user, card, *, force=False):
        self.client.force_authenticate(user)
        url = f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/unarchive/"
        if force:
            url += "?force=true"
        return self.client.post(url)

    def test_restore_into_full_column_is_409_and_stays_archived(self):
        archived = self._card(self.limited, archived=True, created_by=self.member)
        self._fill(self.limited, 2)
        r = self._restore(self.member, archived)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "wip_limit_exceeded")
        self.assertEqual(r.json()["current_count"], 2)
        archived.refresh_from_db()
        self.assertIsNotNone(archived.archived_at)
        self.assertFalse(
            CardMovement.objects.filter(
                card=archived, movement_type=CardMovement.MovementType.UNARCHIVED,
            ).exists()
        )

    def test_restore_under_limit_is_allowed(self):
        archived = self._card(self.limited, archived=True)
        self._fill(self.limited, 1)
        r = self._restore(self.admin, archived)
        self.assertEqual(r.status_code, 200, r.content)
        archived.refresh_from_db()
        self.assertIsNone(archived.archived_at)

    def test_admin_force_member_cannot(self):
        archived = self._card(self.limited, archived=True, created_by=self.member)
        self._fill(self.limited, 2)
        self.assertEqual(self._restore(self.member, archived, force=True).status_code, 403)
        self.assertEqual(self._restore(self.admin, archived, force=True).status_code, 200)
        self.assertEqual(self._active(self.limited), 3)

    def test_hard_mode_blocks_admin_with_force(self):
        self._set_hard()
        archived = self._card(self.limited, archived=True)
        self._fill(self.limited, 2)
        r = self._restore(self.admin, archived, force=True)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["code"], "wip_hard_blocked")

    def test_weight_limit_on_restore(self):
        self._set_weight_limit(self.free, 4)
        archived = self._card(self.free, weight=3, archived=True)
        self._fill(self.free, 1, weight=2)
        r = self._restore(self.admin, archived)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json(), {
            "code": "weight_limit_exceeded", "column_name": "Backlog",
            "current_weight": 2, "weight_limit": 4, "card_weight": 3,
        })

    def test_restoring_a_non_archived_card_is_still_a_no_op(self):
        # The no-op path never re-checks limits, even in an over-limit column.
        self._fill(self.limited, 3)
        active = Card.objects.filter(column=self.limited).first()
        self.assertEqual(self._restore(self.admin, active).status_code, 200)


# ---------------------------------------------------------------------------
# PATCH weight
# ---------------------------------------------------------------------------

class WeightUpdateEnforcementTests(_LimitFixture):
    def setUp(self):
        super().setUp()
        self._set_weight_limit(self.free, 5)
        self.card = self._card(self.free, weight=2, created_by=self.member)
        self._card(self.free, weight=2)  # column total 4 of 5

    def _patch(self, user, body, *, force=False, card=None):
        self.client.force_authenticate(user)
        url = f"/api/v1/boards/{self.board.pk}/cards/{(card or self.card).pk}/"
        if force:
            url += "?force=true"
        return self.client.patch(url, body, format="json")

    def test_raising_weight_past_limit_is_409_and_not_saved(self):
        r = self._patch(self.member, {"weight": 4})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json(), {
            "code": "weight_limit_exceeded", "column_name": "Backlog",
            "current_weight": 2, "weight_limit": 5, "card_weight": 4,
        })
        self.card.refresh_from_db()
        self.assertEqual(self.card.weight, 2)

    def test_raising_weight_to_exactly_the_limit_is_allowed(self):
        self.assertEqual(self._patch(self.member, {"weight": 3}).status_code, 200)

    def test_admin_can_force_member_cannot(self):
        self.assertEqual(self._patch(self.member, {"weight": 9}, force=True).status_code, 403)
        r = self._patch(self.admin, {"weight": 9}, force=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.weight, 9)

    def test_lowering_weight_in_over_limit_column_is_allowed(self):
        self._card(self.free, weight=5)  # total 9 of 5: already over
        r = self._patch(self.member, {"weight": 1})
        self.assertEqual(r.status_code, 200, r.content)

    def test_unrelated_edit_in_over_limit_column_is_allowed(self):
        self._card(self.free, weight=5)  # over weight
        self._fill(self.limited, 3)  # over WIP
        self.assertEqual(self._patch(self.member, {"title": "renamed"}).status_code, 200)
        in_limited = Card.objects.filter(column=self.limited).first()
        self.assertEqual(
            self._patch(self.admin, {"title": "x", "weight": 1}, card=in_limited).status_code, 200,
        )

    def test_weight_increase_does_not_check_wip(self):
        # Column over its WIP limit, no weight limit: a weight change does not
        # add a card, so it must not be refused on WIP grounds.
        self._fill(self.limited, 3)
        card = Card.objects.filter(column=self.limited).first()
        self.assertEqual(self._patch(self.admin, {"weight": 8}, card=card).status_code, 200)

    def test_weight_increase_check_costs_only_lock_and_sum(self):
        # The PATCH path's card comes from _card_queryset, which
        # select_related()s the column, so the check adds exactly the column
        # row lock and the weight aggregate — no column fetch (#1428 perf).
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        def count(weight, card):
            self.client.force_authenticate(self.admin)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.patch(
                    f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/",
                    {"weight": weight}, format="json",
                )
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries)

        unlimited = self._card(self.limited, weight=1)  # `Doing` has no weight_limit
        baseline = count(2, unlimited)
        checked = count(3, self.card)  # `Backlog`: 4 -> 5 of 5, allowed
        self.assertEqual(checked - baseline, 2)

    def test_enforcement_off_allows_weight_increase(self):
        self.board.enforce_weight_limits = False
        self.board.save(update_fields=["enforce_weight_limits"])
        self.assertEqual(self._patch(self.member, {"weight": 50}).status_code, 200)


# ---------------------------------------------------------------------------
# Shared helper — direct
# ---------------------------------------------------------------------------

class EnforceColumnLimitsHelperTests(_LimitFixture):
    def test_hard_mode_is_checked_before_force_and_role(self):
        self._set_hard()
        self._fill(self.limited, 2)
        with self.assertRaises(WipHardBlocked):
            card_services.enforce_column_limits(
                board=self.board, column=self.limited,
                card=SimpleNamespace(pk=None, weight=1), role="site_admin", force=True,
            )

    def test_no_limits_issue_no_queries(self):
        with self.assertNumQueries(0):
            card_services.enforce_column_limits(
                board=self.board, column=self.free,
                card=SimpleNamespace(pk=None, weight=1), role="member",
            )


# ---------------------------------------------------------------------------
# Django admin
# ---------------------------------------------------------------------------

class CardAdminFormEnforcementTests(_LimitFixture):
    def _form(self, instance=None, **overrides):
        data = {
            "board": self.board.pk, "column": self.limited.pk, "swimlane": self.swimlane.pk,
            "title": "admin card", "description": "", "priority": "medium",
            "weight": 1, "position": 0, "created_by": self.admin.pk, "version": 1,
        }
        if instance is not None:
            data.update({
                "column": instance.column_id, "weight": instance.weight,
                "title": instance.title, "position": instance.position,
                "archived_at": instance.archived_at,
            })
        data.update(overrides)
        form_class = CardAdmin(Card, AdminSite()).get_form(None, obj=instance)
        return form_class(data=data, instance=instance)

    def test_card_admin_uses_the_enforcing_form(self):
        self.assertIs(CardAdmin.form, CardAdminForm)

    def test_create_into_full_column_is_a_form_error(self):
        self._fill(self.limited, 2)
        form = self._form()
        self.assertFalse(form.is_valid())
        self.assertIn("WIP limit", str(form.non_field_errors()))

    def test_create_under_limit_is_valid(self):
        form = self._form()
        self.assertTrue(form.is_valid(), form.errors)

    def test_create_in_column_without_card_creation_is_a_form_error(self):
        self.free.allow_card_creation = False
        self.free.save(update_fields=["allow_card_creation"])
        form = self._form(column=self.free.pk)
        self.assertFalse(form.is_valid())
        self.assertIn("column", form.errors)

    def test_hard_mode_message(self):
        self._set_hard()
        self._fill(self.limited, 2)
        form = self._form()
        self.assertFalse(form.is_valid())
        self.assertIn("hard WIP limits", str(form.non_field_errors()))

    def test_move_into_full_column_is_a_form_error(self):
        card = self._card(self.free)
        self._fill(self.limited, 2)
        form = self._form(instance=card, column=self.limited.pk)
        self.assertFalse(form.is_valid())

    def test_restore_into_full_column_is_a_form_error(self):
        card = self._card(self.limited, archived=True)
        self._fill(self.limited, 2)
        form = self._form(instance=card, archived_at="")
        self.assertFalse(form.is_valid())

    def test_weight_increase_past_limit_is_a_form_error(self):
        self._set_weight_limit(self.free, 3)
        card = self._card(self.free, weight=1)
        form = self._form(instance=card, weight=4)
        self.assertFalse(form.is_valid())
        self.assertIn("weight limit", str(form.non_field_errors()))

    def test_column_from_another_board_is_a_form_error(self):
        # Without this check the helper would count the other board's column
        # as empty (it filters by board) and every limit would pass.
        other = _make_board(self.admin, name="Other")
        other_col = Column.objects.create(
            board=other, name="Elsewhere", position=0, wip_limit=1, allow_card_creation=True,
        )
        Card.objects.create(
            board=other, column=other_col,
            swimlane=Swimlane.objects.create(board=other, name="S", position=0),
            title="full", created_by=self.admin, position=0,
        )
        form = self._form(column=other_col.pk)
        self.assertFalse(form.is_valid())
        self.assertEqual(form.errors["column"], ["Column belongs to a different board."])

    def test_unrelated_edit_in_over_limit_column_is_valid(self):
        self._fill(self.limited, 3)
        card = Card.objects.filter(column=self.limited).first()
        form = self._form(instance=card, title="renamed")
        self.assertTrue(form.is_valid(), form.errors)


class CardAdminCellEntryLockTests(_LimitFixture):
    """Which admin edits take the card -> column cell-entry lock (#1588).

    The race itself is pinned on PostgreSQL by
    ``test_admin_card_cell_entry_race.py``; these pin the trigger on any
    backend: every change of column or swimlane, archived cards included.
    """

    LOCK = "boards.admin.lock_card_cell_entry"

    def setUp(self):
        super().setUp()
        self.other_lane = Swimlane.objects.create(board=self.board, name="Other", position=1)

    _form = CardAdminFormEnforcementTests._form

    def _clean_locks(self, instance=None, **overrides):
        with patch(self.LOCK) as lock:
            form = self._form(instance=instance, **overrides)
            self.assertTrue(form.is_valid(), form.errors)
        return lock

    def test_swimlane_only_change_locks_card_then_column(self):
        card = self._card(self.free)
        lock = self._clean_locks(card, column=self.free.pk, swimlane=self.other_lane.pk)
        lock.assert_called_once_with(card_id=card.pk, column_ids={self.free.pk})

    def test_archived_card_swimlane_change_locks(self):
        card = self._card(self.free, archived=True)
        lock = self._clean_locks(card, column=self.free.pk, swimlane=self.other_lane.pk)
        lock.assert_called_once_with(card_id=card.pk, column_ids={self.free.pk})

    def test_archived_card_column_change_locks_both_columns(self):
        card = self._card(self.free, archived=True)
        lock = self._clean_locks(card, column=self.limited.pk)
        lock.assert_called_once_with(
            card_id=card.pk, column_ids={self.free.pk, self.limited.pk},
        )

    def test_create_locks_target_column(self):
        lock = self._clean_locks(column=self.free.pk)
        lock.assert_called_once_with(card_id=None, column_ids={self.free.pk})

    def test_edit_in_place_takes_no_cell_lock(self):
        card = self._card(self.free)
        lock = self._clean_locks(card, column=self.free.pk, title="renamed")
        lock.assert_not_called()

    def test_save_model_relocks_from_stored_cell(self):
        # The save path re-takes the lock in its own transaction, deciding
        # "did the cell change" from the stored row, not from the form.
        card = self._card(self.free, archived=True)
        card.swimlane = self.other_lane
        request = RequestFactory().post("/")
        request.user = self.admin
        with patch(self.LOCK) as lock, patch("boards.admin._refetched_card_data", return_value={}):
            CardAdmin(Card, AdminSite()).save_model(request, card, form=None, change=True)
        lock.assert_called_once_with(card_id=card.pk, column_ids={self.free.pk})
        card.refresh_from_db()
        self.assertEqual(card.swimlane_id, self.other_lane.pk)

    def test_save_model_unchanged_cell_takes_no_lock(self):
        card = self._card(self.free)
        card.title = "renamed"
        request = RequestFactory().post("/")
        request.user = self.admin
        with patch(self.LOCK) as lock, patch("boards.admin._refetched_card_data", return_value={}):
            CardAdmin(Card, AdminSite()).save_model(request, card, form=None, change=True)
        lock.assert_not_called()


# ---------------------------------------------------------------------------
# Import is exempt by design
# ---------------------------------------------------------------------------

class ImportExemptTests(_LimitFixture):
    """A board exported over its WIP and weight limits re-imports with every card.

    Import restores a board as exported, and the sample gallery (#1452) ships
    boards that each have one over-WIP column on purpose. Import uses
    ``bulk_create`` and never reaches ``create_card``.
    """

    def test_json_export_over_limits_with_hard_mode_reimports_all_cards(self):
        self._set_hard()
        self._set_weight_limit(self.limited, 2)
        self._fill(self.limited, 4, weight=3)  # WIP 4/2, weight 12/2
        self.client.force_authenticate(self.admin)

        exported = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        self.assertEqual(exported.status_code, 200)
        upload = io.BytesIO(exported.content)
        upload.name = "board.json"
        r = self.client.post("/api/v1/boards/import/", {"file": upload}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)

        column = Column.objects.get(board_id=r.data["id"], name="Doing")
        self.assertEqual((column.wip_limit, column.weight_limit), (2, 2))
        self.assertEqual(
            Card.objects.filter(column=column, archived_at__isnull=True).count(), 4,
        )

        # Exempting import does not exempt what happens next on the board.
        r = self.client.post(
            f"/api/v1/boards/{r.data['id']}/cards/",
            {"title": "one more", "column": column.pk,
             "swimlane": Swimlane.objects.filter(board_id=r.data["id"]).first().pk},
            format="json",
        )
        self.assertEqual(r.status_code, 409, r.content)

    def test_json_import_payload_over_limits(self):
        data = {
            "name": "Imported",
            "columns": [{"name": "Doing", "position": 0, "wip_limit": 1, "weight_limit": 1,
                         "allow_card_creation": True}],
            "swimlanes": [{"name": "General", "position": 0}],
            "cards": [
                {"title": f"c{i}", "column": "Doing", "swimlane": "General", "weight": 3,
                 "position": i}
                for i in range(3)
            ],
        }
        upload = io.BytesIO(json.dumps(data).encode("utf-8"))
        upload.name = "board.json"
        self.client.force_authenticate(self.admin)
        r = self.client.post("/api/v1/boards/import/", {"file": upload}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Card.objects.filter(board_id=r.data["id"]).count(), 3)
