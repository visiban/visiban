"""Manual blocked state on cards — block, unblock, history, RBAC, broadcast (#1149).

Grouped by the thing that can break:

* ``BlockServiceTests`` — what one block / unblock writes: the ``CardBlock``
  row, the denormalized card fields, the activity rows and the version bump.
* ``BlockApiTests`` — the REST adapter: validation at the boundary, the 409
  codes, the read-only serializer fields, the history endpoint.
* ``BlockRbacTests`` — who may block. A missing check here is a security
  defect: viewers and collaborators are read-only for card state, a member
  follows the edit (ownership) rule, and a card on another board is a 404.
* ``BlockBroadcastTests`` — ``card.updated`` carries the additive fields and
  is published only after commit.
* ``BlockedUnionTests`` — ``is_blocked`` and ``?blocked=`` are the union of
  manual and relation (#449) blocks.
* ``BlockAnalyticsTests`` — Summary's per-swimlane count and Analytics'
  blocked time per column and top reasons.
* ``BlockExportImportTests`` — the JSON round trip keeps who, when and why.
"""

import datetime
import io
import json
from unittest.mock import patch

from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import Board, Card, CardActivity, CardBlock, CardRelation
from boards.serializers import CardSerializer, SavedFilterSerializer, _card_queryset
from boards.services import cards as card_services
from boards.services.errors import CardAlreadyBlocked, CardNotBlocked, CardNotFound, NotPermitted
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane, _make_user,
)


def _render(card):
    """A minimal render callback for direct service calls."""
    return {"id": card.id, "version": card.version}


class _BlockTestBase(TestCase):
    """A board with two columns, one lane, two cards and an admin client."""

    def setUp(self):
        self.owner = _make_user("blk_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board, name="Doing")
        self.col2 = _make_column(self.board, name="Review", order=1)
        self.lane = _make_swimlane(self.board)
        self.card = _make_card(self.col, self.lane, title="Waiting card")
        self.other = _make_card(self.col, self.lane, title="Other card", position=1)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = patcher.start()
        self.addCleanup(patcher.stop)

    def _url(self, card, action):
        return f"/api/v1/boards/{self.board.id}/cards/{card.id}/{action}/"

    def _block(self, card=None, reason="Waiting on customer", client=None):
        return (client or self.client).post(
            self._url(card or self.card, "block"), {"reason": reason}, format="json",
        )

    def _unblock(self, card=None, resolution=None, client=None):
        body = {} if resolution is None else {"resolution": resolution}
        return (client or self.client).post(
            self._url(card or self.card, "unblock"), body, format="json",
        )


class BlockServiceTests(_BlockTestBase):

    def test_block_writes_open_row_card_fields_activity_and_bumps_version(self):
        before = self.card.version
        result = card_services.block_card(
            actor=self.owner, board=self.board, card_id=self.card.id,
            reason="Waiting on customer", render=_render,
        )
        self.card.refresh_from_db()
        self.assertIsNotNone(self.card.blocked_at)
        self.assertEqual(self.card.blocked_reason, "Waiting on customer")
        self.assertEqual(self.card.version, before + 1)
        self.assertEqual(result.payload["version"], before + 1)

        block = CardBlock.objects.get(card=self.card)
        self.assertEqual(block.blocked_by, self.owner)
        self.assertEqual(block.reason, "Waiting on customer")
        self.assertIsNone(block.unblocked_at)
        self.assertEqual(block.blocked_at, self.card.blocked_at)
        self.assertEqual(block.board_id, self.board.id)
        self.assertEqual(block.column, self.col)
        self.assertEqual(block.column_name, "Doing")
        self.assertEqual(block.column_uid, self.col.uid)
        self.assertEqual(block.card_uid, self.card.uid)
        self.assertEqual(block.card_title, "Waiting card")

        activity = CardActivity.objects.get(card=self.card, event_type=CardActivity.EventType.BLOCKED)
        self.assertEqual(activity.to_value, "Waiting on customer")
        self.assertEqual(activity.actor, self.owner)

    def test_unblock_closes_row_clears_fields_and_records_resolution(self):
        card_services.block_card(
            actor=self.owner, board=self.board, card_id=self.card.id,
            reason="Vendor outage", render=_render,
        )
        self.card.refresh_from_db()
        blocked_version = self.card.version
        card_services.unblock_card(
            actor=self.owner, board=self.board, card_id=self.card.id,
            resolution="Vendor restored service", render=_render,
        )
        self.card.refresh_from_db()
        self.assertIsNone(self.card.blocked_at)
        self.assertEqual(self.card.blocked_reason, "")
        self.assertEqual(self.card.version, blocked_version + 1)

        block = CardBlock.objects.get(card=self.card)
        self.assertIsNotNone(block.unblocked_at)
        self.assertEqual(block.unblocked_by, self.owner)
        self.assertEqual(block.resolution, "Vendor restored service")
        self.assertGreaterEqual(block.unblocked_at, block.blocked_at)

        activity = CardActivity.objects.get(card=self.card, event_type=CardActivity.EventType.UNBLOCKED)
        self.assertEqual(activity.from_value, "Vendor outage")
        self.assertEqual(activity.to_value, "Vendor restored service")

    def test_second_block_after_unblock_opens_a_new_row(self):
        for reason in ("First", "Second"):
            card_services.block_card(
                actor=self.owner, board=self.board, card_id=self.card.id, reason=reason, render=_render,
            )
            card_services.unblock_card(
                actor=self.owner, board=self.board, card_id=self.card.id, render=_render,
            )
        self.assertEqual(CardBlock.objects.filter(card=self.card).count(), 2)
        self.assertFalse(CardBlock.objects.filter(card=self.card, unblocked_at__isnull=True).exists())

    def test_block_already_blocked_raises_and_writes_nothing(self):
        card_services.block_card(
            actor=self.owner, board=self.board, card_id=self.card.id, reason="A", render=_render,
        )
        with self.assertRaises(CardAlreadyBlocked):
            card_services.block_card(
                actor=self.owner, board=self.board, card_id=self.card.id, reason="B", render=_render,
            )
        self.assertEqual(CardBlock.objects.filter(card=self.card).count(), 1)
        self.card.refresh_from_db()
        self.assertEqual(self.card.blocked_reason, "A")

    def test_unblock_not_blocked_raises(self):
        with self.assertRaises(CardNotBlocked):
            card_services.unblock_card(
                actor=self.owner, board=self.board, card_id=self.card.id, render=_render,
            )
        self.assertFalse(CardActivity.objects.filter(card=self.card).exists())

    def test_archived_card_cannot_be_blocked(self):
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        with self.assertRaises(CardNotFound):
            card_services.block_card(
                actor=self.owner, board=self.board, card_id=self.card.id, reason="A", render=_render,
            )

    def test_one_open_block_per_card_is_enforced_by_the_database(self):
        """The backstop for the under-lock check: a second open row is refused."""
        CardBlock.objects.create(card=self.card, board=self.board, reason="A")
        with self.assertRaises(IntegrityError), transaction.atomic():
            CardBlock.objects.create(card=self.card, board=self.board, reason="B")
        # Closed rows are unconstrained.
        CardBlock.objects.create(card=self.card, board=self.board, reason="C", unblocked_at=timezone.now())

    def test_hard_delete_keeps_block_history_with_snapshot(self):
        card_services.block_card(
            actor=self.owner, board=self.board, card_id=self.card.id, reason="A", render=_render,
        )
        uid = self.card.uid
        Card.objects.get(pk=self.card.pk).delete()
        block = CardBlock.objects.get(card_uid=uid)
        self.assertIsNone(block.card_id)
        self.assertEqual(block.card_title, "Waiting card")
        self.assertEqual(block.board_id, self.board.id)

    def test_board_delete_removes_blocks(self):
        card_services.block_card(
            actor=self.owner, board=self.board, card_id=self.card.id, reason="A", render=_render,
        )
        Board.objects.filter(pk=self.board.pk).delete()
        self.assertFalse(CardBlock.objects.exists())

    def test_block_rolls_back_when_render_fails(self):
        """Render runs inside the transaction, so a failure leaves no half-block."""
        def _boom(card):
            raise RuntimeError("render failed")

        with self.assertRaises(RuntimeError):
            card_services.block_card(
                actor=self.owner, board=self.board, card_id=self.card.id, reason="A", render=_boom,
            )
        self.card.refresh_from_db()
        self.assertIsNone(self.card.blocked_at)
        self.assertFalse(CardBlock.objects.exists())
        self.assertFalse(CardActivity.objects.exists())


class BlockApiTests(_BlockTestBase):

    def test_block_returns_the_card_with_blocked_fields(self):
        resp = self._block(reason="  Waiting on legal  ")
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        self.assertTrue(resp.data["is_blocked"])
        self.assertEqual(resp.data["blocked_reason"], "Waiting on legal")  # trimmed at the boundary
        self.assertIsNotNone(resp.data["blocked_at"])
        self.assertEqual(resp.data["id"], self.card.id)

    def test_unblock_returns_the_card_cleared(self):
        self._block()
        resp = self._unblock(resolution="Customer replied")
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        self.assertFalse(resp.data["is_blocked"])
        self.assertIsNone(resp.data["blocked_at"])
        self.assertEqual(resp.data["blocked_reason"], "")

    def test_unblock_body_is_optional(self):
        self._block()
        resp = self.client.post(self._url(self.card, "unblock"))
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        self.assertEqual(CardBlock.objects.get(card=self.card).resolution, "")

    def test_reason_is_required(self):
        for body in ({}, {"reason": ""}, {"reason": "   "}):
            with self.subTest(body=body):
                resp = self.client.post(self._url(self.card, "block"), body, format="json")
                self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(resp.data["reason"], ["Enter a reason to block this card."])
        self.assertFalse(CardBlock.objects.exists())

    def test_reason_and_resolution_are_length_capped(self):
        resp = self._block(reason="x" * 501)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self._block(reason="x" * 500).status_code, status.HTTP_200_OK)
        resp = self._unblock(resolution="y" * 501)
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Card.objects.get(pk=self.card.pk).blocked_at)

    def test_reason_with_nul_is_a_400_not_a_500(self):
        resp = self._block(reason="bad\x00reason")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_block_twice_is_409_with_code(self):
        self._block()
        resp = self._block(reason="again")
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.data["code"], "card_already_blocked")

    def test_unblock_not_blocked_is_409_with_code(self):
        resp = self._unblock()
        self.assertEqual(resp.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(resp.data["code"], "card_not_blocked")

    def test_archived_card_is_404(self):
        Card.objects.filter(pk=self.card.pk).update(archived_at=timezone.now())
        self.assertEqual(self._block().status_code, status.HTTP_404_NOT_FOUND)

    def test_patch_cannot_set_blocked_fields(self):
        """Read-only on the serializer: a PATCH would skip the CardBlock row."""
        resp = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/",
            {"blocked_at": "2026-01-01T00:00:00Z", "blocked_reason": "sneaky", "title": "New"},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        self.card.refresh_from_db()
        self.assertIsNone(self.card.blocked_at)
        self.assertEqual(self.card.blocked_reason, "")
        self.assertEqual(self.card.title, "New")

    def test_patch_after_block_keeps_block_state(self):
        """update_card saves every column; it must write the locked block state back."""
        self._block(reason="Hold")
        resp = self.client.patch(
            f"/api/v1/boards/{self.board.id}/cards/{self.card.id}/", {"title": "Renamed"}, format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(resp.data["blocked_reason"], "Hold")
        self.assertTrue(resp.data["is_blocked"])

    def test_blocks_history_lists_newest_first_with_duration(self):
        self._block(reason="First")
        self._unblock(resolution="Done")
        self._block(reason="Second")
        resp = self.client.get(self._url(self.card, "blocks"))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual([b["reason"] for b in resp.data], ["Second", "First"])
        first = resp.data[1]
        self.assertEqual(first["resolution"], "Done")
        self.assertEqual(first["blocked_by"]["username"], "blk_owner")
        self.assertEqual(first["unblocked_by"]["username"], "blk_owner")
        self.assertEqual(first["column_name"], "Doing")
        self.assertIsInstance(first["duration_seconds"], int)
        self.assertIsNone(resp.data[0]["unblocked_at"])

    def test_duration_seconds_measures_to_unblock(self):
        start = timezone.now() - datetime.timedelta(hours=5)
        CardBlock.objects.create(
            card=self.card, board=self.board, reason="Old", blocked_at=start,
            unblocked_at=start + datetime.timedelta(hours=2),
        )
        resp = self.client.get(self._url(self.card, "blocks"))
        self.assertEqual(resp.data[0]["duration_seconds"], 7200)

    def test_card_payload_carries_blocked_fields_on_full(self):
        self._block(reason="Hold")
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        cards = {c["id"]: c for c in resp.data["cards"]}
        self.assertEqual(cards[self.card.id]["blocked_reason"], "Hold")
        self.assertTrue(cards[self.card.id]["is_blocked"])
        self.assertFalse(cards[self.other.id]["is_blocked"])
        self.assertIsNone(cards[self.other.id]["blocked_at"])


class BlockRbacTests(_BlockTestBase):

    def _client_for(self, role):
        user = _make_user(f"blk_{role}")
        _make_membership(self.board, user, role=role)
        client = APIClient()
        client.force_authenticate(user)
        return user, client

    def test_viewer_cannot_block_or_unblock(self):
        _, viewer = self._client_for("viewer")
        self.assertEqual(self._block(client=viewer).status_code, status.HTTP_403_FORBIDDEN)
        self._block()
        self.assertEqual(self._unblock(client=viewer).status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Card.objects.get(pk=self.card.pk).blocked_at)

    def test_viewer_403_comes_before_body_validation(self):
        _, viewer = self._client_for("viewer")
        resp = viewer.post(self._url(self.card, "block"), {}, format="json")
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    def test_collaborator_cannot_block(self):
        _, collaborator = self._client_for("collaborator")
        self.assertEqual(self._block(client=collaborator).status_code, status.HTTP_403_FORBIDDEN)

    def test_member_can_block_own_card_but_not_others(self):
        member, client = self._client_for("member")
        own = _make_card(self.col, self.lane, title="Mine", created_by=member, position=2)
        self.assertEqual(self._block(card=own, client=client).status_code, status.HTTP_200_OK)
        self.assertEqual(self._unblock(card=own, client=client).status_code, status.HTTP_200_OK)
        resp = self._block(client=client)
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(resp.data["detail"], "You can only block cards you created.")

    def test_service_refuses_viewer_directly(self):
        viewer, _ = self._client_for("viewer")
        with self.assertRaises(NotPermitted):
            card_services.block_card(
                actor=viewer, board=self.board, card_id=self.card.id, reason="A", render=_render,
            )

    def test_viewer_can_read_block_history(self):
        self._block()
        _, viewer = self._client_for("viewer")
        resp = viewer.get(self._url(self.card, "blocks"))
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(len(resp.data), 1)

    def test_non_member_gets_404(self):
        stranger = _make_user("blk_stranger")
        client = APIClient()
        client.force_authenticate(stranger)
        self.assertEqual(self._block(client=client).status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(client.get(self._url(self.card, "blocks")).status_code, status.HTTP_404_NOT_FOUND)

    def test_cross_board_card_id_is_404(self):
        """IDOR: a card on a board the caller administers is not reachable through another board."""
        other_board = _make_board(self.owner, name="Other")
        other_card = _make_card(_make_column(other_board), _make_swimlane(other_board), title="Theirs")
        url = f"/api/v1/boards/{self.board.id}/cards/{other_card.id}/"
        for action in ("block", "unblock"):
            with self.subTest(action=action):
                resp = self.client.post(f"{url}{action}/", {"reason": "x"}, format="json")
                self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(self.client.get(f"{url}blocks/").status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(CardBlock.objects.exists())

    def test_unauthenticated_is_rejected(self):
        resp = APIClient().post(self._url(self.card, "block"), {"reason": "x"}, format="json")
        self.assertIn(resp.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN))


class BlockBroadcastTests(_BlockTestBase):

    def test_block_broadcasts_card_updated_after_commit_with_fields(self):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            self._block(reason="Hold")
            # Deferred: nothing is published until the transaction commits.
            self.broadcast.assert_not_called()
        for cb in callbacks:
            cb()
        events = [c.args[1] for c in self.broadcast.call_args_list]
        self.assertEqual(events, ["card.updated"])
        payload = self.broadcast.call_args_list[0].args[2]
        self.assertEqual(payload["id"], self.card.id)
        self.assertTrue(payload["is_blocked"])
        self.assertEqual(payload["blocked_reason"], "Hold")
        self.assertIsNotNone(payload["blocked_at"])
        # A complete card, so clients can replace it wholesale.
        self.assertEqual(set(payload), set(CardSerializer().fields) - {"label_ids", "assignee_id"})

    def test_unblock_broadcasts_card_updated(self):
        self._block()
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self._unblock()
        payload = self.broadcast.call_args_list[0].args[2]
        self.assertEqual(self.broadcast.call_args_list[0].args[1], "card.updated")
        self.assertFalse(payload["is_blocked"])
        self.assertIsNone(payload["blocked_at"])

    def test_refused_block_broadcasts_nothing(self):
        self._block()
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self._block(reason="again")
        self.broadcast.assert_not_called()

    def test_block_fires_card_updated_hook(self):
        calls = []
        with patch("boards.hooks.CARD_MUTATION_HOOKS", [lambda *a: calls.append(a)]):
            with self.captureOnCommitCallbacks(execute=True):
                self._block()
        self.assertEqual(calls, [("card.updated", self.card.id, self.board.id, self.owner.id)])


class BlockedUnionTests(_BlockTestBase):

    def _payload(self, card):
        fresh = _card_queryset(Card.objects.filter(pk=card.pk)).get()
        return CardSerializer(fresh, context={"board": self.board}).data

    def test_is_blocked_covers_manual_and_relation_blocks(self):
        self.assertFalse(self._payload(self.card)["is_blocked"])
        CardRelation.objects.create(
            from_card=self.other, to_card=self.card, relation_type=CardRelation.Type.BLOCKS,
        )
        payload = self._payload(self.card)
        self.assertTrue(payload["is_blocked"])
        self.assertIsNone(payload["blocked_at"])  # relation only: no manual block

    def test_archived_blocker_does_not_count(self):
        CardRelation.objects.create(
            from_card=self.other, to_card=self.card, relation_type=CardRelation.Type.BLOCKS,
        )
        Card.objects.filter(pk=self.other.pk).update(archived_at=timezone.now())
        self.assertFalse(self._payload(self.card)["is_blocked"])

    def test_blocked_filter_returns_the_union(self):
        third = _make_card(self.col, self.lane, title="Relation blocked", position=2)
        CardRelation.objects.create(
            from_card=self.other, to_card=third, relation_type=CardRelation.Type.BLOCKS,
        )
        # Two blockers on one card must not duplicate it.
        CardRelation.objects.create(
            from_card=self.card, to_card=third, relation_type=CardRelation.Type.BLOCKS,
        )
        self._block()
        url = f"/api/v1/boards/{self.board.id}/cards/"
        blocked = {c["title"] for c in self.client.get(url, {"blocked": "true"}).data}
        self.assertEqual(blocked, {"Waiting card", "Relation blocked"})
        self.assertEqual(len(self.client.get(url, {"blocked": "true"}).data), 2)
        unblocked = {c["title"] for c in self.client.get(url, {"blocked": "false"}).data}
        self.assertEqual(unblocked, {"Other card"})

    def test_card_query_endpoint_carries_blocked_fields(self):
        self._block(reason="Hold")
        resp = self.client.get("/api/v1/cards/", {"board": self.board.id})
        self.assertEqual(resp.status_code, status.HTTP_200_OK, resp.data)
        rows = {c["id"]: c for c in resp.data["results"]}
        self.assertTrue(rows[self.card.id]["is_blocked"])
        self.assertEqual(rows[self.card.id]["blocked_reason"], "Hold")


class BlockAnalyticsTests(_BlockTestBase):

    def test_summary_counts_blocked_cards_per_swimlane(self):
        lane2 = _make_swimlane(self.board, name="Second", order=1)
        relation_blocked = _make_card(self.col, lane2, title="R")
        CardRelation.objects.create(
            from_card=self.other, to_card=relation_blocked, relation_type=CardRelation.Type.BLOCKS,
        )
        self._block()
        archived = _make_card(self.col, self.lane, title="Archived", position=3)
        Card.objects.filter(pk=archived.pk).update(
            archived_at=timezone.now(), blocked_at=timezone.now(), blocked_reason="x",
        )
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/summary/")
        rows = {r["name"]: r for r in resp.data["swimlanes"]}
        self.assertEqual(rows["General"]["blocked_cards"], 1)  # archived card excluded
        self.assertEqual(rows["Second"]["blocked_cards"], 1)

    def test_analytics_sums_blocked_time_per_column_and_clusters_reasons(self):
        now = timezone.now()
        # Closed, 2 days, in Doing.
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing",
            reason="Waiting on customer", blocked_at=now - datetime.timedelta(days=5),
            unblocked_at=now - datetime.timedelta(days=3),
        )
        # Open, 1 day, in Review; same reason with other case and spacing.
        CardBlock.objects.create(
            card=self.other, board=self.board, column=self.col2, column_name="Review",
            reason=" waiting on  CUSTOMER", blocked_at=now - datetime.timedelta(days=1),
        )
        # Started before the window: only the in-window part counts.
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing",
            reason="Vendor", blocked_at=now - datetime.timedelta(days=40),
            unblocked_at=now - datetime.timedelta(days=29),
        )
        # Ended before the window: excluded.
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing",
            reason="Ancient", blocked_at=now - datetime.timedelta(days=90),
            unblocked_at=now - datetime.timedelta(days=80),
        )
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/", {"days": 30})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        blocked = resp.data["blocked"]
        self.assertAlmostEqual(blocked["days_per_column"]["Doing"], 3.0, delta=0.1)
        self.assertAlmostEqual(blocked["days_per_column"]["Review"], 1.0, delta=0.1)
        self.assertEqual(blocked["blocks_per_column"], {"Doing": 2, "Review": 1})
        reasons = blocked["top_reasons"]
        self.assertEqual(reasons[0]["count"], 2)
        self.assertEqual(reasons[0]["reason"].casefold().split(), ["waiting", "on", "customer"])
        self.assertAlmostEqual(reasons[0]["total_days"], 3.0, delta=0.1)
        self.assertEqual([r["reason"] for r in reasons[1:]], ["Vendor"])

    def test_seconds_carry_sub_day_blocks(self):
        now = timezone.now()
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing", reason="Quick",
            blocked_at=now - datetime.timedelta(hours=3), unblocked_at=now - datetime.timedelta(hours=1),
        )
        blocked = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/").data["blocked"]
        self.assertAlmostEqual(blocked["seconds_per_column"]["Doing"], 7200, delta=5)
        self.assertEqual(blocked["seconds_per_column"]["Review"], 0)
        self.assertAlmostEqual(blocked["top_reasons"][0]["total_seconds"], 7200, delta=5)
        self.assertEqual(blocked["days_per_column"]["Doing"], 0.1)

    def test_future_timestamps_never_inflate_blocked_time(self):
        """An imported block can carry future times; they are clipped to now."""
        now = timezone.now()
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing", reason="Future end",
            blocked_at=now - datetime.timedelta(days=1), unblocked_at=now + datetime.timedelta(days=300),
        )
        CardBlock.objects.create(
            card=self.other, board=self.board, column=self.col, column_name="Doing", reason="Future start",
            blocked_at=now + datetime.timedelta(days=5), unblocked_at=now + datetime.timedelta(days=9),
        )
        blocked = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/").data["blocked"]
        self.assertAlmostEqual(blocked["days_per_column"]["Doing"], 1.0, delta=0.1)
        self.assertEqual(blocked["blocks_per_column"]["Doing"], 1)
        self.assertEqual([r["reason"] for r in blocked["top_reasons"]], ["Future end"])

    def test_open_block_of_deleted_card_is_left_out(self):
        CardBlock.objects.create(
            card=None, board=self.board, column=self.col, column_name="Doing", reason="Orphan",
            blocked_at=timezone.now() - datetime.timedelta(days=2),
        )
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/")
        self.assertEqual(resp.data["blocked"]["top_reasons"], [])
        self.assertEqual(resp.data["blocked"]["days_per_column"]["Doing"], 0.0)

    def test_open_block_on_archived_card_stops_at_archive(self):
        now = timezone.now()
        Card.objects.filter(pk=self.card.pk).update(archived_at=now - datetime.timedelta(days=2))
        CardBlock.objects.create(
            card=self.card, board=self.board, column=self.col, column_name="Doing", reason="Hold",
            blocked_at=now - datetime.timedelta(days=3),
        )
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/analytics/")
        self.assertAlmostEqual(resp.data["blocked"]["days_per_column"]["Doing"], 1.0, delta=0.1)


class BlockExportImportTests(_BlockTestBase):

    def _export(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.id}/export/?format=json")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        return json.loads(resp.content)

    def _import(self, data, options=None):
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        body = {"file": f}
        if options is not None:
            body["options"] = json.dumps(options)
        resp = self.client.post("/api/v1/boards/import/", body, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, getattr(resp, "data", resp.content))
        return Board.objects.get(pk=resp.data["id"])

    def _make_history(self):
        self._block(reason="First")
        self._unblock(resolution="Fixed")
        self._block(reason="Second")

    def test_export_carries_state_and_history(self):
        self._make_history()
        payload = self._export()
        self.assertEqual(payload["schema_version"], 2)  # additive
        card = next(c for c in payload["cards"] if c["title"] == "Waiting card")
        self.assertEqual(card["blocked_reason"], "Second")
        self.assertIsNotNone(card["blocked_at"])
        self.assertEqual([b["reason"] for b in card["blocks"]], ["First", "Second"])
        first = card["blocks"][0]
        self.assertEqual(first["blocked_by"], "blk_owner")
        self.assertEqual(first["unblocked_by"], "blk_owner")
        self.assertEqual(first["resolution"], "Fixed")
        self.assertEqual(first["column"], "Doing")
        self.assertIsNone(card["blocks"][1]["unblocked_at"])
        activity_types = [a["event_type"] for a in card["activities"]]
        self.assertEqual(activity_types.count("blocked"), 2)
        self.assertEqual(activity_types.count("unblocked"), 1)
        other = next(c for c in payload["cards"] if c["title"] == "Other card")
        self.assertIsNone(other["blocked_at"])
        self.assertEqual(other["blocks"], [])

    def test_round_trip_restores_who_when_and_why(self):
        self._make_history()
        original = list(CardBlock.objects.filter(card=self.card).order_by("blocked_at"))
        board = self._import(self._export())
        card = Card.objects.get(board=board, title="Waiting card")
        self.assertEqual(card.blocked_reason, "Second")
        self.assertEqual(card.blocked_at, original[1].blocked_at)
        rows = list(CardBlock.objects.filter(card=card).order_by("blocked_at"))
        self.assertEqual([r.reason for r in rows], ["First", "Second"])
        self.assertEqual(rows[0].blocked_at, original[0].blocked_at)
        self.assertEqual(rows[0].unblocked_at, original[0].unblocked_at)
        self.assertEqual(rows[0].resolution, "Fixed")
        self.assertIsNone(rows[1].unblocked_at)
        # Attributed to the importer, the file's name kept as text (#1675).
        self.assertEqual(rows[0].blocked_by, self.owner)
        self.assertEqual(rows[0].imported_from_username, "blk_owner")
        self.assertEqual(rows[0].column.board_id, board.id)
        self.assertEqual(rows[0].column_name, "Doing")
        self.assertEqual(rows[0].board_id, board.id)
        self.assertEqual(rows[0].card_uid, card.uid)
        self.assertEqual(
            CardActivity.objects.filter(card=card, event_type=CardActivity.EventType.BLOCKED).count(), 2,
        )
        # The re-export of the imported board matches the original's blocks.
        again = next(c for c in self._export_board(board)["cards"] if c["title"] == "Waiting card")
        self.assertEqual([b["reason"] for b in again["blocks"]], ["First", "Second"])

    def _export_board(self, board):
        resp = self.client.get(f"/api/v1/boards/{board.id}/export/?format=json")
        return json.loads(resp.content)

    def test_import_without_history_keeps_current_block_only(self):
        self._make_history()
        board = self._import(self._export(), options={"history": False})
        card = Card.objects.get(board=board, title="Waiting card")
        self.assertEqual(card.blocked_reason, "Second")
        rows = list(CardBlock.objects.filter(card=card))
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].unblocked_at)
        self.assertEqual(rows[0].blocked_at, card.blocked_at)

    def test_blocked_card_without_blocks_list_gets_an_open_row(self):
        data = {
            "name": "Hand made", "columns": [{"name": "Todo"}], "swimlanes": [{"name": "Lane"}],
            "cards": [{
                "title": "Stuck", "column": "Todo", "swimlane": "Lane",
                "blocked_at": "2026-10-01T09:00:00+00:00", "blocked_reason": "Budget",
            }],
        }
        board = self._import(data)
        card = Card.objects.get(board=board)
        block = CardBlock.objects.get(card=card)
        self.assertEqual(block.reason, "Budget")
        self.assertEqual(block.imported_from_username, "")
        self.assertEqual(block.column.name, "Todo")

    def test_files_without_block_keys_import_unblocked(self):
        data = {
            "name": "Old", "columns": [{"name": "Todo"}], "swimlanes": [{"name": "Lane"}],
            "cards": [{"title": "Plain", "column": "Todo", "swimlane": "Lane"}],
        }
        board = self._import(data)
        card = Card.objects.get(board=board)
        self.assertIsNone(card.blocked_at)
        self.assertFalse(CardBlock.objects.filter(card=card).exists())

    def _bad(self, card_extra, expected_fragment):
        data = {
            "name": "Bad", "columns": [{"name": "Todo"}], "swimlanes": [{"name": "Lane"}],
            "cards": [{"title": "C", "column": "Todo", "swimlane": "Lane", **card_extra}],
        }
        f = io.BytesIO(json.dumps(data).encode())
        f.name = "board.json"
        resp = self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST, resp.content)
        self.assertIn(expected_fragment, resp.data["detail"])

    def test_import_rejects_malformed_block_values(self):
        cases = [
            ({"blocked_at": "not a date"}, "invalid timestamp for 'blocked_at'"),
            ({"blocked_reason": "x" * 501}, "'blocked_reason' must be at most 500"),
            ({"blocks": "nope"}, "'blocks' must be a list"),
            ({"blocks": ["x"]}, "block at index 0 must be an object"),
            ({"blocks": [{"blocked_at": "bad"}]}, "invalid 'blocked_at'"),
            ({"blocks": [{"blocked_at": "2026-01-01T00:00:00Z", "unblocked_at": "bad"}]}, "invalid 'unblocked_at'"),
            ({"blocks": [{"reason": "r" * 501}]}, "'reason' must be at most 500"),
            ({"blocks": [{"blocked_by": ["x"]}]}, "'blocked_by' must be a string"),
        ]
        for extra, fragment in cases:
            with self.subTest(extra=str(extra)[:40]):
                self._bad(extra, fragment)


class SavedFilterBlockedOnlyTests(TestCase):

    def test_blocked_only_is_an_accepted_boolean_key(self):
        ser = SavedFilterSerializer()
        self.assertEqual(ser.validate_state_json({"blockedOnly": True}), {"blockedOnly": True})
        with self.assertRaisesMessage(Exception, "blockedOnly must be true or false"):
            ser.validate_state_json({"blockedOnly": "yes"})
