"""Children mode live-update gaps (#2370 broadcast audit).

- A column-only move that omits ``swimlane_id`` keeps the card's CURRENT lane,
  read under the move's lock, so Children mode's Move cannot put back a lane
  another user changed after the parent board last read the child.
- Changing a child's Needed by hand pings the parent's board
  (``card.children_changed``), published on commit, once.
"""
from unittest.mock import patch

from accounts.models import SiteSetting
from boards import broadcast as _broadcast
from boards.models import Card, CardMovement, Swimlane
from boards.tests.test_planned_children_2371 import PATCH_BROADCAST, PlannedFixture, client_for


class ColumnOnlyMoveKeepsCurrentLaneTests(PlannedFixture):
    def setUp(self):
        super().setUp()
        SiteSetting.get()  # warm the cache so on_commit counts are exact
        self.other_lane = Swimlane.objects.create(board=self.cboard, name="Platform", position=1)
        self.child = Card.objects.create(board=self.cboard, column=self.todo, swimlane=self.clane, title="Spec")

    def test_omitted_swimlane_keeps_the_lane_another_user_set(self):
        # Another user moved the child to another lane after this client read it.
        Card.objects.filter(pk=self.child.pk).update(swimlane=self.other_lane)
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/move/",
                {"column_id": self.doing.pk, "position": 0}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.child.refresh_from_db()
        self.assertEqual((self.child.column_id, self.child.swimlane_id), (self.doing.pk, self.other_lane.pk))
        mv = CardMovement.objects.filter(card=self.child).latest("moved_at")
        self.assertEqual((mv.from_swimlane_id, mv.to_swimlane_id), (self.other_lane.pk, self.other_lane.pk))

    def test_null_swimlane_keeps_the_lane_too(self):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/move/",
                {"column_id": self.doing.pk, "swimlane_id": None, "position": 0}, format="json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.child.refresh_from_db()
        self.assertEqual(self.child.swimlane_id, self.clane.pk)

    def test_rest_move_without_column_id_is_still_404(self):
        # "Keep the column" (#2657) is the service's sentinel, not an omitted REST field.
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/move/",
                {"swimlane_id": self.other_lane.pk, "position": 0}, format="json",
            )
        self.assertEqual(r.status_code, 404, r.content)
        self.child.refresh_from_db()
        self.assertEqual(self.child.swimlane_id, self.clane.pk)

    def test_a_lane_on_another_board_is_still_404(self):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            r = client_for(self.maya).post(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/move/",
                {"column_id": self.doing.pk, "swimlane_id": self.plane.pk, "position": 0}, format="json",
            )
        self.assertEqual(r.status_code, 404, r.content)


class SetNeededPingsTheParentBoardTests(PlannedFixture):
    def setUp(self):
        super().setUp()
        SiteSetting.get()

    def post_needed(self, child, value):
        return client_for(self.maya).post(
            f"/api/v1/boards/{self.cboard.pk}/cards/{child.pk}/needed/", {"needed_at_column": value}, format="json",
        )

    def test_needed_change_pings_the_parent_board_on_commit_once(self):
        child = self.planned_child()
        with patch(PATCH_BROADCAST) as bc, self.captureOnCommitCallbacks(execute=False) as callbacks:
            r = self.post_needed(child, None)
            self.assertEqual(r.status_code, 200, r.content)
            bc.assert_not_called()  # nothing is published before the commit
        with patch(PATCH_BROADCAST) as bc:
            for cb in callbacks:
                cb()
        sent = [(c.args[0], c.args[1], c.args[2]) for c in bc.call_args_list]
        self.assertEqual(
            [s for s in sent if s[1] == _broadcast.EVT_CARD_CHILDREN_CHANGED],
            [(self.pboard.pk, _broadcast.EVT_CARD_CHILDREN_CHANGED, {"parent_id": self.parent.pk})],
        )
        # The child's own board still gets its card.parent_changed, once.
        self.assertEqual(
            [s for s in sent if s[1] == _broadcast.EVT_CARD_PARENT_CHANGED],
            [(self.cboard.pk, _broadcast.EVT_CARD_PARENT_CHANGED, {"card_ids": [child.pk]})],
        )

    def test_a_no_op_pings_nothing(self):
        child = self.planned_child()
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            self.post_needed(child, None)
        with patch(PATCH_BROADCAST) as bc, self.captureOnCommitCallbacks(execute=True):
            r = self.post_needed(child, None)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse([c for c in bc.call_args_list if c.args[1] == _broadcast.EVT_CARD_CHILDREN_CHANGED])
