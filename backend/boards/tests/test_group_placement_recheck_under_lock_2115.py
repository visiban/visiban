"""Group placement re-checks the caller's group standing after the group lock (#2115).

``PATCH``/``PUT /boards/{id}/`` already judged the group rule again once the
group row was held (``recheck_group_under_lock``). Every other placement did
its admin check before the lock and nothing after it: board create with a
``group``, ``POST /groups/{id}/boards/``, ``POST /boards/{id}/move-group/`` and
the JSON, CSV and Trello imports. Each now judges the caller again with the
group held, so a demotion that commits while the request waits on the lock
refuses the placement and writes nothing.

* ``DeterministicRecheckTests`` demotes the caller inside the lock call, so the
  gap is exercised on any database.
* ``ConcurrentRecheckTests`` is PostgreSQL only (SQLite has no row locks): a
  holder keeps the group row ``FOR UPDATE``, the request waits on it
  (``assert_blocked_on_lock``), the demotion commits, then the holder lets go.
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
    """The six placement requests, each ending in a board in ``self.group`` on success."""

    PATHS = ("create", "group_create", "move", "import_json", "import_csv", "import_trello")

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
        files = {"import_json": _json_file, "import_csv": _csv_file, "import_trello": _trello_file}
        url = TRELLO_URL if path == "import_trello" else JSON_URL
        return client.post(url, {"file": files[path](), "group_id": self.group_id}, format="multipart")

    def _lock_patch_target(self, path):
        # move and create take the lock through boards.views.boards' own
        # import; the group board create and the imports import it from
        # groups.services at call time.
        if path in ("create", "move"):
            return "boards.views.boards.lock_group_for_board_placement"
        return "groups.services.lock_group_for_board_placement"

    def _assert_refused(self, path, resp):
        expected = 400 if path == "create" else 403
        self.assertEqual(resp.status_code, expected, (path, resp.status_code))
        if path == "create":
            self.assertEqual(list(resp.json()), ["group"])
        self.assertFalse(
            Board.objects.filter(group_id=self.group_id).exists(), f"{path}: a board was placed"
        )

    def _prepare(self, path):
        """The board a move acts on (none for the other paths)."""
        if path == "move":
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
        expected = {"create": 201, "group_create": 201, "move": 200,
                    "import_json": 201, "import_csv": 201, "import_trello": 201}
        for path in self.PATHS:
            with self.subTest(path=path):
                Board.objects.filter(group_id=self.group_id).delete()
                board_id = self._prepare(path)
                resp = self._request(path, board_id)
                self.assertEqual(resp.status_code, expected[path], (path, getattr(resp, "content", b"")[:200]))
                self.assertTrue(Board.objects.filter(group_id=self.group_id).exists())


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

    def test_demotion_between_validation_and_lock_refuses_every_placement_path(self):
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
