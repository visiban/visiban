"""Pins the ``BOARD_EVENT_HOOKS`` enterprise extension point (#863).

``boards.hooks.BOARD_EVENT_HOOKS`` is a 1.x-stable, append-only contract: a
handler ``(board_id: int, event_type: str, event_id: int) -> None`` is called
once per persisted change-feed row, after commit, never for a rolled-back
write. These tests pin the signature, the post-commit guarantee, the
wrap-and-swallow failure policy, and that every writer is covered because
``persist_board_event`` is the only place a feed row is created.
"""

import logging
import pathlib
import re
from unittest.mock import patch

from django.db import transaction
from django.test import TestCase
from rest_framework.test import APIClient

from boards import hooks
from boards.broadcast import persist_board_event, record_board_event
from boards.models import BoardEvent
from boards.tests.conftest import _make_board, _make_column, _make_swimlane, _make_user


class BoardEventHookTests(TestCase):
    def setUp(self):
        self._broadcast = patch("boards.broadcast.broadcast_board_event")
        self._broadcast.start()
        self.addCleanup(self._broadcast.stop)
        self.calls = []

        def recorder(board_id, event_type, event_id):
            self.calls.append((board_id, event_type, event_id))

        # Append in place, never rebind (boards.hooks stability guarantee, #820).
        hooks.BOARD_EVENT_HOOKS.append(recorder)
        self.addCleanup(hooks.BOARD_EVENT_HOOKS.remove, recorder)
        self.user = _make_user()
        self.board = _make_board(self.user)

    def test_oss_registers_nothing(self):
        self.assertEqual(len(hooks.BOARD_EVENT_HOOKS), 1)  # only this test's recorder
        self.assertIsInstance(hooks.BOARD_EVENT_HOOKS, list)

    def test_fires_after_commit_with_plain_ids(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            event_id = record_board_event(self.board.pk, "card.created", {"id": 1})
            self.assertEqual(self.calls, [], "must not fire before commit")
        self.assertTrue(callbacks)
        self.assertEqual(self.calls, [(self.board.pk, "card.created", event_id)])
        board_id, event_type, eid = self.calls[0]
        self.assertIs(type(board_id), int)
        self.assertIs(type(event_type), str)
        self.assertIs(type(eid), int)

    def test_direct_persist_board_event_writers_are_covered(self):
        with self.captureOnCommitCallbacks(execute=True):
            event_id = persist_board_event(self.board.pk, "member.added", {"user": {"id": 1}})
        self.assertEqual(self.calls, [(self.board.pk, "member.added", event_id)])

    def test_never_fires_on_rollback(self):
        class Boom(Exception):
            pass

        with self.captureOnCommitCallbacks(execute=True):
            try:
                with transaction.atomic():
                    record_board_event(self.board.pk, "card.created", {"id": 1})
                    raise Boom
            except Boom:
                pass
        self.assertEqual(self.calls, [])
        self.assertFalse(BoardEvent.objects.exists())

    def test_fires_once_per_row(self):
        with self.captureOnCommitCallbacks(execute=True):
            ids = [record_board_event(self.board.pk, "card.created", {"id": i}) for i in range(3)]
        self.assertEqual([c[2] for c in self.calls], ids)

    def test_a_real_api_write_fires_it(self):
        col = _make_column(self.board, allow_card_creation=True)
        lane = _make_swimlane(self.board)
        client = APIClient()
        client.force_authenticate(self.user)
        with self.captureOnCommitCallbacks(execute=True):
            r = client.post(
                f"/api/v1/boards/{self.board.pk}/cards/",
                {"title": "Hooked", "column": col.pk, "swimlane": lane.pk},
                format="json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIn("card.created", [c[1] for c in self.calls])

    def test_a_raising_handler_is_logged_and_swallowed(self):
        def broken(board_id, event_type, event_id):
            raise RuntimeError("payload-should-not-be-logged")

        hooks.BOARD_EVENT_HOOKS.insert(0, broken)
        self.addCleanup(hooks.BOARD_EVENT_HOOKS.remove, broken)
        with self.assertLogs("boards.broadcast", level=logging.WARNING) as logs, self.captureOnCommitCallbacks(execute=True):
            event_id = record_board_event(self.board.pk, "card.created", {"id": 1})
        # The later handler still ran.
        self.assertEqual(self.calls, [(self.board.pk, "card.created", event_id)])
        line = "\n".join(logs.output)
        self.assertIn("broken", line)
        self.assertIn("RuntimeError", line)
        self.assertNotIn("payload-should-not-be-logged", line)


class NoHookRegisteredTests(TestCase):
    def test_no_callback_queued_when_the_list_is_empty(self):
        self.assertEqual(hooks.BOARD_EVENT_HOOKS, [])
        board = _make_board(_make_user())
        with patch("boards.broadcast.broadcast_board_event"), self.captureOnCommitCallbacks() as callbacks:
            persist_board_event(board.pk, "card.created", {"id": 1})
        self.assertEqual(callbacks, [])


class SingleWriterTests(TestCase):
    """Every feed row comes from persist_board_event, so the hook sees every writer."""

    def test_no_other_code_creates_board_event_rows(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        pattern = re.compile(r"BoardEvent\.objects\.(create|bulk_create|get_or_create|update_or_create)\(")
        offenders = []
        for path in root.rglob("*.py"):
            parts = path.relative_to(root).parts
            if "tests" in parts or "migrations" in parts or ".venv" in parts or parts[0].startswith("."):
                continue
            text = path.read_text(errors="ignore")
            for match in pattern.finditer(text):
                lineno = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{'/'.join(parts)}:{lineno}")
        self.assertEqual([o.split(":")[0] for o in offenders], ["boards/broadcast.py"], offenders)
