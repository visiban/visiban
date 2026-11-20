"""Stage settings follow-ups (#2368, #2362).

* The stage-save remap writes its gate transitions with one ``bulk_create``
  and its cards with one ``bulk_update``, so the save runs a constant number
  of queries however many cards the stage holds (#2362).
* ``write_gate_transitions`` inserts every gate it crosses in one query and
  stays insert-only (#2362).
* ``GET .../columns/{id}/stage-card-counts/`` gives the Stage settings panel
  the server's per-sub-column counts, archived cards included (#2368).
"""

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from accounts.models import User
from boards.models import (
    AppendOnlyViolation, BoardMembership, Card, CardGateTransition, SubColumn,
)
from boards.services.cards import build_gate_transitions, write_gate_transitions
from boards.tests.test_stages import _StageBase


class StageSaveBulkRemapTests(_StageBase):
    def _fill(self, n):
        return [
            Card.objects.create(
                board=self.board, column=self.stage, swimlane=self.lane, title=f"S{i}",
                created_by=self.user, position=i + 1, gates_passed=1 + (i % 2),
            )
            for i in range(n)
        ]

    def _remove_review(self):
        return self.client.put(
            self.stage_url(),
            {"sub_columns": [{"id": self.subs[0].pk, "name": "Doing"},
                             {"id": self.subs[2].pk, "name": "Ready to pull"}]},
            format="json",
        )

    def _count_save_queries(self, n):
        self._fill(n)
        with CaptureQueriesContext(connection) as ctx:
            resp = self._remove_review()
        self.assertEqual(resp.status_code, 200, resp.data)
        return len(ctx.captured_queries)

    def test_stage_save_query_count_does_not_grow_with_cards(self):
        few = self._count_save_queries(2)
        # Reset the stage: a fresh three-sub-column layout and no cards.
        Card.objects.filter(column=self.stage).delete()
        SubColumn.objects.filter(column=self.stage).delete()
        self.subs = [
            SubColumn.objects.create(column=self.stage, position=i, name=n)
            for i, n in enumerate(["Doing", "Review", "Ready to pull"])
        ]
        many = self._count_save_queries(12)
        self.assertEqual(few, many)

    def test_bulk_remap_keeps_the_per_card_outcome(self):
        cards = self._fill(4)  # gates_passed 1, 2, 1, 2
        resp = self._remove_review()
        self.assertEqual(resp.status_code, 200, resp.data)
        before = {c.pk: c.version for c in cards}
        for c in cards:
            c.refresh_from_db()
        self.assertEqual([c.gates_passed for c in cards], [0, 1, 0, 1])
        self.assertEqual({c.pk: c.version for c in cards}, {pk: v + 1 for pk, v in before.items()})
        remapped = {r["id"]: r for r in resp.data["remapped"]}
        self.assertEqual(
            remapped, {c.pk: {"id": c.pk, "gates_passed": c.gates_passed, "version": c.version} for c in cards},
        )
        rows = CardGateTransition.objects.filter(cause="stage_edited").order_by("id")
        # Only the cards whose own sub-column (Review) was removed fall back.
        self.assertEqual(
            [(r.card_id, r.kind, r.from_index, r.to_index) for r in rows],
            [(cards[0].pk, "reopen", 1, 0), (cards[2].pk, "reopen", 1, 0)],
        )
        # bulk_create skips save(), so the snapshots must be set by the builder.
        for r in rows:
            self.assertEqual(r.board_id, self.board.pk)
            self.assertTrue(r.card_uid)
            self.assertEqual(r.card_title, Card.objects.get(pk=r.card_id).title)
            self.assertEqual(r.sub_column_name, "Doing")

    def test_reorder_with_a_removal_falls_back_in_the_old_order(self):
        # Old [Doing, Review, Ready]; new [Ready, Doing]: a card in Review
        # falls back to Doing (the kept sub-column before it in the old
        # order), which is now at index 1.
        card = Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title="R",
            created_by=self.user, position=1, gates_passed=2,
        )
        resp = self.client.put(
            self.stage_url(),
            {"sub_columns": [{"id": self.subs[2].pk, "name": "Ready to pull"},
                             {"id": self.subs[0].pk, "name": "Doing"}]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.data)
        card.refresh_from_db()
        self.assertEqual(card.gates_passed, 0)  # follows Ready to pull to index 0
        self.assertFalse(CardGateTransition.objects.filter(card=card).exists())


class WriteGateTransitionsBulkTests(_StageBase):
    def test_one_insert_for_every_gate_crossed(self):
        self.card.column = self.stage
        self.card.save()
        with CaptureQueriesContext(connection) as ctx:
            rows = write_gate_transitions(
                card=self.card, column=self.stage, sub_columns=self.subs,
                from_index=0, to_index=2, actor=self.user,
                cause=CardGateTransition.Cause.MOVE,
            )
        inserts = [q for q in ctx.captured_queries if q["sql"].upper().startswith("INSERT")]
        self.assertEqual(len(inserts), 1)
        self.assertEqual([(r.from_index, r.to_index) for r in rows], [(0, 1), (1, 2)])
        self.assertTrue(all(r.pk for r in rows))
        self.assertEqual(CardGateTransition.objects.filter(card=self.card).count(), 2)

    def test_no_gate_crossed_writes_nothing(self):
        with CaptureQueriesContext(connection) as ctx:
            rows = write_gate_transitions(
                card=self.card, column=self.stage, sub_columns=self.subs,
                from_index=1, to_index=1, actor=self.user,
                cause=CardGateTransition.Cause.MOVE,
            )
        self.assertEqual(rows, [])
        self.assertEqual(len(ctx.captured_queries), 0)

    def test_built_rows_are_unsaved_and_rows_stay_append_only(self):
        built = build_gate_transitions(
            card=self.card, column=self.stage, sub_columns=self.subs,
            from_index=2, to_index=0, actor=self.user,
            cause=CardGateTransition.Cause.STAGE_EDITED, created_at=timezone.now(),
        )
        self.assertEqual([r.kind for r in built], ["reopen", "reopen"])
        self.assertTrue(all(r.pk is None for r in built))
        saved = write_gate_transitions(
            card=self.card, column=self.stage, sub_columns=self.subs,
            from_index=0, to_index=1, actor=self.user, cause=CardGateTransition.Cause.MOVE,
        )
        row = CardGateTransition.objects.get(pk=saved[0].pk)
        row.reason = "rewritten"
        with self.assertRaises(AppendOnlyViolation):
            row.save()


class StageCardCountsTests(_StageBase):
    def counts_url(self, column=None):
        column = column or self.stage
        return f"/api/v1/boards/{self.board.pk}/columns/{column.pk}/stage-card-counts/"

    def _card(self, gates, archived=False):
        return Card.objects.create(
            board=self.board, column=self.stage, swimlane=self.lane, title=f"G{gates}",
            created_by=self.user, position=gates + 10, gates_passed=gates,
            archived_at=timezone.now() if archived else None,
        )

    def test_counts_split_active_and_archived_and_clamp_past_the_last(self):
        self._card(0)
        self._card(1)
        self._card(1, archived=True)
        self._card(1, archived=True)
        self._card(7)  # past the last sub-column: counts in the last one
        resp = self.client.get(self.counts_url())
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["sub_columns"], [
            {"id": self.subs[0].pk, "cards": 1, "archived_cards": 0},
            {"id": self.subs[1].pk, "cards": 1, "archived_cards": 2},
            {"id": self.subs[2].pk, "cards": 1, "archived_cards": 0},
        ])

    def test_plain_column_returns_an_empty_list(self):
        resp = self.client.get(self.counts_url(self.plain))
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.data["sub_columns"], [])

    def test_member_gets_403(self):
        member = User.objects.create_user(username="member2368", password="pass")
        BoardMembership.objects.create(board=self.board, user=member, role="member")
        self.client.force_authenticate(member)
        self.assertEqual(self.client.get(self.counts_url()).status_code, 403)

    def test_non_member_gets_404(self):
        stranger = User.objects.create_user(username="stranger2368", password="pass")
        self.client.force_authenticate(stranger)
        self.assertEqual(self.client.get(self.counts_url()).status_code, 404)

    def test_unauthenticated_is_refused(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(self.counts_url()).status_code, (401, 403))

    def test_unknown_and_out_of_range_column_ids_are_404(self):
        base = f"/api/v1/boards/{self.board.pk}/columns"
        for pk in (999999, 2 ** 70):
            resp = self.client.get(f"{base}/{pk}/stage-card-counts/")
            self.assertEqual(resp.status_code, 404, pk)

    def test_column_from_another_board_is_404(self):
        from boards.tests.conftest import _make_board
        from boards.models import Column

        other = _make_board(self.user)
        col = Column.objects.create(board=other, name="Elsewhere", position=0)
        resp = self.client.get(
            f"/api/v1/boards/{self.board.pk}/columns/{col.pk}/stage-card-counts/",
        )
        self.assertEqual(resp.status_code, 404)
