"""``is_starred`` on board/group events goes only to the user it belongs to (#1705).

``board.created``, ``board.updated``, ``group.created`` and ``group.updated``
payloads are serialized in the acting user's request context, so their
``is_starred`` is the actor's own star state. The field stays in the payload
for the actor and is omitted for every other recipient: per subscriber on the
board and group sockets, and per reader in the board change feed. Same
per-recipient omission as ``is_moderator`` on ``member.*`` events.

Four layers are covered:

* the shared rule, ``without_actor_scoped_fields``;
* the consumers, fed frames with and without the channel-layer ``actor_id``;
* the write paths end to end: each REST action runs against a recording
  channel layer, and every frame it publishes is replayed through a consumer
  for the actor and for another subscriber of every role;
* the change feed, for every reader role.

Consumer tests run with the access re-check served from its cache, as in
``test_event_payload_scoping``, so they need no DB from the consumer thread.
"""
import asyncio
import io
import json
from unittest.mock import patch

from django.contrib.admin.helpers import ACTION_CHECKBOX_NAME
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from boards.broadcast import broadcast_board_event, persist_board_event, record_board_event
from boards.models import BoardEvent, BoardFavorite, BoardMembership
from boards.permissions import (
    ACTOR_SCOPED_FIELD_EVENTS,
    ACTOR_SCOPED_FIELDS,
    without_actor_scoped_fields,
)
from boards.tests.conftest import _make_board, _make_membership, _make_user
from boards.tests.test_event_payload_scoping import (
    CONSUMER_ROLES,
    _board_consumer,
    _group_consumer,
)
from groups.broadcast import broadcast_group_event
from groups.models import Group, GroupFavorite, GroupMembership

SCOPED = ("board.created", "board.updated", "group.created", "group.updated")


def _deliver(consumer, handler, message):
    """Run one channel-layer message through a consumer; return the sent frame."""
    consumer.send.reset_mock()
    asyncio.run(getattr(consumer, handler)(message))
    if not consumer.send.called:
        return None
    return json.loads(consumer.send.call_args.kwargs["text_data"])


class _RecordingLayer:
    """Stands in for the channel layer and keeps every ``group_send``."""

    def __init__(self):
        self.sent = []

    async def group_send(self, group, message):
        self.sent.append((group, message))


class ActorScopedFieldRuleTests(TestCase):
    def test_registry_covers_the_four_events(self):
        self.assertEqual(ACTOR_SCOPED_FIELD_EVENTS, frozenset(SCOPED))
        self.assertEqual(ACTOR_SCOPED_FIELDS, frozenset({"is_starred"}))

    def test_actor_keeps_the_field_and_everyone_else_loses_it(self):
        data = {"id": 1, "name": "B", "is_starred": True}
        for event in SCOPED:
            with self.subTest(event=event):
                self.assertEqual(without_actor_scoped_fields(event, data, 5, 5), data)
                self.assertEqual(
                    without_actor_scoped_fields(event, data, 6, 5), {"id": 1, "name": "B"},
                )

    def test_unknown_actor_or_viewer_fails_closed(self):
        data = {"id": 1, "is_starred": False}
        for viewer, actor in ((5, None), (None, 5), (None, None)):
            with self.subTest(viewer=viewer, actor=actor):
                self.assertEqual(
                    without_actor_scoped_fields("board.updated", data, viewer, actor), {"id": 1},
                )

    def test_other_events_and_shapes_are_unchanged(self):
        star = {"uid": "u", "user_id": 5, "is_starred": True}
        # The star events are the owner's own state and are gated elsewhere
        # (PER_USER_EVENTS); this rule must not touch them.
        self.assertIs(without_actor_scoped_fields("board.star_changed", star, 6, None), star)
        self.assertIs(without_actor_scoped_fields("group.star_changed", star, 6, None), star)
        for data in ("not-a-dict", None, ["is_starred"], {"id": 1}):
            with self.subTest(data=data):
                self.assertIs(without_actor_scoped_fields("board.updated", data, 6, 5), data)


class BroadcastHelperActorTests(TestCase):
    """``actor_id`` rides on the channel-layer message, never in the envelope."""

    def test_board_helper_puts_actor_beside_the_envelope(self):
        layer = _RecordingLayer()
        with patch("boards.broadcast.get_channel_layer", return_value=layer):
            broadcast_board_event(1, "board.updated", {"id": 1, "is_starred": True}, event_id=9, actor_id=5)
            broadcast_board_event(1, "board.updated", {"id": 1, "is_starred": True})
        (_, with_actor), (_, without_actor) = layer.sent
        self.assertEqual(with_actor["actor_id"], 5)
        self.assertEqual(
            with_actor["payload"], {"event": "board.updated", "data": {"id": 1, "is_starred": True}, "event_id": 9},
        )
        self.assertNotIn("actor_id", without_actor)

    def test_group_helper_puts_actor_beside_the_envelope(self):
        layer = _RecordingLayer()
        with patch("groups.broadcast.get_channel_layer", return_value=layer):
            broadcast_group_event(3, "group.updated", {"id": 3, "is_starred": True}, actor_id=5)
            broadcast_group_event(3, "group.updated", {"id": 3, "is_starred": True})
        (_, with_actor), (_, without_actor) = layer.sent
        self.assertEqual(with_actor["actor_id"], 5)
        self.assertEqual(with_actor["payload"], {"event": "group.updated", "data": {"id": 3, "is_starred": True}})
        self.assertNotIn("actor_id", without_actor)

    def test_record_board_event_passes_the_actor_through(self):
        owner = _make_user("asf_rec_owner")
        board = _make_board(owner, name="Rec")
        with patch("boards.broadcast.broadcast_board_event") as mock_bcast:
            with self.captureOnCommitCallbacks(execute=True):
                record_board_event(board.id, "board.updated", {"id": board.id}, actor_id=owner.id)
        self.assertEqual(mock_bcast.call_args.kwargs["actor_id"], owner.id)


class ConsumerActorScopedFieldTests(TestCase):
    def setUp(self):
        self.actor = _make_user("asf_actor")
        self.other = _make_user("asf_other")
        self.board = _make_board(self.actor, name="Actor scoped")

    def _message(self, event, actor_id, handler):
        payload = {"event": event, "data": {"id": 7, "name": "N", "is_starred": True}}
        message = {"type": handler, "payload": payload}
        if actor_id is not None:
            message["actor_id"] = actor_id
        return message

    def test_board_channel(self):
        for event in ("board.created", "board.updated"):
            for role in CONSUMER_ROLES:
                with self.subTest(event=event, role=role):
                    msg = self._message(event, self.actor.id, "board_event")
                    own = _deliver(_board_consumer(self.board, self.actor, role), "board_event", msg)
                    self.assertEqual(own, msg["payload"])
                    theirs = _deliver(_board_consumer(self.board, self.other, role), "board_event", msg)
                    self.assertEqual(theirs["data"], {"id": 7, "name": "N"})
                    self.assertEqual(theirs["event"], event)

    def test_group_channel(self):
        for event in SCOPED:
            with self.subTest(event=event):
                msg = self._message(event, self.actor.id, "group_event")
                own = _deliver(_group_consumer(7, self.actor, visible_boards=(7,)), "group_event", msg)
                self.assertEqual(own, msg["payload"])
                theirs = _deliver(_group_consumer(7, self.other, visible_boards=(7,)), "group_event", msg)
                self.assertNotIn("is_starred", theirs["data"])
                self.assertEqual(theirs["data"], {"id": 7, "name": "N"})

    def test_frame_without_actor_omits_the_field_for_everyone(self):
        board_msg = self._message("board.updated", None, "board_event")
        group_msg = self._message("group.updated", None, "group_event")
        for user in (self.actor, self.other):
            with self.subTest(user=user.username):
                frame = _deliver(_board_consumer(self.board, user, "admin"), "board_event", board_msg)
                self.assertNotIn("is_starred", frame["data"])
                frame = _deliver(_group_consumer(7, user), "group_event", group_msg)
                self.assertNotIn("is_starred", frame["data"])

    def test_event_id_and_other_events_are_untouched(self):
        msg = self._message("board.updated", self.actor.id, "board_event")
        msg["payload"]["event_id"] = 42
        theirs = _deliver(_board_consumer(self.board, self.other, "member"), "board_event", msg)
        self.assertEqual(theirs["event_id"], 42)
        star = {
            "type": "board_event",
            "payload": {"event": "board.star_changed",
                        "data": {"uid": self.board.uid, "user_id": self.actor.id, "is_starred": True}},
        }
        own = _deliver(_board_consumer(self.board, self.actor, "member"), "board_event", star)
        self.assertEqual(own, star["payload"])


class WritePathBase(TestCase):
    """Every write path that publishes a scoped event names its actor, except a
    change to a board's share state, which has none (#2043).

    Each action runs against a recording channel layer; every scoped frame it
    publishes is then delivered to the actor's socket (which keeps
    ``is_starred`` with the actor's own value) and to another subscriber's
    socket (which does not get the key).
    """

    def setUp(self):
        self.actor = _make_user("asf_wp_actor")
        self.other = _make_user("asf_wp_other")
        self.group = Group.objects.create(name="WP group", owner=self.actor)
        GroupMembership.objects.create(group=self.group, user=self.actor, role=GroupMembership.Role.ADMIN)
        GroupMembership.objects.create(group=self.group, user=self.other, role=GroupMembership.Role.MEMBER)
        self.group2 = Group.objects.create(name="WP group 2", owner=self.actor)
        GroupMembership.objects.create(group=self.group2, user=self.actor, role=GroupMembership.Role.ADMIN)
        self.board = _make_board(self.actor, name="WP board", group=self.group)
        _make_membership(self.board, self.other, "member")
        # The actor has starred both, so the actor's own value is True.
        BoardFavorite.objects.create(user=self.actor, board=self.board)
        GroupFavorite.objects.create(user=self.actor, group=self.group)
        self.client = APIClient()
        self.client.force_authenticate(user=self.actor)

    def _run(self, call):
        layer = _RecordingLayer()
        with patch("boards.broadcast.get_channel_layer", return_value=layer), \
             patch("groups.broadcast.get_channel_layer", return_value=layer):
            with self.captureOnCommitCallbacks(execute=True):
                resp = call()
        self.assertLess(resp.status_code, 300, getattr(resp, "data", None))
        return [(g, m) for g, m in layer.sent if m["payload"]["event"] in SCOPED]

    def _assert_scoped(self, sent, expected, starred=None):
        self.assertEqual(sorted((g.split("_")[0], m["payload"]["event"]) for g, m in sent), sorted(expected))
        for group_name, message in sent:
            with self.subTest(channel=group_name, event=message["payload"]["event"]):
                self.assertEqual(message.get("actor_id"), self.actor.id)
                self.assertIn("is_starred", message["payload"]["data"])
                if group_name.startswith("board_"):
                    handler = "board_event"
                    own_c = _board_consumer(self.board, self.actor, "admin")
                    others = [_board_consumer(self.board, self.other, r) for r in CONSUMER_ROLES]
                else:
                    handler = "group_event"
                    gid = int(group_name.split("_")[1])
                    board_ids = (message["payload"]["data"].get("id"),)
                    own_c = _group_consumer(gid, self.actor, visible_boards=board_ids)
                    others = [_group_consumer(gid, self.other, visible_boards=board_ids)]
                own = _deliver(own_c, handler, message)
                self.assertIn("is_starred", own["data"])
                if starred is not None:
                    self.assertIs(own["data"]["is_starred"], starred)
                for consumer in others:
                    theirs = _deliver(consumer, handler, message)
                    self.assertNotIn("is_starred", theirs["data"])
                    expected_data = {k: v for k, v in own["data"].items() if k != "is_starred"}
                    self.assertEqual(theirs["data"], expected_data)



class WritePathActorTests(WritePathBase):
    def test_board_create(self):
        sent = self._run(lambda: self.client.post("/api/v1/boards/", {"name": "New", "group": self.group.id}))
        self._assert_scoped(sent, [("board", "board.created"), ("group", "board.created")], starred=False)

    def test_board_update(self):
        sent = self._run(lambda: self.client.patch(f"/api/v1/boards/{self.board.id}/", {"name": "Renamed"}))
        self._assert_scoped(sent, [("board", "board.updated"), ("group", "board.updated")], starred=True)

    def test_board_move_group(self):
        sent = self._run(lambda: self.client.post(
            f"/api/v1/boards/{self.board.id}/move-group/", {"group_id": self.group2.id}, format="json",
        ))
        self._assert_scoped(sent, [("board", "board.updated"), ("group", "board.created")], starred=True)

    def test_board_share_frame_has_no_actor_and_omits_the_field_for_everyone(self):
        """The exception to this class's rule: a share-state frame has no actor (#2043)."""
        sent = self._run(lambda: self.client.post(f"/api/v1/boards/{self.board.id}/share/"))
        ((group_name, message),) = sent
        self.assertEqual(group_name, f"board_{self.board.id}")
        self.assertEqual(message["payload"]["event"], "board.updated")
        self.assertNotIn("actor_id", message)
        for user in (self.actor, self.other):
            frame = _deliver(_board_consumer(self.board, user, "admin"), "board_event", message)
            self.assertNotIn("is_starred", frame["data"])

    def test_group_boards_create(self):
        sent = self._run(lambda: self.client.post(f"/api/v1/groups/{self.group.id}/boards/", {"name": "GB"}))
        self._assert_scoped(sent, [("board", "board.created"), ("group", "board.created")], starred=False)

    def test_group_create(self):
        sent = self._run(lambda: self.client.post("/api/v1/groups/", {"name": "Sub", "parent": self.group.id}))
        self._assert_scoped(sent, [("group", "group.created"), ("group", "group.created")], starred=False)

    def test_group_update(self):
        sent = self._run(lambda: self.client.patch(f"/api/v1/groups/{self.group.id}/", {"name": "G renamed"}))
        self._assert_scoped(sent, [("group", "group.updated")], starred=True)

    def test_group_board_defaults(self):
        sent = self._run(lambda: self.client.patch(
            f"/api/v1/groups/{self.group.id}/board-defaults/", {"allowed_priorities": ["low", "high"]}, format="json",
        ))
        self._assert_scoped(sent, [("group", "group.updated")], starred=True)

    def test_group_transfer_ownership(self):
        heir = _make_user("asf_wp_heir")
        GroupMembership.objects.create(group=self.group, user=heir, role=GroupMembership.Role.ADMIN)
        sent = self._run(lambda: self.client.post(
            f"/api/v1/groups/{self.group.id}/transfer-ownership/",
            {"new_owner_id": heir.id, "confirmation": self.group.name}, format="json",
        ))
        self._assert_scoped(sent, [("group", "group.updated")], starred=True)


def _upload(raw, name):
    f = io.BytesIO(raw if isinstance(raw, bytes) else raw.encode("utf-8"))
    f.name = name
    return f


class ImportWritePathActorTests(WritePathBase):
    """The three import emitters: JSON import, CSV import, and the Trello
    import (``_broadcast_imported_board``). An imported board is new, so the
    importer's own value is ``False``."""

    def setUp(self):
        super().setUp()
        cache.clear()  # Trello import is throttled

    def test_json_import(self):
        data = json.dumps({
            "name": "Imported JSON",
            "columns": [{"name": "To Do", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
            "labels": [], "cards": [],
        })
        sent = self._run(lambda: self.client.post(
            "/api/v1/boards/import/",
            {"file": _upload(data, "board.json"), "group_id": self.group.id}, format="multipart",
        ))
        self._assert_scoped(sent, [("board", "board.created"), ("group", "board.created")], starred=False)

    def test_csv_import(self):
        sent = self._run(lambda: self.client.post(
            "/api/v1/boards/import/",
            {"file": _upload("Title,Column,Swimlane\nFix login,To Do,General\n", "plan.csv"),
             "group_id": self.group.id},
            format="multipart",
        ))
        self._assert_scoped(sent, [("board", "board.created"), ("group", "board.created")], starred=False)

    def test_trello_import(self):
        from boards.tests.test_trello_import import load_fixture

        sent = self._run(lambda: self.client.post(
            "/api/v1/boards/import/trello/?confirm=true",
            {"file": _upload(json.dumps(load_fixture()), "trello.json"), "group_id": self.group.id},
            format="multipart",
        ))
        self._assert_scoped(sent, [("board", "board.created"), ("group", "board.created")], starred=False)


class AdminGroupTransferActorTests(TestCase):
    """The Django-admin group transfer names the admin user as actor, so only
    that user's sockets receive ``is_starred`` (a constant ``False`` there)."""

    def test_admin_transfer_is_scoped_to_the_admin(self):
        root = _make_user("asf_root", is_staff=True, is_superuser=True)
        owner = _make_user("asf_adm_owner")
        heir = _make_user("asf_adm_heir")
        other = _make_user("asf_adm_other")
        group = Group.objects.create(name="Adm transfer", owner=owner)
        for u, role in ((owner, "admin"), (heir, "admin"), (other, "member")):
            GroupMembership.objects.create(group=group, user=u, role=role)
        self.client.force_login(root)
        layer = _RecordingLayer()
        with patch("groups.broadcast.get_channel_layer", return_value=layer):
            with self.captureOnCommitCallbacks(execute=True):
                self.client.post(reverse("admin:groups_group_changelist"), {
                    "action": "transfer_ownership", ACTION_CHECKBOX_NAME: [group.pk],
                    "step": "confirm", "expected_owner": owner.pk, "new_owner": heir.pk,
                })
        group.refresh_from_db()
        self.assertEqual(group.owner_id, heir.id)
        (message,) = [m for _, m in layer.sent if m["payload"]["event"] == "group.updated"]
        self.assertEqual(message["actor_id"], root.id)
        own = _deliver(_group_consumer(group.id, root), "group_event", message)
        self.assertIs(own["data"]["is_starred"], False)
        theirs = _deliver(_group_consumer(group.id, other), "group_event", message)
        self.assertNotIn("is_starred", theirs["data"])


class FeedActorScopedFieldTests(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.owner = _make_user("asf_feed_owner")  # board admin
        self.board = _make_board(self.owner, name="Feed actor")
        self.moderator = _make_user("asf_feed_mod")
        BoardMembership.objects.create(
            board=self.board, user=self.moderator, role=BoardMembership.Role.MEMBER, is_moderator=True,
        )
        self.member = _make_user("asf_feed_member")
        _make_membership(self.board, self.member, "member")
        self.viewer = _make_user("asf_feed_viewer")
        _make_membership(self.board, self.viewer, "viewer")
        self.site_admin = _make_user("asf_feed_sa", can_access_all_content=True)
        self.readers = {
            "admin": self.owner, "site_admin": self.site_admin,
            "moderator": self.moderator, "member": self.member, "viewer": self.viewer,
        }
        self.url = f"/api/v1/boards/{self.board.pk}/events/"

    def _rows(self, user, event):
        client = APIClient()
        client.force_authenticate(user=user)
        resp = client.get(self.url)
        self.assertEqual(resp.status_code, 200)
        return [r for r in resp.data["results"] if r["event"] == event]

    def test_updated_row_keeps_is_starred_for_its_actor_only(self):
        BoardFavorite.objects.create(user=self.owner, board=self.board)
        client = APIClient()
        client.force_authenticate(user=self.owner)
        self.assertEqual(
            client.patch(f"/api/v1/boards/{self.board.pk}/", {"name": "Fed"}).status_code, 200,
        )
        for name, reader in self.readers.items():
            with self.subTest(reader=name):
                (row,) = self._rows(reader, "board.updated")
                self.assertEqual(row["data"]["name"], "Fed")
                if reader == self.owner:
                    self.assertIs(row["data"]["is_starred"], True)
                else:
                    self.assertNotIn("is_starred", row["data"])

    def test_every_scoped_row_follows_its_actor(self):
        # Rows written by different actors (site admin edits, a member-created
        # row): each reader sees is_starred on their own rows only.
        BoardEvent.objects.filter(board_id=self.board.id).delete()
        for actor in self.readers.values():
            persist_board_event(
                self.board.id, "board.created", {"id": self.board.id, "is_starred": True}, actor_id=actor.id,
            )
        for name, reader in self.readers.items():
            with self.subTest(reader=name):
                rows = self._rows(reader, "board.created")
                self.assertEqual(len(rows), len(self.readers))
                for row in rows:
                    self.assertEqual("is_starred" in row["data"], row["actor_id"] == reader.id)

    def test_row_with_no_actor_omits_is_starred_for_everyone(self):
        BoardEvent.objects.create(
            board_id=self.board.id, event="board.updated", data={"id": self.board.id, "is_starred": True},
        )
        for name, reader in self.readers.items():
            with self.subTest(reader=name):
                (row,) = self._rows(reader, "board.updated")
                self.assertNotIn("is_starred", row["data"])
