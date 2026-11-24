"""Stateful property tests for card positions and movement history (#1424).

Hand-picked examples missed the position-corruption bugs of #1275 and #1292
because those lived in sequences nobody wrote down. Hypothesis generates the
sequences: random create / cross-cell move / same-cell reorder / archive /
unarchive against a small board, with every invariant re-checked after every
step:

1. positions of the live cards in each (column, swimlane) cell are unique
   (and contiguous from 0 in any cell that has seen neither a same-cell
   reorder nor an archive/unarchive);
2. every card's column and swimlane belong to the card's board;
3. a cross-cell move writes exactly one ``move`` movement with the right
   from/to, a same-cell reorder writes none;
4. movement history is append-only: rows seen once never change or vanish.

Contiguity is deliberately not asserted in a cell once it has had a same-cell
reorder (the move endpoint treats ``position`` as a raw slot and does not
compact the slot the card leaves, #2277, documented in ``test_card_move.py``)
or an archive/unarchive (an archived card keeps its slot, so a later create
lands after it). Uniqueness is asserted everywhere. Everything is driven through the HTTP API, so a bypass of the move
endpoint (the #1275 class) is exactly what this catches.

CI profile: small and derandomized (no flake, no wall-clock deadline). Raise
``HYPOTHESIS_PROFILE=deep`` for a larger local or nightly run; see
``docs/development/testing.md``.
"""

import os

from django.db import transaction
from django.test import TestCase
from hypothesis import HealthCheck, settings, strategies as st
from hypothesis.stateful import (
    RuleBasedStateMachine,
    invariant,
    precondition,
    rule,
    run_state_machine_as_test,
)
from rest_framework.test import APIClient

from boards.models import Card, CardMovement
from boards.tests.conftest import _make_board, _make_column, _make_swimlane, _make_user

# Few cells on purpose: collisions and reorders need populated cells, and a
# small board makes the generated sequences hit them within a dozen steps.
N_COLUMNS = 2
N_LANES = 2

# Two sequences the machine found were real position-integrity defects, kept
# out of the generated space until fixed: a create after a same-cell reorder
# (#2562, ``create_card`` used the cell's row count as the next slot) and an
# unarchive after a move out of the cell (#2563, the restored card returned to a
# slot a live card had been compacted into). Both are fixed and generated now;
# the exact sequences are pinned in ``test_position_collisions_2562_2563.py``.

_PROFILES = {
    "ci": dict(max_examples=40, stateful_step_count=16),
    "deep": dict(max_examples=300, stateful_step_count=30),
}
_PROFILE = _PROFILES.get(os.environ.get("HYPOTHESIS_PROFILE", "ci"), _PROFILES["ci"])
MACHINE_SETTINGS = settings(
    deadline=None,
    derandomize=True,  # same examples every run: a red run is a real defect
    database=None,
    suppress_health_check=list(HealthCheck),
    **_PROFILE,
)

_MOVEMENT_FIELDS = (
    "card_id", "board_id", "movement_type", "from_column_id", "to_column_id",
    "from_swimlane_id", "to_swimlane_id", "moved_by_id",
)


def _movement_row(m):
    return tuple(getattr(m, f) for f in _MOVEMENT_FIELDS)


class CardPositionMachine(RuleBasedStateMachine):
    """Model of one board; ``fixture`` is injected by the owning TestCase."""

    fixture = None  # (user, board, columns, lanes)

    def __init__(self):
        super().__init__()
        user, board, self.columns, self.lanes = self.fixture
        self.board = board
        self.client = APIClient()
        self.client.force_authenticate(user)
        self.base = f"/api/v1/boards/{board.id}"
        self.cards = []  # ids of cards this example created
        self.trace = []  # readable step log, appended to invariant failures
        self.seen_movements = {}
        # Cells whose slots may legitimately have a gap: an in-place reorder
        # does not compact the slot the card leaves (#2277), and an archived
        # card keeps its slot so unarchive can restore it.
        self.gappy_cells = set()
        # A savepoint per example: the board fixture survives, example rows don't.
        self._atomic = transaction.atomic()
        self._atomic.__enter__()

    def teardown(self):
        transaction.set_rollback(True)
        self._atomic.__exit__(None, None, None)

    # -- helpers ----------------------------------------------------------

    def _live(self):
        return Card.objects.filter(board=self.board, archived_at__isnull=True)

    def _moves(self, card_id):
        return CardMovement.objects.filter(
            card_id=card_id, movement_type=CardMovement.MovementType.MOVE
        ).count()

    def _snapshot(self):
        return list(self._live().order_by("id").values_list("id", "column_id", "swimlane_id", "position"))

    # -- rules ------------------------------------------------------------

    @rule(col=st.integers(0, N_COLUMNS - 1), lane=st.integers(0, N_LANES - 1))
    def create(self, col, lane):
        resp = self.client.post(
            f"{self.base}/cards/",
            {"title": f"c{len(self.cards)}", "column": self.columns[col].id,
             "swimlane": self.lanes[lane].id},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        self.cards.append(resp.json()["id"])
        self.trace.append(f"create card {resp.json()['id']} in col{col}/lane{lane} -> pos {resp.json()['position']}")

    @precondition(lambda self: bool(self.cards))
    @rule(data=st.data())
    def move(self, data):
        """Cross-cell move or same-cell reorder, chosen by the target cell."""
        live_ids = [c for c in self.cards if self._live().filter(pk=c).exists()]
        if not live_ids:
            return
        card_id = data.draw(st.sampled_from(live_ids))
        card = Card.objects.get(pk=card_id)
        col = data.draw(st.integers(0, N_COLUMNS - 1))
        lane = data.draw(st.integers(0, N_LANES - 1))
        position = data.draw(st.integers(0, 4))
        target_col, target_lane = self.columns[col], self.lanes[lane]
        same_cell = (card.column_id, card.swimlane_id) == (target_col.id, target_lane.id)
        before = self._moves(card_id)
        source = (card.column_id, card.swimlane_id)

        resp = self.client.post(
            f"{self.base}/cards/{card_id}/move/",
            {"column_id": target_col.id, "swimlane_id": target_lane.id, "position": position},
            format="json",
        )
        assert resp.status_code == 200, resp.content
        card.refresh_from_db()
        self.trace.append(
            f"move card {card_id} from {source} to ({target_col.id}, {target_lane.id}) at slot {position} -> pos {card.position}"
        )
        assert (card.column_id, card.swimlane_id) == (target_col.id, target_lane.id)
        if same_cell:
            assert self._moves(card_id) == before, "same-cell reorder wrote a movement"
        else:
            assert self._moves(card_id) == before + 1, "cross-cell move must write one movement"
            latest = CardMovement.objects.filter(card_id=card_id).order_by("-id").first()
            assert (latest.from_column_id, latest.from_swimlane_id) == source
            assert (latest.to_column_id, latest.to_swimlane_id) == (target_col.id, target_lane.id)
        if same_cell:
            self.gappy_cells.add(source)

    @precondition(lambda self: bool(self.cards))
    @rule(data=st.data())
    def patch_position_is_rejected(self, data):
        """#1275: a plain PATCH must not move a card; the move endpoint owns that."""
        live_ids = [c for c in self.cards if self._live().filter(pk=c).exists()]
        if not live_ids:
            return
        card_id = data.draw(st.sampled_from(live_ids))
        card = Card.objects.get(pk=card_id)
        before = (card.position, card.column_id, card.swimlane_id)
        new_position = card.position + data.draw(st.integers(1, 5))
        resp = self.client.patch(
            f"{self.base}/cards/{card_id}/", {"position": new_position}, format="json"
        )
        assert 400 <= resp.status_code < 500, (resp.status_code, resp.content)
        card.refresh_from_db()
        # A rejected PATCH must leave the card exactly where it was, not merely
        # off the requested slot.
        assert (card.position, card.column_id, card.swimlane_id) == before, (
            "PATCH moved the card (#1275 bypass)"
        )

    @precondition(lambda self: bool(self.cards))
    @rule(data=st.data())
    def archive(self, data):
        live_ids = [c for c in self.cards if self._live().filter(pk=c).exists()]
        if not live_ids:
            return
        card_id = data.draw(st.sampled_from(live_ids))
        card = Card.objects.get(pk=card_id)
        self.gappy_cells.add((card.column_id, card.swimlane_id))
        resp = self.client.post(f"{self.base}/cards/{card_id}/archive/")
        assert resp.status_code == 200, resp.content
        self.trace.append(f"archive card {card_id}")

    @precondition(lambda self: bool(self.cards))
    @rule(data=st.data())
    def unarchive(self, data):
        archived = [
            c for c in self.cards
            if Card.objects.filter(pk=c, archived_at__isnull=False).exists()
        ]
        if not archived:
            return
        card_id = data.draw(st.sampled_from(archived))
        card = Card.objects.get(pk=card_id)
        self.gappy_cells.add((card.column_id, card.swimlane_id))
        resp = self.client.post(f"{self.base}/cards/{card_id}/unarchive/")
        assert resp.status_code == 200, resp.content

    # -- invariants (checked after every step) ----------------------------

    @invariant()
    def positions_unique_within_each_cell(self):
        cells = {}
        for card in self._live():
            cells.setdefault((card.column_id, card.swimlane_id), []).append(card.position)
        for cell, positions in cells.items():
            assert len(positions) == len(set(positions)), (
                f"duplicate positions in {cell}: {sorted(positions)}\nsteps: " + "; ".join(self.trace)
                + f"\nlive cards (id, cell, position): {self._snapshot()}"
            )

    @invariant()
    def positions_contiguous_in_cells_without_known_gaps(self):
        cells = {}
        for card in self._live():
            cells.setdefault((card.column_id, card.swimlane_id), []).append(card.position)
        for cell, positions in cells.items():
            if cell in self.gappy_cells:
                continue  # raw-slot / archived-slot semantics, see module docstring
            assert sorted(positions) == list(range(len(positions))), (
                f"positions in {cell} are not contiguous from 0: {sorted(positions)}"
            )

    @invariant()
    def card_cell_belongs_to_card_board(self):
        for card in Card.objects.filter(board=self.board).select_related("column", "swimlane"):
            assert card.column.board_id == card.board_id
            assert card.swimlane.board_id == card.board_id

    @invariant()
    def movement_history_is_append_only(self):
        current = {m.id: _movement_row(m) for m in CardMovement.objects.filter(board=self.board)}
        for mid, row in self.seen_movements.items():
            assert mid in current, f"movement {mid} disappeared"
            assert current[mid] == row, f"movement {mid} was rewritten"
        self.seen_movements.update(current)


class CardPositionInvariantTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        user = _make_user("prop-owner")
        board = _make_board(user, name="Property board")
        columns = [
            _make_column(board, f"Col{i}", i, allow_card_creation=True) for i in range(N_COLUMNS)
        ]
        lanes = [_make_swimlane(board, f"Lane{i}", i) for i in range(N_LANES)]
        cls.fixture = (user, board, columns, lanes)

    def test_card_position_and_movement_invariants_hold_over_random_sequences(self):
        machine = type(
            "BoundCardPositionMachine", (CardPositionMachine,), {"fixture": self.fixture}
        )
        run_state_machine_as_test(machine, settings=MACHINE_SETTINGS)
