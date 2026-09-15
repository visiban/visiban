"""Invariant coverage for ``boards.services.cards``, called directly.

Every test here bypasses HTTP entirely. That is the point of #1107: the card
invariants used to live inside DRF view methods, so the only way to exercise
them was through a request, and the only way for a second consumer (MCP write
tools, a second front end, a webhook) to get them was to re-implement them.
These tests are the proof that a non-HTTP caller gets the same enforcement —
including the parts that are easy to lose in an extraction: that hard WIP mode
cannot be forced by anyone, that the role defaults to *derived* rather than
trusted, and that broadcasts and ``CARD_MUTATION_HOOKS`` still fire.

The endpoint-level contract is covered separately, by
``test_card_error_bodies`` (exact response bodies) and the existing card view
suites. Here we assert on the typed errors and on the database.
"""
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from boards import hooks
from boards.models import BoardMembership, Card, CardActivity, CardMovement
from boards.permissions import get_board_role, get_board_roles
from boards.services import cards as svc
from boards.services.errors import (
    CardCreationNotAllowed, CardNotFound, ColumnNotFound, ForceNotPermitted,
    InvalidVersion, MoveNotPermitted, NotPermitted, SwimlaneNotFound,
    UseMoveEndpoint, VersionConflict, WeightLimitExceeded, WipHardBlocked,
    WipLimitExceeded,
)
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)


def _render(card, movement=None):
    """Minimal payload renderer.

    The service never inspects what ``render`` returns — it only forwards it to
    the broadcast and the result — so a direct caller can keep it this cheap
    instead of dragging DRF serializers into a non-HTTP path.
    """
    return {"id": card.pk, "position": card.position, "movement": bool(movement)}


class CardServiceTestBase(TestCase):
    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = self._broadcast_patcher.start()

        self.owner = _make_user("svc_owner")
        self.board = _make_board(self.owner)
        self.col_a = _make_column(self.board, "A", 0)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col_a, self.lane, title="Subject")

        self.member = _make_user("svc_member")
        _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)
        self.viewer = _make_user("svc_viewer")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)

    def tearDown(self):
        self._broadcast_patcher.stop()

    # ── helpers ───────────────────────────────────────────────────────────

    def _move(self, actor=None, **kwargs):
        kwargs.setdefault("card_id", self.card.pk)
        kwargs.setdefault("target_column_id", self.col_b.pk)
        kwargs.setdefault("target_swimlane_id", self.lane.pk)
        kwargs.setdefault("position", 0)
        return svc.move_card(
            actor=actor or self.owner, board=self.board, render=_render, **kwargs
        )

    def _fill(self, column, n, weight=1):
        return [
            _make_card(column, self.lane, title=f"f{i}", position=i, weight=weight)
            for i in range(n)
        ]


class RoleAllowListTests(CardServiceTestBase):
    """The allow-list is an allow-list, and the role is derived by default."""

    def test_viewer_cannot_move(self):
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer, role=BoardMembership.Role.VIEWER)

    def test_collaborator_cannot_move(self):
        collaborator = _make_user("svc_collab")
        _make_membership(self.board, collaborator, BoardMembership.Role.COLLABORATOR)
        with self.assertRaises(NotPermitted):
            self._move(actor=collaborator, role=BoardMembership.Role.COLLABORATOR)

    def test_role_is_derived_when_not_supplied(self):
        """Omitting ``role`` must derive it, not skip the check.

        This is the safe default every non-HTTP caller uses: it has no reason to
        have resolved the role itself, and a service that treated a missing role
        as "unchecked" would be an authorization hole rather than a convenience.
        """
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer)

    def test_derived_role_grants_access_to_a_real_member(self):
        self.card.created_by = self.member
        self.card.save(update_fields=["created_by"])
        result = self._move(actor=self.member)
        self.assertEqual(result.card.column_id, self.col_b.pk)

    def test_non_member_cannot_move(self):
        outsider = _make_user("svc_outsider")
        with self.assertRaises(NotPermitted):
            self._move(actor=outsider)

    def test_a_forged_elevated_role_is_ignored(self):
        """A supplied ``role`` is believed only if a resolver actually produced it.

        The service accepts an already-resolved role so an adapter that has just
        resolved it need not pay twice. That parameter has to fail closed, or it
        is an authorization hole with a docstring for a lock: a viewer claiming
        ``admin`` must still be refused.
        """
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer, role=BoardMembership.Role.ADMIN)

    def test_a_role_resolved_for_another_board_is_ignored(self):
        """The likelier mistake, now that ``get_board_roles`` returns a dict:
        indexing it with the wrong board id."""
        other_board = _make_board(self.viewer, name="Where they are admin")
        roles = get_board_roles(self.viewer, [other_board])
        self.assertEqual(roles[other_board.pk], BoardMembership.Role.ADMIN)
        # Passing that admin role against *this* board must not be believed.
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer, role=roles[other_board.pk])

    def test_a_role_resolved_for_another_actor_is_ignored(self):
        get_board_role(self.owner, self.board)  # stamps the board for the owner
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer, role=BoardMembership.Role.ADMIN)

    def test_a_correctly_resolved_role_is_used_as_supplied(self):
        """The fast path must still work, or the parameter is pointless."""
        self.card.created_by = self.member
        self.card.save(update_fields=["created_by"])
        role = get_board_role(self.member, self.board)
        self.assertEqual(role, BoardMembership.Role.MEMBER)
        result = self._move(actor=self.member, role=role)
        self.assertEqual(result.card.column_id, self.col_b.pk)

    def test_viewer_cannot_create_update_archive_or_delete(self):
        with self.assertRaises(NotPermitted):
            svc.create_card(
                actor=self.viewer, board=self.board, column_id=self.col_a.pk,
                swimlane_id=self.lane.pk, save=lambda position: None, render=_render,
            )
        with self.assertRaises(NotPermitted):
            svc.update_card(
                actor=self.viewer, board=self.board, card=self.card,
                submitted={}, apply=lambda: None, render=_render,
            )
        with self.assertRaises(NotPermitted):
            svc.archive_card(
                actor=self.viewer, board=self.board, card_id=self.card.pk, render=_render,
            )
        with self.assertRaises(NotPermitted):
            svc.delete_card(actor=self.viewer, board=self.board, card=self.card)


class RoleHintAcceptedOverHttpTests(TestCase):
    """The view adapters' role must survive the fail-closed check.

    The stamp comparison in ``_resolve_role`` is silent when it succeeds and
    only logs when it rejects — and on an owner-owned board a rejection costs
    zero extra queries, so no query budget would notice the fast path quietly
    falling back to a fresh derivation on every single mutation. This asserts
    the negative directly: a normal request must log no rejection.
    """

    def setUp(self):
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()
        self.user = _make_user("hint_user")
        self.board = _make_board(self.user)
        self.col_a = _make_column(self.board, "A", 0)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)
        self.card = _make_card(self.col_a, self.lane, title="Hinted")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def tearDown(self):
        self._broadcast_patcher.stop()

    def _assert_no_rejection(self, fn):
        with self.assertNoLogs("boards.services.cards", level="WARNING"):
            resp = fn()
        return resp

    def test_move_accepts_the_adapters_role(self):
        resp = self._assert_no_rejection(lambda: self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.col_b.pk, "swimlane_id": self.lane.pk, "position": 0},
            format="json",
        ))
        self.assertEqual(resp.status_code, 200)

    def test_update_accepts_the_adapters_role(self):
        resp = self._assert_no_rejection(lambda: self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
            {"title": "renamed"}, format="json",
        ))
        self.assertEqual(resp.status_code, 200)

    def test_create_accepts_the_adapters_role(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])
        resp = self._assert_no_rejection(lambda: self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "new", "column": self.col_a.pk, "swimlane": self.lane.pk},
            format="json",
        ))
        self.assertEqual(resp.status_code, 201)

    def test_archive_and_unarchive_accept_the_adapters_role(self):
        base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        self.assertEqual(
            self._assert_no_rejection(lambda: self.client.post(base + "archive/")).status_code,
            200,
        )
        self.assertEqual(
            self._assert_no_rejection(lambda: self.client.post(base + "unarchive/")).status_code,
            200,
        )

    def test_destroy_accepts_the_adapters_role(self):
        resp = self._assert_no_rejection(lambda: self.client.delete(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/"
        ))
        self.assertEqual(resp.status_code, 204)


class OwnershipGateTests(CardServiceTestBase):
    def test_member_cannot_move_a_card_assigned_to_someone_else(self):
        self.card.assignee = self.owner
        self.card.created_by = self.owner
        self.card.save(update_fields=["assignee", "created_by"])
        with self.assertRaises(MoveNotPermitted):
            self._move(actor=self.member)

    def test_assignee_may_move_their_own_assigned_card(self):
        """The assignee owns the work, so they may move it even though they did
        not create it."""
        self.card.assignee = self.member
        self.card.created_by = self.owner
        self.card.save(update_fields=["assignee", "created_by"])
        result = self._move(actor=self.member)
        self.assertEqual(result.card.column_id, self.col_b.pk)

    def test_any_member_may_move_an_unassigned_card(self):
        self.assertIsNone(self.card.assignee_id)
        self._move(actor=self.member)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_moderator_may_move_a_card_assigned_to_someone_else(self):
        membership = _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)
        membership.is_moderator = True
        membership.save(update_fields=["is_moderator"])
        self.card.assignee = self.owner
        self.card.save(update_fields=["assignee"])
        self._move(actor=self.member)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_member_cannot_update_delete_or_archive_anothers_card(self):
        with self.assertRaises(NotPermitted) as ctx:
            svc.update_card(
                actor=self.member, board=self.board, card=self.card,
                submitted={"title": "x"}, apply=lambda: None, render=_render,
            )
        self.assertEqual(ctx.exception.detail, "You can only edit cards you created.")

        with self.assertRaises(NotPermitted) as ctx:
            svc.delete_card(actor=self.member, board=self.board, card=self.card)
        self.assertEqual(ctx.exception.detail, "You can only delete cards you created.")

        with self.assertRaises(NotPermitted) as ctx:
            svc.archive_card(
                actor=self.member, board=self.board, card_id=self.card.pk, render=_render,
            )
        self.assertEqual(ctx.exception.detail, "You can only archive cards you created.")

    def test_assignee_denial_message_differs_when_assigning(self):
        """Supplying ``assignee_id`` changes the denial wording, because that is
        the common case and the entitlement it needs is worth naming."""
        with self.assertRaises(NotPermitted) as ctx:
            svc.update_card(
                actor=self.member, board=self.board, card=self.card,
                submitted={"assignee_id": self.member.pk}, apply=lambda: None,
                render=_render,
            )
        self.assertEqual(
            ctx.exception.detail,
            "Assigning cards requires Moderator or Admin access — ask a board admin.",
        )


class WipEnforcementTests(CardServiceTestBase):
    def test_soft_limit_blocks_with_counters(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.col_b.wip_limit = 2
        self.col_b.save(update_fields=["wip_limit"])
        self._fill(self.col_b, 2)

        with self.assertRaises(WipLimitExceeded) as ctx:
            self._move()
        self.assertEqual(ctx.exception.column_name, "B")
        self.assertEqual(ctx.exception.current_count, 2)
        self.assertEqual(ctx.exception.wip_limit, 2)
        # Nothing moved.
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_a.pk)

    def test_admin_may_force_past_a_soft_limit(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.col_b.wip_limit = 1
        self.col_b.save(update_fields=["wip_limit"])
        self._fill(self.col_b, 1)

        self._move(force=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_member_may_not_force_past_a_soft_limit(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.col_b.wip_limit = 1
        self.col_b.save(update_fields=["wip_limit"])
        self._fill(self.col_b, 1)
        self.card.created_by = self.member
        self.card.save(update_fields=["created_by"])

        with self.assertRaises(ForceNotPermitted) as ctx:
            self._move(actor=self.member, force=True)
        self.assertEqual(ctx.exception.limit, "wip")

    def test_hard_mode_cannot_be_forced_by_anyone(self):
        """Hard WIP is evaluated before ``force`` is consulted at all.

        The regression this guards against is reordering the two checks, which
        would silently hand board admins an override that hard mode exists
        specifically to deny.
        """
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.col_b.wip_limit = 1
        self.col_b.save(update_fields=["wip_limit"])
        self._fill(self.col_b, 1)

        # Board owner — the highest role available — with force=True.
        with self.assertRaises(WipHardBlocked) as ctx:
            self._move(force=True)
        self.assertEqual(ctx.exception.wip_limit, 1)
        self.assertEqual(ctx.exception.current_count, 1)

    def test_hard_mode_applies_even_when_soft_enforcement_is_off(self):
        self.board.enforce_wip_limits = False
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_limits", "enforce_wip_hard"])
        self.col_b.wip_limit = 0
        self.col_b.save(update_fields=["wip_limit"])
        with self.assertRaises(WipHardBlocked):
            self._move()

    def test_pure_reorder_is_exempt_from_the_limit(self):
        """Position changes inside one cell do not enter a column, so the limit
        must not apply — otherwise a full column could never be reordered."""
        self.board.enforce_wip_limits = True
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_limits", "enforce_wip_hard"])
        self.col_a.wip_limit = 1
        self.col_a.save(update_fields=["wip_limit"])
        self._fill(self.col_a, 3)

        self._move(target_column_id=self.col_a.pk, position=2)
        self.card.refresh_from_db()
        self.assertEqual(self.card.position, 2)

    def test_limit_is_not_enforced_when_the_board_setting_is_off(self):
        """A column may carry a wip_limit while the board has enforcement off.

        Note ``enforce_wip_limits`` defaults to **True** on a new board, so this
        has to switch it off explicitly — the permissive case is the configured
        one, not the default one.
        """
        self.board.enforce_wip_limits = False
        self.board.enforce_wip_hard = False
        self.board.save(update_fields=["enforce_wip_limits", "enforce_wip_hard"])
        self.col_b.wip_limit = 0
        self.col_b.save(update_fields=["wip_limit"])
        self._move()
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_archived_cards_do_not_count_toward_the_limit(self):
        self.board.enforce_wip_limits = True
        self.board.save(update_fields=["enforce_wip_limits"])
        self.col_b.wip_limit = 1
        self.col_b.save(update_fields=["wip_limit"])
        filler = self._fill(self.col_b, 1)[0]
        filler.archived_at = timezone.now()
        filler.save(update_fields=["archived_at"])

        self._move()
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)


class WeightEnforcementTests(CardServiceTestBase):
    def setUp(self):
        super().setUp()
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.col_b.weight_limit = 5
        self.col_b.save(update_fields=["weight_limit"])

    def test_limit_blocks_with_counters(self):
        self._fill(self.col_b, 1, weight=4)
        self.card.weight = 3
        self.card.save(update_fields=["weight"])

        with self.assertRaises(WeightLimitExceeded) as ctx:
            self._move()
        self.assertEqual(ctx.exception.current_weight, 4)
        self.assertEqual(ctx.exception.weight_limit, 5)
        self.assertEqual(ctx.exception.card_weight, 3)

    def test_move_that_exactly_reaches_the_limit_is_allowed(self):
        """The check is ``current + card > limit``, so landing exactly on the
        limit must succeed."""
        self._fill(self.col_b, 1, weight=2)
        self.card.weight = 3
        self.card.save(update_fields=["weight"])
        self._move()
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_admin_may_force_past_the_limit(self):
        self._fill(self.col_b, 1, weight=5)
        self.card.weight = 3
        self.card.save(update_fields=["weight"])
        self._move(force=True)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_member_may_not_force_past_the_limit(self):
        self._fill(self.col_b, 1, weight=5)
        self.card.weight = 3
        self.card.created_by = self.member
        self.card.save(update_fields=["weight", "created_by"])
        with self.assertRaises(ForceNotPermitted) as ctx:
            self._move(actor=self.member, force=True)
        self.assertEqual(ctx.exception.limit, "weight")


class VersionConflictTests(CardServiceTestBase):
    def test_stale_version_is_rejected_and_reports_the_current_one(self):
        self.card.refresh_from_db()
        with self.assertRaises(VersionConflict) as ctx:
            self._move(expected_version=self.card.version + 3)
        self.assertEqual(ctx.exception.current_version, self.card.version)

    def test_matching_version_is_accepted(self):
        self.card.refresh_from_db()
        self._move(expected_version=self.card.version)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_omitting_the_version_skips_the_check(self):
        """Optimistic concurrency is opt-in for backward compatibility."""
        self._move(expected_version=None)
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_a_non_integer_version_is_rejected(self):
        with self.assertRaises(InvalidVersion):
            self._move(expected_version="not-a-number")

    def test_a_numeric_string_version_is_accepted(self):
        """The coercion is int(), so a JSON string of digits still works — a
        client that round-trips the version as text keeps working."""
        self.card.refresh_from_db()
        self._move(expected_version=str(self.card.version))
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)

    def test_role_and_lookup_are_checked_before_the_version_is_coerced(self):
        """Ordering is contract, not taste.

        A caller who fails the role allow-list, names a card that does not
        exist, or fails the assignment gate must see *that* answer, even when
        they also sent a malformed version. This is why the coercion lives in
        the service rather than in the adapter.
        """
        with self.assertRaises(NotPermitted):
            self._move(actor=self.viewer, expected_version="garbage")
        with self.assertRaises(CardNotFound):
            self._move(card_id=999999, expected_version="garbage")

        self.card.assignee = self.owner
        self.card.created_by = self.owner
        self.card.save(update_fields=["assignee", "created_by"])
        with self.assertRaises(MoveNotPermitted):
            self._move(actor=self.member, expected_version="garbage")

    def test_move_bumps_the_version(self):
        before = Card.objects.get(pk=self.card.pk).version
        self._move()
        self.assertEqual(Card.objects.get(pk=self.card.pk).version, before + 1)


class CrossBoardRejectionTests(CardServiceTestBase):
    """A row on another board is rejected as *not found*, never as forbidden.

    Answering 403 would confirm that an id the caller guessed exists somewhere
    they cannot see, which is the IDOR this project treats as a security bug.
    """

    def setUp(self):
        super().setUp()
        self.other_owner = _make_user("svc_other_owner")
        self.other_board = _make_board(self.other_owner, name="Other")
        self.other_col = _make_column(self.other_board, "OC", 0)
        self.other_lane = _make_swimlane(self.other_board, "OL", 0)
        self.other_card = _make_card(self.other_col, self.other_lane, title="Foreign")

    def test_move_to_a_foreign_column_is_rejected(self):
        with self.assertRaises(ColumnNotFound):
            self._move(target_column_id=self.other_col.pk)

    def test_move_to_a_foreign_swimlane_is_rejected(self):
        with self.assertRaises(SwimlaneNotFound):
            self._move(target_swimlane_id=self.other_lane.pk)

    def test_moving_a_foreign_card_is_rejected(self):
        with self.assertRaises(CardNotFound):
            self._move(card_id=self.other_card.pk)

    def test_creating_into_a_foreign_column_is_rejected(self):
        with self.assertRaises(ColumnNotFound):
            svc.create_card(
                actor=self.owner, board=self.board, column_id=self.other_col.pk,
                swimlane_id=self.lane.pk, save=lambda position: None, render=_render,
            )

    def test_creating_into_a_foreign_swimlane_is_rejected(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])
        with self.assertRaises(SwimlaneNotFound):
            svc.create_card(
                actor=self.owner, board=self.board, column_id=self.col_a.pk,
                swimlane_id=self.other_lane.pk, save=lambda position: None, render=_render,
            )

    def test_archiving_a_foreign_card_is_rejected(self):
        with self.assertRaises(CardNotFound):
            svc.archive_card(
                actor=self.owner, board=self.board, card_id=self.other_card.pk,
                render=_render,
            )

    def test_a_nonexistent_card_is_rejected(self):
        with self.assertRaises(CardNotFound):
            self._move(card_id=999999)


class UpdateInvariantTests(CardServiceTestBase):
    def test_changing_the_column_is_rejected_at_the_service_boundary(self):
        """#1106 must be unreachable for a direct caller too.

        The guard lives in the service rather than in the view precisely so a
        future MCP write tool passing a ``column`` field cannot reintroduce the
        bug class the view-level check fixed.
        """
        with self.assertRaises(UseMoveEndpoint) as ctx:
            svc.update_card(
                actor=self.owner, board=self.board, card=self.card,
                submitted={"column": self.col_b.pk}, apply=lambda: None, render=_render,
            )
        self.assertEqual(ctx.exception.field_name, "column")

    def test_changing_the_swimlane_is_rejected(self):
        other_lane = _make_swimlane(self.board, "L2", 1)
        with self.assertRaises(UseMoveEndpoint):
            svc.update_card(
                actor=self.owner, board=self.board, card=self.card,
                submitted={"swimlane": other_lane.pk}, apply=lambda: None, render=_render,
            )

    def test_echoing_back_the_current_column_is_accepted(self):
        """A client that round-trips the representation it was given must keep
        working — required by the 1.0 backward-compatibility contract."""
        svc.update_card(
            actor=self.owner, board=self.board, card=self.card,
            submitted={"column": self.card.column_id}, apply=lambda: None, render=_render,
        )

    def test_an_archived_card_cannot_be_updated(self):
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        with self.assertRaises(CardNotFound):
            svc.update_card(
                actor=self.owner, board=self.board, card=self.card,
                submitted={"title": "x"}, apply=lambda: None, render=_render,
            )

    def test_an_archived_card_cannot_be_deleted(self):
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        with self.assertRaises(CardNotFound):
            svc.delete_card(actor=self.owner, board=self.board, card=self.card)

    def test_update_records_an_activity_row_and_bumps_the_version(self):
        before = Card.objects.get(pk=self.card.pk).version

        def apply():
            self.card.priority = "high"
            self.card.save(update_fields=["priority"])

        svc.update_card(
            actor=self.owner, board=self.board, card=self.card,
            submitted={"priority": "high"}, apply=apply, render=_render,
        )
        self.assertEqual(Card.objects.get(pk=self.card.pk).version, before + 1)
        activity = CardActivity.objects.get(
            card=self.card, event_type=CardActivity.EventType.PRIORITY_CHANGE,
        )
        self.assertEqual(activity.to_value, "high")

    def test_a_title_change_the_caller_did_not_submit_records_no_activity(self):
        """``submitted`` gates title and description so a partial write cannot
        produce a spurious activity row."""
        def apply():
            self.card.title = "changed by something else"
            self.card.save(update_fields=["title"])

        svc.update_card(
            actor=self.owner, board=self.board, card=self.card,
            submitted={}, apply=apply, render=_render,
        )
        self.assertFalse(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.TITLE_CHANGE,
            ).exists()
        )


class CreateInvariantTests(CardServiceTestBase):
    def test_creation_is_refused_in_a_column_that_disallows_it(self):
        self.assertFalse(self.col_a.allow_card_creation)
        with self.assertRaises(CardCreationNotAllowed):
            svc.create_card(
                actor=self.owner, board=self.board, column_id=self.col_a.pk,
                swimlane_id=self.lane.pk, save=lambda position: None, render=_render,
            )

    def test_new_card_lands_at_the_end_of_its_cell(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])
        self._fill(self.col_a, 3)  # plus self.card == 4 cards in the cell

        captured = {}

        def save(position):
            captured["position"] = position
            return Card.objects.create(
                board=self.board, column=self.col_a, swimlane=self.lane,
                title="new", created_by=self.owner, position=position,
            )

        result = svc.create_card(
            actor=self.owner, board=self.board, column_id=self.col_a.pk,
            swimlane_id=self.lane.pk, save=save, render=_render,
        )
        self.assertEqual(captured["position"], 4)
        self.assertEqual(result.card.position, 4)

    def test_creation_writes_an_opening_movement_row(self):
        self.col_a.allow_card_creation = True
        self.col_a.save(update_fields=["allow_card_creation"])

        def save(position):
            return Card.objects.create(
                board=self.board, column=self.col_a, swimlane=self.lane,
                title="new", created_by=self.owner, position=position,
            )

        result = svc.create_card(
            actor=self.owner, board=self.board, column_id=self.col_a.pk,
            swimlane_id=self.lane.pk, save=save, render=_render,
        )
        movement = CardMovement.objects.get(card=result.card)
        self.assertIsNone(movement.from_column)
        self.assertEqual(movement.to_column_id, self.col_a.pk)
        self.assertEqual(movement.notes, "Card created")


class PositionBookkeepingTests(CardServiceTestBase):
    def test_source_cell_is_compacted_and_target_cell_shifted(self):
        others = self._fill(self.col_a, 3)  # positions 0,1,2 alongside self.card
        # Give the source cell a deterministic layout: self.card at 0, then 1..3.
        for i, c in enumerate(others, start=1):
            c.position = i
            c.save(update_fields=["position"])
        target = self._fill(self.col_b, 2)

        self._move(position=1)

        # Source cell closed the gap the moved card left at position 0.
        self.assertEqual(
            [c.position for c in Card.objects.filter(
                column=self.col_a, swimlane=self.lane).order_by("pk")],
            [0, 1, 2],
        )
        # Target cell made room at position 1.
        target_positions = sorted(
            Card.objects.filter(column=self.col_b, swimlane=self.lane)
            .values_list("position", flat=True)
        )
        self.assertEqual(target_positions, [0, 1, 2])
        self.card.refresh_from_db()
        self.assertEqual(self.card.position, 1)
        self.assertEqual(
            Card.objects.get(pk=target[1].pk).position, 2,
            "the card previously at position 1 should have shifted down",
        )

    def test_a_cross_cell_move_writes_a_movement_row(self):
        result = self._move()
        self.assertIsNotNone(result.movement)
        self.assertEqual(result.movement.from_column_id, self.col_a.pk)
        self.assertEqual(result.movement.to_column_id, self.col_b.pk)

    def test_a_pure_reorder_writes_no_movement_row(self):
        """Reordering inside one cell is not a movement, so the audit trail must
        not record one — otherwise drag-to-reorder floods the history."""
        self._fill(self.col_a, 3)
        result = self._move(target_column_id=self.col_a.pk, position=2)
        self.assertIsNone(result.movement)
        self.assertEqual(CardMovement.objects.filter(card=self.card).count(), 0)

    def test_a_swimlane_only_move_writes_a_movement_row(self):
        other_lane = _make_swimlane(self.board, "L2", 1)
        result = self._move(
            target_column_id=self.col_a.pk, target_swimlane_id=other_lane.pk,
        )
        self.assertIsNotNone(result.movement)
        self.assertEqual(result.movement.from_swimlane_id, self.lane.pk)
        self.assertEqual(result.movement.to_swimlane_id, other_lane.pk)


class ArchiveInvariantTests(CardServiceTestBase):
    def test_archive_stamps_the_card_and_records_a_movement(self):
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        self.card.refresh_from_db()
        self.assertIsNotNone(self.card.archived_at)
        movement = CardMovement.objects.get(card=self.card)
        self.assertEqual(movement.movement_type, CardMovement.MovementType.ARCHIVED)

    def test_archiving_twice_is_a_no_op_that_broadcasts_once(self):
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        self.assertEqual(
            CardMovement.objects.filter(
                card=self.card, movement_type=CardMovement.MovementType.ARCHIVED,
            ).count(),
            1,
        )

    def test_unarchive_clears_the_stamp_and_records_a_restore(self):
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        svc.unarchive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        self.card.refresh_from_db()
        self.assertIsNone(self.card.archived_at)
        self.assertTrue(
            CardMovement.objects.filter(
                card=self.card, movement_type=CardMovement.MovementType.UNARCHIVED,
            ).exists()
        )

    def test_unarchiving_a_live_card_is_a_no_op(self):
        result = svc.unarchive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        self.assertIsNotNone(result.payload)
        self.assertFalse(CardMovement.objects.filter(card=self.card).exists())

    def test_archived_cards_can_still_be_moved(self):
        """Archiving does not freeze a card's position, and the move endpoint
        reads through the unfiltered manager — pinned so the new archived-card
        guards on update/delete are not over-applied to move."""
        self.card.archived_at = timezone.now()
        self.card.save(update_fields=["archived_at"])
        self._move()
        self.card.refresh_from_db()
        self.assertEqual(self.card.column_id, self.col_b.pk)


class DeleteInvariantTests(CardServiceTestBase):
    def test_delete_removes_the_row(self):
        card_id = self.card.pk
        svc.delete_card(actor=self.owner, board=self.board, card=self.card)
        self.assertFalse(Card.objects.filter(pk=card_id).exists())


class SideEffectTests(CardServiceTestBase):
    """Broadcasts and hooks must fire for a direct caller, not just over HTTP.

    This is the whole justification for the extraction: a second consumer gets
    the real-time updates and the enterprise audit hook for free, rather than
    having to remember to wire them.
    """

    def setUp(self):
        super().setUp()
        self.events = []
        self._recorder = lambda event, c, b, a: self.events.append((event, c, b, a))
        hooks.CARD_MUTATION_HOOKS.append(self._recorder)

    def tearDown(self):
        hooks.CARD_MUTATION_HOOKS.remove(self._recorder)
        super().tearDown()

    def test_move_broadcasts_and_fires_the_hook(self):
        with self.captureOnCommitCallbacks(execute=True):
            self._move()
        self.assertEqual(self.events, [
            ("card.moved", self.card.pk, self.board.pk, self.owner.pk),
        ])
        self.broadcast.assert_called_once()
        board_id, event, payload = self.broadcast.call_args[0]
        self.assertEqual((board_id, event), (self.board.pk, "card.moved"))
        self.assertTrue(payload["movement"])

    def test_archive_broadcasts_only_the_card_uid(self):
        """The archive event payload is deliberately not the whole card — a
        client only needs to drop it from the board view. Frozen event schema."""
        with self.captureOnCommitCallbacks(execute=True):
            svc.archive_card(
                actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
            )
        board_id, event, payload = self.broadcast.call_args[0]
        self.assertEqual(event, "card.archived")
        self.assertEqual(payload, {"card_uid": self.card.uid})

    def test_unarchive_broadcasts_card_unarchived_but_hooks_card_restored(self):
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
        )
        self.events.clear()
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            svc.unarchive_card(
                actor=self.owner, board=self.board, card_id=self.card.pk, render=_render,
            )
        self.assertEqual(self.broadcast.call_args[0][1], "card.unarchived")
        self.assertEqual([e[0] for e in self.events], ["card.restored"])

    def test_a_rejected_move_broadcasts_nothing_and_fires_no_hook(self):
        self.board.enforce_wip_hard = True
        self.board.save(update_fields=["enforce_wip_hard"])
        self.col_b.wip_limit = 0
        self.col_b.save(update_fields=["wip_limit"])

        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(WipHardBlocked):
                self._move()
        self.assertEqual(self.events, [])
        self.broadcast.assert_not_called()

    def test_side_effects_are_deferred_until_commit(self):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self._move()
        self.assertEqual(self.events, [])
        self.broadcast.assert_not_called()
        self.assertTrue(callbacks)
        for cb in callbacks:
            cb()
        self.assertEqual([e[0] for e in self.events], ["card.moved"])
        self.broadcast.assert_called_once()

    def test_a_failed_move_rolls_back_any_partial_shift(self):
        """A weight rejection must leave the source and target cells untouched.

        The service owns the transaction, so an error raised mid-way rolls back
        any position shifting it had already done.
        """
        self.board.enforce_weight_limits = True
        self.board.save(update_fields=["enforce_weight_limits"])
        self.col_b.weight_limit = 1
        self.col_b.save(update_fields=["weight_limit"])
        self._fill(self.col_b, 1, weight=1)
        others = self._fill(self.col_a, 2)
        before = {c.pk: c.position for c in Card.objects.all()}

        with self.assertRaises(WeightLimitExceeded):
            self._move()

        after = {c.pk: c.position for c in Card.objects.all()}
        self.assertEqual(before, after)
        self.assertTrue(others)  # fixture sanity
