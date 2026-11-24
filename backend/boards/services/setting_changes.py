"""Audit rows for board enforcement settings (#1923, #2584).

Board saves otherwise leave only a ``board.updated`` feed row, which carries
no old value and is pruned after ``BOARD_EVENT_RETENTION_DAYS``. Every toggle
that widens or relaxes who can place a card past a limit is recorded here, on
every write path that changes it (the board and swimlane PATCH/PUT views).
"""

from ..models import BoardSettingChange

# Board fields audited on every change. ``allow_assignee_override`` widens who
# can force past a Block limit; the three ``enforce_*`` flags turn limits on,
# off, or hard.
AUDITED_BOARD_SETTINGS = (
    "allow_assignee_override",
    "enforce_wip_limits",
    "enforce_wip_hard",
    "enforce_weight_limits",
)


def _as_text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


def snapshot_board_settings(board):
    """The audited values of ``board`` as they are now (read under the lock)."""
    return {name: getattr(board, name) for name in AUDITED_BOARD_SETTINGS}


def record_board_setting_changes(*, board, actor, before):
    """Write one ``BoardSettingChange`` per audited field that changed.

    ``before`` is ``snapshot_board_settings`` taken under the board lock before
    the save; call this after the save, in the same transaction. One INSERT at
    most, none when nothing audited changed.
    """
    rows = [
        BoardSettingChange(
            board=board, actor=actor, setting=name,
            old_value=_as_text(old), new_value=_as_text(getattr(board, name)),
        )
        for name, old in before.items()
        if getattr(board, name) != old
    ]
    if rows:
        BoardSettingChange.objects.bulk_create(rows)
    return rows


def record_swimlane_enforcement_change(*, swimlane, actor, old_value):
    """Record a change to a swimlane's ``limit_enforcement`` (#2584).

    ``setting`` names the lane by uid, which survives a rename.
    """
    if swimlane.limit_enforcement == old_value:
        return None
    return BoardSettingChange.objects.create(
        board_id=swimlane.board_id, actor=actor,
        setting=f"swimlane:{swimlane.uid}:limit_enforcement",
        old_value=_as_text(old_value), new_value=_as_text(swimlane.limit_enforcement),
    )
