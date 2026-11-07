"""Group placement re-checks the caller's group standing inside the write transaction (#2115).

``PATCH``/``PUT /boards/{id}/`` already judged the group rule again inside the
transaction (``recheck_group_under_lock``). Every other placement did its admin
check before the transaction and nothing after: board create with a ``group``,
``POST /groups/{id}/boards/``, ``POST /boards/{id}/move-group/`` and the JSON,
CSV and Trello imports. Each now judges the caller again, against the group and
memberships read again after the group lock, so a role change or a re-parenting
that committed since the first check refuses the placement and writes nothing.

This is a fresh read, not a lock interaction: the placement lock is
``FOR KEY SHARE`` and a demotion takes ``FOR NO KEY UPDATE``, which do not
conflict, so a placement never waits on a demotion.

* ``DeterministicRecheckTests`` changes the caller's role, or the group's
  parent, inside the lock call, so the gap is exercised on any database.
* ``ConcurrentRecheckTests`` is PostgreSQL only: a holder keeps the group row
  ``FOR UPDATE`` so the request is parked inside its transaction
  (``assert_blocked_on_lock``), a demotion commits, then the holder lets go. It
  proves the re-read sees a change committed before it, not lock interaction.
"""
import io
import json
import threading
from unittest import mock, skipUnless

from django.core.cache import cache
from django.db import connection, connections, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board
from boards.tests.lock_wait import assert_blocked_on_lock
from groups.models import Group, GroupMembership

ADMIN = GroupMembership.Role.ADMIN
MEMBER = GroupMembership.Role.MEMBER
WAIT = 10

JSON_URL = "/api/v1/boards/import/"
TRELLO_URL = "/api/v1/boards/import/trello/?confirm=true"


def _json_file():
    data = {
        "name": "Imp",
        "columns": [{"name": "To Do", "position": 0}],
        "swimlanes": [{"name": "General", "position": 0}],
        "labels": [],
        "cards": [{"title": "A", "column": "To Do", "swimlane": "General", "position": 0}],
    }
    f = io.BytesIO(json.dumps(data).encode())
    f.name = "board.json"
    return f


def _csv_file():
    f = io.BytesIO(b"Title,Column,Swimlane\nA,To Do,General\n")
    f.name = "board.csv"
    return f


def _trello_file():
    data = {
        "name": "T",
        "lists": [{"id": "l1", "name": "To Do", "closed": False, "pos": 1}],
        "cards": [{
            "id": "c1", "name": "A", "idList": "l1", "closed": False, "pos": 1,
            "desc": "", "idLabels": [], "idMembers": [], "idChecklists": [],
        }],
        "labels": [], "checklists": [], "members": [], "actions": [],
    }
    f = io.BytesIO(json.dumps(data).encode())
    f.name = "trello.json"
    return f


class _PlacementPathsMixin:
    """The placement requests, each ending in a board in ``self.group`` on success."""

    PATHS = ("create", "group_create", "move", "patch", "import_json", "import_csv", "import_trello")

    def _make_actor(self, suffix):
        cache.clear()
        self.owner = User.objects.create_user(username=f"owner_{suffix}", password="x")
        self.actor = User.objects.create_user(username=f"actor_{suffix}", password="x")
        self.group = Group.objects.create(name=f"Team {suffix}", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.actor, role=ADMIN)
        self.group_id = self.group.pk

    def _demote(self):
        GroupMembership.objects.filter(group_id=self.group_id, user=self.actor).update(role=MEMBER)

    def _client(self):
        client = APIClient()
        client.force_authenticate(User.objects.get(pk=self.actor.pk))
        return client

    def _request(self, path, board_id=None):
        client = self._client()
        if path == "create":
            return client.post("/api/v1/boards/", {"name": "New", "group": self.group_id}, format="json")
        if path == "group_create":
            return client.post(f"/api/v1/groups/{self.group_id}/boards/", {"name": "New"}, format="json")
        if path == "move":
            return client.post(
                f"/api/v1/boards/{board_id}/move-group/", {"group_id": self.group_id}, format="json"
            )
        if path == "patch":
            return client.patch(f"/api/v1/boards/{board_id}/", {"group": self.group_id}, format="json")
        files = {"import_json": _json_file, "import_csv": _csv_file, "import_trello": _trello_file}
        url = TRELLO_URL if path == "import_trello" else JSON_URL
        return client.post(url, {"file": files[path](), "group_id": self.group_id}, format="multipart")

    def _lock_patch_target(self, path):
        # move and create take the lock through boards.views.boards' own
        # import; the group board create and the imports import it from
        # groups.services at call time.
        if path in ("create", "move", "patch"):
            return "boards.views.boards.lock_group_for_board_placement"
        return "groups.services.lock_group_for_board_placement"

    def _assert_refused(self, path, resp):
        expected = 400 if path in ("create", "patch") else 403
        self.assertEqual(resp.status_code, expected, (path, resp.status_code))
        if path in ("create", "patch"):
            self.assertEqual(list(resp.json()), ["group"])
        self.assertFalse(
            Board.objects.filter(group_id=self.group_id).exists(), f"{path}: a board was placed"
        )

    def _prepare(self, path):
        """The board a move or PATCH acts on (none for the other paths)."""
        if path in ("move", "patch"):
            return Board.objects.create(name="Mine", owner=self.actor).pk
        return None


class DeterministicRecheckTests(_PlacementPathsMixin, TestCase):
    def setUp(self):
        self._make_actor("det")

    def test_demotion_during_lock_refuses_every_placement_path(self):
        from groups.services import lock_group_for_board_placement as real_lock

        for path in self.PATHS:
            with self.subTest(path=path):
                board_id = self._prepare(path)

                def lock_then_demote(group_id, _real=real_lock):
                    held = _real(group_id)
                    self._demote()
                    return held

                with mock.patch(self._lock_patch_target(path), side_effect=lock_then_demote):
                    resp = self._request(path, board_id)
                self._assert_refused(path, resp)
                GroupMembership.objects.filter(group_id=self.group_id, user=self.actor).update(role=ADMIN)

    def test_admin_who_stays_admin_still_places_on_every_path(self):
        expected = {"create": 201, "group_create": 201, "move": 200, "patch": 200,
                    "import_json": 201, "import_csv": 201, "import_trello": 201}
        for path in self.PATHS:
            with self.subTest(path=path):
                Board.objects.filter(group_id=self.group_id).delete()
                board_id = self._prepare(path)
                resp = self._request(path, board_id)
                self.assertEqual(resp.status_code, expected[path], (path, getattr(resp, "content", b"")[:200]))
                self.assertTrue(Board.objects.filter(group_id=self.group_id).exists())


class ReparentRecheckTests(_PlacementPathsMixin, TestCase):
    """The caller administers only an ancestor; the group leaves it inside the lock call.

    The check walks the group's parent chain, so it must walk the chain as
    stored after the lock, not the one loaded before the transaction.
    """

    def setUp(self):
        self._make_actor("rep")
        # Admin of the parent only; the target group is its child.
        self.parent = self.group
        GroupMembership.objects.filter(group=self.parent, user=self.actor).update(role=ADMIN)
        self.child = Group.objects.create(name="Child rep", owner=self.owner, parent=self.parent)
        self.group_id = self.child.pk
        self.group = self.child

    def test_reparent_during_lock_refuses_every_placement_path(self):
        from groups.services import lock_group_for_board_placement as real_lock

        for path in self.PATHS:
            with self.subTest(path=path):
                Group.objects.filter(pk=self.child.pk).update(parent=self.parent)
                board_id = self._prepare(path)

                def lock_then_reparent(group_id, _real=real_lock):
                    held = _real(group_id)
                    Group.objects.filter(pk=self.child.pk).update(parent=None)
                    return held

                with mock.patch(self._lock_patch_target(path), side_effect=lock_then_reparent):
                    resp = self._request(path, board_id)
                self._assert_refused(path, resp)


@skipUnless(connection.vendor == "postgresql", "row locks need PostgreSQL")
class ConcurrentRecheckTests(_PlacementPathsMixin, TransactionTestCase):
    def setUp(self):
        self._make_actor("conc")

    def _hold_group_row(self, locked, release, results):
        def run():
            try:
                with transaction.atomic():
                    Group.objects.select_for_update().get(pk=self.group_id)
                    locked.set()
                    release.wait(WAIT)
            except Exception as exc:  # surfaced by the assertions
                results["holder"] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name="holder-2115")
        t.start()
        return t

    def test_change_committed_while_request_is_parked_is_seen_by_reread_on_every_path(self):
        for path in self.PATHS:
            with self.subTest(path=path):
                board_id = self._prepare(path)
                results = {}
                locked, release = threading.Event(), threading.Event()
                holder = self._hold_group_row(locked, release, results)
                try:
                    self.assertTrue(locked.wait(WAIT))

                    def request_thread(_path=path, _board=board_id):
                        try:
                            results["resp"] = self._request(_path, _board)
                        except Exception as exc:  # surfaced by the assertions
                            results["resp"] = exc
                        finally:
                            connections.close_all()

                    requester = threading.Thread(target=request_thread, name=f"req-2115-{path}")
                    requester.start()
                    # The request passed its pre-lock checks and now waits on
                    # the group row; the demotion lands in that gap.
                    assert_blocked_on_lock(self, requester, f"{path} waits on the group row")
                    self._demote()
                finally:
                    release.set()
                    holder.join(WAIT)
                requester.join(WAIT)
                self.assertFalse(requester.is_alive(), f"{path}: request did not finish")
                self.assertNotIn("holder", results)
                resp = results["resp"]
                self.assertNotIsInstance(resp, Exception, resp)
                self._assert_refused(path, resp)
                GroupMembership.objects.filter(group_id=self.group_id, user=self.actor).update(role=ADMIN)
