"""PostgreSQL race test: creating a card vs a column reorder (#1566).

``create_card`` holds its column row ``FOR NO KEY UPDATE`` and, at commit, the
card insert's deferred foreign-key check needs ``FOR KEY SHARE`` on the board
row. ``ColumnViewSet.reorder`` takes the board row and then waits on the column
rows. With a ``FOR UPDATE`` board lock each waits on the other and PostgreSQL
aborts one with ``deadlock detected`` (a 500). The reorder takes the board lock
``FOR NO KEY UPDATE`` so it does not block the key-share.

Technique: same as ``test_concurrent_lock_sites.py`` (#1524). The create is
paused inside its transaction after the card is inserted (column lock held);
the reorder starts once it is paused and queues on the column. On resume the
create commits. SQLite has no row locks, so this only runs on PostgreSQL.

The admin card form (``admin.py`` -> ``save_model``) has the same shape (column
lock via ``enforce_column_limits``, then a card insert) and is fixed by the same
change on the reorder side, so it needs no separate change.
"""

from boards.models import Card, Column
from boards.tests.test_concurrent_lock_sites import _LockRaceBase


class CardCreateVsColumnReorderTests(_LockRaceBase):
    def setUp(self):
        super().setUp()
        self.col2 = Column.objects.create(board=self.board, name="Done", position=1)

    def test_create_card_does_not_deadlock_with_column_reorder(self):
        body = {"column": self.col.pk, "swimlane": self.swim.pk, "title": "Racer"}
        done, _hold_ended = self._race(
            self._request("post", "/cards/", body),
            self._request(
                "post",
                "/columns/reorder/",
                {"order": [self.col2.pk, self.col.pk]},
            ),
            patch_target="boards.services.cards.enforce_column_limits",
        )
        self.assertEqual(done["first"][0].status_code, 201)
        self.assertEqual(done["second"][0].status_code, 200)
        self.assertEqual(Card.objects.filter(column=self.col, title="Racer").count(), 1)
        self.assertEqual(
            list(
                Column.objects.filter(board=self.board)
                .order_by("position")
                .values_list("pk", flat=True)
            ),
            [self.col2.pk, self.col.pk],
        )
