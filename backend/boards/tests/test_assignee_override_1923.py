"""#1923 MR A / #2584: the force-override audit foundation.

* ``_require_force`` -- the one eligibility predicate. Every input it branches
  on gets an absent-input test (#1075): no assignee, an assignee who is no
  longer a member, a viewer or collaborator assignee, the switch off, a NULL
  ``assigned_by``, a self-assignment, and a missing role/actor/board/card.
* ``CardOverride`` + ``override_used`` activity + the additive ``override``
  payload on every path that can force (move, create, restore, weight update).
* ``Card.assigned_by`` on every assignee write path.
* ``BoardSettingChange`` for the switch and the WIP/weight toggles (#2584).
* A PostgreSQL race: eligibility is read under the move's card lock.
"""

import threading
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.db import connection, connections
from django.test import RequestFactory, TestCase, TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.admin import CardAdmin
from boards.management.commands.purge_card_history import redact_card_event_payload
from boards.models import (
    Board, BoardMembership, BoardSettingChange, Card, CardActivity, CardOverride, Column,
    Swimlane,
)
from boards.permissions import SITE_ADMIN
from boards.services import cards as card_services
from boards.services.errors import ForceNotPermitted
from boards.tests.lock_wait import assert_blocked_on_lock

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"
R = BoardMembership.Role
HOLD_TIMEOUT = 10


class _Fixture:
    def _setup_board(self):
        self.admin = User.objects.create_user(username="ao_admin", password="pass")
        self.member = User.objects.create_user(username="ao_member", password="pass")
        self.other = User.objects.create_user(username="ao_other", password="pass")
        self.board = Board.objects.create(
            name="Override", owner=self.admin, allow_assignee_override=True,
        )
        BoardMembership.objects.create(board=self.board, user=self.admin, role=R.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=R.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.other, role=R.MEMBER)
        self.src = Column.objects.create(
            board=self.board, name="Src", position=0, allow_card_creation=True,
        )
        self.dst = Column.objects.create(
            board=self.board, name="Dst", position=1, wip_limit=1, allow_card_creation=True,
        )
        self.lane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        Card.objects.create(
            board=self.board, column=self.dst, swimlane=self.lane, title="Filler",
            created_by=self.admin, position=0,
        )
        # Assigned to the member by the admin: eligible once the switch is on.
        self.card = Card.objects.create(
            board=self.board, column=self.src, swimlane=self.lane, title="Mine",
            created_by=self.admin, position=0, assignee=self.member, assigned_by=self.admin,
        )

    def _client(self, user):
        client = APIClient()
        client.force_authenticate(user)
        return client

    def _move(self, user, *, force=True, reason=None, card=None):
        card = card or self.card
        body = {"column_id": self.dst.pk, "swimlane_id": self.lane.pk, "position": 0}
        if reason is not None:
            body["override_reason"] = reason
        url = f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/"
        return self._client(user).post(url + ("?force=true" if force else ""), body, format="json")


class RequireForcePredicateTests(_Fixture, TestCase):
    """``_require_force`` fails closed on every absent or wrong input (#1075)."""

    def setUp(self):
        self._setup_board()

    def _call(self, **overrides):
        kwargs = dict(role=R.MEMBER, card=self.card, actor=self.member, board=self.board, kinds=("wip",))
        kwargs.update(overrides)
        return card_services._require_force(**kwargs)

    def _denied(self, **overrides):
        with self.assertRaises(ForceNotPermitted) as ctx:
            self._call(**overrides)
        return ctx.exception

    def test_eligible_assignee(self):
        self.assertEqual(self._call(), CardOverride.ActorBasis.ASSIGNEE)

    def test_admin_and_site_admin_bases(self):
        self.assertEqual(self._call(role=R.ADMIN, actor=None, card=None), "admin")
        self.assertEqual(self._call(role=SITE_ADMIN, actor=None, card=None), "site_admin")

    def test_switch_off(self):
        Board.objects.filter(pk=self.board.pk).update(allow_assignee_override=False)
        # The in-memory board still says True: the predicate must re-read it.
        self.assertFalse(self._denied().self_assigned)

    def test_no_assignee(self):
        self.card.assignee_id = None
        self._denied()

    def test_actor_not_the_assignee(self):
        self._denied(actor=self.other)

    def test_viewer_or_collaborator_or_no_role(self):
        for role in (R.VIEWER, R.COLLABORATOR, None, ""):
            with self.subTest(role=role):
                self._denied(role=role)

    def test_assignee_no_longer_a_member(self):
        # get_board_role resolves to None for an ex-member.
        BoardMembership.objects.filter(board=self.board, user=self.member).delete()
        self._denied(role=None)

    def test_null_assigned_by(self):
        self.card.assigned_by_id = None
        self.assertFalse(self._denied().self_assigned)

    def test_self_assigned(self):
        self.card.assigned_by_id = self.member.pk
        exc = self._denied()
        self.assertTrue(exc.self_assigned)
        self.assertEqual(exc.body(), {
            "detail": "You assigned this card to yourself, so a board admin needs to move it anyway.",
            "code": "force_not_permitted", "reason": "self_assigned",
        })

    def test_self_assigned_hint_hidden_when_switch_off(self):
        self.card.assigned_by_id = self.member.pk
        Board.objects.filter(pk=self.board.pk).update(allow_assignee_override=False)
        self.assertFalse(self._denied().self_assigned)

    def test_missing_actor_card_board_or_kinds(self):
        self._denied(actor=None)
        self._denied(actor=SimpleNamespace(pk=None))
        self._denied(card=None)
        self._denied(board=None)
        self.assertEqual(self._denied(kinds=(), actor=None).limit, "wip")


class OverrideRecordingTests(_Fixture, TestCase):
    def setUp(self):
        self._setup_board()
        self._bc = patch(PATCH_BROADCAST)
        self.broadcast = self._bc.start()

    def tearDown(self):
        self._bc.stop()

    def test_assignee_override_records_row_activity_and_payload(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self._move(self.member, reason="  Customer escalation  ")
        self.assertEqual(resp.status_code, 200, resp.content)
        row = CardOverride.objects.get()
        self.assertEqual(
            (row.kind, row.trigger, row.actor_basis, row.reason, row.actor_id, row.assigned_by_id),
            ("wip", "move", "assignee", "Customer escalation", self.member.pk, self.admin.pk),
        )
        self.assertEqual(row.column_id, self.dst.pk)
        self.assertIsNotNone(row.movement_id)
        self.assertEqual(row.unmet, [{"kind": "wip", "scope": "column", "uid": self.dst.uid, "limit": 1}])
        act = CardActivity.objects.get(event_type="override_used")
        self.assertEqual((act.from_value, act.to_value, act.item_text), ("assignee", "wip", "Customer escalation"))
        self.assertEqual(resp.json()["override"], {
            "kinds": ["wip"], "actor_basis": "assignee",
            "actor": {"id": self.member.pk, "username": self.member.username},
            "reason": "Customer escalation",
        })
        sent = self.broadcast.call_args_list[-1].args
        self.assertEqual(sent[2]["override"]["actor_basis"], "assignee")

    def test_assignee_override_requires_reason(self):
        for reason in (None, "", "   "):
            with self.subTest(reason=reason):
                resp = self._move(self.member, reason=reason)
                self.assertEqual(resp.status_code, 400)
                self.assertEqual(resp.json()["code"], "override_reason_required")
        self.assertFalse(CardOverride.objects.exists())
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.src.pk)

    def test_reason_boundary_validation(self):
        for bad in ("x" * 501, "a\x00b", 5):
            with self.subTest(bad=bad):
                resp = self._move(self.admin, reason=bad)
                self.assertEqual(resp.status_code, 400)
                self.assertIn("override_reason", resp.json())
        self.assertEqual(self._move(self.admin, reason="x" * 500).status_code, 200)

    def test_self_assigned_member_gets_coded_403(self):
        Card.objects.filter(pk=self.card.pk).update(assigned_by=self.member)
        resp = self._move(self.member, reason="mine")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["reason"], "self_assigned")
        self.assertFalse(CardOverride.objects.exists())

    def test_switch_off_member_gets_pre_13_body_plus_code(self):
        Board.objects.filter(pk=self.board.pk).update(allow_assignee_override=False)
        resp = self._move(self.member, reason="please")
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json(), {
            "detail": "Only board admins can override a WIP limit.", "code": "force_not_permitted",
        })

    def test_admin_force_without_reason_is_recorded_blank(self):
        resp = self._move(self.admin)
        self.assertEqual(resp.status_code, 200, resp.content)
        row = CardOverride.objects.get()
        self.assertEqual((row.actor_basis, row.reason, row.assigned_by_id), ("admin", "", None))
        self.assertEqual(resp.json()["override"]["reason"], "")

    def test_no_override_payload_or_row_when_nothing_tripped(self):
        Column.objects.filter(pk=self.dst.pk).update(wip_limit=None)
        resp = self._move(self.admin)
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("override", resp.json())
        self.assertFalse(CardOverride.objects.exists())
        self.assertFalse(CardActivity.objects.filter(event_type="override_used").exists())

    def test_wip_and_weight_tripped_write_one_row_each(self):
        Column.objects.filter(pk=self.dst.pk).update(weight_limit=1)
        resp = self._move(self.admin, reason="both")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(sorted(CardOverride.objects.values_list("kind", flat=True)), ["weight", "wip"])
        self.assertEqual(CardActivity.objects.filter(event_type="override_used").count(), 1)

    def test_create_force_records_create_trigger(self):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self._client(self.admin).post(
                f"/api/v1/boards/{self.board.pk}/cards/?force=true",
                {"title": "New", "column": self.dst.pk, "swimlane": self.lane.pk, "override_reason": "ok"},
                format="json",
            )
        self.assertEqual(resp.status_code, 201, resp.content)
        row = CardOverride.objects.get()
        self.assertEqual((row.trigger, row.reason), ("create", "ok"))
        # The REST create body is the serializer's; the card.created frame
        # carries the additive override object.
        created = [c.args[2] for c in self.broadcast.call_args_list if c.args[1] == "card.created"]
        self.assertEqual(created[-1]["override"]["kinds"], ["wip"])

    def test_restore_force_records_restore_trigger(self):
        from django.utils import timezone
        archived = Card.objects.create(
            board=self.board, column=self.dst, swimlane=self.lane, title="Old",
            created_by=self.admin, position=1, archived_at=timezone.now(),
        )
        resp = self._client(self.admin).post(
            f"/api/v1/boards/{self.board.pk}/cards/{archived.pk}/unarchive/?force=true",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        row = CardOverride.objects.get()
        self.assertEqual((row.trigger, row.card_id), ("restore", archived.pk))
        self.assertIsNotNone(row.movement_id)

    def test_weight_update_force_by_assignee(self):
        # Members edit only cards they created; the assignment stays the admin's.
        Card.objects.filter(pk=self.card.pk).update(column=self.dst, position=1, created_by=self.member)
        Column.objects.filter(pk=self.dst.pk).update(wip_limit=None, weight_limit=2)
        resp = self._client(self.member).patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/?force=true",
            {"weight": 5, "override_reason": "estimate grew"}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        row = CardOverride.objects.get()
        self.assertEqual((row.kind, row.trigger, row.actor_basis), ("weight", "weight_update", "assignee"))

    def test_purge_feed_redaction_nulls_override_reason(self):
        data = {"id": 1, "title": "t", "override": {"kinds": ["wip"], "reason": "secret"}}
        out = redact_card_event_payload("card.created", data)
        self.assertIsNone(out["override"]["reason"])
        self.assertEqual(out["override"]["kinds"], ["wip"])
        moved = {"card": {"title": "t"}, "movement": {}, "override": {"reason": "secret"}}
        self.assertIsNone(redact_card_event_payload("card.moved", moved)["override"]["reason"])

    def test_override_row_is_append_only(self):
        self._move(self.admin)
        row = CardOverride.objects.get()
        row.reason = "changed"
        with self.assertRaises(Exception):
            row.save()


class AssignedByWritePathTests(_Fixture, TestCase):
    def setUp(self):
        self._setup_board()
        self._bc = patch(PATCH_BROADCAST)
        self._bc.start()

    def tearDown(self):
        self._bc.stop()

    def test_patch_sets_and_clears_assigned_by(self):
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        Card.objects.filter(pk=self.card.pk).update(assigned_by=None)
        resp = self._client(self.admin).patch(url, {"assignee_id": self.other.pk}, format="json")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.assigned_by_id, self.admin.pk)
        self.assertEqual(resp.json()["assigned_by"], self.admin.pk)
        # An unrelated edit by someone else keeps the provenance.
        Card.objects.filter(pk=self.card.pk).update(created_by=self.member)
        self._client(self.member).patch(url, {"title": "Renamed"}, format="json")
        self.card.refresh_from_db()
        self.assertEqual(self.card.assigned_by_id, self.admin.pk)
        self._client(self.admin).patch(url, {"assignee_id": None}, format="json")
        self.card.refresh_from_db()
        self.assertIsNone(self.card.assigned_by_id)

    def test_create_with_assignee_sets_assigned_by(self):
        resp = self._client(self.admin).post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "N", "column": self.src.pk, "swimlane": self.lane.pk, "assignee_id": self.member.pk},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Card.objects.get(pk=resp.json()["id"]).assigned_by_id, self.admin.pk)
        self.assertEqual(resp.json()["assigned_by"], self.admin.pk)

    def test_create_without_assignee_leaves_null(self):
        resp = self._client(self.other).post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "N", "column": self.src.pk, "swimlane": self.lane.pk}, format="json",
        )
        self.assertIsNone(Card.objects.get(pk=resp.json()["id"]).assigned_by_id)

    def test_admin_form_tracks_assignee(self):
        admin = CardAdmin(Card, AdminSite())
        staff = User.objects.create_superuser(username="ao_staff", password="pass", email="s@x.test")
        request = RequestFactory().post("/")
        request.user = staff
        self.card.assignee = self.other
        admin.save_model(request, self.card, form=None, change=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.assigned_by_id, staff.pk)
        stale = Card.objects.get(pk=self.card.pk)
        stale.assigned_by_id = None  # a stale form value must not win
        admin.save_model(request, stale, form=None, change=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.assigned_by_id, staff.pk)

    def test_clear_viewer_assignees_clears_assigned_by(self):
        from django.core.management import call_command
        BoardMembership.objects.filter(board=self.board, user=self.member).update(role=R.VIEWER)
        call_command("clear_viewer_assignees", "--board", str(self.board.pk), verbosity=0)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.assignee_id)
        self.assertIsNone(self.card.assigned_by_id)

    def test_public_card_serializer_omits_assigned_by(self):
        from boards.serializers import PublicCardSerializer
        self.assertNotIn("assigned_by", PublicCardSerializer.Meta.fields)


class BoardSettingChangeTests(_Fixture, TestCase):
    def setUp(self):
        self._setup_board()
        self._bc = patch(PATCH_BROADCAST)
        self._bc.start()

    def tearDown(self):
        self._bc.stop()

    def _patch_board(self, user, body):
        return self._client(user).patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")

    def test_every_enforcement_toggle_is_recorded(self):
        resp = self._patch_board(self.admin, {
            "allow_assignee_override": False, "enforce_wip_limits": False,
            "enforce_wip_hard": True, "enforce_weight_limits": False,
        })
        self.assertEqual(resp.status_code, 200, resp.content)
        rows = {r.setting: (r.old_value, r.new_value, r.actor_id) for r in BoardSettingChange.objects.all()}
        self.assertEqual(rows, {
            "allow_assignee_override": ("true", "false", self.admin.pk),
            "enforce_wip_limits": ("true", "false", self.admin.pk),
            "enforce_wip_hard": ("false", "true", self.admin.pk),
            "enforce_weight_limits": ("true", "false", self.admin.pk),
        })

    def test_unchanged_or_unrelated_save_records_nothing(self):
        self._patch_board(self.admin, {"allow_assignee_override": True, "name": "Renamed"})
        self.assertFalse(BoardSettingChange.objects.exists())

    def test_member_cannot_flip_the_switch(self):
        resp = self._patch_board(self.member, {"allow_assignee_override": False})
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(Board.objects.get(pk=self.board.pk).allow_assignee_override)
        self.assertFalse(BoardSettingChange.objects.exists())

    def test_switch_defaults_off(self):
        self.assertFalse(Board.objects.create(name="New", owner=self.admin).allow_assignee_override)

    def test_switch_not_on_public_board_serializer(self):
        from boards.serializers import PublicBoardSerializer
        self.assertNotIn("allow_assignee_override", PublicBoardSerializer().fields)

    def test_swimlane_limit_enforcement_is_recorded(self):
        resp = self._client(self.admin).patch(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.lane.pk}/",
            {"limit_enforcement": "hard"}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        row = BoardSettingChange.objects.get()
        self.assertEqual(row.setting, f"swimlane:{self.lane.uid}:limit_enforcement")
        self.assertEqual(row.new_value, "hard")


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class AssigneeEligibilityLockTests(_Fixture, TransactionTestCase):
    """A reassignment racing the assignee's forced move is seen, not missed."""

    def setUp(self):
        self._setup_board()
        Column.objects.filter(pk=self.src.pk).update(weight_limit=100)

    def test_move_waits_for_a_reassignment_and_sees_it(self):
        held, release = threading.Event(), threading.Event()
        results, errors = {}, []
        real = card_services.enforce_column_limits

        def hold(*args, **kwargs):
            out = real(*args, **kwargs)
            if threading.current_thread().name == "first":
                held.set()
                release.wait(HOLD_TIMEOUT)
            return out

        def reassign():
            # A weight increase runs the (held) limit check with the card row
            # locked and the new assignee already written.
            return self._client(self.admin).patch(
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                {"assignee_id": self.other.pk, "weight": 2}, format="json",
            )

        def worker(name, fn):
            try:
                results[name] = fn()
            except BaseException as exc:  # noqa: BLE001 - surfaced after join
                errors.append(exc)
            finally:
                connections.close_all()

        with patch("boards.services.cards.enforce_column_limits", side_effect=hold), \
                patch(PATCH_BROADCAST):
            first = threading.Thread(target=worker, args=("first", reassign), name="first")
            first.start()
            self.assertTrue(held.wait(HOLD_TIMEOUT), "the reassignment never reached its check")
            second = threading.Thread(
                target=worker, args=("second", lambda: self._move(self.member, reason="mine")),
                name="second",
            )
            second.start()
            try:
                assert_blocked_on_lock(self, second, "the forced move did not wait on the card lock")
            finally:
                release.set()
                first.join(30)
                second.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(results["first"].status_code, 200, results["first"].content)
        self.assertEqual(results["second"].status_code, 403, results["second"].content)
        self.assertFalse(CardOverride.objects.exists())
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.src.pk)
