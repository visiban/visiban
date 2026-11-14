"""Health status change history (#2242).

Covers the explicit set-or-confirm action (``POST .../health-status/``), the
history read (``GET .../health-history/``), the generic writers that record a
change only when the value differs (PATCH, create, Django admin), the
last-change read fields on board and group responses, navigation-only
withholding, account deletion (``SET_NULL``), the board.updated / group.updated
broadcast, and an entry-point pin of every writer.
"""
from unittest.mock import patch

from django.contrib.admin.sites import AdminSite
from django.utils import timezone
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import User
from accounts.tests.test_auth_entry_points import required_call_violations
from boards.admin import BoardAdmin
from boards.models import Board, BoardHealthChange, BoardMembership
from boards.serializers import PublicBoardSerializer
from groups.health_history import HEALTH_HISTORY_LIMIT, record_health_change
from groups.models import Group, GroupHealthChange, GroupMembership

BOARD_BROADCAST = "boards.broadcast.broadcast_board_event"
GROUP_BROADCAST = "groups.broadcast.broadcast_group_event"
NEW_FIELDS = ("health_status_changed_at", "health_status_changed_by", "health_status_note")


def _client(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


class BoardHealthHistoryTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="priya", password="pw", display_name="Priya")
        self.member = User.objects.create_user(username="mem", password="pw")
        self.viewer = User.objects.create_user(username="view", password="pw")
        self.collab = User.objects.create_user(username="collab", password="pw")
        self.outsider = User.objects.create_user(username="out", password="pw")
        self.board = Board.objects.create(name="B", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        BoardMembership.objects.create(board=self.board, user=self.collab, role=BoardMembership.Role.COLLABORATOR)
        self.url = f"/api/v1/boards/{self.board.pk}/"

    def _post(self, body, user=None):
        return _client(user or self.admin).post(f"{self.url}health-status/", body, format="json")

    def _history(self, user=None):
        return _client(user or self.admin).get(f"{self.url}health-history/")

    def test_set_records_from_to_by_at_note_and_read_fields(self):
        r = self._post({"status": "at_risk", "note": "  vendor slipped\nAPI delivery  "})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["health_status"], "at_risk")
        self.assertEqual(body["health_status_note"], "vendor slipped API delivery")
        self.assertEqual(body["health_status_changed_by"]["id"], self.admin.pk)
        self.assertEqual(body["health_status_changed_by"]["display_name"], "Priya")
        self.assertIsNotNone(body["health_status_changed_at"])
        change = BoardHealthChange.objects.get(board=self.board)
        self.assertEqual((change.from_status, change.to_status), (None, "at_risk"))
        self.assertEqual(change.changed_by, self.admin)
        self.assertEqual(change.note, "vendor slipped API delivery")
        self.board.refresh_from_db()
        self.assertEqual(self.board.health_status_changed_at, change.changed_at)
        # The read fields are on detail and list responses too.
        detail = _client(self.viewer).get(self.url).json()
        listed = [b for b in _client(self.viewer).get("/api/v1/boards/").json()["results"] if b["id"] == self.board.pk][0]
        full = _client(self.viewer).get(f"{self.url}full/").json()
        for payload in (detail, listed, full):
            self.assertEqual(payload["health_status_note"], "vendor slipped API delivery")
            self.assertEqual(payload["health_status_changed_by"]["id"], self.admin.pk)

    def test_reconfirm_only_through_the_action(self):
        self._post({"status": "on_track"})
        first = Board.objects.get(pk=self.board.pk).health_status_changed_at
        # PATCH of the same value records nothing and keeps the timestamp.
        r = _client(self.admin).patch(self.url, {"health_status": "on_track"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(BoardHealthChange.objects.count(), 1)
        self.assertEqual(Board.objects.get(pk=self.board.pk).health_status_changed_at, first)
        # The action records a reconfirm (from == to) and refreshes it.
        r = self._post({"status": "on_track", "note": "checked with vendor"})
        self.assertEqual(r.status_code, 200)
        latest = BoardHealthChange.objects.order_by("-id").first()
        self.assertEqual((latest.from_status, latest.to_status), ("on_track", "on_track"))
        self.assertGreaterEqual(latest.changed_at, first)
        self.assertEqual(r.json()["health_status_note"], "checked with vendor")

    def test_patch_change_records_without_note(self):
        self._post({"status": "on_track", "note": "kickoff"})
        r = _client(self.admin).patch(self.url, {"health_status": "off_track"}, format="json")
        self.assertEqual(r.status_code, 200)
        latest = BoardHealthChange.objects.order_by("-id").first()
        self.assertEqual((latest.from_status, latest.to_status, latest.note), ("on_track", "off_track", None))
        self.assertIsNone(r.json()["health_status_note"])
        # A PATCH that does not touch health records nothing.
        _client(self.admin).patch(self.url, {"name": "Renamed"}, format="json")
        self.assertEqual(BoardHealthChange.objects.count(), 2)

    def test_create_with_status_records_a_change(self):
        r = _client(self.admin).post("/api/v1/boards/", {"name": "New", "health_status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        change = BoardHealthChange.objects.get(board_id=r.json()["id"])
        self.assertEqual((change.from_status, change.to_status), (None, "at_risk"))
        _client(self.admin).post("/api/v1/boards/", {"name": "Plain"}, format="json")
        self.assertEqual(BoardHealthChange.objects.count(), 1)

    def test_clear_to_inherit_records_null_and_empty_clear_is_400(self):
        self._post({"status": "at_risk"})
        r = self._post({"status": None, "note": "rolled up to group"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.json()["health_status"])
        latest = BoardHealthChange.objects.order_by("-id").first()
        self.assertEqual((latest.from_status, latest.to_status), ("at_risk", None))
        r = self._post({"status": None})
        self.assertEqual(r.status_code, 400)
        self.assertIn("status", r.json())
        self.assertEqual(BoardHealthChange.objects.count(), 2)

    def test_note_validated_at_the_boundary(self):
        self.assertEqual(self._post({"status": "on_track", "note": "x" * 281}).status_code, 400)
        self.assertEqual(self._post({"status": "on_track", "note": "x" * 280}).status_code, 200)
        r = self._post({"status": "on_track", "note": "   "})
        self.assertIsNone(r.json()["health_status_note"])
        self.assertEqual(self._post({"status": "bogus"}).status_code, 400)
        self.assertEqual(self._post({}).status_code, 400)

    def test_roles_read_but_only_admins_write_and_outsiders_get_404(self):
        self._post({"status": "at_risk"})
        for user in (self.member, self.viewer, self.collab):
            with self.subTest(user=user.username):
                self.assertEqual(self._post({"status": "on_track"}, user).status_code, 403)
                r = self._history(user)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(r.json()["results"]), 1)
        self.assertEqual(self._post({"status": "on_track"}, self.outsider).status_code, 404)
        self.assertEqual(self._history(self.outsider).status_code, 404)
        self.assertEqual(APIClient().get(f"{self.url}health-history/").status_code, 401)
        self.assertEqual(BoardHealthChange.objects.count(), 1)

    def test_history_newest_first_capped_with_has_more(self):
        r = self._history()
        self.assertEqual(r.json(), {"results": [], "has_more": False})
        for i in range(HEALTH_HISTORY_LIMIT + 1):
            self._post({"status": "at_risk" if i % 2 else "on_track", "note": f"n{i}"})
        with self.assertNumQueries(self._history_query_budget()):
            body = self._history().json()
        self.assertEqual(len(body["results"]), HEALTH_HISTORY_LIMIT)
        self.assertTrue(body["has_more"])
        self.assertEqual(body["results"][0]["note"], f"n{HEALTH_HISTORY_LIMIT}")
        self.assertEqual(
            set(body["results"][0]), {"from_status", "to_status", "changed_by", "changed_at", "note"},
        )

    def test_offset_reaches_older_rows(self):
        """The envelope is pageable: offset walks past the first page (#2242)."""
        for i in range(HEALTH_HISTORY_LIMIT + 1):
            self._post({"status": "at_risk" if i % 2 else "on_track", "note": f"n{i}"})
        r = _client(self.admin).get(f"{self.url}health-history/?offset={HEALTH_HISTORY_LIMIT}")
        body = r.json()
        self.assertEqual([row["note"] for row in body["results"]], ["n0"])
        self.assertFalse(body["has_more"])
        # Lenient like every other hand-paged read: junk and negatives are page one.
        for junk in ("abc", "-5"):
            got = _client(self.admin).get(f"{self.url}health-history/?offset={junk}").json()
            self.assertEqual(len(got["results"]), HEALTH_HISTORY_LIMIT)
        self.assertEqual(
            _client(self.admin).get(f"{self.url}health-history/?offset={2**63}").status_code, 400,
        )

    def _history_query_budget(self):
        # Measure the fixed cost (auth + board lookup + role) on an empty
        # history, so the assertion pins "one query for the rows".
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        other = Board.objects.create(name="Empty", owner=self.admin)
        BoardMembership.objects.create(board=other, user=self.admin, role=BoardMembership.Role.ADMIN)
        with CaptureQueriesContext(connection) as ctx:
            _client(self.admin).get(f"/api/v1/boards/{other.pk}/health-history/")
        return len(ctx.captured_queries)

    def test_deleting_the_setter_leaves_history_with_null_user(self):
        setter = User.objects.create_user(username="gone", password="pw")
        BoardMembership.objects.create(board=self.board, user=setter, role=BoardMembership.Role.ADMIN)
        self._post({"status": "off_track", "note": "kept"}, setter)
        setter.delete()
        change = BoardHealthChange.objects.get(board=self.board)
        self.assertIsNone(change.changed_by)
        self.assertEqual(change.note, "kept")
        self.board.refresh_from_db()
        self.assertIsNone(self.board.health_status_changed_by)
        row = self._history().json()["results"][0]
        self.assertIsNone(row["changed_by"])

    def test_action_broadcasts_board_updated_with_the_new_fields(self):
        with patch(BOARD_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            self._post({"status": "at_risk", "note": "why"})
        events = [c.args[1] for c in mock_broadcast.call_args_list]
        self.assertIn("board.updated", events)
        payload = next(c.args[2] for c in mock_broadcast.call_args_list if c.args[1] == "board.updated")
        self.assertEqual(payload["health_status_note"], "why")
        self.assertEqual(payload["health_status_changed_by"]["id"], self.admin.pk)

    def test_public_board_serializer_has_no_health_fields(self):
        fields = set(PublicBoardSerializer().fields)
        self.assertFalse(fields & {"health_status", *NEW_FIELDS})

    def test_admin_save_records_a_changed_value_only(self):
        request = RequestFactory().post("/admin/")
        request.user = self.admin
        board = Board(name="Admin made", owner=self.admin, health_status="off_track")
        BoardAdmin(Board, AdminSite()).save_model(request, board, None, False)
        change = BoardHealthChange.objects.get(board=board)
        self.assertEqual((change.from_status, change.to_status, change.changed_by), (None, "off_track", self.admin))
        self.assertIn("health_status_changed_by", BoardAdmin.readonly_fields)

    # The admin templates need a non-manifest static backend in tests.
    @override_settings(STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    })
    def test_admin_change_form_records_once_and_only_when_changed(self):
        from django.test import Client
        from django.urls import reverse
        from boards.tests.test_admin_board_concurrent_edits import page_data

        staff = User.objects.create_superuser(username="staff2242", password="pw", email="s2242@example.com")
        # The change form requires a non-empty allowed_priorities.
        Board.objects.filter(pk=self.board.pk).update(allowed_priorities=["low"])
        web = Client()
        web.force_login(staff)
        url = reverse("admin:boards_board_change", args=[self.board.pk])
        r = web.post(url, page_data(web.get(url), health_status="at_risk"))
        self.assertEqual(r.status_code, 302, r.context["adminform"].form.errors if r.status_code == 200 else "")
        rows = BoardHealthChange.objects.filter(board=self.board)
        self.assertEqual(rows.count(), 1)
        change = rows.get()
        self.assertEqual((change.from_status, change.to_status, change.changed_by, change.note),
                         (None, "at_risk", staff, None))
        r = web.post(url, page_data(web.get(url), health_status="at_risk", name="Renamed2242"))
        self.assertEqual(r.status_code, 302)
        self.assertEqual(BoardHealthChange.objects.filter(board=self.board).count(), 1)

    def test_post_bumps_board_updated_at_like_a_patch(self):
        past = timezone.now() - timezone.timedelta(days=2)
        Board.objects.filter(pk=self.board.pk).update(updated_at=past)
        self.assertEqual(self._post({"status": "at_risk"}).status_code, 200)
        self.board.refresh_from_db()
        self.assertGreater(self.board.updated_at, past)
        # Reconfirm of the same value also bumps it.
        Board.objects.filter(pk=self.board.pk).update(updated_at=past)
        self.assertEqual(self._post({"status": "at_risk"}).status_code, 200)
        self.board.refresh_from_db()
        self.assertGreater(self.board.updated_at, past)
        # PATCH still does.
        Board.objects.filter(pk=self.board.pk).update(updated_at=past)
        r = _client(self.admin).patch(self.url, {"health_status": "off_track"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.board.refresh_from_db()
        self.assertGreater(self.board.updated_at, past)

    def test_group_has_no_updated_at_so_service_skips_it(self):
        group = Group.objects.create(name="NoUA2242", owner=self.admin)
        self.assertFalse(any(f.name == "updated_at" for f in Group._meta.concrete_fields))
        record_health_change(group, change_model=GroupHealthChange, from_status=None,
                             to_status="at_risk", user=self.admin)
        group.refresh_from_db()
        self.assertEqual(group.health_status, "at_risk")

    def test_inherited_source_carries_changed_at_only(self):
        owner = self.admin
        group = Group.objects.create(name="Eng", owner=owner)
        GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
        Board.objects.filter(pk=self.board.pk).update(group=group)
        r = _client(owner).post(f"/api/v1/groups/{group.pk}/health-status/", {"status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = _client(owner).get(self.url).json()
        self.assertEqual(body["effective_health_status"], "at_risk")
        self.assertEqual(set(body["health_status_source"]), {"id", "name", "changed_at"})
        self.assertIsNotNone(body["health_status_source"]["changed_at"])
        # The board's own fields describe the board, not the group.
        self.assertIsNone(body["health_status_changed_by"])


class GroupHealthHistoryTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="gadmin", password="pw")
        self.member = User.objects.create_user(username="gmember", password="pw")
        self.outsider = User.objects.create_user(username="gout", password="pw")
        self.root = Group.objects.create(name="Root", owner=self.admin)
        self.child = Group.objects.create(name="Child", owner=self.admin, parent=self.root)
        GroupMembership.objects.create(group=self.root, user=self.admin, role=GroupMembership.Role.ADMIN)
        # The member belongs to the child only, so the root is navigation-only to them.
        GroupMembership.objects.create(group=self.child, user=self.member, role=GroupMembership.Role.MEMBER)

    def _post(self, group, body, user=None):
        return _client(user or self.admin).post(f"/api/v1/groups/{group.pk}/health-status/", body, format="json")

    def test_set_reconfirm_and_patch_rules(self):
        r = self._post(self.child, {"status": "at_risk", "note": "late"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["health_status_note"], "late")
        _client(self.admin).patch(f"/api/v1/groups/{self.child.pk}/", {"health_status": "at_risk"}, format="json")
        self.assertEqual(GroupHealthChange.objects.count(), 1)
        _client(self.admin).patch(f"/api/v1/groups/{self.child.pk}/", {"health_status": "on_track"}, format="json")
        self._post(self.child, {"status": "on_track"})
        rows = list(GroupHealthChange.objects.order_by("id").values_list("from_status", "to_status", "note"))
        self.assertEqual(rows, [(None, "at_risk", "late"), ("at_risk", "on_track", None), ("on_track", "on_track", None)])
        r = _client(self.admin).post("/api/v1/groups/", {"name": "Fresh", "health_status": "off_track"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(GroupHealthChange.objects.filter(group_id=r.json()["id"], to_status="off_track").exists())

    def test_member_reads_admin_writes_navigation_only_and_outsider_404(self):
        self._post(self.child, {"status": "at_risk"})
        self._post(self.root, {"status": "off_track", "note": "root note"})
        self.assertEqual(self._post(self.child, {"status": "on_track"}, self.member).status_code, 403)
        r = _client(self.member).get(f"/api/v1/groups/{self.child.pk}/health-history/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["results"]), 1)
        # Navigation-only ancestor: history 404, and the read fields are withheld.
        self.assertEqual(_client(self.member).get(f"/api/v1/groups/{self.root.pk}/health-history/").status_code, 404)
        rows = {g["id"]: g for g in _client(self.member).get("/api/v1/groups/").json()["results"]}
        self.assertTrue(rows[self.root.pk]["navigation_only"])
        for field in NEW_FIELDS:
            self.assertIsNone(rows[self.root.pk][field])
        self.assertEqual(rows[self.child.pk]["health_status_changed_by"]["id"], self.admin.pk)
        self.assertIsNotNone(rows[self.child.pk]["health_status_changed_at"])
        self.assertEqual(_client(self.outsider).get(f"/api/v1/groups/{self.child.pk}/health-history/").status_code, 404)
        self.assertEqual(self._post(self.child, {"status": "on_track"}, self.outsider).status_code, 404)

    def test_clear_and_empty_clear(self):
        self._post(self.child, {"status": "at_risk"})
        self.assertEqual(self._post(self.child, {"status": None}).status_code, 200)
        self.assertEqual(self._post(self.child, {"status": None}).status_code, 400)

    def test_action_broadcasts_group_updated(self):
        with patch(GROUP_BROADCAST) as mock_broadcast, self.captureOnCommitCallbacks(execute=True):
            self._post(self.child, {"status": "on_track", "note": "fine"})
        updated = [c for c in mock_broadcast.call_args_list if c.args[1] == "group.updated"]
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0].args[2]["health_status_note"], "fine")

    def test_service_attributes_anonymous_to_nobody(self):
        from django.contrib.auth.models import AnonymousUser

        change = record_health_change(
            self.child, change_model=GroupHealthChange, from_status=None,
            to_status="at_risk", user=AnonymousUser(), note=None,
        )
        self.assertIsNone(change.changed_by)


#: Every writer of ``health_status`` that should be attributed, and what it
#: must call (#2242). A new writer must be added here, and must go through
#: ``groups.health_history``.
HEALTH_WRITER_PINS = {
    "boards.views.boards.BoardViewSet.perform_create": frozenset({"record_if_changed"}),
    "boards.views.boards.BoardViewSet.perform_update": frozenset({"record_if_changed", "lock_board_row_or_404"}),
    "boards.views.boards.BoardViewSet.health_status": frozenset({"record_health_change", "lock_board_row_or_404"}),
    "boards.admin.BoardAdmin.save_model": frozenset({"record_if_changed"}),
    "groups.views.GroupViewSet.boards": frozenset({"record_if_changed"}),
    "groups.views.GroupViewSet.perform_create": frozenset({"record_if_changed"}),
    "groups.views.GroupViewSet.perform_update": frozenset({"record_if_changed", "recheck_parent_under_lock"}),
    "groups.views.GroupViewSet.health_status": frozenset({"record_health_change", "select_for_update"}),
}


class GroupBoardCreateHealthHistoryTests(TestCase):
    """POST /groups/{id}/boards/ is a health_status writer too (#2242)."""

    def setUp(self):
        self.user = User.objects.create_user(username="gbc", password="pw")
        self.group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)
        self.url = f"/api/v1/groups/{self.group.pk}/boards/"

    def test_create_with_status_records_one_change_from_nothing(self):
        r = _client(self.user).post(self.url, {"name": "B", "health_status": "at_risk"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["health_status_changed_by"]["id"], self.user.pk)
        change = BoardHealthChange.objects.get(board_id=r.json()["id"])
        self.assertEqual((change.from_status, change.to_status), (None, "at_risk"))
        self.assertEqual(change.changed_by, self.user)
        self.assertIsNone(change.note)
        board = Board.objects.get(pk=r.json()["id"])
        self.assertEqual(board.health_status_changed_at, change.changed_at)

    def test_create_without_status_records_nothing(self):
        r = _client(self.user).post(self.url, {"name": "B"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(BoardHealthChange.objects.count(), 0)
        self.assertIsNone(r.json()["health_status_changed_at"])


class HealthListQueryCountTests(TestCase):
    """Setters must not add queries to the list endpoints (#2242).

    A null changed_by FK costs no query, so only fixtures with distinct
    setters prove the ``select_related("health_status_changed_by")`` calls.
    """

    def _build(self, n):
        admin = User.objects.create_user(username=f"qadmin{n}", password="pw")
        parent = Group.objects.create(name=f"P{n}", owner=admin)
        GroupMembership.objects.create(group=parent, user=admin, role=GroupMembership.Role.ADMIN)
        setters = [User.objects.create_user(username=f"qs{n}_{i}", password="pw") for i in range(3)]
        for i in range(n):
            group = Group.objects.create(name=f"C{n}_{i}", owner=admin, parent=parent)
            board = Board.objects.create(name=f"B{n}_{i}", owner=admin, group=parent)
            BoardMembership.objects.create(board=board, user=admin, role=BoardMembership.Role.ADMIN)
            Group.objects.filter(pk=group.pk).update(
                health_status="at_risk", health_status_changed_by=setters[i], health_status_changed_at=timezone.now(),
            )
            Board.objects.filter(pk=board.pk).update(
                health_status="at_risk", health_status_changed_by=setters[i], health_status_changed_at=timezone.now(),
            )
        return admin, parent

    def _counts(self, admin, parent):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        urls = ["/api/v1/boards/", "/api/v1/groups/", f"/api/v1/groups/{parent.pk}/boards/",
                f"/api/v1/groups/{parent.pk}/descendant-boards/"]
        counts = {}
        for url in urls:
            with CaptureQueriesContext(connection) as ctx:
                r = _client(admin).get(url)
            self.assertEqual(r.status_code, 200, url)
            counts[url.replace(f"/groups/{parent.pk}/", "/groups/<id>/")] = len(ctx.captured_queries)
        return counts

    def test_query_counts_do_not_grow_with_distinct_setters(self):
        one = self._counts(*self._build(1))
        three = self._counts(*self._build(3))
        self.assertEqual(one, three)


class HealthWriterEntryPointTests(SimpleTestCase):
    """Every writer of health_status records history through the one service (#2242)."""

    def test_every_writer_calls_the_service(self):
        failures = required_call_violations(HEALTH_WRITER_PINS)
        self.assertEqual(failures, [], "\n".join(failures))

    def test_writable_health_serializers_are_known(self):
        """A new serializer with a writable health_status needs a pinned writer above."""
        from groups.serializers import HealthStatusFieldsMixin

        def subclasses(cls):
            for sub in cls.__subclasses__():
                yield sub
                yield from subclasses(sub)

        writable = {
            cls.__name__ for cls in subclasses(HealthStatusFieldsMixin)
            if not cls().fields["health_status"].read_only
        }
        # BoardImportResponseSerializer is a response schema only (no writer).
        self.assertEqual(writable, {
            "BoardSerializer", "GroupSerializer", "GroupDetailSerializer", "BoardImportResponseSerializer",
        })
