"""The ``board.updated`` recording a share-state change has no actor (#2043).

Every write that enables, rotates or clears a share link records this row, and
the row stays for clients that treat it as a "board changed" signal. It has a
null ``actor_id`` and ``actor`` in the change feed, its channel-layer message
has no ``actor_id``, and ``is_starred`` is omitted. A group change that clears
a link also records its own ordinary ``board.updated``, and that one keeps its
actor.
"""

import inspect
import json
from unittest.mock import patch

from django.test import Client, TestCase, override_settings
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardEvent, BoardFavorite, BoardMembership
from boards.services.feed import feed_queryset, serialize_feed_rows
from boards.services.share_links import revoke_lapsed_share_links
from boards.tests.test_actor_scoped_event_fields import _deliver, _RecordingLayer
from boards.tests.test_event_payload_scoping import _board_consumer
from groups.models import Group, GroupMembership

PW = "pw123456!x"
EVENT = "board.updated"


def _client(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


class _Fixtures(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="owner2043", password=PW)
        self.enabler = User.objects.create_user(username="enabler2043", password=PW)
        self.member = User.objects.create_user(username="member2043", password=PW)
        self.site_admin = User.objects.create_user(username="siteadm2043", password=PW, is_staff=True)
        User.objects.filter(pk=self.site_admin.pk).update(is_site_admin=True)
        self.site_admin.refresh_from_db()
        self.group = Group.objects.create(name="G2043", owner=self.owner)
        GroupMembership.objects.get_or_create(
            group=self.group, user=self.owner, defaults={"role": GroupMembership.Role.ADMIN},
        )
        self.board = Board.objects.create(name="B2043", owner=self.owner, group=self.group)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        self.enabler_membership = BoardMembership.objects.create(
            board=self.board, user=self.enabler, role=BoardMembership.Role.ADMIN,
        )
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        # The caller's own star must not reach the row, the frame or the feed.
        BoardFavorite.objects.create(user=self.enabler, board=self.board)

    def url(self, suffix=""):
        return f"/api/v1/boards/{self.board.pk}/{suffix}"

    def enable(self, user=None):
        r = _client(user or self.enabler).post(self.url("share/"), {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.board.refresh_from_db()
        return r

    def run_recording(self, call, expected_status=status.HTTP_200_OK):
        """Run *call*; return (new board.updated rows, every message it published)."""
        last = BoardEvent.objects.order_by("-id").values_list("id", flat=True).first() or 0
        layer = _RecordingLayer()
        with patch("boards.broadcast.get_channel_layer", return_value=layer), \
             patch("groups.broadcast.get_channel_layer", return_value=layer):
            with self.captureOnCommitCallbacks(execute=True):
                response = call()
        if response is not None:
            self.assertEqual(response.status_code, expected_status, getattr(response, "content", None))
        rows = list(
            BoardEvent.objects.filter(id__gt=last, board_id=self.board.pk, event=EVENT).order_by("id"),
        )
        return rows, layer.sent

    def feed_row(self, reader, row_id):
        results = _client(reader).get(self.url("events/")).data["results"]
        return next(r for r in results if r["id"] == row_id)

    def assert_no_actor(self, row, sent):
        """*row* and the frame that publishes it have no actor, on every surface."""
        self.assertIsNone(row.actor_id)
        self.assertNotIn("is_starred", row.data)
        # The change-feed row, for the caller and for a member.
        for reader in (self.owner, self.member):
            served = self.feed_row(reader, row.pk)
            self.assertIsNone(served["actor_id"])
            self.assertIsNone(served["actor"])
            self.assertNotIn("is_starred", served["data"])
            self.assertEqual(served["data"]["id"], self.board.pk)
        # The webhook body is the same serialized row, at its fixed reader.
        board_rows = feed_queryset(self.board.pk, role="viewer", reader_id=None).filter(pk=row.pk)
        [delivered] = serialize_feed_rows(self.board.pk, board_rows, role="viewer", reader_id=None)
        self.assertIsNone(delivered["actor_id"])
        self.assertIsNone(delivered["actor"])
        # The frame: only the board channel, with no actor beside the envelope.
        [(channel, message)] = [
            (g, m) for g, m in sent
            if m["payload"]["event"] == EVENT and m["payload"].get("event_id") == row.pk
        ]
        self.assertEqual(channel, f"board_{self.board.pk}")
        self.assertNotIn("actor_id", message)
        self.assertEqual(set(message["payload"]), {"event", "data", "event_id"})
        for user, role in ((self.enabler, "admin"), (self.owner, "admin"), (self.member, "member")):
            frame = _deliver(_board_consumer(self.board, user, role), "board_event", message)
            self.assertEqual(frame["event"], EVENT)
            self.assertNotIn("is_starred", frame["data"])
            self.assertEqual(frame["data"]["id"], self.board.pk)


class ShareActionTests(_Fixtures):
    def test_post_records_a_row_with_no_actor(self):
        rows, sent = self.run_recording(lambda: _client(self.enabler).post(self.url("share/"), {}, format="json"))
        self.assertEqual(len(rows), 1)
        self.assert_no_actor(rows[0], sent)

    def test_rotate_records_a_row_with_no_actor(self):
        self.enable()
        rows, sent = self.run_recording(lambda: _client(self.owner).post(self.url("share/"), {}, format="json"))
        self.assertEqual(len(rows), 1)
        self.assert_no_actor(rows[0], sent)

    def test_delete_records_a_row_with_no_actor(self):
        self.enable()
        rows, sent = self.run_recording(lambda: _client(self.enabler).delete(self.url("share/")))
        self.assertEqual(len(rows), 1)
        self.assert_no_actor(rows[0], sent)

    def test_no_frame_reaches_the_group_channel(self):
        _, sent = self.run_recording(lambda: _client(self.enabler).post(self.url("share/"), {}, format="json"))
        self.assertEqual([g for g, _m in sent if g.startswith("group_")], [])

    def test_caller_reads_its_star_from_the_board_detail(self):
        """The caller's own value is on the board detail."""
        self.enable()
        r = _client(self.enabler).get(self.url())
        self.assertIs(r.data["is_starred"], True)

    def test_recording_does_not_touch_other_rows(self):
        other = BoardEvent.objects.create(
            board_id=self.board.pk, event=EVENT, actor_id=self.owner.pk,
            data={"id": self.board.pk, "name": self.board.name},
        )
        self.enable()
        other.refresh_from_db()
        self.assertEqual(other.actor_id, self.owner.pk)


class ServerSideClearTests(_Fixtures):
    """Every route through ``_clear_lapsed`` and the deleted-enabler receiver."""

    def make_group_derived_enabler(self):
        """The enabler holds admin only through the group, so a group change ends it."""
        self.enabler_membership.delete()
        GroupMembership.objects.create(group=self.group, user=self.enabler, role=GroupMembership.Role.ADMIN)
        self.enable()

    def assert_group_change_rows(self, rows, sent, actor):
        """One row for the clear with no actor, then the group change's own row."""
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertEqual(len(rows), 2)
        cleared, ordinary = rows
        self.assert_no_actor(cleared, sent)
        self.assertEqual(ordinary.actor_id, actor.pk)
        self.assertEqual(self.feed_row(self.member, ordinary.pk)["actor"]["id"], actor.pk)
        [message] = [m for _g, m in sent if m["payload"].get("event_id") == ordinary.pk]
        self.assertEqual(message["actor_id"], actor.pk)

    def test_group_change_through_patch(self):
        self.make_group_derived_enabler()
        rows, sent = self.run_recording(
            lambda: _client(self.owner).patch(self.url(), {"group": None}, format="json"),
        )
        self.assert_group_change_rows(rows, sent, self.owner)

    def test_group_change_through_move_group(self):
        self.make_group_derived_enabler()
        rows, sent = self.run_recording(
            lambda: _client(self.owner).post(self.url("move-group/"), {"group_id": None}, format="json"),
        )
        self.assert_group_change_rows(rows, sent, self.owner)

    def assert_single_clear(self, rows, sent):
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertEqual(len(rows), 1)
        self.assert_no_actor(rows[0], sent)

    def test_enabler_deactivated(self):
        self.enable()
        rows, sent = self.run_recording(
            lambda: _client(self.site_admin).post(
                f"/api/v1/admin/users/{self.enabler.pk}/deactivate/", {}, format="json",
            ),
        )
        self.assert_single_clear(rows, sent)

    def test_enabler_removed_from_the_board(self):
        self.enable()
        rows, sent = self.run_recording(
            lambda: _client(self.owner).delete(self.url(f"members/{self.enabler.pk}/")),
            expected_status=status.HTTP_204_NO_CONTENT,
        )
        self.assert_single_clear(rows, sent)

    def test_enabler_demoted_on_the_board(self):
        self.enable()
        rows, sent = self.run_recording(
            lambda: _client(self.owner).post(
                self.url("members/"), {"user_id": self.enabler.pk, "role": "member"}, format="json",
            ),
        )
        self.assert_single_clear(rows, sent)

    def test_enabler_group_role_lowered(self):
        self.make_group_derived_enabler()
        rows, sent = self.run_recording(
            lambda: _client(self.owner).patch(
                f"/api/v1/groups/{self.group.pk}/members/{self.enabler.pk}/",
                {"role": "member"}, format="json",
            ),
        )
        self.assert_single_clear(rows, sent)

    def test_enabler_deleted(self):
        self.enable()

        def delete_enabler():
            self.enabler.delete()

        rows, sent = self.run_recording(delete_enabler)
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertIsNone(row.actor_id)
        self.assertNotIn("is_starred", row.data)
        [message] = [m for _g, m in sent if m["payload"].get("event_id") == row.pk]
        self.assertNotIn("actor_id", message)

    def test_public_view_clear(self):
        token = str(self.enable().data["share_token"])
        BoardMembership.objects.filter(pk=self.enabler_membership.pk).update(role=BoardMembership.Role.MEMBER)
        rows, sent = self.run_recording(
            lambda: APIClient().get(f"/api/share/{token}/"),
            expected_status=status.HTTP_404_NOT_FOUND,
        )
        self.assert_single_clear(rows, sent)

    def test_sweep_takes_no_actor(self):
        self.assertNotIn("actor_id", inspect.signature(revoke_lapsed_share_links).parameters)

    def test_feed_row_names_no_user(self):
        rows, _sent = self.run_recording(lambda: _client(self.enabler).post(self.url("share/"), {}, format="json"))
        served = self.feed_row(self.member, rows[0].pk)
        self.assertNotIn(self.enabler.username, json.dumps(served, default=str))


@override_settings(
    STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
)
class DjangoAdminClearTests(_Fixtures):
    def setUp(self):
        super().setUp()
        self.root = User.objects.create_superuser(username="root2043", email="root2043@example.com", password=PW)
        self.web = Client()
        self.web.force_login(self.root)
        # Same pre-existing quirk the #1865 admin tests work around.
        Board.objects.filter(pk=self.board.pk).update(allowed_priorities=["low"])

    def test_membership_delete(self):
        self.enable()
        rows, sent = self.run_recording(
            lambda: self.web.post(
                reverse("admin:boards_boardmembership_delete", args=[self.enabler_membership.pk]),
                {"post": "yes"},
            ),
            expected_status=status.HTTP_302_FOUND,
        )
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].actor_id)
        [message] = [m for _g, m in sent if m["payload"].get("event_id") == rows[0].pk]
        self.assertNotIn("actor_id", message)

    def test_board_group_change_keeps_the_actor_on_the_ordinary_row(self):
        from boards.tests.test_admin_board_concurrent_edits import page_data

        self.enabler_membership.delete()
        GroupMembership.objects.create(group=self.group, user=self.enabler, role=GroupMembership.Role.ADMIN)
        self.enable()
        url = reverse("admin:boards_board_change", args=[self.board.pk])
        page = self.web.get(url)
        self.assertEqual(page.status_code, 200)
        rows, sent = self.run_recording(
            lambda: self.web.post(url, page_data(page, group="")),
            expected_status=status.HTTP_302_FOUND,
        )
        self.board.refresh_from_db()
        self.assertIsNone(self.board.share_token)
        self.assertEqual(len(rows), 2)
        cleared, ordinary = rows
        self.assertIsNone(cleared.actor_id)
        self.assertEqual(ordinary.actor_id, self.root.pk)
        [message] = [m for _g, m in sent if m["payload"].get("event_id") == cleared.pk]
        self.assertNotIn("actor_id", message)
