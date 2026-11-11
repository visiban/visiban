"""Cursor storage.

A cursor is the integer id of the last event a consumer finished handling.
It is a feed row id, never the ``event_id`` of a WebSocket frame.
The client calls ``set`` only after the consumer's handler returned, which is
what makes delivery at-least-once.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class CursorStore(Protocol):
    """Where a consumer keeps its position, keyed by board id."""

    def get(self, board_id: int) -> int | None:
        """Return the stored cursor, or ``None`` if there is none."""
        ...

    def set(self, board_id: int, cursor: int) -> None:
        """Persist ``cursor``. Make this durable if you need to survive restarts."""
        ...


class MemoryCursorStore:
    """In-memory default. Lost on restart, so the consumer re-reads from the start."""

    def __init__(self) -> None:
        self._cursors: dict[int, int] = {}

    def get(self, board_id: int) -> int | None:
        return self._cursors.get(board_id)

    def set(self, board_id: int, cursor: int) -> None:
        self._cursors[board_id] = cursor
