"""Regression tests for #1120 — non-numeric path/lookup parameters must 404, not 500.

The `backend-schema-fuzz` CI job (#1080) fuzzes every documented operation, including
generating non-numeric values for path parameters like ``board_pk`` that are, in the
Django URL conf, unconstrained string segments (the nested router does not restrict
them to digits). Several view modules resolved these values with
``django.shortcuts.get_object_or_404``, which only catches
``Board.DoesNotExist``-style lookup failures — a non-numeric string against an
IntegerField pk raises a raw ``ValueError`` from the ORM that propagates uncaught,
producing an unhandled 500 instead of the documented 404 error envelope.

The fix (see ``boards/views/_helpers.py``) swaps every such call in the affected
view modules to ``rest_framework.generics.get_object_or_404``, which additionally
catches ``TypeError``/``ValueError``/``ValidationError`` and re-raises them as
``Http404``. These tests exercise one representative endpoint per affected module
with a non-numeric pk to confirm the ORM ValueError no longer escapes as a 500.
"""
import json

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane
from groups.models import Group, GroupMembership


def _make_board_with_card(owner):
    board = Board.objects.create(name="Board", owner=owner)
    BoardMembership.objects.create(board=board, user=owner, role=BoardMembership.Role.ADMIN)
    col = Column.objects.create(board=board, name="Backlog", position=0)
    swim = Swimlane.objects.create(board=board, name="General", position=0)
    return board, col, swim


class MalformedPkReturns404Tests(TestCase):
    """A non-numeric pk/lookup value must 404, never 500 (#1120)."""

    def setUp(self):
        self.owner = User.objects.create_user(username="owner", password="pass")
        self.board, self.column, self.swimlane = _make_board_with_card(self.owner)
        self.group = Group.objects.create(name="Group", owner=self.owner)
        GroupMembership.objects.create(
            group=self.group, user=self.owner, role=GroupMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    # ── boards/views/_helpers.py: get_board_for_user() — shared by cards,
    #    columns, swimlanes, labels, and custom-field viewsets ──────────────

    def test_non_numeric_board_pk_on_nested_cards_404s(self):
        resp = self.client.get("/api/v1/boards/not-a-number/cards/1/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(resp.data["detail"], "Not found.")

    def test_non_numeric_board_pk_on_nested_columns_404s(self):
        resp = self.client.get("/api/v1/boards/not-a-number/columns/1/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_non_numeric_board_pk_on_nested_swimlanes_404s(self):
        resp = self.client.get("/api/v1/boards/not-a-number/swimlanes/1/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── boards/views/cards.py: comment_pk / item_pk / attachment_pk ────────

    def test_non_numeric_comment_pk_404s(self):
        resp = self.client.delete(
            f"/api/v1/boards/{self.board.id}/cards/1/comments/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── boards/views/swimlanes.py: pk on the set-collapsed action ──────────

    def test_non_numeric_swimlane_pk_on_action_404s(self):
        resp = self.client.patch(
            f"/api/v1/boards/{self.board.id}/swimlanes/not-a-number/set-collapsed/",
            {"is_collapsed": True},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── boards/views/boards.py: group_id / user_id ──────────────────────────

    def test_non_numeric_user_id_on_board_member_404s(self):
        resp = self.client.delete(
            f"/api/v1/boards/{self.board.id}/members/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── boards/views/share.py ───────────────────────────────────────────────

    def test_non_numeric_board_id_on_share_404s(self):
        resp = self.client.post("/api/v1/boards/not-a-number/share/")
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    # ── boards/views/import_export.py: group_id on import ──────────────────

    def test_non_numeric_group_id_on_import_404s(self):
        payload = json.dumps({
            "name": "Imported",
            "columns": [{"name": "Backlog", "position": 0}],
            "swimlanes": [{"name": "General", "position": 0}],
        }).encode()
        upload = SimpleUploadedFile("board.json", payload, content_type="application/json")
        resp = self.client.post(
            "/api/v1/boards/import/",
            {"file": upload, "group_id": "not-a-number"},
            format="multipart",
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND, resp.data)

    # ── groups/views.py: user_id / link_id / label_id ───────────────────────

    def test_non_numeric_user_id_on_group_member_404s(self):
        resp = self.client.delete(
            f"/api/v1/groups/{self.group.id}/members/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_non_numeric_link_id_on_group_invite_link_404s(self):
        resp = self.client.delete(
            f"/api/v1/groups/{self.group.id}/invite-links/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)

    def test_non_numeric_label_id_on_group_label_404s(self):
        resp = self.client.delete(
            f"/api/v1/groups/{self.group.id}/labels/not-a-number/"
        )
        self.assertEqual(resp.status_code, status.HTTP_404_NOT_FOUND)
