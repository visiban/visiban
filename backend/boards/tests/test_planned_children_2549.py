"""Planned children follow-ups (#2549, rollup half of #2551).

Add child's optional ``due_date`` (validated at the boundary, stored inactive
on a planned child) and the parent rollup's planned bucket: ``planned`` is its
own count, left out of ``todo`` and ``last_moved_at``; ``planned_due_dates``
and ``needed_not_started`` feed the two row-2 warnings. A viewer who cannot
open the child board, or no viewer at all, gets the count-only rollup with
none of them (Rule 19; #1075).
"""
import datetime
import json
from unittest.mock import patch

from django.utils import timezone

from boards.models import Card, CardActivity, CardMovement
from boards.services import card_links
from boards.tests.test_planned_children_2371 import PATCH_BROADCAST, PlannedFixture, Role, client_for


class AddChildDueDateTests(PlannedFixture):
    def test_omitted_or_null_stores_no_date(self):
        for extra in ({}, {"due_date": None}):
            r = self.add_child(**extra)
            self.assertEqual(r.status_code, 201, r.content)
            self.assertIsNone(Card.objects.get(pk=r.json()["id"]).due_date)

    def test_now_child_stores_a_live_date(self):
        r = self.add_child(due_date="2026-12-04")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["due_date"], "2026-12-04")
        self.assertEqual(Card.objects.get(pk=r.json()["id"]).due_date, datetime.date(2026, 12, 4))

    def test_planned_child_stores_the_date_inactive(self):
        past = (timezone.localdate() - datetime.timedelta(days=3)).isoformat()
        r = self.add_child(needed_at_column=self.proposal.pk, due_date=past)
        self.assertEqual(r.status_code, 201, r.content)
        child = Card.objects.get(pk=r.json()["id"])
        self.assertEqual(child.due_date.isoformat(), past)
        body = self.read(child, self.maya)
        self.assertTrue(body["planned"])
        # Stored, but out of Overdue while planned.
        res = client_for(self.maya).get(f"/api/v1/boards/{self.cboard.pk}/cards/?overdue=true")
        self.assertEqual(res.status_code, 200, res.content)
        rows = res.json()
        rows = rows.get("results", rows) if isinstance(rows, dict) else rows
        self.assertNotIn(child.pk, [c["id"] for c in rows])

    def test_rejects_a_bad_date_and_creates_nothing(self):
        for value in ("2026-13-01", "Dec 4", 20261204, True, "", ["2026-12-04"]):
            r = self.add_child(due_date=value)
            self.assertEqual(r.status_code, 400, (value, r.content))
            self.assertIn("due_date", r.json())
        self.assertFalse(Card.objects.filter(board=self.cboard).exists())

    def test_role_is_checked_before_the_date(self):
        vera = self.member("vera_d", parent=Role.VIEWER, child=Role.MEMBER)
        r = self.add_child(vera, due_date="not a date")
        self.assertEqual(r.status_code, 403, r.content)


class PlannedRollupTests(PlannedFixture):
    def setUp(self):
        super().setUp()
        self.done = self._col("Done", 9, is_done=True)
        self.pboard_viewer = self.member("pv", parent=Role.VIEWER, child=Role.VIEWER)

    def _col(self, name, position, **kw):
        from boards.models import Column

        return Column.objects.create(board=self.cboard, name=name, position=position, **kw)

    def rollup(self, user):
        res = client_for(user).get(f"/api/v1/boards/{self.pboard.pk}/full/")
        self.assertEqual(res.status_code, 200, res.content)
        return {c["id"]: c for c in res.json()["cards"]}[self.parent.pk]["children_rollup"]

    def test_planned_is_its_own_bucket_out_of_todo_and_last_moved(self):
        now_child = Card.objects.get(pk=self.add_child(title="Kickoff").json()["id"])
        planned = self.planned_child(due=datetime.date(2026, 12, 4))
        self.planned_child(column=self.won)
        # A planned child's move (its creation) must not read as work moved.
        CardMovement.objects.filter(card=now_child).update(moved_at=timezone.now() - datetime.timedelta(days=9))
        CardMovement.objects.filter(card=planned).update(moved_at=timezone.now())
        r = self.rollup(self.maya)
        self.assertEqual(
            {k: r[k] for k in ("total", "todo", "doing", "done", "blocked", "planned")},
            {"total": 3, "todo": 1, "doing": 0, "done": 0, "blocked": 0, "planned": 2},
        )
        self.assertEqual(r["planned_due_dates"], ["2026-12-04"])
        self.assertEqual(r["needed_not_started"], [])
        self.assertLess(
            datetime.datetime.fromisoformat(r["last_moved_at"].replace("Z", "+00:00")),
            timezone.now() - datetime.timedelta(days=8),
        )

    def test_released_by_the_parent_and_not_started_names_the_column(self):
        a = self.planned_child(column=self.qualify)
        self.planned_child(column=self.qualify)
        later = self.planned_child(column=self.won)
        r = self.move(self.parent, self.pboard, self.qualify, self.plane)
        self.assertEqual(r.status_code, 200, r.content)
        r = self.rollup(self.pboard_viewer)
        self.assertEqual((r["todo"], r["planned"]), (2, 1))
        self.assertEqual(r["needed_not_started"], [{"column_name": "Qualify", "count": 2}])
        # Pulling one starts it: it leaves the warning.
        self.assertEqual(self.move(a, self.cboard, self.doing, self.clane).status_code, 200)
        r = self.rollup(self.maya)
        self.assertEqual(r["needed_not_started"], [{"column_name": "Qualify", "count": 1}])
        self.assertEqual((r["doing"], r["planned"]), (1, 1))
        self.assertTrue(Card.objects.filter(pk=later.pk).exists())

    def test_blocked_or_done_planned_children_keep_their_louder_bucket(self):
        child = self.planned_child()
        Card.objects.filter(pk=child.pk).update(blocked_at=timezone.now())
        r = self.rollup(self.maya)
        self.assertEqual((r["blocked"], r["planned"]), (1, 0))

    def test_hidden_child_board_gets_the_count_only(self):
        self.planned_child(due=datetime.date(2026, 12, 4))
        outsider = self.member("out", parent=Role.MEMBER)
        r = self.rollup(outsider)
        self.assertEqual(r, {"visible": False, "total": 1})
        self.assertNotIn("Proposal", json.dumps(r))

    def test_absent_viewer_fails_closed_without_planned_keys(self):
        """#1075: no user or an anonymous one gets the count-only rollup, never the planned fields."""
        from django.contrib.auth.models import AnonymousUser

        self.planned_child(due=datetime.date(2026, 12, 4))
        for user in (None, AnonymousUser()):
            r = card_links.rollups_for_viewer([self.parent.pk], user)[self.parent.pk]
            self.assertEqual(r, {"visible": False, "total": 1})

    def test_zero_rollup_carries_empty_planned_fields(self):
        r = card_links.rollups_for_viewer([self.parent.pk], self.maya)[self.parent.pk]
        self.assertEqual((r["planned"], r["planned_due_dates"], r["needed_not_started"]), (0, [], []))

    def test_planned_fields_add_no_query(self):
        self.planned_child(due=datetime.date(2026, 12, 4))
        self.add_child(title="Now")
        with self.assertNumQueries(4):
            card_links.rollups_for_viewer([self.parent.pk], self.maya)

    def test_release_history_unchanged(self):
        """Rule 19: the rollup work leaves the release row's wording alone (no actor, no parent)."""
        child = self.planned_child(column=self.qualify)
        with patch(PATCH_BROADCAST):
            self.move(self.parent, self.pboard, self.qualify, self.plane)
        row = CardActivity.objects.filter(card=child, event_type=CardActivity.EventType.PLANNED_RELEASED).get()
        self.assertIsNone(row.actor_id)
