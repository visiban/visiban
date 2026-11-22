"""Kills the ``null=True`` mutants of the CardMovement gate-position columns (#2517).

With ``null=False`` Django drops the ``IS NOT NULL`` clause from
``exclude(<field>__gt=0)``, so a row whose gate field is NULL vanishes from the
result. Asserting that such a row is still returned pins ``null=True``.
"""
from unittest.mock import patch

from django.test import TestCase

from boards.models import CardMovement
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_swimlane, _make_user,
)

GATE_FIELDS = ("from_gates_passed", "from_gates_open", "to_gates_passed")


class GateColumnsNullableTests(TestCase):
    def test_null_gate_fields_survive_exclude(self):
        with patch("boards.broadcast.broadcast_board_event"):
            owner = _make_user("null_gate_owner")
            board = _make_board(owner)
            col = _make_column(board, "A", 0)
            lane = _make_swimlane(board, "L", 0)
            card = _make_card(col, lane, title="Subject")
        movement = CardMovement.objects.create(
            card=card, from_column=col, to_column=col, moved_by=owner,
        )
        for field in GATE_FIELDS:
            with self.subTest(field=field):
                self.assertIsNone(getattr(movement, field))
                self.assertIn(
                    movement.pk,
                    CardMovement.objects.exclude(**{f"{field}__gt": 0})
                    .values_list("pk", flat=True),
                )
