"""#2553: planned-children edge cases left open by #2371.

* A column reorder releases a planned child whose Needed column now sits at or
  before the parent's current column (release used to happen only on a parent
  move).
* The public share link hides a planned child's due date, so the client cannot
  derive Overdue from a date the server treats as inactive (Rule 19: the five
  planned fields stay off the wire).
"""
import datetime
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from boards import broadcast as _broadcast
from boards.models import Card, CardActivity, CardParentLink
from boards.serializers import PublicCardSerializer
from boards.services import planned_children
from boards.tests.test_planned_children_2371 import PATCH_BROADCAST, PlannedFixture, client_for

EV = CardActivity.EventType


class ReorderReleaseTests(PlannedFixture):
    def reorder(self, order, user=None):
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            return client_for(user or self.owner).post(
                f"/api/v1/boards/{self.pboard.pk}/columns/reorder/", {"order": [c.pk for c in order]}, format="json",
            )

    def test_reorder_that_puts_the_needed_column_before_the_parent_releases(self):
        child = self.planned_child(column=self.proposal, due=datetime.date(2026, 12, 4))
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        self.assertIsNone(self.link(child).planned_released_at)
        # Proposal now sits before Qualify, where the parent is.
        r = self.reorder([self.lead, self.proposal, self.qualify, self.won])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(self.link(child).planned_released_at)
        # Actorless, names no parent/board/column (Rule 19).
        self.assertEqual(self.events(child)[-1], (EV.PLANNED_RELEASED, "parent_reached", "2026-12-04", None))
        body = self.read(child, self.maya)
        self.assertEqual((body["planned"], body["needed_now"], body["needed_now_reason"]), (False, True, "parent"))

    def test_reorder_to_the_same_column_as_the_parent_releases(self):
        child = self.planned_child(column=self.qualify)
        self.move(self.parent, self.pboard, self.lead, self.plane)
        # Qualify moves to the front: position 0, the parent's column (Lead) is now 1.
        self.reorder([self.qualify, self.lead, self.proposal, self.won])
        self.assertIsNotNone(self.link(child).planned_released_at)

    def test_reorder_that_does_not_cross_leaves_it_planned(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        self.assertEqual(self.reorder([self.lead, self.qualify, self.won, self.proposal]).status_code, 200)
        self.assertIsNone(self.link(child).planned_released_at)
        self.assertEqual([e[0] for e in self.events(child)], [EV.NEEDED_CHANGED])

    def test_release_pings_the_child_board_with_ids_only(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        with patch.object(planned_children._broadcast, "record_board_event") as rec:
            with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
                client_for(self.owner).post(
                    f"/api/v1/boards/{self.pboard.pk}/columns/reorder/",
                    {"order": [c.pk for c in [self.lead, self.proposal, self.qualify, self.won]]}, format="json",
                )
        pings = [c for c in rec.call_args_list if c.args[1] == _broadcast.EVT_CARD_PARENT_CHANGED]
        self.assertEqual(len(pings), 1)
        self.assertEqual(pings[0].args[0], self.cboard.pk)
        self.assertEqual(pings[0].args[2], {"card_ids": [child.pk]})

    def test_already_released_link_is_not_released_twice(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.proposal, self.plane)
        released = self.link(child).planned_released_at
        self.reorder([self.proposal, self.lead, self.qualify, self.won])
        self.assertEqual(self.link(child).planned_released_at, released)
        self.assertEqual(len([e for e in self.events(child) if e[0] == EV.PLANNED_RELEASED]), 1)

    def test_other_boards_links_are_untouched(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        # Reordering the CHILD board's columns scans no planned link.
        with patch(PATCH_BROADCAST), self.captureOnCommitCallbacks(execute=True):
            client_for(self.owner).post(
                f"/api/v1/boards/{self.cboard.pk}/columns/reorder/",
                {"order": [self.doing.pk, self.todo.pk]}, format="json",
            )
        self.assertIsNone(self.link(child).planned_released_at)

    def test_absent_board_releases_nothing(self):
        # #1075 absent-input guard: no board, no scope, no release (and no query).
        child = self.planned_child(column=self.qualify)
        with CaptureQueriesContext(connection) as ctx:
            planned_children.release_on_reorder(None, actor=self.owner)
        self.assertEqual(len(ctx), 0)
        self.assertIsNone(self.link(child).planned_released_at)

    def test_non_admin_cannot_reorder_so_cannot_release(self):
        child = self.planned_child(column=self.proposal)
        self.move(self.parent, self.pboard, self.qualify, self.plane)
        r = self.reorder([self.lead, self.proposal, self.qualify, self.won], user=self.maya)
        self.assertEqual(r.status_code, 403)
        self.assertIsNone(self.link(child).planned_released_at)


class ShareLinkPlannedDateTests(PlannedFixture):
    def setUp(self):
        super().setUp()
        self.past = datetime.date(2020, 1, 1)
        self.planned = self.planned_child(due=self.past)
        self.released = self.planned_child(due=self.past)
        CardParentLink.objects.filter(child=self.released).update(planned_released_at=self.parent.created_at)
        self.plain = Card.objects.create(
            board=self.cboard, column=self.todo, swimlane=self.clane, title="Plain", due_date=self.past,
        )
        self.token = client_for(self.owner).post(f"/api/v1/boards/{self.cboard.pk}/share/").data["share_token"]

    def public(self):
        return {c["uid"]: c for c in APIClient().get(f"/api/share/{self.token}/").json()["cards"]}

    def test_planned_child_date_is_hidden_and_others_are_unchanged(self):
        cards = self.public()
        self.assertIsNone(cards[str(self.planned.uid)]["due_date"])
        self.assertEqual(cards[str(self.released.uid)]["due_date"], "2020-01-01")
        self.assertEqual(cards[str(self.plain.uid)]["due_date"], "2020-01-01")
        # Rule 19 holds: no planned field on any card.
        for card in cards.values():
            for key in ("planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at"):
                self.assertNotIn(key, card)

    def test_date_comes_back_once_the_child_is_released(self):
        CardParentLink.objects.filter(child=self.planned).update(planned_released_at=self.parent.created_at)
        self.assertEqual(self.public()[str(self.planned.uid)]["due_date"], "2020-01-01")

    def test_query_count_is_flat_in_the_number_of_planned_cards(self):
        def count():
            cache.clear()  # the share view caches its payload
            with CaptureQueriesContext(connection) as ctx:
                self.assertEqual(APIClient().get(f"/api/share/{self.token}/").status_code, 200)
            return len(ctx)

        before = count()
        for _ in range(4):
            self.planned_child(due=self.past)
        self.assertEqual(count(), before)

    def test_unannotated_card_fails_closed(self):
        # #1075: a card built without the planned annotation reads its link
        # instead of leaking the date.
        card = Card.objects.select_related("board", "assignee").get(pk=self.planned.pk)
        self.assertFalse(hasattr(card, "_planned_active"))
        self.assertIsNone(PublicCardSerializer(card).data["due_date"])
        plain = Card.objects.select_related("board", "assignee").get(pk=self.plain.pk)
        self.assertEqual(PublicCardSerializer(plain).data["due_date"], "2020-01-01")
