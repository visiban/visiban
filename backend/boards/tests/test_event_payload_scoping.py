"""Per-recipient scoping of board events on the socket and in the change feed (#1677).

Three rules, each checked for every recipient role (admin, moderator, member,
viewer — plus site admin where the role ladder makes it distinct):

* ``board.star_changed``, ``saved_filter.created`` and ``saved_filter.deleted``
  (and ``group.star_changed`` on the group channel) are one user's own state:
  only that user's sockets forward them, and only that user reads their rows
  back from the change feed.
* ``invite`` on a ``member.added`` frame is forwarded to admin / site_admin
  subscribers and feed readers only, like ``is_site_admin``.
* Stored swimlane rows are re-filtered at feed read time against the board's
  CURRENT shareable swimlane field definitions, so a field marked
  ``is_admin_only`` after the row was written is not replayable.

Consumer tests drive ``board_event`` / ``group_event`` directly with the access
re-check served from its cache (``_access_verified_at = _now()``), so they need
no DB from the consumer thread and run under a plain ``TestCase``.
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from django.test import TestCase
from rest_framework.test import APIClient

from boards.broadcast import record_board_event
from boards.consumers import BoardConsumer, _now as board_now
from boards.models import BoardEvent, BoardMembership, SwimlaneCustomFieldDefinition
from boards.serializers import BoardEventSerializer
from boards.tests.conftest import _make_board, _make_membership, _make_swimlane, _make_user
from groups.consumers import GroupConsumer, _now as group_now

ADMIN = BoardMembership.Role.ADMIN
MEMBER = BoardMembership.Role.MEMBER
VIEWER = BoardMembership.Role.VIEWER

# Effective roles a consumer can hold; "moderator" is a member with the
# is_moderator flag, which does not change the resolved role.
CONSUMER_ROLES = ("admin", "site_admin", "member", "viewer")


def _deliver(consumer, handler, payload):
    consumer.send.reset_mock()
    asyncio.run(getattr(consumer, handler)({"payload": payload}))
    if not consumer.send.called:
        return None
    return json.loads(consumer.send.call_args.kwargs["text_data"])


def _board_consumer(board, user, role):
    consumer = BoardConsumer()
    consumer.board_id = board.id
    consumer.room = f"board_{board.id}"
    consumer.channel_name = "test-channel"
    consumer.channel_layer = AsyncMock()
    consumer.send = AsyncMock()
    consumer.close = AsyncMock()
    consumer.scope = {"url_route": {"kwargs": {"board_id": board.id}}, "user": user}
    consumer._role = role
    consumer._access_verified_at = board_now()
    return consumer


def _group_consumer(group_id, user):
    consumer = GroupConsumer()
    consumer.group_id = group_id
    consumer.room = f"group_{group_id}"
    consumer.channel_name = "test-channel"
    consumer.channel_layer = AsyncMock()
    consumer.send = AsyncMock()
    consumer.close = AsyncMock()
    consumer.scope = {"url_route": {"kwargs": {"group_id": group_id}}, "user": user}
    consumer._access_verified_at = group_now()
    return consumer


class ConsumerStarScopingTests(TestCase):
    def setUp(self):
        self.owner = _make_user("sc_owner")
        self.board = _make_board(self.owner, name="Scoping")
        self.starrer = _make_user("sc_starrer")
        self.other = _make_user("sc_other")
        self.frame = {
            "event": "board.star_changed",
            "data": {"uid": self.board.uid, "user_id": self.starrer.pk, "is_starred": True},
        }

    def test_star_frame_reaches_only_the_starring_users_sockets(self):
        for role in CONSUMER_ROLES:
            with self.subTest(role=role):
                own = _board_consumer(self.board, self.starrer, role)
                self.assertEqual(_deliver(own, "board_event", self.frame), self.frame)

                someone_else = _board_consumer(self.board, self.other, role)
                self.assertIsNone(_deliver(someone_else, "board_event", self.frame))

    def test_malformed_star_frame_is_dropped_for_everyone(self):
        consumer = _board_consumer(self.board, self.starrer, "admin")
        for data in ({"uid": "x", "is_starred": True}, "not-a-dict", None):
            with self.subTest(data=data):
                self.assertIsNone(
                    _deliver(consumer, "board_event", {"event": "board.star_changed", "data": data})
                )

    def test_saved_filter_frames_reach_only_the_owning_users_sockets(self):
        for event in ("saved_filter.created", "saved_filter.deleted"):
            frame = {"event": event, "data": {"filter_id": 3, "user_id": self.starrer.pk}}
            for role in CONSUMER_ROLES:
                with self.subTest(event=event, role=role):
                    own = _board_consumer(self.board, self.starrer, role)
                    self.assertEqual(_deliver(own, "board_event", frame), frame)
                    other = _board_consumer(self.board, self.other, role)
                    self.assertIsNone(_deliver(other, "board_event", frame))

    def test_other_users_star_frame_does_not_run_an_access_recheck(self):
        consumer = _board_consumer(self.board, self.other, "member")
        consumer._access_verified_at = None  # would force a DB re-check
        with patch.object(BoardConsumer, "_refresh_role") as refresh:
            self.assertIsNone(_deliver(consumer, "board_event", self.frame))
        refresh.assert_not_called()
        consumer.close.assert_not_called()

    def test_group_channel_star_frames_reach_only_the_starring_user(self):
        frames = [
            {"event": "board.star_changed",
             "data": {"uid": self.board.uid, "user_id": self.starrer.pk, "is_starred": True}},
            {"event": "group.star_changed",
             "data": {"id": 7, "user_id": self.starrer.pk, "is_starred": False}},
        ]
        for frame in frames:
            with self.subTest(event=frame["event"]):
                own = _group_consumer(7, self.starrer)
                self.assertEqual(_deliver(own, "group_event", frame), frame)
                other = _group_consumer(7, self.other)
                self.assertIsNone(_deliver(other, "group_event", frame))

    def test_group_channel_other_events_are_unaffected(self):
        frame = {"event": "group.updated", "data": {"id": 7, "user_id": self.starrer.pk}}
        self.assertEqual(_deliver(_group_consumer(7, self.other), "group_event", frame), frame)


class PerUserEventRegistryTests(TestCase):
    """Every per-user event name is in the set(s) that scope it.

    A per-user event is one whose payload is keyed by its owner's ``user_id``:
    any ``*star_changed`` and every ``saved_filter.*``. A new one added to the
    channel registries without joining these sets fails here.
    """

    @staticmethod
    def _per_user(names):
        return {n for n in names if n.endswith("star_changed") or n.startswith("saved_filter.")}

    def test_board_channel_per_user_events_are_scoped(self):
        from boards.broadcast import BOARD_CHANNEL_EVENTS
        from boards.permissions import PER_USER_EVENTS

        expected = self._per_user(BOARD_CHANNEL_EVENTS)
        self.assertTrue(expected)
        self.assertLessEqual(expected, PER_USER_EVENTS)

    def test_group_channel_per_user_events_are_scoped(self):
        from boards.permissions import PER_USER_EVENTS
        from groups.broadcast import GROUP_CHANNEL_EVENTS
        from groups.consumers import GROUP_PER_USER_EVENTS

        expected = self._per_user(GROUP_CHANNEL_EVENTS)
        self.assertIn("group.star_changed", expected)
        self.assertLessEqual(expected, GROUP_PER_USER_EVENTS)
        self.assertLessEqual(PER_USER_EVENTS, GROUP_PER_USER_EVENTS)


class ConsumerInviteFieldTests(TestCase):
    def setUp(self):
        self.owner = _make_user("inv_owner")
        self.board = _make_board(self.owner, name="Invite scoping")
        self.subscriber = _make_user("inv_sub")
        self.joiner = _make_user("inv_joiner")

    def _frame(self, subject_id):
        return {
            "event": "member.added",
            "data": {
                "id": 1, "user": {"id": subject_id}, "role": "member",
                "is_moderator": False, "invite": {"id": 5, "created_by_id": self.owner.pk},
            },
        }

    def test_invite_is_forwarded_to_admins_only(self):
        expected = {"admin": True, "site_admin": True, "member": False, "viewer": False}
        for role, visible in expected.items():
            with self.subTest(role=role):
                consumer = _board_consumer(self.board, self.subscriber, role)
                data = _deliver(consumer, "board_event", self._frame(self.joiner.pk))["data"]
                self.assertEqual("invite" in data, visible)
                # Field strip, not a redaction: the membership row itself arrives.
                self.assertEqual(data["user"], {"id": self.joiner.pk})

    def test_member_added_without_invite_is_unchanged(self):
        frame = self._frame(self.joiner.pk)
        del frame["data"]["invite"]
        data = _deliver(_board_consumer(self.board, self.subscriber, "admin"), "board_event", frame)
        self.assertEqual(data, frame)


class FeedScopingBase(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        patcher.start()
        self.addCleanup(patcher.stop)

        self.owner = _make_user("fs_owner")  # board admin
        self.board = _make_board(self.owner, name="Feed scoping")
        self.lane = _make_swimlane(self.board, "Acme", 0)
        self.moderator = _make_user("fs_moderator")
        BoardMembership.objects.create(
            board=self.board, user=self.moderator, role=MEMBER, is_moderator=True,
        )
        self.member = _make_user("fs_member")
        _make_membership(self.board, self.member, MEMBER)
        self.viewer = _make_user("fs_viewer")
        _make_membership(self.board, self.viewer, VIEWER)
        self.site_admin = _make_user("fs_site_admin", can_access_all_content=True)
        self.url = f"/api/v1/boards/{self.board.pk}/events/"

    def readers(self):
        return {
            "admin": self.owner, "site_admin": self.site_admin,
            "moderator": self.moderator, "member": self.member, "viewer": self.viewer,
        }

    def feed(self, user, query=""):
        client = APIClient()
        client.force_authenticate(user=user)
        resp = client.get(self.url + query)
        self.assertEqual(resp.status_code, 200)
        return resp.data


class FeedStarScopingTests(FeedScopingBase):
    def test_star_row_is_returned_only_to_the_starring_user(self):
        for name, starrer in self.readers().items():
            with self.subTest(starrer=name):
                BoardEvent.objects.filter(board_id=self.board.id).delete()
                client = APIClient()
                client.force_authenticate(user=starrer)
                self.assertEqual(client.post(f"/api/v1/boards/{self.board.pk}/star/").status_code, 200)
                for reader_name, reader in self.readers().items():
                    events = [r["event"] for r in self.feed(reader)["results"]]
                    if reader == starrer:
                        self.assertEqual(events, ["board.star_changed"], reader_name)
                    else:
                        self.assertNotIn("board.star_changed", events, reader_name)

    def test_saved_filter_rows_are_returned_only_to_the_owning_user(self):
        from boards.tests.test_saved_filters import SIMPLE_STATE

        for name, owner in self.readers().items():
            with self.subTest(owner=name):
                BoardEvent.objects.filter(board_id=self.board.id).delete()
                client = APIClient()
                client.force_authenticate(user=owner)
                base = f"/api/v1/boards/{self.board.pk}/saved-filters/"
                created = client.post(
                    base, {"name": f"view-{name}", "state_json": SIMPLE_STATE}, format="json",
                )
                self.assertEqual(created.status_code, 201, created.data)
                self.assertEqual(client.delete(f"{base}{created.data['id']}/").status_code, 204)
                # Writer contract: the feed exclusion keys on actor_id.
                self.assertEqual(
                    set(BoardEvent.objects.filter(board_id=self.board.id)
                        .values_list("event", "actor_id")),
                    {("saved_filter.created", owner.pk), ("saved_filter.deleted", owner.pk)},
                )
                for reader_name, reader in self.readers().items():
                    events = [r["event"] for r in self.feed(reader)["results"]]
                    if reader == owner:
                        self.assertEqual(
                            events, ["saved_filter.created", "saved_filter.deleted"], reader_name,
                        )
                    else:
                        self.assertEqual(events, [], reader_name)

    def test_star_rows_are_persisted_with_the_starring_user_as_actor(self):
        client = APIClient()
        client.force_authenticate(user=self.member)
        client.post(f"/api/v1/boards/{self.board.pk}/star/")
        client.delete(f"/api/v1/boards/{self.board.pk}/star/")
        self.assertEqual(
            set(BoardEvent.objects.filter(board_id=self.board.id).values_list("actor_id", flat=True)),
            {self.member.pk},
        )

    def test_excluded_star_rows_do_not_shorten_a_page(self):
        for _ in range(3):
            record_board_event(
                self.board.id, "board.star_changed",
                {"uid": self.board.uid, "user_id": self.member.pk, "is_starred": True},
                actor_id=self.member.pk,
            )
        for n in range(3):
            record_board_event(self.board.id, "card.updated", {"n": n}, actor_id=self.owner.pk)
        data = self.feed(self.viewer, "?limit=3")
        self.assertEqual([r["data"]["n"] for r in data["results"]], [0, 1, 2])

    def test_star_row_with_no_actor_is_returned_to_nobody(self):
        record_board_event(
            self.board.id, "board.star_changed",
            {"uid": self.board.uid, "user_id": self.member.pk, "is_starred": True},
        )
        for reader in self.readers().values():
            self.assertEqual(self.feed(reader)["results"], [])


class FeedInviteFieldTests(FeedScopingBase):
    def setUp(self):
        super().setUp()
        self.joiner = _make_user("fs_joiner")
        record_board_event(
            self.board.id, "member.added",
            {"id": 42, "user": {"id": self.joiner.pk}, "role": "member",
             "is_moderator": False, "invite": {"id": 9, "created_by_id": self.owner.pk}},
            actor_id=self.joiner.pk,
        )

    def test_invite_is_readable_by_admins_only(self):
        _make_membership(self.board, self.joiner, MEMBER)
        readers = {**self.readers(), "joiner": self.joiner}
        visible = {"admin", "site_admin"}
        for name, reader in readers.items():
            with self.subTest(reader=name):
                row = self.feed(reader)["results"][0]
                self.assertEqual("invite" in row["data"], name in visible)
                self.assertEqual(row["data"]["role"], "member")

    def test_unknown_role_strips_invite(self):
        row = BoardEventSerializer(BoardEvent.objects.get(board_id=self.board.id), context={}).data
        self.assertNotIn("invite", row["data"])


class FeedSwimlaneRedactionTests(FeedScopingBase):
    def setUp(self):
        super().setUp()
        self.region = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Region", position=0, is_admin_only=False,
        )
        self.tier = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", position=1, is_admin_only=False,
        )
        client = APIClient()
        client.force_authenticate(user=self.owner)
        resp = client.patch(
            f"/api/v1/boards/{self.board.pk}/swimlanes/{self.lane.pk}/",
            {"custom_field_values": [
                {"field_definition": self.region.pk, "value": "EMEA"},
                {"field_definition": self.tier.pk, "value": "Gold"},
            ]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)

    def _values(self, row):
        return {v["field_definition"]: v["value"] for v in row["data"]["custom_field_values"]}

    def _updated_row(self, reader):
        return next(
            r for r in self.feed(reader)["results"] if r["event"] == "swimlane.updated"
        )

    def test_shareable_values_replay_for_every_reader(self):
        for name, reader in self.readers().items():
            with self.subTest(reader=name):
                self.assertEqual(
                    self._values(self._updated_row(reader)),
                    {self.region.pk: "EMEA", self.tier.pk: "Gold"},
                )

    def test_field_marked_admin_only_later_is_not_replayable(self):
        stored = BoardEvent.objects.get(board_id=self.board.id, event="swimlane.updated")
        SwimlaneCustomFieldDefinition.objects.filter(pk=self.tier.pk).update(is_admin_only=True)
        for name, reader in self.readers().items():
            with self.subTest(reader=name):
                self.assertEqual(self._values(self._updated_row(reader)), {self.region.pk: "EMEA"})
        # Read-time only: the stored row is not rewritten.
        stored.refresh_from_db()
        self.assertEqual(len(stored.data["custom_field_values"]), 2)

    def test_field_made_shareable_again_replays_again(self):
        SwimlaneCustomFieldDefinition.objects.filter(pk=self.tier.pk).update(is_admin_only=True)
        SwimlaneCustomFieldDefinition.objects.filter(pk=self.tier.pk).update(is_admin_only=False)
        self.assertIn(self.tier.pk, self._values(self._updated_row(self.viewer)))

    def test_deleted_definition_values_are_not_replayed(self):
        tier_pk = self.tier.pk
        self.tier.delete()
        self.assertNotIn(tier_pk, self._values(self._updated_row(self.member)))

    def test_reordered_and_created_rows_are_filtered_too(self):
        lane_payload = {
            "id": self.lane.pk, "name": "Acme",
            "custom_field_values": [
                {"field_definition": self.region.pk, "value": "EMEA"},
                {"field_definition": self.tier.pk, "value": "Gold"},
            ],
        }
        record_board_event(self.board.id, "swimlane.created", lane_payload)
        record_board_event(self.board.id, "swimlane.reordered", {"swimlanes": [lane_payload]})
        SwimlaneCustomFieldDefinition.objects.filter(pk=self.tier.pk).update(is_admin_only=True)
        for name, reader in self.readers().items():
            with self.subTest(reader=name):
                rows = {r["event"]: r for r in self.feed(reader)["results"]}
                self.assertEqual(self._values(rows["swimlane.created"]), {self.region.pk: "EMEA"})
                lane = rows["swimlane.reordered"]["data"]["swimlanes"][0]
                self.assertEqual([v["field_definition"] for v in lane["custom_field_values"]],
                                 [self.region.pk])

    def test_missing_context_fails_closed(self):
        row = BoardEventSerializer(
            BoardEvent.objects.get(board_id=self.board.id, event="swimlane.updated"),
            context={"role": "admin"},
        ).data
        self.assertEqual(row["data"]["custom_field_values"], [])

    def test_malformed_swimlane_payloads_do_not_500(self):
        for payload in ({"custom_field_values": "x"}, {"swimlanes": ["x", None]},
                        {"custom_field_values": ["x", {"value": 1}]},
                        {"custom_field_values": [
                            {"field_definition": [self.region.pk], "value": 1},
                            {"field_definition": {"id": self.region.pk}, "value": 2},
                            {"field_definition": True, "value": 3},
                            {"field_definition": str(self.region.pk), "value": 4},
                        ]}):
            record_board_event(self.board.id, "swimlane.updated", payload)
        rows = self.feed(self.viewer)["results"]
        unhashable = rows[-1]["data"]
        self.assertEqual(unhashable["custom_field_values"], [])

    def test_events_endpoint_costs_one_extra_query_only_with_swimlane_rows(self):
        """Measured at the HTTP layer: the definition lookup runs once per page
        that holds swimlane rows, and never for a page without them."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        BoardEvent.objects.filter(board_id=self.board.id).delete()
        for n in range(3):
            record_board_event(self.board.id, "card.updated", {"n": n}, actor_id=self.owner.pk)
        with CaptureQueriesContext(connection) as without_lanes:
            self.feed(self.viewer)
        for n in range(3):
            record_board_event(
                self.board.id, "swimlane.updated",
                {"id": self.lane.pk, "custom_field_values": [
                    {"field_definition": self.region.pk, "value": n}]},
                actor_id=self.owner.pk,
            )
        with CaptureQueriesContext(connection) as with_lanes:
            self.feed(self.viewer)
        self.assertEqual(len(with_lanes), len(without_lanes) + 1)
        with self.assertNumQueries(len(with_lanes)):
            self.feed(self.viewer)

    def test_definition_lookup_is_one_query_and_only_for_swimlane_pages(self):
        rows = list(BoardEvent.objects.filter(board_id=self.board.id))
        with self.assertNumQueries(1):
            ids = BoardEventSerializer.shareable_swimlane_field_ids(self.board.id, rows)
        self.assertEqual(ids, {self.region.pk, self.tier.pk})
        card_row = BoardEvent.objects.get(
            pk=record_board_event(self.board.id, "card.updated", {"n": 1})
        )
        with self.assertNumQueries(0):
            BoardEventSerializer.shareable_swimlane_field_ids(self.board.id, [card_row])
