"""Coverage for the board change feed — model, write path, endpoint, retention (#1114).

The feed's whole promise is that a consumer outside the Django process can drop
its WebSocket and still find out what it missed. That promise has four load-
bearing parts, and each gets its own class below:

* every event type the broadcast surface emits actually lands in the table
  (``EveryEmittedEventIsPersistedTests``) — a type that is broadcast but not
  persisted is an invisible hole in the feed that no consumer can detect;
* a rolled-back mutation writes no row and sends no frame
  (``RollbackWritesNothingTests``) — the feed must never describe a mutation the
  database refused;
* reads strip per-recipient fields exactly as the WebSocket consumer does
  (``ReadSideStrippingTests``) — otherwise the feed is a way to read back what
  the socket refuses to send;
* pruning bounds the table, and a cursor it removed fails loudly rather than
  returning a page that silently skips events (``RetentionAndGoneTests``).
"""

import contextlib
import datetime
import types
from unittest.mock import patch

from django.core.management import call_command
from django.db import transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from boards.broadcast import record_board_event
from boards.models import BoardEvent, BoardMembership, Card
from boards.services import cards as svc
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)


def _render(card, movement=None):
    """Cheap payload renderer for direct service calls (see test_card_services)."""
    return {"id": card.pk, "title": card.title}


@contextlib.contextmanager
def _capture_frames():
    """Record what reaches the channel layer, without a running Redis.

    ``group_send`` has to be a real coroutine: ``broadcast_board_event`` calls it
    through ``async_to_sync``, and a plain callable would not exercise the code
    path production uses.
    """
    sent = []

    async def _group_send(group, message):
        sent.append((group, message))

    layer = types.SimpleNamespace(group_send=_group_send)
    with patch("boards.broadcast.get_channel_layer", return_value=layer):
        yield sent


class BoardEventTestBase(TestCase):
    def setUp(self):
        # Suppress the channel layer. Patched at the source module so every
        # indirect caller — including record_board_event's deferred publish — is
        # intercepted; see the note in boards.broadcast.record_board_event.
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self.broadcast = self._broadcast_patcher.start()
        self.addCleanup(self._broadcast_patcher.stop)

        self.owner = _make_user("evt_owner")
        self.board = _make_board(self.owner, name="Feed Board")
        self.col_a = _make_column(self.board, "A", 0, allow_card_creation=True)
        self.col_b = _make_column(self.board, "B", 1)
        self.lane = _make_swimlane(self.board, "L", 0)

        self.member = _make_user("evt_member")
        _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)
        self.viewer = _make_user("evt_viewer")
        _make_membership(self.board, self.viewer, BoardMembership.Role.VIEWER)

    def client_for(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def events(self, board=None):
        return list(
            BoardEvent.objects.filter(board_id=(board or self.board).id).order_by("id")
        )

    def event_types(self, board=None):
        return [e.event for e in self.events(board)]


class EveryEmittedEventIsPersistedTests(BoardEventTestBase):
    """A broadcast without a feed row is a hole the consumer cannot see.

    These drive the real write paths — HTTP endpoints and the card service — and
    assert the row landed, rather than calling ``record_board_event`` directly.
    Calling the helper would only prove the helper works; what can actually
    regress is a call site that goes back to a bare ``on_commit`` broadcast.
    """

    def test_card_lifecycle_events_are_persisted(self):
        card = svc.create_card(
            actor=self.owner, board=self.board, column_id=self.col_a.pk,
            swimlane_id=self.lane.pk,
            save=lambda position: _make_card(
                self.col_a, self.lane, title="C", position=position,
            ),
            render=_render,
        ).card
        svc.update_card(
            actor=self.owner, board=self.board, card=card,
            submitted={"title": "C2"},
            apply=lambda: Card.objects.filter(pk=card.pk).update(title="C2"),
            render=_render,
        )
        svc.move_card(
            actor=self.owner, board=self.board, card_id=card.pk,
            target_column_id=self.col_b.pk, target_swimlane_id=self.lane.pk,
            position=0, render=_render,
        )
        svc.archive_card(
            actor=self.owner, board=self.board, card_id=card.pk, render=_render,
        )
        svc.unarchive_card(
            actor=self.owner, board=self.board, card_id=card.pk, render=_render,
        )
        svc.delete_card(
            actor=self.owner, board=self.board,
            card=Card.objects.get(pk=card.pk),
        )

        self.assertEqual(
            self.event_types(),
            [
                "card.created", "card.updated", "card.moved",
                "card.archived", "card.unarchived", "card.deleted",
            ],
        )

    def test_persisted_payload_is_the_broadcast_payload(self):
        """The feed row and the frame must be the same data, not two renderings.

        ``captureOnCommitCallbacks(execute=True)`` is required throughout: a
        ``TestCase`` runs inside a transaction that is never committed, so
        ``on_commit`` callbacks are collected and dropped unless a test asks for
        them. Without it every broadcast assertion below would pass vacuously.
        """
        with self.captureOnCommitCallbacks(execute=True):
            card = svc.create_card(
                actor=self.owner, board=self.board, column_id=self.col_a.pk,
                swimlane_id=self.lane.pk,
                save=lambda position: _make_card(
                    self.col_a, self.lane, title="Same", position=position,
                ),
                render=_render,
            ).card
        row = self.events()[0]
        args, kwargs = self.broadcast.call_args
        self.assertEqual(row.data, args[2])
        self.assertEqual(kwargs["event_id"], row.pk)
        self.assertEqual(row.data["id"], card.pk)

    def test_actor_is_recorded(self):
        svc.create_card(
            actor=self.member, board=self.board, column_id=self.col_a.pk,
            swimlane_id=self.lane.pk,
            save=lambda position: _make_card(
                self.col_a, self.lane, title="Mine", position=position,
                created_by=self.member,
            ),
            render=_render,
        )
        self.assertEqual(self.events()[0].actor_id, self.member.pk)

    def test_structural_and_membership_events_are_persisted(self):
        """column.*, swimlane.*, label.*, member.*, board.* all reach the feed."""
        c = self.client_for(self.owner)
        b = self.board.pk

        col = c.post(f"/api/v1/boards/{b}/columns/", {"name": "New"}, format="json")
        self.assertEqual(col.status_code, 201)
        c.patch(f"/api/v1/boards/{b}/columns/{col.data['id']}/", {"name": "Ren"}, format="json")
        c.post(
            f"/api/v1/boards/{b}/columns/reorder/",
            {"order": [col.data["id"], self.col_a.pk, self.col_b.pk]}, format="json",
        )
        c.delete(f"/api/v1/boards/{b}/columns/{col.data['id']}/")

        lane = c.post(f"/api/v1/boards/{b}/swimlanes/", {"name": "L2"}, format="json")
        self.assertEqual(lane.status_code, 201)
        c.patch(f"/api/v1/boards/{b}/swimlanes/{lane.data['id']}/", {"name": "L3"}, format="json")
        c.post(
            f"/api/v1/boards/{b}/swimlanes/reorder/",
            {"order": [lane.data["id"], self.lane.pk]}, format="json",
        )
        c.delete(f"/api/v1/boards/{b}/swimlanes/{lane.data['id']}/")

        label = c.post(
            f"/api/v1/boards/{b}/labels/", {"name": "bug", "color": "#ff0000"}, format="json",
        )
        self.assertEqual(label.status_code, 201)
        c.patch(f"/api/v1/boards/{b}/labels/{label.data['id']}/", {"name": "defect"}, format="json")
        c.delete(f"/api/v1/boards/{b}/labels/{label.data['id']}/")

        outsider = _make_user("evt_outsider")
        c.post(f"/api/v1/boards/{b}/members/", {"user_id": outsider.pk}, format="json")
        c.post(
            f"/api/v1/boards/{b}/members/",
            {"user_id": outsider.pk, "role": "admin"}, format="json",
        )
        c.delete(f"/api/v1/boards/{b}/members/{outsider.pk}/")

        c.patch(f"/api/v1/boards/{b}/", {"name": "Renamed"}, format="json")
        c.post(f"/api/v1/boards/{b}/star/")

        self.assertEqual(
            self.event_types(),
            [
                "column.created", "column.updated", "column.reordered", "column.deleted",
                "swimlane.created", "swimlane.updated", "swimlane.reordered", "swimlane.deleted",
                "label.created", "label.updated", "label.deleted",
                "member.added", "member.updated", "member.removed",
                "board.updated", "board.star_changed",
            ],
        )

    def test_board_created_and_deleted_are_persisted(self):
        """board.deleted in particular — the row has to outlive its subject.

        This is the case a ``ForeignKey(Board, on_delete=CASCADE)`` could never
        satisfy: the cascade would remove the row in the same transaction that
        wrote it, and a consumer holding a cursor would never learn the board
        went away.
        """
        c = self.client_for(self.owner)
        created = c.post("/api/v1/boards/", {"name": "Ephemeral"}, format="json")
        self.assertEqual(created.status_code, 201)
        new_id = created.data["id"]
        self.assertEqual(
            [e.event for e in self.events(board=type("B", (), {"id": new_id})())],
            ["board.created"],
        )

        self.assertEqual(c.delete(f"/api/v1/boards/{new_id}/").status_code, 204)
        self.assertEqual(
            list(
                BoardEvent.objects.filter(board_id=new_id)
                .order_by("id").values_list("event", flat=True)
            ),
            ["board.created", "board.deleted"],
        )

    def test_saved_filter_events_are_persisted(self):
        c = self.client_for(self.owner)
        b = self.board.pk
        created = c.post(
            f"/api/v1/boards/{b}/saved-filters/",
            {"name": "Mine", "state_json": {"search": "x"}, "state_version": 1},
            format="json",
        )
        self.assertEqual(created.status_code, 201)
        c.delete(f"/api/v1/boards/{b}/saved-filters/{created.data['id']}/")
        self.assertEqual(
            self.event_types(), ["saved_filter.created", "saved_filter.deleted"],
        )

    def test_custom_field_events_are_persisted(self):
        """#1134: schema changes must reach the resumable feed, not just live sockets."""
        c = self.client_for(self.owner)
        base = f"/api/v1/boards/{self.board.pk}/custom-fields/"
        first = c.post(base, {"name": "One", "field_type": "text"}, format="json")
        second = c.post(base, {"name": "Two", "field_type": "text"}, format="json")
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        renamed = c.patch(f"{base}{first.data['id']}/", {"name": "Uno"}, format="json")
        self.assertEqual(renamed.status_code, 200)
        reordered = c.post(
            f"{base}reorder/", {"order": [second.data["id"], first.data["id"]]}, format="json"
        )
        self.assertEqual(reordered.status_code, 200)
        deleted = c.delete(f"{base}{first.data['id']}/")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(
            self.event_types(),
            [
                "custom_field.created",
                "custom_field.created",
                "custom_field.updated",
                "custom_field.reordered",
                "custom_field.deleted",
            ],
        )
        events = self.events()
        self.assertTrue(all(e.actor_id == self.owner.pk for e in events))
        self.assertEqual(events[2].data["name"], "Uno")
        self.assertEqual(
            [f["id"] for f in events[3].data["custom_fields"]],
            [second.data["id"], first.data["id"]],
        )
        self.assertEqual(events[4].data, {"custom_field_uid": first.data["uid"]})

    def test_custom_field_schema_change_replays_from_a_cursor(self):
        c = self.client_for(self.owner)
        cursor = record_board_event(self.board.id, "card.created", {"n": 0})
        created = c.post(
            f"/api/v1/boards/{self.board.pk}/custom-fields/",
            {"name": "Missed", "field_type": "number"},
            format="json",
        )
        self.assertEqual(created.status_code, 201)
        resp = self.client_for(self.viewer).get(
            f"/api/v1/boards/{self.board.pk}/events/?after={cursor}"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([e["event"] for e in resp.data["results"]], ["custom_field.created"])
        self.assertEqual(resp.data["results"][0]["data"]["name"], "Missed")

    def test_broadcast_frame_carries_the_event_id(self):
        """``event_id`` is additive: the frozen {event, data} envelope is intact."""
        self._broadcast_patcher.stop()
        try:
            with _capture_frames() as sent:
                with self.captureOnCommitCallbacks(execute=True):
                    event_id = record_board_event(
                        self.board.id, "card.created", {"id": 1}, actor_id=self.owner.pk,
                    )
        finally:
            self.broadcast = self._broadcast_patcher.start()

        group, message = sent[0]
        self.assertEqual(group, f"board_{self.board.id}")
        self.assertEqual(message["type"], "board_event")
        payload = message["payload"]
        self.assertEqual(payload["event"], "card.created")
        self.assertEqual(payload["data"], {"id": 1})
        self.assertEqual(payload["event_id"], event_id)

    def test_event_id_is_absent_when_a_caller_broadcasts_without_persisting(self):
        """Omitted, not null — a client never has to tell the two apart."""
        self._broadcast_patcher.stop()
        try:
            from boards.broadcast import broadcast_board_event

            with _capture_frames() as sent:
                broadcast_board_event(self.board.id, "card.updated", {"id": 1})
        finally:
            self.broadcast = self._broadcast_patcher.start()
        self.assertNotIn("event_id", sent[0][1]["payload"])


class RollbackWritesNothingTests(BoardEventTestBase):
    """A rolled-back mutation must leave no trace in the feed and send nothing."""

    def test_rollback_writes_no_event_and_broadcasts_nothing(self):
        class Boom(Exception):
            pass

        def _explode():
            raise Boom()

        card = _make_card(self.col_a, self.lane, title="Doomed")
        # execute=True so "broadcast nothing" is a real assertion: without it a
        # TestCase never runs on_commit at all and the check passes vacuously.
        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(Boom):
                svc.update_card(
                    actor=self.owner, board=self.board, card=card,
                    submitted={"title": "never"}, apply=_explode, render=_render,
                )

        self.assertEqual(BoardEvent.objects.count(), 0)
        self.broadcast.assert_not_called()

    def test_explicit_rollback_of_a_recorded_event_leaves_nothing(self):
        """The row is written inside the caller's transaction, so it rolls back with it.

        Written as an explicit rollback rather than an exception because that is
        the acceptance criterion: an outer ``atomic`` block that aborts must take
        the feed row with it *and* leave ``on_commit`` unfired.
        """
        class Rollback(Exception):
            pass

        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(Rollback):
                with transaction.atomic():
                    record_board_event(
                        self.board.id, "card.created", {"id": 99}, actor_id=self.owner.pk,
                    )
                    # Visible inside the block — and gone once it unwinds.
                    self.assertEqual(BoardEvent.objects.count(), 1)
                    raise Rollback()

        self.assertEqual(BoardEvent.objects.count(), 0)
        self.broadcast.assert_not_called()


class EventsEndpointTests(BoardEventTestBase):
    """Cursor paging, validation, and access scoping on GET /boards/<id>/events/."""

    def setUp(self):
        super().setUp()
        self.url = f"/api/v1/boards/{self.board.pk}/events/"
        self.ids = [
            record_board_event(self.board.id, "card.created", {"n": n}, actor_id=self.owner.pk)
            for n in range(5)
        ]

    def test_returns_events_in_id_order(self):
        resp = self.client_for(self.owner).get(self.url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([e["id"] for e in resp.data["results"]], self.ids)
        self.assertIsNone(resp.data["next"])

    def test_after_resumes_from_the_cursor(self):
        resp = self.client_for(self.owner).get(f"{self.url}?after={self.ids[1]}")
        self.assertEqual([e["id"] for e in resp.data["results"]], self.ids[2:])

    def test_limit_pages_and_next_is_the_cursor_for_the_following_page(self):
        c = self.client_for(self.owner)
        first = c.get(f"{self.url}?limit=2")
        self.assertEqual([e["id"] for e in first.data["results"]], self.ids[:2])
        self.assertEqual(first.data["next"], self.ids[1])

        second = c.get(f"{self.url}?after={first.data['next']}&limit=2")
        self.assertEqual([e["id"] for e in second.data["results"]], self.ids[2:4])

        last = c.get(f"{self.url}?after={second.data['next']}&limit=2")
        self.assertEqual([e["id"] for e in last.data["results"]], self.ids[4:])
        self.assertIsNone(last.data["next"])

    def test_event_shape(self):
        row = self.client_for(self.owner).get(self.url).data["results"][0]
        self.assertEqual(
            set(row), {"id", "event", "data", "actor_id", "created_at"},
        )
        self.assertEqual(row["event"], "card.created")
        self.assertEqual(row["actor_id"], self.owner.pk)

    def test_malformed_cursor_is_rejected_rather_than_silently_restarted(self):
        c = self.client_for(self.owner)
        self.assertEqual(c.get(f"{self.url}?after=abc").status_code, 400)
        self.assertEqual(c.get(f"{self.url}?after=-1").status_code, 400)

    def test_out_of_range_limit_is_rejected_rather_than_clamped(self):
        c = self.client_for(self.owner)
        self.assertEqual(c.get(f"{self.url}?limit=0").status_code, 400)
        self.assertEqual(c.get(f"{self.url}?limit=501").status_code, 400)
        self.assertEqual(c.get(f"{self.url}?limit=x").status_code, 400)

    def test_anonymous_is_rejected(self):
        self.assertIn(APIClient().get(self.url).status_code, (401, 403))

    def test_non_member_cannot_read_the_feed(self):
        """403, the same answer /full/ gives — the feed invents no new access rule."""
        outsider = _make_user("evt_stranger")
        self.assertEqual(self.client_for(outsider).get(self.url).status_code, 403)

    def test_viewer_can_read_the_feed(self):
        """Parity with the WebSocket channel, which any board role may open."""
        resp = self.client_for(self.viewer).get(self.url)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["results"]), 5)

    def test_a_cursor_never_leaks_another_board_s_events(self):
        """IDOR: ids are global, so the board filter is the only thing between them."""
        other_owner = _make_user("evt_other_owner")
        other = _make_board(other_owner, name="Other")
        record_board_event(other.id, "card.created", {"secret": True}, actor_id=other_owner.pk)

        resp = self.client_for(self.owner).get(f"{self.url}?after=0")
        self.assertEqual([e["id"] for e in resp.data["results"]], self.ids)
        self.assertNotIn(
            True, [e["data"].get("secret") for e in resp.data["results"]],
        )

        # And the reverse: our member cannot use a valid cursor to read theirs.
        self.assertEqual(
            self.client_for(self.member).get(
                f"/api/v1/boards/{other.pk}/events/"
            ).status_code,
            403,
        )

    def test_serializing_a_page_costs_one_query_regardless_of_size(self):
        """actor_id is a column, not a relation — a page cannot N+1 on the actor.

        Serialization is inside ``assertNumQueries`` on purpose: fetching rows in
        one query proves nothing if ``to_representation`` then walks a FK per row.
        50 rows with distinct actors is the shape an N+1 would show up in.
        """
        from boards.serializers import BoardEventSerializer

        actors = [_make_user(f"evt_bulk{n}") for n in range(5)]
        for n in range(50):
            record_board_event(
                self.board.id, "card.updated", {"n": n}, actor_id=actors[n % 5].pk,
            )

        with self.assertNumQueries(1):
            rows = list(
                BoardEvent.objects.filter(board_id=self.board.id).order_by("id")[:500]
            )
            data = BoardEventSerializer(rows, many=True, context={"role": "admin"}).data
            self.assertEqual(len(data), 55)


class ReadSideStrippingTests(BoardEventTestBase):
    """is_moderator must not be readable from the feed by a role the socket hides it from."""

    def setUp(self):
        super().setUp()
        self.url = f"/api/v1/boards/{self.board.pk}/events/"
        target = _make_user("evt_mod")
        self.client_for(self.owner).post(
            f"/api/v1/boards/{self.board.pk}/members/",
            {"user_id": target.pk, "role": "member", "is_moderator": True},
            format="json",
        )
        self.assertEqual(self.event_types(), ["member.added"])
        self.assertIn("is_moderator", self.events()[0].data)

    def test_admin_sees_is_moderator(self):
        row = self.client_for(self.owner).get(self.url).data["results"][0]
        self.assertIn("is_moderator", row["data"])

    def test_member_does_not_see_is_moderator(self):
        row = self.client_for(self.member).get(self.url).data["results"][0]
        self.assertNotIn("is_moderator", row["data"])
        # The rest of the payload is untouched — this is a field strip, not a redaction.
        self.assertIn("role", row["data"])

    def test_viewer_does_not_see_is_moderator(self):
        row = self.client_for(self.viewer).get(self.url).data["results"][0]
        self.assertNotIn("is_moderator", row["data"])

    def test_stripping_matches_the_websocket_consumer_gate(self):
        """One definition, two readers — the feed and the socket cannot drift."""
        from boards.consumers import _ROLES_WITH_MODERATOR_VISIBILITY
        from boards.permissions import ROLES_WITH_MODERATOR_VISIBILITY

        self.assertIs(_ROLES_WITH_MODERATOR_VISIBILITY, ROLES_WITH_MODERATOR_VISIBILITY)

    def test_unknown_role_fails_closed(self):
        from boards.serializers import BoardEventSerializer

        row = BoardEventSerializer(self.events()[0], context={}).data
        self.assertNotIn("is_moderator", row["data"])


class RetentionAndGoneTests(BoardEventTestBase):
    """Pruning bounds the table; a pruned cursor fails loudly, not silently."""

    def setUp(self):
        super().setUp()
        self.url = f"/api/v1/boards/{self.board.pk}/events/"

    def _age(self, event, days):
        # auto_now_add ignores an assigned value, so rewrite the row directly.
        BoardEvent.objects.filter(pk=event.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=days)
        )

    def test_prune_deletes_only_events_past_the_window(self):
        old = BoardEvent.objects.get(
            pk=record_board_event(self.board.id, "card.created", {"n": 1})
        )
        fresh = BoardEvent.objects.get(
            pk=record_board_event(self.board.id, "card.created", {"n": 2})
        )
        self._age(old, 45)

        call_command("prune_board_events")
        self.assertFalse(BoardEvent.objects.filter(pk=old.pk).exists())
        self.assertTrue(BoardEvent.objects.filter(pk=fresh.pk).exists())

    def test_prune_dry_run_deletes_nothing(self):
        old = BoardEvent.objects.get(
            pk=record_board_event(self.board.id, "card.created", {"n": 1})
        )
        self._age(old, 45)
        call_command("prune_board_events", "--dry-run")
        self.assertTrue(BoardEvent.objects.filter(pk=old.pk).exists())

    def test_prune_days_override(self):
        old = BoardEvent.objects.get(
            pk=record_board_event(self.board.id, "card.created", {"n": 1})
        )
        self._age(old, 3)
        call_command("prune_board_events")  # 30-day default keeps it
        self.assertTrue(BoardEvent.objects.filter(pk=old.pk).exists())
        call_command("prune_board_events", "--days", "1")
        self.assertFalse(BoardEvent.objects.filter(pk=old.pk).exists())

    def test_pruned_cursor_with_newer_events_returns_410(self):
        stale_id = record_board_event(self.board.id, "card.created", {"n": 1})
        record_board_event(self.board.id, "card.updated", {"n": 2})
        BoardEvent.objects.filter(pk=stale_id).delete()

        resp = self.client_for(self.owner).get(f"{self.url}?after={stale_id}")
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.data["code"], "cursor_expired")
        self.assertIn(f"/api/v1/boards/{self.board.pk}/full/", resp.data["resync_url"])

    def test_pruned_cursor_with_nothing_newer_returns_an_empty_page(self):
        """An idle consumer must not be sent to re-sync for events that never existed."""
        stale_id = record_board_event(self.board.id, "card.created", {"n": 1})
        BoardEvent.objects.filter(pk=stale_id).delete()

        resp = self.client_for(self.owner).get(f"{self.url}?after={stale_id}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["results"], [])
        self.assertIsNone(resp.data["next"])

    def test_after_zero_never_410s(self):
        record_board_event(self.board.id, "card.created", {"n": 1})
        resp = self.client_for(self.owner).get(f"{self.url}?after=0")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["results"]), 1)

    def test_a_cursor_from_another_board_is_410_not_a_silent_page(self):
        other_owner = _make_user("evt_other2")
        other = _make_board(other_owner, name="Other2")
        foreign_id = record_board_event(other.id, "card.created", {"n": 1})
        record_board_event(self.board.id, "card.created", {"n": 2})

        resp = self.client_for(self.owner).get(f"{self.url}?after={foreign_id}")
        self.assertEqual(resp.status_code, 410)
