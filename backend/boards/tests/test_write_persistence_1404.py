"""Successful writes must prove persisted state, not just a status code (#1404).

Each test drives one write endpoint as a legitimate caller and asserts three
things a bare ``assertEqual(resp.status_code, 201)`` cannot:

1. the response body equals the row that is now in the database (re-read, never
   the in-memory object);
2. the row belongs where the request said (board / column / swimlane / author);
3. the audit-trail and change-feed side effects exist (``CardMovement``,
   ``CardActivity``, ``BoardEvent``).

This is the success-path counterpart to ``assert_denied_write_noop`` (#1402).
The helpers live in ``boards/tests/conftest.py``.
"""

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import (
    BoardMembership,
    Card,
    CardActivity,
    CardAttachment,
    CardChecklist,
    CardComment,
    CardMovement,
    Column,
    Label,
    Swimlane,
)
from boards.tests.conftest import (
    _make_board,
    _make_card,
    _make_column,
    _make_membership,
    _make_swimlane,
    _make_user,
    assert_response_matches_row,
    board_event_names,
    last_board_event_id,
)


class _WritePersistenceBase(TestCase):
    def setUp(self):
        self.owner = _make_user("owner")
        self.board = _make_board(self.owner)
        self.todo = _make_column(self.board, "Todo", 0, allow_card_creation=True)
        self.doing = _make_column(self.board, "Doing", 1)
        self.lane_a = _make_swimlane(self.board, "A", 0)
        self.lane_b = _make_swimlane(self.board, "B", 1)
        self.member = _make_user("member")
        _make_membership(self.board, self.member, BoardMembership.Role.MEMBER)
        self.client = APIClient()
        self.client.force_authenticate(self.member)
        self.base = f"/api/v1/boards/{self.board.id}"

    def _mark(self):
        return last_board_event_id()


class CardWritePersistenceTests(_WritePersistenceBase):
    def test_create_card_persists_row_creation_movement_and_event(self):
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/cards/",
                {"title": "Ship it", "column": self.todo.id, "swimlane": self.lane_b.id},
                format="json",
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

        card = Card.objects.get(pk=resp.json()["id"])
        self.assertEqual(card.board_id, self.board.id)
        self.assertEqual(card.column_id, self.todo.id)
        self.assertEqual(card.swimlane_id, self.lane_b.id)
        self.assertEqual(card.title, "Ship it")
        self.assertEqual(card.created_by_id, self.member.id)
        self.assertIsNone(card.archived_at)
        assert_response_matches_row(self, resp.json(), card, ["id", "title", "column", "swimlane", "position"])

        # Exactly one creation movement: no source cell, destination = request.
        movement = CardMovement.objects.get(card=card)
        self.assertIsNone(movement.from_column_id)
        self.assertEqual(movement.to_column_id, self.todo.id)
        self.assertEqual(movement.to_swimlane_id, self.lane_b.id)
        self.assertEqual(movement.moved_by_id, self.member.id)
        self.assertIn("card.created", board_event_names(self.board, mark))

    def test_patch_card_persists_changes_and_leaves_other_fields(self):
        card = _make_card(self.todo, self.lane_a, "Before", created_by=self.member)
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.patch(
                f"{self.base}/cards/{card.id}/", {"title": "After"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        card.refresh_from_db()
        self.assertEqual(card.title, "After")
        assert_response_matches_row(self, resp.json(), card, ["title", "column", "swimlane"])
        # Untouched: placement and authorship (members edit only cards they created).
        self.assertEqual(card.column_id, self.todo.id)
        self.assertEqual(card.swimlane_id, self.lane_a.id)
        self.assertEqual(card.created_by_id, self.member.id)
        self.assertEqual(CardMovement.objects.filter(card=card).count(), 0)
        self.assertIn("card.updated", board_event_names(self.board, mark))

    def test_move_card_persists_cell_and_records_one_movement(self):
        card = _make_card(self.todo, self.lane_a, "Mover", created_by=self.member)
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/cards/{card.id}/move/",
                {"column_id": self.doing.id, "swimlane_id": self.lane_b.id, "position": 0},
                format="json",
            )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        card.refresh_from_db()
        self.assertEqual((card.column_id, card.swimlane_id), (self.doing.id, self.lane_b.id))
        assert_response_matches_row(self, resp.json()["card"], card, ["column", "swimlane", "position"])
        self.assertEqual(resp.json()["movement"]["id"], CardMovement.objects.get(card=card).id)

        movement = CardMovement.objects.get(card=card)
        self.assertEqual(movement.from_column_id, self.todo.id)
        self.assertEqual(movement.to_column_id, self.doing.id)
        self.assertEqual(movement.from_swimlane_id, self.lane_a.id)
        self.assertEqual(movement.to_swimlane_id, self.lane_b.id)
        self.assertEqual(movement.moved_by_id, self.member.id)
        self.assertEqual(movement.board_id, self.board.id)
        self.assertIn("card.moved", board_event_names(self.board, mark))

    def test_archive_card_persists_archive_state_and_movement(self):
        card = _make_card(self.todo, self.lane_a, "Old", created_by=self.owner)
        self.client.force_authenticate(self.owner)  # archiving needs board admin
        resp = self.client.post(f"{self.base}/cards/{card.id}/archive/")
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        card.refresh_from_db()
        self.assertIsNotNone(card.archived_at)
        movement = CardMovement.objects.get(card=card)
        self.assertEqual(movement.movement_type, CardMovement.MovementType.ARCHIVED)


class CardAnnotationPersistenceTests(_WritePersistenceBase):
    def setUp(self):
        super().setUp()
        self.card = _make_card(self.todo, self.lane_a, "Annotated", created_by=self.member)

    def test_add_comment_persists_author_body_and_activity(self):
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/cards/{self.card.id}/comments/", {"body": "Looks good"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        comment = CardComment.objects.get(pk=resp.json()["id"])
        self.assertEqual(comment.card_id, self.card.id)
        self.assertEqual(comment.author_id, self.member.id)
        self.assertEqual(comment.body, "Looks good")
        assert_response_matches_row(self, resp.json(), comment, ["id", "body"])
        self.assertTrue(
            CardActivity.objects.filter(
                card=self.card,
                event_type=CardActivity.EventType.COMMENT_ADDED,
                actor=self.member,
            ).exists()
        )
        self.assertIn("card.updated", board_event_names(self.board, mark))

    def test_add_checklist_item_persists_position_creator_and_activity(self):
        first = self.client.post(
            f"{self.base}/cards/{self.card.id}/checklist/", {"text": "one"}, format="json"
        )
        second = self.client.post(
            f"{self.base}/cards/{self.card.id}/checklist/", {"text": "two"}, format="json"
        )
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED)
        items = list(CardChecklist.objects.filter(card=self.card).order_by("position"))
        self.assertEqual([i.text for i in items], ["one", "two"])
        self.assertEqual([i.position for i in items], [0, 1])
        self.assertTrue(all(i.created_by_id == self.member.id for i in items))
        self.assertFalse(any(i.is_checked for i in items))
        assert_response_matches_row(self, second.json(), items[1], ["id", "text", "position"])
        self.assertEqual(
            CardActivity.objects.filter(
                card=self.card, event_type=CardActivity.EventType.CHECKLIST_ITEM_ADDED
            ).count(),
            2,
        )

    def test_toggle_checklist_item_persists_checked_state(self):
        item = CardChecklist.objects.create(
            card=self.card, text="t", position=0, created_by=self.member
        )
        resp = self.client.patch(
            f"{self.base}/cards/{self.card.id}/checklist/{item.id}/",
            {"is_checked": True},
            format="json",
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        item.refresh_from_db()
        self.assertTrue(item.is_checked)
        self.assertEqual(item.text, "t")
        assert_response_matches_row(self, resp.json(), item, ["is_checked", "text"])

    def test_upload_attachment_persists_row_and_file(self):
        png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff"
            b"\xff?\x00\x05\xfe\x02\xfe\xa7\x9a\xa0\xa0\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        upload = SimpleUploadedFile("pixel.png", png, content_type="image/png")
        resp = self.client.post(
            f"{self.base}/cards/{self.card.id}/attachments/", {"file": upload}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED, resp.content)
        attachment = CardAttachment.objects.get(card=self.card)
        self.addCleanup(attachment.file.delete, save=False)
        self.assertEqual(attachment.filename, "pixel.png")
        self.assertEqual(attachment.size, len(png))
        self.assertEqual(attachment.uploaded_by_id, self.member.id)
        self.assertEqual(resp.json()["id"], attachment.id)
        with attachment.file.open("rb") as stored:
            self.assertEqual(stored.read(), png)


class StructureWritePersistenceTests(_WritePersistenceBase):
    def setUp(self):
        super().setUp()
        self.client.force_authenticate(self.owner)

    def test_create_column_persists_scope_name_and_next_position(self):
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/columns/", {"name": "Review", "color": "#FF0000"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        column = Column.objects.get(pk=resp.json()["id"])
        self.assertEqual(column.board_id, self.board.id)
        self.assertEqual(column.name, "Review")
        self.assertEqual(column.color.upper(), "#FF0000")
        self.assertEqual(column.position, 2)  # after Todo (0) and Doing (1)
        assert_response_matches_row(self, resp.json(), column, ["id", "name", "position"])
        self.assertIn("column.created", board_event_names(self.board, mark))

    def test_rename_column_persists_and_keeps_position(self):
        resp = self.client.patch(
            f"{self.base}/columns/{self.doing.id}/", {"name": "In flight"}, format="json"
        )
        self.assertEqual(resp.status_code, status.HTTP_200_OK)
        self.doing.refresh_from_db()
        self.assertEqual(self.doing.name, "In flight")
        self.assertEqual(self.doing.position, 1)
        self.assertEqual(self.doing.board_id, self.board.id)

    def test_create_swimlane_persists_scope_name_and_next_position(self):
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/swimlanes/", {"name": "Customer C", "color": "#00FF00"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        lane = Swimlane.objects.get(pk=resp.json()["id"])
        self.assertEqual(lane.board_id, self.board.id)
        self.assertEqual(lane.name, "Customer C")
        self.assertEqual(lane.position, 2)
        assert_response_matches_row(self, resp.json(), lane, ["id", "name", "position"])
        self.assertIn("swimlane.created", board_event_names(self.board, mark))

    def test_create_label_persists_scope_and_name(self):
        mark = self._mark()
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(
                f"{self.base}/labels/", {"name": "urgent", "color": "#112233"}, format="json"
            )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)
        label = Label.objects.get(pk=resp.json()["id"])
        self.assertEqual(label.board_id, self.board.id)
        self.assertEqual(label.name, "urgent")
        assert_response_matches_row(self, resp.json(), label, ["id", "name"])
        self.assertIn("label.created", board_event_names(self.board, mark))
