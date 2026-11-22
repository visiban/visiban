"""History's Parent filter (#2209, #2499): ``GET /boards/{id}/movements/?parent_id=``.

"Movement history of these children" opens the child board's History with
Parent = the parent card. The parent sits on another board, so the filter
crosses the #1104 boundary: a parent the caller cannot open must answer
exactly like a parent with no children here (absent-input rule, #1075).
"""

from django.test import TestCase

from boards.models import BoardMembership, CardMovement, CardParentLink
from boards.tests.conftest import _make_card
from boards.tests.test_card_parent_links import _LinkFixture

Role = BoardMembership.Role


class MovementsParentFilterTests(_LinkFixture, TestCase):
    def setUp(self):
        self._setup_boards()
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        self.other = _make_card(self.col_c, self.lane_c, title="Not a child")
        for card in (self.child, self.other):
            CardMovement.objects.create(
                card=card, board=self.cboard, to_column=self.col_c, to_column_name=self.col_c.name,
                to_swimlane=self.lane_c, to_swimlane_name=self.lane_c.name,
                movement_type=CardMovement.MovementType.MOVE,
            )
        self.url = f"/api/v1/boards/{self.cboard.pk}/movements/"

    def _ids(self, user, parent_id):
        r = self._client(user).get(self.url, {"parent_id": parent_id})
        self.assertEqual(r.status_code, 200, r.content)
        return {m["card_uid"] for m in r.json()["results"]}, r.json()["count"]

    def test_filters_to_the_children_of_an_openable_parent(self):
        u = self._user("mpf_both", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        uids, count = self._ids(u, self.parent.pk)
        self.assertEqual(uids, {self.child.uid})
        self.assertEqual(count, 1)
        # Without the param, History is unfiltered.
        all_rows = self._client(u).get(self.url).json()["count"]
        self.assertGreaterEqual(all_rows, 2)

    def test_unopenable_parent_answers_like_a_missing_one(self):
        u = self._user("mpf_child_only", child_role=Role.VIEWER)
        hidden = self._ids(u, self.parent.pk)
        missing = self._ids(u, 987654321)
        self.assertEqual(hidden, (set(), 0))
        self.assertEqual(hidden, missing)

    def test_rejects_a_non_integer_parent_id(self):
        u = self._user("mpf_bad", parent_role=Role.VIEWER, child_role=Role.VIEWER)
        r = self._client(u).get(self.url, {"parent_id": "abc"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "invalid_query_param")
