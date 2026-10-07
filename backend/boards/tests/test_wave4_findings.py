"""Regression tests for the Wave 4 pre-release audit fixes (#920–#930, #952).

Each test class is named after the issue it guards against and contains the
minimal assertions needed to prevent the original bug from re-emerging.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership


class IsModeratorVisibilityTests(TestCase):
    """#920 — moderator status must not leak to non-admin board members.

    #1173 — the self-row exception: a non-admin's OWN row must still carry
    is_moderator, or the moderator-only UI (CardDetail, ArchivedCardsPanel,
    BulkActionToolbar all check `m.is_moderator` for the current user) never
    appears for a member an admin promoted to moderator. The #920 invariant
    (hidden on every OTHER non-admin-visible row) must hold unchanged.
    """

    def setUp(self):
        self.admin = User.objects.create_user(username="adm", password="x")
        self.viewer = User.objects.create_user(username="view", password="x")
        self.member = User.objects.create_user(username="mem", password="x")
        self.plain_member = User.objects.create_user(username="mem2", password="x")
        self.board = Board.objects.create(name="B", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(
            board=self.board, user=self.member, role=BoardMembership.Role.MEMBER, is_moderator=True,
        )
        BoardMembership.objects.create(
            board=self.board, user=self.plain_member, role=BoardMembership.Role.MEMBER,
        )
        BoardMembership.objects.create(board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER)
        Column.objects.create(board=self.board, name="C", position=0)
        Swimlane.objects.create(board=self.board, name="L", position=0)
        self.client = APIClient()

    def _members_response(self, requester):
        self.client.force_authenticate(requester)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return r.data["members"]

    def test_admin_sees_is_moderator_field(self):
        members = self._members_response(self.admin)
        moderator_row = next(m for m in members if m["user"]["id"] == self.member.id)
        self.assertIn("is_moderator", moderator_row)
        self.assertTrue(moderator_row["is_moderator"])

    def test_admin_sees_is_moderator_on_every_row(self):
        # #1173: the admin view is unchanged by the self-row exception.
        members = self._members_response(self.admin)
        for row in members:
            self.assertIn("is_moderator", row, f"Admin must see is_moderator on every row; missing on {row}")

    def test_viewer_does_not_see_is_moderator_field(self):
        # #1173: the self-row exception applies to the viewer's own row too
        # (it always shows False there, since is_moderator can't be granted
        # to a viewer), but every OTHER row must still omit the field.
        members = self._members_response(self.viewer)
        for row in members:
            if row["user"]["id"] == self.viewer.id:
                continue
            self.assertNotIn(
                "is_moderator", row,
                f"Viewer must not see is_moderator (#920); leaked on row {row}",
            )

    def test_non_admin_moderator_sees_own_is_moderator_true(self):
        # #1173: a real (non-admin) moderator must see is_moderator on their
        # own row, or moderator-only UI stays hidden from themselves.
        members = self._members_response(self.member)
        own_row = next(m for m in members if m["user"]["id"] == self.member.id)
        self.assertIn("is_moderator", own_row)
        self.assertTrue(own_row["is_moderator"])

    def test_non_admin_non_moderator_sees_own_is_moderator_false(self):
        # #1173: the self-row exception reveals the real value rather than
        # only ever showing True — a non-moderator member's own row carries
        # is_moderator: False instead of omitting the field.
        members = self._members_response(self.plain_member)
        own_row = next(m for m in members if m["user"]["id"] == self.plain_member.id)
        self.assertIn("is_moderator", own_row)
        self.assertFalse(own_row["is_moderator"])

    def test_member_does_not_see_is_moderator_on_other_rows(self):
        # #920 invariant preserved: the #1173 self-row exception must not
        # leak is_moderator on rows belonging to OTHER members.
        members = self._members_response(self.member)
        for row in members:
            if row["user"]["id"] == self.member.id:
                continue
            self.assertNotIn(
                "is_moderator", row,
                f"Member must not see is_moderator on another member's row (#920); leaked on row {row}",
            )


class JsonImportTopLevelTypeValidationTests(TestCase):
    """#921 — malformed top-level keys must return 400, not 500."""

    def setUp(self):
        self.user = User.objects.create_user(username="imp", password="x")
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _import(self, payload_dict):
        import io
        import json
        f = io.BytesIO(json.dumps(payload_dict).encode("utf-8"))
        f.name = "board.json"
        return self.client.post(
            "/api/v1/boards/import/",
            {"file": f},
            format="multipart",
        )

    def test_cards_as_string_returns_400(self):
        r = self._import({"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "cards": "not a list"})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("must be a list", str(r.data).lower())

    def test_columns_as_int_returns_400(self):
        r = self._import({"name": "B", "columns": 5, "swimlanes": [{"name": "s"}]})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_labels_as_dict_returns_400(self):
        r = self._import({"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "labels": {"k": "v"}})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)


class StarChangedCrossChannelBroadcastTests(TestCase):
    """#952 — board.star_changed must fan out to the group channel when the
    board belongs to a group, in addition to the board channel."""

    def setUp(self):
        self.user = User.objects.create_user(username="starusr", password="x")
        self.group = Group.objects.create(name="G", owner=self.user)
        GroupMembership.objects.create(group=self.group, user=self.user, role=GroupMembership.Role.ADMIN)
        self.board = Board.objects.create(name="B", owner=self.user, group=self.group)
        BoardMembership.objects.create(board=self.board, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=self.board, name="C", position=0)
        Swimlane.objects.create(board=self.board, name="L", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_star_fires_on_both_board_and_group_channels(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_board, \
             patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(f"/api/v1/boards/{self.board.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        board_events = [c.args[1] for c in mock_board.call_args_list]
        group_events = [c.args[1] for c in mock_group.call_args_list]
        self.assertIn("board.star_changed", board_events)
        self.assertIn("board.star_changed", group_events)

    def test_star_on_groupless_board_does_not_fire_group_event(self):
        groupless = Board.objects.create(name="Solo", owner=self.user)
        BoardMembership.objects.create(board=groupless, user=self.user, role=BoardMembership.Role.ADMIN)
        Column.objects.create(board=groupless, name="C", position=0)
        Swimlane.objects.create(board=groupless, name="L", position=0)
        with patch("boards.views.boards._broadcast_group_event") as mock_group:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.post(f"/api/v1/boards/{groupless.id}/star/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # The board belongs to no group, so no group-channel event must fire.
        self.assertFalse(any(c.args[1] == "board.star_changed" for c in mock_group.call_args_list))


class JsonImportPerItemTypeValidationTests(TestCase):
    """#1451 — a non-object entry in a per-item list must return 400, not 500."""

    def setUp(self):
        self.user = User.objects.create_user(username="imp1451", password="x")
        self.user.is_site_admin = True
        self.user.save(update_fields=["is_site_admin"])
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _import(self, payload_dict):
        import io
        import json
        f = io.BytesIO(json.dumps(payload_dict).encode("utf-8"))
        f.name = "board.json"
        return self.client.post("/api/v1/boards/import/", {"file": f}, format="multipart")

    def _payload(self, **card_extra):
        card = {"title": "t", "column": "c", "swimlane": "s", **card_extra}
        return {"name": "B", "columns": [{"name": "c"}], "swimlanes": [{"name": "s"}], "cards": [card]}

    def _assert_400(self, payload, expected):
        before = Board.objects.count()
        r = self._import(payload)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn(expected, str(r.data))
        self.assertEqual(Board.objects.count(), before)

    def test_card_entry_not_object(self):
        payload = self._payload()
        payload["cards"] = ["x"]
        self._assert_400(payload, "Card at index 0 must be an object")

    def test_comment_entry_not_object(self):
        self._assert_400(self._payload(comments=["x"]), "Card at index 0, comment at index 0 must be an object")

    def test_movement_entry_not_object(self):
        self._assert_400(self._payload(movements=["x"]), "Card at index 0, movement at index 0 must be an object")

    def test_activity_entry_not_object(self):
        self._assert_400(self._payload(activities=[5]), "Card at index 0, activity at index 0 must be an object")

    def test_checklist_entry_not_object(self):
        self._assert_400(self._payload(checklist=[None]), "checklist item at index 0 must be an object")

    def test_nested_lists_must_be_lists(self):
        for key in ("comments", "movements", "activities", "checklist"):
            with self.subTest(key=key):
                self._assert_400(self._payload(**{key: "x"}), f"'{key}' must be a list")

    def test_card_labels_must_be_list_of_names(self):
        self._assert_400(self._payload(labels=[["a"]]), "'labels' must be a list of names")
        self._assert_400(self._payload(labels=[{}]), "'labels' must be a list of names")
        self._assert_400(self._payload(labels="x"), "'labels' must be a list of names")

    def test_column_swimlane_label_entry_not_object(self):
        for key, label in (("columns", "Column"), ("swimlanes", "Swimlane"), ("labels", "Label")):
            with self.subTest(key=key):
                payload = self._payload()
                payload["cards"] = []
                payload[key] = payload.get(key, []) + ["x"]
                self._assert_400(payload, f"{label} at index {len(payload[key]) - 1} must be an object")

    def test_non_string_name_rejected(self):
        payload = self._payload()
        payload["columns"] = [{"name": ["c"]}]
        self._assert_400(payload, "name must be a string")

    def test_null_nested_lists_rejected(self):
        for key in ("comments", "movements", "activities", "checklist"):
            with self.subTest(key=key):
                self._assert_400(self._payload(**{key: None}), f"'{key}' must be a list")

    def test_non_string_swimlane_and_label_name_rejected(self):
        payload = self._payload()
        payload["swimlanes"] = [{"name": 5}]
        payload["cards"] = []
        self._assert_400(payload, "Swimlane at index 0: name must be a string")
        payload = self._payload()
        payload["labels"] = [{"name": ["x"]}]
        self._assert_400(payload, "Label at index 0: name must be a string")

    def test_missing_name_rejected(self):
        for key, label in (("columns", "Column"), ("swimlanes", "Swimlane"), ("labels", "Label")):
            with self.subTest(key=key):
                payload = self._payload()
                payload["cards"] = []
                payload[key] = [{}]
                self._assert_400(payload, f"{label} at index 0: name must be a string")

    def test_empty_name_still_imports(self):
        # An empty name imported before #1451 for all three lists.
        for key in ("columns", "swimlanes", "labels"):
            with self.subTest(key=key):
                payload = self._payload()
                payload["cards"] = []
                payload[key] = [{"name": ""}]
                self.assertEqual(self._import(payload).status_code, status.HTTP_201_CREATED)

    def test_card_title_must_be_string(self):
        for bad in (["x"], {"a": 1}, 5, True):
            with self.subTest(bad=bad):
                self._assert_400(self._payload(title=bad), "'title' must be a string")

    def test_card_labels_hashable_non_strings_still_import(self):
        # Never matched a label, but imported before #1451; keep accepting.
        for item in (0, 1, True, False, None):
            with self.subTest(item=item):
                self.assertEqual(self._import(self._payload(labels=[item])).status_code, status.HTTP_201_CREATED)

    def test_schema_version_must_be_int(self):
        for bad in ("2", [1], {"a": 1}, None, True):
            with self.subTest(bad=bad):
                payload = self._payload()
                payload["schema_version"] = bad
                self._assert_400(payload, "'schema_version' must be an integer")

    def test_schema_version_absent_or_int_still_imports(self):
        self.assertEqual(self._import(self._payload()).status_code, status.HTTP_201_CREATED)
        payload = self._payload()
        payload["schema_version"] = 2
        self.assertEqual(self._import(payload).status_code, status.HTTP_201_CREATED)

    def test_movement_refs_must_be_strings(self):
        for key in ("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"):
            for bad in (["x"], {"a": 1}, 5, True):
                with self.subTest(key=key, bad=bad):
                    self._assert_400(self._payload(movements=[{key: bad}]), f"'{key}' must be a string")

    def test_falsy_non_string_refs_still_import(self):
        # Coerced away by ``or ""`` / truthiness checks before #1451.
        for bad in (None, "", 0, False, [], {}):
            with self.subTest(bad=bad):
                keys = ("from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by")
                for payload in (
                    self._payload(movements=[{k: bad for k in keys}]),
                    self._payload(activities=[{"actor": bad}]),
                    self._payload(assignee=bad),
                ):
                    self.assertEqual(self._import(payload).status_code, status.HTTP_201_CREATED)

    def test_activity_actor_must_be_string(self):
        for bad in (["x"], {"a": 1}, 5, True):
            with self.subTest(bad=bad):
                self._assert_400(self._payload(activities=[{"actor": bad}]), "'actor' must be a string")

    def test_assignee_must_be_string(self):
        for bad in (["x"], {"a": 1}, 5, True):
            with self.subTest(bad=bad):
                self._assert_400(self._payload(assignee=bad), "'assignee' must be a string")
