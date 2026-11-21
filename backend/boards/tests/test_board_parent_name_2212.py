"""Parent-item naming on the upstream board (#2212).

``Board.parent_name_singular`` / ``parent_name_plural``: admin-only writes,
validation (strip, 24 max, no control/bidi characters), the child-side and
picker read shapes, and absence from the public share and MCP.
"""

from django.test import TestCase
from rest_framework.test import APIClient

from boards.models import BoardMembership, CardParentLink
from boards.serializers import BoardFullSerializer, ParentBoardOptionSerializer, PublicBoardSerializer
from boards.services.card_links import parent_boards_for_viewer, parents_for_viewer
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

Role = BoardMembership.Role


class _Base(TestCase):
    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner, name="Pipeline", cards_can_have_children=True)
        self.member = _make_user()
        BoardMembership.objects.create(board=self.board, user=self.member, role=Role.MEMBER)

    def _client(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def _patch(self, user, body):
        return self._client(user).patch(f"/api/v1/boards/{self.board.pk}/", body, format="json")


class WriteTests(_Base):
    def test_defaults_are_empty(self):
        res = self._client(self.owner).get(f"/api/v1/boards/{self.board.pk}/")
        self.assertEqual(res.json()["parent_name_singular"], "")
        self.assertEqual(res.json()["parent_name_plural"], "")

    def test_admin_writes_and_value_is_stripped(self):
        res = self._patch(self.owner, {"parent_name_singular": "  Initiative ", "parent_name_plural": "Initiatives"})
        self.assertEqual(res.status_code, 200, res.content)
        self.board.refresh_from_db()
        self.assertEqual((self.board.parent_name_singular, self.board.parent_name_plural), ("Initiative", "Initiatives"))
        full = self._client(self.owner).get(f"/api/v1/boards/{self.board.pk}/full/").json()
        self.assertEqual(full["parent_name_singular"], "Initiative")

    def test_each_field_falls_back_on_its_own(self):
        self.assertEqual(self._patch(self.owner, {"parent_name_singular": "Release"}).status_code, 200)
        self.board.refresh_from_db()
        self.assertEqual((self.board.parent_name_singular, self.board.parent_name_plural), ("Release", ""))

    def test_clearing_stores_empty(self):
        self.board.parent_name_singular = "Release"
        self.board.save()
        self.assertEqual(self._patch(self.owner, {"parent_name_singular": "   "}).status_code, 200)
        self.board.refresh_from_db()
        self.assertEqual(self.board.parent_name_singular, "")

    def test_member_is_refused_even_with_an_invalid_body(self):
        for body in ({"parent_name_singular": "Initiative"}, {"parent_name_singular": "x" * 99}):
            self.assertEqual(self._patch(self.member, body).status_code, 403, body)
        self.board.refresh_from_db()
        self.assertEqual(self.board.parent_name_singular, "")

    def test_length_boundary(self):
        self.assertEqual(self._patch(self.owner, {"parent_name_plural": "x" * 24}).status_code, 200)
        res = self._patch(self.owner, {"parent_name_plural": "x" * 25})
        self.assertEqual(res.status_code, 400)
        self.assertIn("parent_name_plural", res.json())
        # 24 after stripping is fine.
        self.assertEqual(self._patch(self.owner, {"parent_name_plural": " " + "y" * 24 + " "}).status_code, 200)

    def test_control_bidi_and_zero_width_characters_refused(self):
        for bad in ("Init\x00", "Ini\ttiative", "Init\u202eevitaitini", "Ini\u200btiative", "Init\u2066x", "\x7f"):
            res = self._patch(self.owner, {"parent_name_singular": bad})
            self.assertEqual(res.status_code, 400, repr(bad))
        self.board.refresh_from_db()
        self.assertEqual(self.board.parent_name_singular, "")

    def test_unicode_letters_and_punctuation_allowed(self):
        self.assertEqual(self._patch(self.owner, {"parent_name_singular": "Épica-1 (Q3)"}).status_code, 200)

    def test_board_full_serializer_is_read_only(self):
        ser = BoardFullSerializer(self.board, data={"parent_name_singular": "X"}, partial=True)
        ser.is_valid()
        self.assertNotIn("parent_name_singular", ser.validated_data)


class ReadShapeTests(_Base):
    def setUp(self):
        super().setUp()
        self.board.parent_name_singular = "Opportunity"
        self.board.parent_name_plural = "Opportunities"
        self.board.save()
        self.parent = _make_card(_make_column(self.board), _make_swimlane(self.board), title="P")
        self.child_board = _make_board(self.owner, name="Delivery")
        self.child = _make_card(_make_column(self.child_board), _make_swimlane(self.child_board), title="C")
        CardParentLink.objects.create(parent=self.parent, child=self.child, created_by=self.owner)
        self.child_only = _make_user()
        BoardMembership.objects.create(board=self.child_board, user=self.child_only, role=Role.MEMBER)

    def test_visible_parent_carries_the_raw_singular(self):
        entry = parents_for_viewer([self.child.pk], self.owner)[self.child.pk]
        self.assertFalse(entry["hidden"])
        self.assertEqual(entry["board_parent_name_singular"], "Opportunity")

    def test_empty_name_is_sent_raw(self):
        self.board.parent_name_singular = ""
        self.board.save()
        entry = parents_for_viewer([self.child.pk], self.owner)[self.child.pk]
        self.assertEqual(entry["board_parent_name_singular"], "")

    def test_hidden_parent_does_not_carry_the_name(self):
        entry = parents_for_viewer([self.child.pk], self.child_only)[self.child.pk]
        self.assertEqual(entry, {"hidden": True})

    def test_absent_user_hides_the_name(self):
        self.assertEqual(parents_for_viewer([self.child.pk], None)[self.child.pk], {"hidden": True})

    def test_picker_rows_carry_the_names(self):
        rows = parent_boards_for_viewer(self.owner, self.child_board)
        self.assertEqual(rows, [{"id": self.board.pk, "name": "Pipeline", "parent_name_singular": "Opportunity", "parent_name_plural": "Opportunities"}])
        self.assertEqual(set(rows[0]), set(ParentBoardOptionSerializer().fields))
        res = self._client(self.owner).get(f"/api/v1/boards/{self.child_board.pk}/parent-boards/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["results"][0]["parent_name_singular"], "Opportunity")
        self.assertEqual(res.json()["results"][0]["parent_name_plural"], "Opportunities")

    def test_picker_omits_boards_without_a_write_role(self):
        self.assertEqual(parent_boards_for_viewer(self.child_only, self.child_board), [])


class AbsenceTests(_Base):
    """Rule 11: the public share and MCP never carry the parent name."""

    def test_public_board_serializer_has_no_parent_name(self):
        fields = set(PublicBoardSerializer().fields)
        self.assertNotIn("parent_name_singular", fields)
        self.assertNotIn("parent_name_plural", fields)

    def test_mcp_board_shape_has_no_parent_name(self):
        from mcp_server.tools import _serialize_board

        self.board.parent_name_singular = "Opportunity"
        self.board._column_count = self.board._swimlane_count = self.board._card_count = 0
        shape = _serialize_board(self.board, Role.ADMIN)
        self.assertNotIn("parent_name_singular", shape)
        self.assertNotIn("parent_name_plural", shape)
        self.assertNotIn("Opportunity", repr(shape))
