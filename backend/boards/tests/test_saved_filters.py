"""Tests for the saved-filter endpoints on BoardViewSet.

Coverage:
- GET  /api/boards/{id}/saved-filters/  — list
- POST /api/boards/{id}/saved-filters/  — create
- DELETE /api/boards/{id}/saved-filters/{filter_pk}/ — delete
- RBAC: viewer can read, save, and delete their own filters
- Isolation: user A cannot see or delete user B's filters
- Validation: missing name, missing state_json, non-dict state_json, name too long
- Duplicate name returns 400
- Non-member (outsider) gets 404
- Unauthenticated returns 401
"""

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, SavedFilter


SIMPLE_STATE = {
    "search": "bug",
    "assigneeIds": [1],
    "labelIds": [],
    "priorities": ["high"],
    "dueDate": None,
}


def _make_board(owner, name="Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    return board


class SavedFilterListCreateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.other = User.objects.create_user(username="bob", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/saved-filters/"

    # --- list ---

    def test_list_returns_empty_for_new_board(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data, [])

    def test_list_returns_only_own_filters(self):
        # Create a filter for alice
        SavedFilter.objects.create(
            user=self.user, board=self.board, name="My filter", state_json=SIMPLE_STATE
        )
        # Create a filter for bob (as board admin adding bob)
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        SavedFilter.objects.create(
            user=self.other, board=self.board, name="Bob filter", state_json=SIMPLE_STATE
        )

        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        names = [f["name"] for f in r.data]
        self.assertIn("My filter", names)
        self.assertNotIn("Bob filter", names)

    def test_list_returns_expected_fields(self):
        SavedFilter.objects.create(
            user=self.user, board=self.board, name="Alpha", state_json=SIMPLE_STATE
        )
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        entry = r.data[0]
        self.assertIn("id", entry)
        self.assertIn("name", entry)
        self.assertIn("state_json", entry)
        self.assertIn("created_at", entry)
        # Sensitive fields must not be exposed
        self.assertNotIn("user", entry)
        self.assertNotIn("board", entry)

    # --- create ---

    def test_create_happy_path(self):
        r = self.client.post(
            self.url, {"name": "Sprint view", "state_json": SIMPLE_STATE}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["name"], "Sprint view")
        self.assertEqual(r.data["state_json"], SIMPLE_STATE)
        self.assertTrue(SavedFilter.objects.filter(user=self.user, board=self.board, name="Sprint view").exists())

    def test_create_missing_name_returns_400(self):
        r = self.client.post(self.url, {"state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", r.data["detail"])

    def test_create_empty_name_returns_400(self):
        r = self.client.post(self.url, {"name": "   ", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_non_string_name_returns_400(self):
        # Regression (#1120 schema-fuzz): a bool/int/list name used to reach
        # `.strip()` unguarded and crash with AttributeError instead of 400.
        r = self.client.post(self.url, {"name": True, "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_non_dict_body_returns_400_not_500(self):
        """A top-level JSON list (or other non-mapping) body must not crash
        `request.data.get(...)` with AttributeError — same bug class as
        CardViewSet.move and GroupViewSet.transfer_ownership (#1120 schema-fuzz)."""
        r = self.client.post(self.url, ["not", "a", "dict"], format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_name_too_long_returns_400(self):
        long_name = "x" * 101
        r = self.client.post(self.url, {"name": long_name, "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_missing_state_json_returns_400(self):
        r = self.client.post(self.url, {"name": "Nostate"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("state_json", r.data["detail"])

    def test_create_non_dict_state_json_returns_400(self):
        r = self.client.post(self.url, {"name": "Bad", "state_json": ["list"]}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_oversized_state_json_returns_400(self):
        """state_json payloads larger than 64 KB must be rejected.

        Uses a valid v1 key (``search``) with a huge string value so the size
        check is the reason for rejection, not the shape validator (#698).
        """
        big_state = {"search": "x" * 70_000}
        r = self.client.post(self.url, {"name": "Huge", "state_json": big_state}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("64 KB", r.data["detail"])

    def test_create_state_json_at_limit_is_accepted(self):
        """A state_json payload right under 64 KB should be accepted."""
        ok_state = {"search": "x" * 60_000}
        r = self.client.post(self.url, {"name": "Ok size", "state_json": ok_state}, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_create_duplicate_name_returns_400(self):
        self.client.post(self.url, {"name": "Dupe", "state_json": SIMPLE_STATE}, format="json")
        r = self.client.post(self.url, {"name": "Dupe", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("already exists", r.data["detail"])

    def test_create_non_member_is_denied(self):
        # Callers with no access to the board get 404, the same answer as a
        # board that does not exist (get_board_for_user).
        outsider = User.objects.create_user(username="charlie", password="pass")
        c = APIClient()
        c.force_authenticate(outsider)
        r = c.post(self.url, {"name": "Outsider", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_create_unauthenticated_returns_401(self):
        anon = APIClient()
        r = anon.post(self.url, {"name": "Anon", "state_json": SIMPLE_STATE}, format="json")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)


class SavedFilterDeleteTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.other = User.objects.create_user(username="bob", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def _delete_url(self, filter_pk):
        return f"/api/v1/boards/{self.board.id}/saved-filters/{filter_pk}/"

    def test_delete_own_filter(self):
        sf = SavedFilter.objects.create(
            user=self.user, board=self.board, name="To delete", state_json=SIMPLE_STATE
        )
        r = self.client.delete(self._delete_url(sf.pk))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(SavedFilter.objects.filter(pk=sf.pk).exists())

    def test_delete_other_users_filter_returns_404(self):
        # bob's filter on the same board — alice must not be able to delete it
        BoardMembership.objects.create(board=self.board, user=self.other, role=BoardMembership.Role.MEMBER)
        sf = SavedFilter.objects.create(
            user=self.other, board=self.board, name="Bob only", state_json=SIMPLE_STATE
        )
        r = self.client.delete(self._delete_url(sf.pk))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        # Filter must still exist
        self.assertTrue(SavedFilter.objects.filter(pk=sf.pk).exists())

    def test_delete_nonexistent_filter_returns_404(self):
        r = self.client.delete(self._delete_url(9999))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_delete_unauthenticated_returns_401(self):
        sf = SavedFilter.objects.create(
            user=self.user, board=self.board, name="Auth test", state_json=SIMPLE_STATE
        )
        anon = APIClient()
        r = anon.delete(self._delete_url(sf.pk))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)


class SavedFilterStateVersionTests(TestCase):
    """Coverage for the state_version column and state_json shape validation (#698).

    The versioning scheme lets the frontend dispatch to version-specific readers
    when the FilterState shape changes non-additively; the shape validator
    prevents malformed payloads (including ones from a future import flow)
    from landing in the DB.
    """

    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/saved-filters/"

    def test_state_version_defaults_to_1_when_omitted(self):
        r = self.client.post(
            self.url, {"name": "Default", "state_json": SIMPLE_STATE}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["state_version"], 1)

    def test_state_version_round_trips_on_create(self):
        r = self.client.post(
            self.url,
            {"name": "V1 explicit", "state_json": SIMPLE_STATE, "state_version": 1},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["state_version"], 1)

    def test_state_version_accepted_from_newer_client(self):
        """A mixed-version deploy where a newer client posts a higher version
        to an older server must not lose the user's save — we accept unknown
        higher versions rather than rejecting them."""
        r = self.client.post(
            self.url,
            {"name": "Future", "state_json": SIMPLE_STATE, "state_version": 99},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["state_version"], 99)

    def test_state_version_above_smallint_rejected(self):
        """The column is a smallint; an oversized value must be a 400, not a 500 (#1919)."""
        for bad in (32768, 2**31):
            r = self.client.post(
                self.url,
                {"name": f"Huge {bad}", "state_json": SIMPLE_STATE, "state_version": bad},
                format="json",
            )
            self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_state_version_max_smallint_accepted(self):
        r = self.client.post(
            self.url,
            {"name": "Max", "state_json": SIMPLE_STATE, "state_version": 32767},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_state_version_zero_rejected(self):
        r = self.client.post(
            self.url,
            {"name": "Bad version", "state_json": SIMPLE_STATE, "state_version": 0},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_list_includes_state_version(self):
        SavedFilter.objects.create(
            user=self.user, board=self.board, name="V1", state_json=SIMPLE_STATE
        )
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data[0]["state_version"], 1)

    def test_existing_row_backfills_state_version(self):
        """Rows created before migration 0046 backfill to 1 via the column default."""
        sf = SavedFilter.objects.create(
            user=self.user, board=self.board, name="Old", state_json=SIMPLE_STATE
        )
        sf.refresh_from_db()
        self.assertEqual(sf.state_version, 1)

    # --- state_json shape validation ---

    def test_unknown_key_rejected(self):
        bad_state = {**SIMPLE_STATE, "mysteryKey": "oops"}
        r = self.client.post(
            self.url, {"name": "Typo", "state_json": bad_state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Unknown keys", r.data["detail"])

    def test_search_wrong_type_rejected(self):
        bad_state = {**SIMPLE_STATE, "search": 123}
        r = self.client.post(
            self.url, {"name": "Bad search", "state_json": bad_state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_assignee_ids_non_integer_rejected(self):
        bad_state = {**SIMPLE_STATE, "assigneeIds": ["not-an-int"]}
        r = self.client.post(
            self.url, {"name": "Bad assignee", "state_json": bad_state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_priorities_unknown_value_rejected(self):
        bad_state = {**SIMPLE_STATE, "priorities": ["catastrophic"]}
        r = self.client.post(
            self.url, {"name": "Bad prio", "state_json": bad_state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_due_date_unknown_value_rejected(self):
        bad_state = {**SIMPLE_STATE, "dueDate": "next_year"}
        r = self.client.post(
            self.url, {"name": "Bad due", "state_json": bad_state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_due_date_null_accepted(self):
        """None is the frontend's 'no filter' value and must round-trip."""
        state = {**SIMPLE_STATE, "dueDate": None}
        r = self.client.post(
            self.url, {"name": "Null due", "state_json": state}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_partial_state_json_accepted(self):
        """All v1 keys are optional — a payload with only some keys is valid."""
        r = self.client.post(
            self.url,
            {"name": "Partial", "state_json": {"search": "bug"}},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)


class SavedFilterViewerRbacTests(TestCase):
    """Viewer-role members can list, create, and delete their own saved filters."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.viewer = User.objects.create_user(username="viewer", password="pass")
        self.board = _make_board(self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.viewer, role=BoardMembership.Role.VIEWER
        )
        self.client = APIClient()
        self.client.force_authenticate(self.viewer)
        self.url = f"/api/v1/boards/{self.board.id}/saved-filters/"

    def test_viewer_can_list_saved_filters(self):
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)

    def test_viewer_can_create_saved_filter(self):
        r = self.client.post(
            self.url, {"name": "Viewer preset", "state_json": SIMPLE_STATE}, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)

    def test_viewer_can_delete_own_saved_filter(self):
        sf = SavedFilter.objects.create(
            user=self.viewer, board=self.board, name="Viewer preset", state_json=SIMPLE_STATE
        )
        r = self.client.delete(f"/api/v1/boards/{self.board.id}/saved-filters/{sf.pk}/")
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)


# Shaped exactly like the frontend's EMPTY_FILTER (FilterBar.tsx) — the payload
# useSavedFilters always posts. #2213: every save was a 400 because the
# serializer did not know customFields / visibleCustomFieldFilterIds.
EMPTY_FILTER_STATE = {
    "search": "",
    "assigneeIds": [],
    "labelIds": [],
    "priorities": [],
    "dueDate": None,
    "customFields": {},
    "visibleCustomFieldFilterIds": [],
    "blockedOnly": False,
}


class SavedFilterCustomFieldStateTests(TestCase):
    """#2213 — customFields / visibleCustomFieldFilterIds accepted and bounded."""

    def setUp(self):
        self.user = User.objects.create_user(username="alice", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/saved-filters/"

    def _post(self, state):
        return self.client.post(self.url, {"name": "F", "state_json": state}, format="json")

    def test_empty_filter_payload_saves(self):
        r = self._post(EMPTY_FILTER_STATE)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["state_json"], EMPTY_FILTER_STATE)

    def test_populated_custom_fields_round_trip(self):
        state = {
            **EMPTY_FILTER_STATE,
            "customFields": {
                "12": {"kind": "text", "query": "acme"},
                "13": {"kind": "number", "equals": "5"},
                "14": {"kind": "date", "equals": "2026-11-13"},
                "15": {"kind": "choice", "values": ["a", "b"]},
                "16": {"kind": "multi_choice", "values": ["x"]},
            },
            "visibleCustomFieldFilterIds": [12, 13],
        }
        r = self._post(state)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        listed = self.client.get(self.url).data
        self.assertEqual(listed[0]["state_json"], state)

    def test_invalid_custom_field_payloads_rejected_with_string_detail(self):
        long_str = "x" * 501
        cases = {
            "customFields not a dict": {"customFields": []},
            "non-digit key": {"customFields": {"abc": {"kind": "text", "query": ""}}},
            "unicode digit key": {"customFields": {"٣": {"kind": "text", "query": ""}}},
            "entry not a dict": {"customFields": {"1": "text"}},
            "unknown kind": {"customFields": {"1": {"kind": "bogus"}}},
            "missing kind": {"customFields": {"1": {"query": "a"}}},
            "text query not str": {"customFields": {"1": {"kind": "text", "query": 5}}},
            "text query too long": {"customFields": {"1": {"kind": "text", "query": long_str}}},
            "equals not str": {"customFields": {"1": {"kind": "number", "equals": 5}}},
            "choice values not list": {"customFields": {"1": {"kind": "choice", "values": "a"}}},
            "choice value not str": {"customFields": {"1": {"kind": "choice", "values": [1]}}},
            "choice value too long": {"customFields": {"1": {"kind": "multi_choice", "values": [long_str]}}},
            "too many values": {"customFields": {"1": {"kind": "choice", "values": ["a"] * 51}}},
            "too many entries": {
                "customFields": {str(i): {"kind": "text", "query": ""} for i in range(51)}
            },
            "ids not list": {"visibleCustomFieldFilterIds": "1"},
            "ids bool": {"visibleCustomFieldFilterIds": [True]},
            "ids str": {"visibleCustomFieldFilterIds": ["1"]},
            "too many ids": {"visibleCustomFieldFilterIds": list(range(51))},
        }
        for label, extra in cases.items():
            with self.subTest(label):
                r = self._post({**EMPTY_FILTER_STATE, **extra})
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIsInstance(r.data["detail"], str)

    def test_frontend_filter_state_keys_match_serializer(self):
        """Parity pin: the shared fixture lists FilterState's keys; the Vitest
        in src/test/savedFilterKeysParity.test.ts asserts the same list
        against EMPTY_FILTER. Drift on either side fails CI."""
        import json
        from pathlib import Path

        from boards.serializers import SavedFilterSerializer

        fixture = Path(__file__).parent / "fixtures" / "filter_state_keys.json"
        keys = json.loads(fixture.read_text())["keys"]
        self.assertEqual(set(keys), SavedFilterSerializer._STATE_V1_KEYS)

    def test_lane_filter_limits_match_shared_fixture(self):
        """The lane-filter bounds are duplicated in laneFilter.ts; the shared
        fixture pins both copies (the Vitest parity test reads the same file)."""
        import json
        from pathlib import Path

        from boards.serializers import SavedFilterSerializer as S

        fixture = Path(__file__).parent / "fixtures" / "filter_state_keys.json"
        limits = json.loads(fixture.read_text())["laneFilterLimits"]
        self.assertEqual(
            limits,
            {
                "maxItems": S._LANE_MAX_ITEMS,
                "maxRules": S._LANE_MAX_RULES,
                "maxString": S._CF_MAX_STRING,
                "maxId": S._LANE_MAX_ID,
            },
        )

    def test_unhashable_values_are_400_not_500(self):
        for label, extra in {
            "kind list": {"customFields": {"1": {"kind": []}}},
            "kind dict": {"customFields": {"1": {"kind": {}}}},
            "priority list": {"priorities": [[]]},
            "dueDate list": {"dueDate": []},
        }.items():
            with self.subTest(label):
                r = self._post({**EMPTY_FILTER_STATE, **extra})
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIsInstance(r.data["detail"], str)

    def test_nul_characters_are_400_not_500(self):
        """Postgres jsonb rejects U+0000 (DataError -> 500); guard in the serializer."""
        nul = "a\u0000b"
        for label, extra in {
            "search": {"search": nul},
            "text query": {"customFields": {"1": {"kind": "text", "query": nul}}},
            "equals": {"customFields": {"1": {"kind": "number", "equals": nul}}},
            "choice value": {"customFields": {"1": {"kind": "choice", "values": ["ok", nul]}}},
        }.items():
            with self.subTest(label):
                r = self._post({**EMPTY_FILTER_STATE, **extra})
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIsInstance(r.data["detail"], str)
                self.assertIn("NUL", r.data["detail"])


def _lane_rule(rid=1, **kw):
    return {"kind": "rule", "id": rid, "join": "and", "field": 7, "op": "is", "value": "Priya", **kw}


class SavedFilterLaneFilterStateTests(TestCase):
    """#2205 — laneFilter accepted, bounded, and never a 500."""

    def setUp(self):
        self.user = User.objects.create_user(username="lane", password="pass")
        self.board = _make_board(self.user)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = f"/api/v1/boards/{self.board.id}/saved-filters/"

    def _post(self, state):
        return self.client.post(self.url, {"name": "Lanes", "state_json": state}, format="json")

    def _assert_400(self, lane_filter):
        r = self._post({**EMPTY_FILTER_STATE, "laneFilter": lane_filter})
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIsInstance(r.data["detail"], str)
        return r

    def test_valid_lane_filter_round_trips(self):
        lane_filter = {
            "items": [
                _lane_rule(1),
                {"kind": "rule", "id": 2, "join": "and", "field": 8, "op": "between", "min": "50000", "max": ""},
                {
                    "kind": "group", "id": 3, "join": "or",
                    "rules": [
                        _lane_rule(4, field=9, value="Jo"),
                        _lane_rule(5, join="or", op="is_not", value="Sam"),
                    ],
                },
                # Incomplete rules (no field yet) are kept; the client ignores them.
                {"kind": "rule", "id": 6, "join": "and", "field": None, "op": "is"},
            ]
        }
        state = {**EMPTY_FILTER_STATE, "laneFilter": lane_filter}
        r = self._post(state)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["state_json"], state)

    def test_filter_without_lane_filter_still_saves(self):
        r = self._post(EMPTY_FILTER_STATE)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertNotIn("laneFilter", r.data["state_json"])

    def test_invalid_shapes_rejected_with_string_detail(self):
        long_str = "x" * 501
        cases = {
            "not an object": [],
            "missing items": {},
            "extra top-level key": {"items": [], "x": 1},
            "items not list": {"items": {}},
            "rule not dict": {"items": ["a"]},
            "unknown rule key": {"items": [_lane_rule(extra=1)]},
            "bad op": {"items": [_lane_rule(op="starts_with")]},
            "bad join": {"items": [_lane_rule(join="xor")]},
            "id negative": {"items": [_lane_rule(-1)]},
            "id bool": {"items": [_lane_rule(True)]},
            "id str": {"items": [_lane_rule("1")]},
            "id too big": {"items": [_lane_rule(2**31)]},
            "field str": {"items": [_lane_rule(field="7")]},
            "field bool": {"items": [_lane_rule(field=False)]},
            "value not str": {"items": [_lane_rule(value=5)]},
            "value too long": {"items": [_lane_rule(value=long_str)]},
            "min not str": {"items": [_lane_rule(op="between", min=1)]},
            "nested group": {
                "items": [{"kind": "group", "id": 1, "join": "and", "rules": [
                    {"kind": "group", "id": 2, "join": "and", "rules": []}]}]
            },
            "group rules not list": {"items": [{"kind": "group", "id": 1, "join": "and", "rules": {}}]},
            "unknown group key": {"items": [{"kind": "group", "id": 1, "join": "and", "rules": [], "x": 1}]},
            "group id missing": {"items": [{"kind": "group", "join": "and", "rules": []}]},
        }
        for label, lane_filter in cases.items():
            with self.subTest(label):
                self._assert_400(lane_filter)

    def test_contains_rule_round_trips(self):
        """#2226 — `contains` is accepted on a value string, including the
        empty string an untouched input saves (the client ignores it)."""
        lane_filter = {
            "items": [
                _lane_rule(1, op="contains", value="ross"),
                _lane_rule(2, join="or", op="contains", value=""),
                _lane_rule(3, op="contains", value="x" * 500),
            ]
        }
        state = {**EMPTY_FILTER_STATE, "laneFilter": lane_filter}
        r = self._post(state)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["state_json"], state)

    def test_contains_rule_rejected_outside_its_bounds(self):
        cases = {
            "value too long": _lane_rule(op="contains", value="x" * 501),
            "no value": {k: v for k, v in _lane_rule(op="contains").items() if k != "value"},
            "value not str": _lane_rule(op="contains", value=["ross"]),
            "with min": _lane_rule(op="contains", min="1"),
            "with max": _lane_rule(op="contains", max="9"),
            "value with NUL": _lane_rule(op="contains", value="ro\x00ss"),
        }
        for label, rule in cases.items():
            with self.subTest(label):
                self._assert_400({"items": [rule]})

    def test_oversized_lane_filter_rejected(self):
        with self.subTest("too many items"):
            self._assert_400({"items": [_lane_rule(i) for i in range(21)]})
        with self.subTest("too many rules across groups"):
            groups = [
                {"kind": "group", "id": 100 + g, "join": "and", "rules": [_lane_rule(g * 20 + i) for i in range(20)]}
                for g in range(3)
            ]
            self._assert_400({"items": groups})

    def test_unhashable_lane_values_are_400_not_500(self):
        for label, rule in {
            "op list": _lane_rule(op=[]),
            "op dict": _lane_rule(op={}),
            "join list": _lane_rule(join=[]),
            "kind list": _lane_rule(kind=[]),
        }.items():
            with self.subTest(label):
                self._assert_400({"items": [rule]})
        with self.subTest("group join dict"):
            self._assert_400({"items": [{"kind": "group", "id": 1, "join": {}, "rules": []}]})

    def test_lane_nul_characters_are_400_not_500(self):
        nul = "a\u0000b"
        for key in ("value", "min", "max"):
            with self.subTest(key):
                r = self._assert_400({"items": [_lane_rule(**{key: nul})]})
                self.assertIn("NUL", r.data["detail"])
