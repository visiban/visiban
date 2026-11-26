"""Tests for group-scoped WebSocket broadcasts (#753).

Covers: perform_create, perform_update, destroy, move_group (old + new group),
GroupViewSet.boards POST — each must fire broadcast_group_event via
transaction.on_commit() with event types board.created / board.updated /
board.deleted on the appropriate group channels.
"""
from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership


def _make_group(owner, name="G", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(
        group=group, user=owner, role=GroupMembership.Role.ADMIN
    )
    return group


def _make_board(owner, group=None, name="B"):
    board = Board.objects.create(name=name, owner=owner, group=group)
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN
    )
    return board


class GroupBroadcastWiringTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.group = _make_group(self.user)

    def _group_broadcast_calls(self, mock):
        return [c.args for c in mock.call_args_list]

    def test_boards_post_fires_group_broadcast_on_commit(self):
        """POST /groups/<id>/boards/ must fire broadcast_group_event(board.created)."""
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            # The view sets a nested import of broadcast_group_event inside the
            # closure, so patching groups.broadcast.broadcast_group_event suffices.
            # on_commit is patched to run the callback synchronously.
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                f"/api/v1/groups/{self.group.id}/boards/",
                {"name": "Live Board"},
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[1] == "board.created" and args[0] == self.group.id for args in called))

    def test_board_create_in_group_fires_group_broadcast(self):
        """POST /boards/ with group=<id> fires broadcast_group_event(board.created)."""
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                "/api/v1/boards/", {"name": "X", "group": self.group.id}
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.created" for args in called))

    def test_board_create_without_group_does_not_broadcast_group_event(self):
        """Personal (no-group) board create must NOT trigger a group broadcast."""
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post("/api/v1/boards/", {"name": "Solo"})
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        mock_group.assert_not_called()

    def test_board_update_fires_group_broadcast(self):
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.patch(
                f"/api/v1/boards/{board.id}/", {"name": "Renamed"}
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.updated" for args in called))

    def test_board_delete_fires_group_broadcast(self):
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.delete(f"/api/v1/boards/{board.id}/")
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.deleted" for args in called))

    def test_move_group_fans_out_to_old_and_new_groups(self):
        """A board moved between groups fires board.deleted on the old and
        board.created on the new — in a single on_commit callback."""
        other_group = _make_group(self.user, name="Other")
        board = _make_board(self.user, group=self.group)
        with patch("boards.views.boards.transaction.on_commit") as mock_on_commit, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.post(
                f"/api/v1/boards/{board.id}/move-group/",
                {"group_id": other_group.id},
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # move_group registers exactly one on_commit callback so the old/new
        # broadcasts are atomic from a subscriber's perspective.
        self.assertEqual(mock_on_commit.call_count, 1)
        called = self._group_broadcast_calls(mock_group)
        self.assertTrue(any(args[0] == self.group.id and args[1] == "board.deleted" for args in called))
        self.assertTrue(any(args[0] == other_group.id and args[1] == "board.created" for args in called))

    def test_broadcast_deferred_until_commit(self):
        """Group broadcast must not fire inside the transaction — clients would
        otherwise see state that could still roll back."""
        with patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=False):
                resp = self.client.post(
                    "/api/v1/boards/", {"name": "X", "group": self.group.id}
                )
            self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
            mock_group.assert_not_called()



class GroupUpdateSinglePublishTests(TestCase):
    """PATCH and PUT on a group each publish group.updated exactly once (#1713).

    DRF's partial_update re-enters update(); overriding both once ran the
    update work and the broadcast twice for a PATCH.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.group = _make_group(self.user)

    def _update_publishes(self, method):
        with patch("groups.broadcast.broadcast_group_event") as mock_group, \
             patch("groups.views.GroupViewSet.perform_update", autospec=True,
                   side_effect=lambda view, ser: ser.save()) as mock_perform:
            with self.captureOnCommitCallbacks(execute=True):
                resp = getattr(self.client, method)(
                    f"/api/v1/groups/{self.group.id}/", {"name": "Renamed"},
                )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "Renamed")
        updated = [c for c in mock_group.call_args_list if c.args[1] == "group.updated"]
        self.assertEqual(len(updated), 1)
        self.assertEqual(mock_perform.call_count, 1)

    def test_patch_publishes_group_updated_once(self):
        self._update_publishes("patch")

    def test_put_publishes_group_updated_once(self):
        self._update_publishes("put")

    def test_patch_is_partial(self):
        resp = self.client.patch(f"/api/v1/groups/{self.group.id}/", {"description": "d"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.group.refresh_from_db()
        self.assertEqual(self.group.name, "G")


class BoardGroupChangeViaUpdateTests(TestCase):
    """A PATCH/PUT that changes ``group`` is a group move to group subscribers
    (#1684): board.deleted to the old group, board.created to the new one, the
    same frames move-group sends. Before the fix it sent board.updated to the
    new group only, so the old group kept listing the board and the new group
    got a patch for a board it had never seen.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="owner", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.old = _make_group(self.user, name="Old")
        self.new = _make_group(self.user, name="New")

    def _write(self, method, url, body):
        """Run one request with on_commit callbacks executed, returning the
        response, the group-channel calls, and the board-channel calls."""
        with patch("boards.views.boards._broadcast_group_event") as mock_group, \
             patch("boards.broadcast.broadcast_board_event") as mock_board:
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                resp = getattr(self.client, method)(url, body, format="json")
        group_calls = [c.args for c in mock_group.call_args_list]
        board_calls = [c.args[1] for c in mock_board.call_args_list]
        return resp, group_calls, board_calls, callbacks

    def _patch(self, board, body):
        return self._write("patch", f"/api/v1/boards/{board.id}/", body)

    def test_patch_group_change_moves_board_between_group_channels(self):
        board = _make_board(self.user, group=self.old)
        resp, group_calls, board_calls, callbacks = self._patch(board, {"group": self.new.id})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        # One callback, so the old/new frames go out together (#753).
        self.assertEqual(len(callbacks), 1)
        self.assertEqual(group_calls, [
            (self.old.id, "board.deleted", {"board_uid": str(board.uid), "board_id": board.id}),
            (self.new.id, "board.created", resp.json()),
        ])
        # The board channel still gets its board.updated.
        self.assertEqual(board_calls, ["board.updated"])

    def test_patch_group_to_null_sends_board_deleted_to_old_group_only(self):
        board = _make_board(self.user, group=self.old)
        resp, group_calls, board_calls, _ = self._patch(board, {"group": None})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(group_calls, [
            (self.old.id, "board.deleted", {"board_uid": str(board.uid), "board_id": board.id}),
        ])
        self.assertEqual(board_calls, ["board.updated"])

    def test_patch_personal_board_into_group_sends_board_created_only(self):
        board = _make_board(self.user, group=None)
        resp, group_calls, board_calls, _ = self._patch(board, {"group": self.new.id})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(group_calls, [(self.new.id, "board.created", resp.json())])
        self.assertEqual(board_calls, ["board.updated"])

    def test_patch_without_group_change_sends_only_board_updated(self):
        board = _make_board(self.user, group=self.old)
        resp, group_calls, board_calls, _ = self._patch(board, {"name": "Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(group_calls, [(self.old.id, "board.updated", resp.json())])
        self.assertEqual(board_calls, ["board.updated"])

    def test_patch_echoing_current_group_is_not_a_move(self):
        board = _make_board(self.user, group=self.old)
        resp, group_calls, _, _ = self._patch(board, {"group": self.old.id, "name": "R"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual([c[:2] for c in group_calls], [(self.old.id, "board.updated")])

    def test_put_group_change_moves_board_between_group_channels(self):
        board = _make_board(self.user, group=self.old)
        resp, group_calls, _, _ = self._write(
            "put", f"/api/v1/boards/{board.id}/", {"name": board.name, "group": self.new.id},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual([c[:2] for c in group_calls], [
            (self.old.id, "board.deleted"), (self.new.id, "board.created"),
        ])

    def test_patch_personal_board_without_group_sends_no_group_events(self):
        board = _make_board(self.user, group=None)
        resp, group_calls, board_calls, _ = self._patch(board, {"name": "Renamed"})
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(group_calls, [])
        self.assertEqual(board_calls, ["board.updated"])

    def test_patch_and_move_group_send_the_same_group_frames(self):
        """Both endpoints share one helper; guard against them drifting apart."""
        a = _make_board(self.user, group=self.old, name="A")
        b = _make_board(self.user, group=self.old, name="B")
        _, via_patch, _, _ = self._patch(a, {"group": self.new.id})
        resp, via_move, _, _ = self._write(
            "post", f"/api/v1/boards/{b.id}/move-group/", {"group_id": self.new.id},
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.assertEqual(via_move, [
            (self.old.id, "board.deleted", {"board_uid": str(b.uid), "board_id": b.id}),
            (self.new.id, "board.created", resp.json()),
        ])
        self.assertEqual([c[:2] for c in via_patch], [c[:2] for c in via_move])
        self.assertEqual(set(via_patch[0][2]), set(via_move[0][2]))


class GroupMembershipBroadcastNamingTests(TestCase):
    """Group membership events use the member.* naming that mirrors the board
    channel (member.added / member.updated), so a single frontend socket layer
    handles both channels. Guards against reverting to the membership.* names.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="g_owner", password="pass")
        self.member = User.objects.create_user(username="g_member", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.group = _make_group(self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.member, role=GroupMembership.Role.MEMBER
        )

    def test_role_update_fires_member_updated(self):
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.patch(
                f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
                {"role": GroupMembership.Role.ADMIN},
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        called = [c.args for c in mock_group.call_args_list]
        self.assertTrue(
            any(args[0] == self.group.id and args[1] == "member.updated" for args in called),
            f"expected a member.updated broadcast on the group channel, got {called}",
        )

    def test_member_removal_fires_member_removed_on_group_channel(self):
        """DELETE of a real membership emits member.removed on the group channel
        so other admins' members panels converge in real time (#1051)."""
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn, **kwargs: fn()
            resp = self.client.delete(
                f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
            )
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        called = [c.args for c in mock_group.call_args_list]
        self.assertTrue(
            any(
                args[0] == self.group.id
                and args[1] == "member.removed"
                and args[2].get("user_id") == self.member.id
                for args in called
            ),
            f"expected member.removed on the group channel, got {called}",
        )

    def test_idempotent_member_removal_does_not_broadcast(self):
        """A DELETE for a user with no membership row answers 404 and must not broadcast — there
        is no state change for other admins to converge on (#1051)."""
        GroupMembership.objects.filter(group=self.group, user=self.member).delete()
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.delete(
                f"/api/v1/groups/{self.group.id}/members/{self.member.id}/",
            )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        called = [c.args for c in mock_group.call_args_list]
        self.assertFalse(
            any(args[1] == "member.removed" for args in called),
            f"idempotent removal must not broadcast member.removed, got {called}",
        )


class GroupInviteLinkRevokeBroadcastTests(TestCase):
    """Revoking an invite link emits an additive invite_link.revoked event on the
    group channel, deferred to on_commit, so other admins' invite panels converge
    in real time (#1051)."""

    def setUp(self):
        from groups.models import GroupInviteLink
        self.admin = User.objects.create_user(username="il_admin", password="pass")
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.group = _make_group(self.admin)
        self.link, _ = GroupInviteLink.generate(group=self.group, created_by=self.admin)

    def _revoke_url(self):
        return f"/api/v1/groups/{self.group.id}/invite-links/{self.link.id}/"

    def test_revoke_fires_invite_link_revoked(self):
        with patch("groups.views.transaction.on_commit") as mock_on_commit, \
             patch("groups.broadcast.broadcast_group_event") as mock_group:
            mock_on_commit.side_effect = lambda fn: fn()
            resp = self.client.delete(self._revoke_url())
        self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
        called = [c.args for c in mock_group.call_args_list]
        self.assertTrue(
            any(
                args[0] == self.group.id
                and args[1] == "invite_link.revoked"
                and args[2].get("id") == self.link.id
                for args in called
            ),
            f"expected invite_link.revoked on the group channel, got {called}",
        )

    def test_revoke_broadcast_deferred_until_commit(self):
        """The broadcast must be registered via on_commit, never fired inline."""
        with patch("groups.broadcast.broadcast_group_event") as mock_group:
            resp = self.client.delete(self._revoke_url())
            self.assertEqual(resp.status_code, status.HTTP_204_NO_CONTENT)
            # on_commit is NOT patched here, so within the test's outer transaction
            # the callback never runs — proving the broadcast is deferred.
            mock_group.assert_not_called()
