"""``share_link.updated``: the share state reaches admin sessions, and only them (#1967).

``board.updated`` cannot carry the share state: ``ADMIN_ONLY_BOARD_FIELDS``
drops ``share_link_active`` and ``share_token_expires_at`` from every payload
(#1880, #1935). Every write that enables, rotates or clears a link therefore
also records the admin-only ``share_link.updated``:

* the share action (POST enable/rotate, DELETE revoke),
* ``_clear_lapsed`` (an enabler losing admin standing, and the public view
  clearing an unrecorded link),
* the deleted-enabler ``pre_delete`` receiver.

The frame goes to admin / site_admin sockets only, its feed rows go to
admin / site_admin readers only, it is published on commit, and its payload
never carries the token or the enabler.
"""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from django.test import Client, TestCase, override_settings
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.broadcast import (
    BOARD_CHANNEL_EVENTS,
    EVT_SHARE_LINK_UPDATED,
    record_board_event,
)
from boards.consumers import BoardConsumer, _now as board_now
from boards.models import Board, BoardEvent, BoardMembership
from boards.permissions import ADMIN_ONLY_EVENTS, admin_only_event_visible
from boards.services.share_links import revoke_lapsed_share_links, share_link_state_payload

PW = "pw123456!x"
EVENT = "share_link.updated"


def _client(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def _rows(board):
    return list(BoardEvent.objects.filter(board_id=board.pk, event=EVENT).order_by("id"))


class _Fixtures(TestCase):
    def setUp(self):
        patcher = patch("boards.broadcast.broadcast_board_event")
        self.bc = patcher.start()
        self.addCleanup(patcher.stop)

        self.owner = User.objects.create_user(username="owner1967", password=PW)
        self.enabler = User.objects.create_user(username="enabler1967", password=PW)
        self.member = User.objects.create_user(username="member1967", password=PW)
        self.viewer = User.objects.create_user(username="viewer1967", password=PW)
        self.site_admin = User.objects.create_user(
            username="siteadm1967", password=PW, can_access_all_content=True,
        )
        self.board = Board.objects.create(name="B1967", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.enabler_membership = BoardMembership.objects.create(
            board=self.board, user=self.enabler, role=BoardMembership.Role.ADMIN,
        )
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)

    def share(self, method="post", user=None, body=None):
        c = _client(user or self.enabler)
        url = f"/api/v1/boards/{self.board.pk}/share/"
        r = c.post(url, body or {}, format="json") if method == "post" else c.delete(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.board.refresh_from_db()
        return r

    def broadcast_payloads(self):
        return [c.args[2] for c in self.bc.call_args_list if c.args[1] == EVENT]


class RegistryTests(TestCase):
    def test_event_is_registered_and_admin_only(self):
        self.assertEqual(EVT_SHARE_LINK_UPDATED, EVENT)
        self.assertIn(EVENT, BOARD_CHANNEL_EVENTS)
        self.assertIn(EVENT, ADMIN_ONLY_EVENTS)
        self.assertLessEqual(ADMIN_ONLY_EVENTS, BOARD_CHANNEL_EVENTS)

    def test_visibility_is_admin_and_site_admin_only(self):
        expected = {
            "admin": True, "site_admin": True, "member": False,
            "collaborator": False, "viewer": False, None: False, "bogus": False,
        }
        for role, visible in expected.items():
            with self.subTest(role=role):
                self.assertIs(admin_only_event_visible(role), visible)

    def test_visible_roles_are_the_roles_that_may_hold_a_share_link(self):
        """Who receives the share state is exactly who may enable or revoke the link."""
        from boards.permissions import ROLES_WITH_ADMIN_ONLY_EVENT_VISIBILITY
        from boards.services.share_links import SHARE_ADMIN_ROLES

        self.assertEqual(set(ROLES_WITH_ADMIN_ONLY_EVENT_VISIBILITY), set(SHARE_ADMIN_ROLES))


class ShareActionTests(_Fixtures):
    def test_enable_records_active_with_expiry_on_commit(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.share(body={"expires_in_days": 7})
            # Deferred: nothing is published before the transaction commits.
            self.assertEqual(self.broadcast_payloads(), [])
        expected = {
            "board_uid": self.board.uid,
            "active": True,
            "expires_at": self.board.share_token_expires_at.isoformat(),
        }
        [row] = _rows(self.board)
        self.assertEqual(row.data, expected)
        self.assertEqual(row.actor_id, self.enabler.pk)
        self.assertEqual(self.broadcast_payloads(), [expected])
        # Published with the feed row's id and the actor beside the envelope.
        call = next(c for c in self.bc.call_args_list if c.args[1] == EVENT)
        self.assertEqual(call.kwargs["event_id"], row.pk)
        self.assertEqual(call.kwargs["actor_id"], self.enabler.pk)

    def test_enable_without_ttl_records_null_expiry(self):
        self.share()
        self.assertEqual(_rows(self.board)[-1].data["expires_at"], None)
        self.assertIs(_rows(self.board)[-1].data["active"], True)

    def test_board_updated_is_still_recorded_alongside(self):
        """The existing emission is kept (additive change); only the new event carries the state."""
        self.share()
        events = list(
            BoardEvent.objects.filter(board_id=self.board.pk).order_by("id").values_list("event", flat=True)
        )
        self.assertEqual(events, ["board.updated", EVENT])

    def test_revoke_records_inactive(self):
        self.share()
        with self.captureOnCommitCallbacks(execute=True):
            self.share("delete")
        self.assertEqual(
            _rows(self.board)[-1].data,
            {"board_uid": self.board.uid, "active": False, "expires_at": None},
        )
        self.assertEqual(self.broadcast_payloads()[-1]["active"], False)

    def test_rotate_records_a_new_state(self):
        self.share(body={"expires_in_days": 7})
        self.share(user=self.owner, body={"expires_in_days": 30})
        first, second = _rows(self.board)
        self.assertTrue(first.data["active"] and second.data["active"])
        self.assertNotEqual(first.data["expires_at"], second.data["expires_at"])
        self.assertEqual(second.actor_id, self.owner.pk)

    def test_refused_request_records_nothing(self):
        r = _client(self.member).post(f"/api/v1/boards/{self.board.pk}/share/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        r = _client(self.enabler).post(
            f"/api/v1/boards/{self.board.pk}/share/", {"expires_in_days": 3}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(_rows(self.board), [])

    def test_payload_never_carries_the_token_or_the_enabler(self):
        self.share()
        token = str(self.board.share_token)
        for row in _rows(self.board):
            raw = json.dumps(row.data)
            self.assertNotIn(token, raw)
            self.assertNotIn(self.board.share_token_hash, raw)
            self.assertEqual(set(row.data), {"board_uid", "active", "expires_at"})
        for payload in self.broadcast_payloads():
            self.assertNotIn(token, json.dumps(payload))


class ServerDrivenClearTests(_Fixtures):
    def test_lapsed_enabler_records_inactive_on_commit(self):
        self.share()
        self.bc.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            r = _client(self.owner).post(
                f"/api/v1/boards/{self.board.pk}/members/",
                {"user_id": self.enabler.pk, "role": "member"}, format="json",
            )
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
            self.assertEqual(self.broadcast_payloads(), [])
        state = {"board_uid": self.board.uid, "active": False, "expires_at": None}
        self.assertEqual(_rows(self.board)[-1].data, state)
        self.assertEqual(_rows(self.board)[-1].actor_id, self.owner.pk)
        self.assertEqual(self.broadcast_payloads(), [state])

    def test_sweep_that_clears_nothing_records_nothing(self):
        self.share()
        before = len(_rows(self.board))
        self.assertEqual(revoke_lapsed_share_links(board_ids=[self.board.pk]), [])
        self.assertEqual(len(_rows(self.board)), before)

    def test_public_view_clearing_an_unrecorded_link_records_inactive(self):
        self.share()
        token = str(self.board.share_token)
        Board.objects.filter(pk=self.board.pk).update(share_enabled_by=None)
        before = len(_rows(self.board))
        self.assertEqual(APIClient().get(f"/api/share/{token}/").status_code, status.HTTP_404_NOT_FOUND)
        rows = _rows(self.board)
        self.assertEqual(len(rows), before + 1)
        self.assertIs(rows[-1].data["active"], False)

    def test_deleted_enabler_records_inactive(self):
        self.share()
        before = len(_rows(self.board))
        self.enabler.delete()
        rows = _rows(self.board)
        self.assertEqual(len(rows), before + 1)
        self.assertEqual(rows[-1].data, {"board_uid": self.board.uid, "active": False, "expires_at": None})


class StatePayloadTests(TestCase):
    def test_unrecorded_link_reads_inactive(self):
        """Same rule as ``/full/`` share_link_active (#1939): no enabler, no live link."""
        owner = User.objects.create_user(username="sp1967", password=PW)
        board = Board.objects.create(name="SP1967", owner=owner)
        board.issue_share_token()
        board.share_enabled_by = None
        self.assertEqual(share_link_state_payload(board)["active"], False)
        self.assertIsNone(share_link_state_payload(board)["expires_at"])


def _deliver(consumer, payload):
    consumer.send.reset_mock()
    asyncio.run(consumer.board_event({"payload": payload}))
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
    # Served from the access-check cache, so no DB from the consumer thread.
    consumer._access_verified_at = board_now()
    return consumer


class ConsumerDeliveryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="sub1967", password=PW)
        self.board = Board.objects.create(name="C1967", owner=self.user)
        self.frame = {
            "event": EVENT,
            "data": {"board_uid": self.board.uid, "active": False, "expires_at": None},
            "event_id": 12,
        }

    def test_forwarded_to_admin_sockets_only(self):
        expected = {"admin": True, "site_admin": True, "member": False, "collaborator": False, "viewer": False}
        for role, visible in expected.items():
            with self.subTest(role=role):
                consumer = _board_consumer(self.board, self.user, role)
                sent = _deliver(consumer, self.frame)
                if visible:
                    self.assertEqual(sent, self.frame)
                else:
                    self.assertIsNone(sent)
                    # Withheld, not an eviction: the socket stays open.
                    consumer.close.assert_not_called()

    def test_role_is_judged_after_the_access_recheck(self):
        """An admin demoted since the last check is filtered by the re-resolved role."""
        consumer = _board_consumer(self.board, self.user, "admin")
        consumer._access_verified_at = None  # force the re-check
        with patch.object(BoardConsumer, "_refresh_role", AsyncMock(return_value="member")):
            self.assertIsNone(_deliver(consumer, self.frame))
        self.assertEqual(consumer._role, "member")
        consumer.close.assert_not_called()

    def test_other_events_still_reach_non_admins(self):
        frame = {"event": "board.updated", "data": {"id": 1, "name": "x"}}
        self.assertEqual(_deliver(_board_consumer(self.board, self.user, "viewer"), frame), frame)


class FeedScopingTests(_Fixtures):
    def feed(self, user, query=""):
        r = _client(user).get(f"/api/v1/boards/{self.board.pk}/events/{query}")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return r.data["results"]

    def test_rows_are_returned_to_admin_readers_only(self):
        collaborator = User.objects.create_user(username="collab1967", password=PW)
        BoardMembership.objects.create(
            board=self.board, user=collaborator, role=BoardMembership.Role.COLLABORATOR,
        )
        self.share()
        self.share("delete")
        readers = {
            "owner": (self.owner, True), "enabler": (self.enabler, True),
            "site_admin": (self.site_admin, True),
            "member": (self.member, False), "collaborator": (collaborator, False),
            "viewer": (self.viewer, False),
        }
        for name, (reader, visible) in readers.items():
            with self.subTest(reader=name):
                events = [r["event"] for r in self.feed(reader)]
                # board.updated rows reach everyone either way.
                self.assertEqual(events.count("board.updated"), 2)
                self.assertEqual(events.count(EVENT), 2 if visible else 0)
                if visible:
                    states = [r["data"]["active"] for r in self.feed(reader) if r["event"] == EVENT]
                    self.assertEqual(states, [True, False])

    def test_excluded_rows_do_not_shorten_a_page(self):
        for _ in range(3):
            record_board_event(
                self.board.pk, EVENT,
                {"board_uid": self.board.uid, "active": True, "expires_at": None},
                actor_id=self.owner.pk,
            )
        for n in range(3):
            record_board_event(self.board.pk, "card.updated", {"n": n}, actor_id=self.owner.pk)
        rows = self.feed(self.viewer, "?limit=3")
        self.assertEqual([r["data"]["n"] for r in rows], [0, 1, 2])


@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)
class DjangoAdminExpiryEditTests(_Fixtures):
    """The Django admin board form can edit ``share_token_expires_at`` (#1967)."""

    def setUp(self):
        super().setUp()
        root = User.objects.create_superuser(username="root1967", email="root1967@example.com", password=PW)
        self.web = Client()
        self.web.force_login(root)
        # Same pre-existing quirk the #1865 admin tests work around.
        Board.objects.filter(pk=self.board.pk).update(allowed_priorities=["low"])
        self.url = reverse("admin:boards_board_change", args=[self.board.pk])

    def _post(self, **overrides):
        from boards.tests.test_admin_board_concurrent_edits import page_data

        page = self.web.get(self.url)
        self.assertEqual(page.status_code, 200)
        r = self.web.post(self.url, page_data(page, **overrides))
        self.assertEqual(r.status_code, 302, getattr(r, "context", None) and r.context["adminform"].form.errors)
        self.board.refresh_from_db()

    def test_expiry_edit_on_a_live_link_records_the_new_state_on_commit(self):
        self.share()
        before = len(_rows(self.board))
        self.bc.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self._post(share_token_expires_at_0="2999-01-02", share_token_expires_at_1="03:04:05")
            self.assertEqual(self.broadcast_payloads(), [])
        rows = _rows(self.board)
        self.assertEqual(len(rows), before + 1)
        self.assertEqual(rows[-1].data, {
            "board_uid": self.board.uid,
            "active": True,
            "expires_at": self.board.share_token_expires_at.isoformat(),
        })
        self.assertTrue(rows[-1].data["expires_at"].startswith("2999-01-02"))
        self.assertEqual(len(self.broadcast_payloads()), 1)

    def test_save_that_leaves_the_expiry_alone_records_nothing(self):
        self.share()  # never-expiring link
        before = len(_rows(self.board))
        self._post(name="Renamed1967")
        self.assertEqual(self.board.name, "Renamed1967")
        self.assertEqual(len(_rows(self.board)), before)

    def test_expiry_edit_with_no_link_records_nothing(self):
        self._post(share_token_expires_at_0="2999-01-02", share_token_expires_at_1="03:04:05")
        self.assertEqual(_rows(self.board), [])
