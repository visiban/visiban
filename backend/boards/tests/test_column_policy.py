"""Explicit column policies (#1101).

One versioned JSON field, ``Column.policy``, validated by one function
(``boards.column_policy.normalize_policy``) on every write path: the REST
column endpoints, JSON board import, board templates and the Django admin.
Nothing here is enforced on a card move -- "confirm on entry" is a client-side
acknowledgment -- so the last class pins that a move into a confirm-mode
column is never refused.
"""

import io
import json
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.column_policy import (
    POLICY_CRITERION_MAX_LENGTH,
    POLICY_MAX_CRITERIA,
    PolicyError,
    normalize_policy,
    policy_or_none,
)
from boards.models import Board, BoardMembership, BoardTemplate, Card, Column, Swimlane
from boards.utils import create_template_columns

POLICY = {"v": 1, "entry": ["Has an owner", "Acceptance criteria written"], "done": ["Reviewed"], "mode": "confirm"}


class NormalizePolicyTests(SimpleTestCase):
    def test_none_is_no_policy(self):
        self.assertIsNone(normalize_policy(None))

    def test_valid_policy_round_trips(self):
        self.assertEqual(normalize_policy(POLICY), POLICY)

    def test_criteria_are_trimmed(self):
        out = normalize_policy({"v": 1, "entry": ["  Owner set  "], "done": [], "mode": "advisory"})
        self.assertEqual(out["entry"], ["Owner set"])

    def test_missing_lists_and_mode_default(self):
        out = normalize_policy({"v": 1, "entry": ["One"]})
        self.assertEqual(out, {"v": 1, "entry": ["One"], "done": [], "mode": "advisory"})

    def test_both_lists_empty_is_stored_as_none(self):
        self.assertIsNone(normalize_policy({"v": 1, "entry": [], "done": [], "mode": "confirm"}))

    def test_rejections(self):
        too_many = ["x"] * (POLICY_MAX_CRITERIA + 1)
        too_long = "x" * (POLICY_CRITERION_MAX_LENGTH + 1)
        cases = {
            "not an object": ["a list"],
            "string": "policy",
            "unknown key": {"v": 1, "entry": ["a"], "gate": "dimension"},
            "missing version": {"entry": ["a"]},
            "wrong version": {"v": 2, "entry": ["a"]},
            "bool version": {"v": True, "entry": ["a"]},
            "string version": {"v": "1", "entry": ["a"]},
            "bad mode": {"v": 1, "entry": ["a"], "mode": "block"},
            "entry not a list": {"v": 1, "entry": "a"},
            "too many": {"v": 1, "entry": too_many},
            "too long": {"v": 1, "done": [too_long]},
            "blank": {"v": 1, "done": ["   "]},
            "non-string item": {"v": 1, "done": [3]},
        }
        for label, value in cases.items():
            with self.subTest(label):
                with self.assertRaises(PolicyError):
                    normalize_policy(value)

    def test_limits_are_inclusive(self):
        at_cap = {"v": 1, "entry": ["x" * POLICY_CRITERION_MAX_LENGTH] * POLICY_MAX_CRITERIA}
        self.assertEqual(len(normalize_policy(at_cap)["entry"]), POLICY_MAX_CRITERIA)

    def test_unknown_key_message_is_bounded(self):
        with self.assertRaises(PolicyError) as ctx:
            normalize_policy({"v": 1, **{f"k{'x' * 500}{i}": 1 for i in range(50)}})
        self.assertLess(len(str(ctx.exception)), 400)

    def test_policy_or_none_swallows_errors(self):
        self.assertIsNone(policy_or_none({"v": 9}))
        self.assertEqual(policy_or_none(POLICY), POLICY)


class _BoardMixin:
    def setUp(self):
        self.owner = User.objects.create_user(username="policy-owner", password="pass")
        self.member = User.objects.create_user(username="policy-member", password="pass")
        self.board = Board.objects.create(name="Policy board", owner=self.owner)
        BoardMembership.objects.create(board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.member, role=BoardMembership.Role.MEMBER)
        self.todo = Column.objects.create(board=self.board, name="To do", position=0, allow_card_creation=True)
        self.review = Column.objects.create(board=self.board, name="Review", position=1)
        self.swim = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def col_url(self, column):
        return f"/api/v1/boards/{self.board.pk}/columns/{column.pk}/"


class ColumnPolicyApiTests(_BoardMixin, TestCase):
    def test_admin_patch_sets_and_returns_policy(self):
        r = self.client.patch(self.col_url(self.review), {"policy": POLICY}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.assertEqual(r.data["policy"], POLICY)
        self.review.refresh_from_db()
        self.assertEqual(self.review.policy, POLICY)

    def test_stored_value_is_normalized(self):
        r = self.client.patch(
            self.col_url(self.review), {"policy": {"v": 1, "done": ["  Shipped "]}}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.review.refresh_from_db()
        self.assertEqual(self.review.policy, {"v": 1, "entry": [], "done": ["Shipped"], "mode": "advisory"})

    def test_invalid_policy_is_a_400_naming_the_field(self):
        r = self.client.patch(
            self.col_url(self.review), {"policy": {"v": 1, "entry": ["a"], "extra": 1}}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("policy", r.data)
        self.review.refresh_from_db()
        self.assertIsNone(self.review.policy)

    def test_null_clears_policy(self):
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        r = self.client.patch(self.col_url(self.review), {"policy": None}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.review.refresh_from_db()
        self.assertIsNone(self.review.policy)

    def test_put_without_policy_keeps_the_stored_policy(self):
        # The web client's settings save sends a PUT with every other field;
        # an older client that never heard of policy must not wipe it.
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        r = self.client.put(self.col_url(self.review), {"name": "Review", "color": "#123456"}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        self.review.refresh_from_db()
        self.assertEqual(self.review.policy, POLICY)

    def test_create_accepts_policy(self):
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/columns/", {"name": "QA", "policy": POLICY}, format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertEqual(Column.objects.get(pk=r.data["id"]).policy, POLICY)

    def test_member_cannot_edit_policy(self):
        self.client.force_authenticate(self.member)
        r = self.client.patch(self.col_url(self.review), {"policy": POLICY}, format="json")
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.review.refresh_from_db()
        self.assertIsNone(self.review.policy)

    def test_every_member_reads_policy_on_the_board(self):
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        self.client.force_authenticate(self.member)
        r = self.client.get(f"/api/v1/boards/{self.board.pk}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        by_name = {c["name"]: c for c in r.data["columns"]}
        self.assertEqual(by_name["Review"]["policy"], POLICY)
        self.assertIsNone(by_name["To do"]["policy"])

    def test_update_broadcast_carries_policy(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.patch(self.col_url(self.review), {"policy": POLICY}, format="json")
            self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        mock_broadcast.assert_called_once()
        _board_id, event, payload = mock_broadcast.call_args[0][:3]
        self.assertEqual(event, "column.updated")
        self.assertEqual(payload["policy"], POLICY)


class ColumnPolicyNotEnforcedOnMoveTests(_BoardMixin, TestCase):
    def test_move_into_confirm_column_is_not_refused(self):
        # Confirm-on-entry is a client acknowledgment; the server never sees
        # or checks it (#1101 architect review).
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        card = Card.objects.create(
            board=self.board, column=self.todo, swimlane=self.swim, title="c", position=0,
            created_by=self.owner,
        )
        self.client.force_authenticate(self.member)
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/move/",
            {"column_id": self.review.pk, "swimlane_id": self.swim.pk, "position": 0},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        card.refresh_from_db()
        self.assertEqual(card.column_id, self.review.pk)


class ColumnPolicyImportExportTests(_BoardMixin, TestCase):
    def _import(self, data):
        upload = io.BytesIO(json.dumps(data).encode("utf-8"))
        upload.name = "board.json"
        return self.client.post("/api/v1/boards/import/", {"file": upload}, format="multipart")

    def _data(self, policy):
        return {
            "name": "Imported",
            "columns": [
                {"name": "To do", "position": 0, "allow_card_creation": True},
                {"name": "Review", "position": 1, "policy": policy},
            ],
            "swimlanes": [{"name": "General", "position": 0}],
            "cards": [],
        }

    def test_export_includes_policy(self):
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        r = self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json")
        data = json.loads(r.content.decode("utf-8"))
        by_name = {c["name"]: c for c in data["columns"]}
        self.assertEqual(by_name["Review"]["policy"], POLICY)
        self.assertIsNone(by_name["To do"]["policy"])

    def test_export_then_import_round_trips_policy(self):
        self.review.policy = POLICY
        self.review.save(update_fields=["policy"])
        exported = json.loads(
            self.client.get(f"/api/v1/boards/{self.board.pk}/export/?format=json").content.decode("utf-8")
        )
        r = self._import(exported)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        imported = Column.objects.get(board_id=r.data["id"], name="Review")
        self.assertEqual(imported.policy, POLICY)

    def test_import_normalizes_policy(self):
        r = self._import(self._data({"v": 1, "entry": [" Owner "]}))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        col = Column.objects.get(board_id=r.data["id"], name="Review")
        self.assertEqual(col.policy, {"v": 1, "entry": ["Owner"], "done": [], "mode": "advisory"})

    def test_import_without_policy_key_stores_none(self):
        r = self._import(self._data(None) | {"columns": [{"name": "Only", "position": 0}]})
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.content)
        self.assertIsNone(Column.objects.get(board_id=r.data["id"], name="Only").policy)

    def test_import_rejects_invalid_policy_before_writing(self):
        boards_before = Board.objects.count()
        r = self._import(self._data({"v": 1, "entry": ["a"], "mode": "block"}))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("Column at index 1: 'policy' is invalid", r.data["detail"])
        self.assertEqual(Board.objects.count(), boards_before)


class ColumnPolicyTemplateTests(_BoardMixin, TestCase):
    def test_template_column_carries_its_policy(self):
        template = BoardTemplate.objects.create(
            name="Policy template", slug="policy-template-1101", description="d",
            columns_json=[{"name": "Doing"}, {"name": "Review", "policy": POLICY}],
        )
        board = Board.objects.create(name="From template", owner=self.owner)
        create_template_columns(board, template)
        by_name = {c.name: c for c in board.columns.all()}
        self.assertEqual(by_name["Review"].policy, POLICY)
        self.assertIsNone(by_name["Doing"].policy)

    def test_malformed_template_policy_degrades_to_none(self):
        template = BoardTemplate.objects.create(
            name="Bad template", slug="bad-policy-template-1101", description="d",
            columns_json=[{"name": "Review", "policy": {"v": 1, "entry": "not a list"}}],
        )
        board = Board.objects.create(name="From bad template", owner=self.owner)
        create_template_columns(board, template)
        self.assertIsNone(board.columns.get(name="Review").policy)


class ColumnPolicyModelCleanTests(_BoardMixin, TestCase):
    """The Django admin edits the raw JSON; ``Column.clean`` holds it to the API's rules."""

    def test_clean_rejects_invalid_policy(self):
        self.review.policy = {"v": 1, "gate": "x"}
        with self.assertRaises(ValidationError) as ctx:
            self.review.clean()
        self.assertIn("policy", ctx.exception.message_dict)

    def test_clean_normalizes_valid_policy(self):
        self.review.policy = {"v": 1, "done": [" Shipped "]}
        self.review.clean()
        self.assertEqual(self.review.policy, {"v": 1, "entry": [], "done": ["Shipped"], "mode": "advisory"})
