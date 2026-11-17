"""Commitment point (#2050): cycle time and age start at a chosen column.

A board opts in by setting ``commitment_column_uid``. A board that does not
keeps the flow-metric ADR's rule exactly (the existing ``test_flow_metrics``
suite pins that). The fixture's columns are Backlog(0), Doing(1), Review(2),
Done(3, done) and Released(4, done).
"""

from rest_framework.test import APIClient

from accounts.models import User
from boards.models import Board, BoardMembership, Column
from boards.services import flow_metrics as fm
from boards.tests.test_flow_metrics import EndpointFixture, FlowFixture


class CommitmentFixture(FlowFixture):
    def commit_at(self, column):
        Board.objects.filter(pk=self.board.pk).update(commitment_column_uid=column.uid if column else None)
        self.board.refresh_from_db()

    def cycle(self):
        return {s["card_uid"]: s["value_days"] for s in fm.cycle_time(self.flow(), self.last())["samples"]}

    def ages(self):
        return {s["card_uid"]: s["value_days"] for s in fm.age(self.flow(), self.last())["samples"]}


class CommitmentCycleTimeTests(CommitmentFixture):
    def test_unset_keeps_the_adr_rule(self):
        card = self.path(self.backlog, 30, self.doing, 20, self.review, 15, self.done, 10)
        self.assertIsNone(self.flow().committed_uids)
        self.assertAlmostEqual(self.cycle()[card.uid], 10.0)

    def test_cycle_starts_at_the_commitment_column(self):
        card = self.path(self.backlog, 30, self.doing, 20, self.review, 15, self.done, 10)
        self.commit_at(self.review)
        self.assertAlmostEqual(self.cycle()[card.uid], 5.0)

    def test_a_card_that_skips_the_commitment_column_starts_at_the_first_column_past_it(self):
        card = self.path(self.backlog, 30, self.review, 18, self.done, 10)
        self.commit_at(self.doing)
        self.assertAlmostEqual(self.cycle()[card.uid], 8.0)

    def test_a_card_created_at_the_commitment_column_starts_at_creation(self):
        # Under the default rule this card would start only when it left Review.
        card = self.path(self.review, 25, self.done, 10)
        self.commit_at(self.review)
        self.assertAlmostEqual(self.cycle()[card.uid], 15.0)

    def test_a_card_that_reaches_done_before_committing_has_no_cycle_time_and_is_not_excluded(self):
        card = self.path(self.backlog, 30, self.doing, 20, self.done, 10)
        self.commit_at(self.review)
        payload = fm.cycle_time(self.flow(), self.last())
        self.assertNotIn(card.uid, {s["card_uid"] for s in payload["samples"]})
        self.assertEqual(payload["excluded_incomplete_history"], 0)

    def test_a_backward_move_does_not_restart_the_clock(self):
        card = self.path(self.backlog, 30, self.review, 25, self.backlog, 20, self.review, 15, self.done, 10)
        self.commit_at(self.review)
        self.assertAlmostEqual(self.cycle()[card.uid], 15.0)

    def test_a_done_or_deleted_commitment_column_reads_as_unset(self):
        card = self.path(self.backlog, 30, self.doing, 20, self.review, 15, self.done, 10)
        Board.objects.filter(pk=self.board.pk).update(commitment_column_uid=self.done.uid)
        self.board.refresh_from_db()
        self.assertIsNone(self.flow().committed_uids)
        Board.objects.filter(pk=self.board.pk).update(commitment_column_uid="gone0000gone0000")
        self.board.refresh_from_db()
        self.assertIsNone(self.flow().committed_uids)
        self.assertAlmostEqual(self.cycle()[card.uid], 10.0)

    def test_definitions_follow_the_board(self):
        flow = self.flow()
        self.assertEqual(fm.cycle_time(flow, self.last())["definition"], fm.DEFINITIONS["cycle_time"])
        self.commit_at(self.review)
        flow = self.flow()
        self.assertEqual(fm.cycle_time(flow, self.last())["definition"], fm.COMMITMENT_DEFINITIONS["cycle_time"])
        self.assertEqual(fm.age(flow, self.last())["definition"], fm.COMMITMENT_DEFINITIONS["age"])
        # Definitions with no commitment variant are unchanged.
        self.assertEqual(fm.throughput(flow, self.last())["definition"], fm.DEFINITIONS["throughput"])


class CommitmentAgeTests(CommitmentFixture):
    def test_a_card_before_the_commitment_point_is_not_in_progress(self):
        waiting = self.path(self.backlog, 30, self.doing, 20)
        working = self.path(self.backlog, 30, self.doing, 20, self.review, 4)
        self.commit_at(self.review)
        ages = self.ages()
        self.assertNotIn(waiting.uid, ages)
        self.assertAlmostEqual(ages[working.uid], 4.0)

    def test_throughput_counts_starts_at_the_commitment_point(self):
        self.path(self.backlog, 30, self.doing, 20, self.review, 4)
        self.commit_at(self.review)
        payload = fm.throughput(self.flow(), self.last(), period="day")
        started = {s["start"]: s["started"] for s in payload["samples"] if s["started"]}
        # Counted on the day it reached Review, not the day it left Backlog.
        self.assertEqual(started, {self.ago(4).date().isoformat(): 1})


class CommitmentSerializerTests(EndpointFixture):
    def patch(self, value, user=None):
        client = self.client if user is None else APIClient()
        if user is not None:
            client.force_authenticate(user)
        return client.patch(f"/api/v1/boards/{self.board.pk}/", {"commitment_column_uid": value}, format="json")

    def test_defaults_to_null(self):
        resp = self.client.get(f"/api/v1/boards/{self.board.pk}/")
        self.assertIsNone(resp.json()["commitment_column_uid"])

    def test_admin_sets_and_clears_a_column_of_the_board(self):
        resp = self.patch(self.review.uid)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["commitment_column_uid"], self.review.uid)
        resp = self.patch(None)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNone(resp.json()["commitment_column_uid"])

    def test_member_and_viewer_cannot_set_it(self):
        for role in ("member", "viewer"):
            with self.subTest(role=role):
                user = User.objects.create_user(username=f"commit_{role}", password="pw")
                BoardMembership.objects.create(board=self.board, user=user, role=role)
                self.assertEqual(self.patch(self.review.uid, user=user).status_code, 403)
                # An invalid value is still refused for the role, not the value.
                self.assertEqual(self.patch("not-a-column", user=user).status_code, 403)
                self.board.refresh_from_db()
                self.assertIsNone(self.board.commitment_column_uid)

    def test_echoing_the_stored_value_is_accepted_after_the_column_is_marked_done(self):
        self.assertEqual(self.patch(self.review.uid).status_code, 200)
        Column.objects.filter(pk=self.review.pk).update(is_done=True)
        self.assertEqual(self.patch(self.review.uid).status_code, 200)

    def test_rejects_a_done_column(self):
        self.assertEqual(self.patch(self.done.uid).status_code, 400)

    def test_rejects_another_boards_column(self):
        other = Board.objects.create(name="Other", owner=self.user)
        foreign = Column.objects.create(board=other, name="Elsewhere", position=0)
        self.assertEqual(self.patch(foreign.uid).status_code, 400)

    def test_endpoint_serves_the_commitment_definition(self):
        self.commit_at = CommitmentFixture.commit_at.__get__(self)
        self.commit_at(self.review)
        resp = self.client.get(self.url("cycle-time"))
        self.assertEqual(resp.json()["definition"], fm.COMMITMENT_DEFINITIONS["cycle_time"])
