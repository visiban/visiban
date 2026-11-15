"""Auto health status for lanes and boards (#2245).

A board with ``health_auto_enabled`` gets a *computed* status per lane, from
the lane's own open cards, and a computed board status that is the worst of
its lanes' effective statuses (a lane's pin if set, else its computed value).
The values are stored, not live: the nightly ``compute_health_status``
command and the board admin's "Recompute now"
(``POST /api/boards/{id}/health-recompute/``) both call
:func:`compute_board_health`, the one code path, so the two can never
disagree. Reads (lists, ``/full/``) cost nothing extra.

Rules (owner decisions 2026-11-14 and 2026-11-15; frozen at 1.3 GA):

* A card is *flagged* when it is open (``card_signals.open_cards_q``) and
  overdue, stale (the board's ``staleness_threshold_days``, the
  ``_annotate_is_stale`` rule) or blocked. A card counts once however many
  signals it has.
* ``health_off_track_cards`` is an **absolute** count: a lane with at least
  that many flagged cards is off track, with at least one it is at risk,
  otherwise on track. A lane with no open cards computes no status (null).
* "Today" for overdue is ``timezone.localdate()``, UTC on a default install;
  a team far from UTC can see a card turn overdue a few hours early or late.

Concurrency: the counts are read before any lock (one grouped query). The
write is one transaction holding the board row ``FOR NO KEY UPDATE`` and
then the lane rows (board -> lanes, the order every lane write takes), and it
compares before it writes. Two overlapping runs therefore serialize, and the
second finds nothing changed: no second history row, no second broadcast.
``health_computed_at`` advances on every run (it is "last computed", not
"last changed"), and ``Board.updated_at`` never moves (it is the board
list's default sort; a nightly job must not reorder it).
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from groups.health import valid_health_status
from groups.health_history import record_computed_health_change
from groups.models import HealthStatus

from ..card_signals import blocked_q, open_cards_q, overdue_q

COUNT_KEYS = ("open", "overdue", "stale", "blocked", "flagged")
EMPTY_COUNTS = dict.fromkeys(COUNT_KEYS, 0)

#: Worst-of ordering for the roll-up.
SEVERITY = {HealthStatus.ON_TRACK: 0, HealthStatus.AT_RISK: 1, HealthStatus.OFF_TRACK: 2}

_LABEL = {
    HealthStatus.ON_TRACK: "on track",
    HealthStatus.AT_RISK: "at risk",
    HealthStatus.OFF_TRACK: "off track",
}


@dataclass
class ComputeResult:
    """What one :func:`compute_board_health` run wrote."""

    board_id: int
    board_status: str | None = None
    board_changed: bool = False
    changed_lane_ids: list = field(default_factory=list)


def lane_counts(board):
    """``lane_id -> {open, overdue, stale, blocked, flagged}`` for ``board``'s open cards, in one query.

    Lanes with no open card are absent (read them as :data:`EMPTY_COUNTS`).
    """
    from ..models import Card
    from ..serializers import _annotate_is_stale

    today = timezone.localdate()
    cutoff = timezone.now() - datetime.timedelta(days=board.staleness_threshold_days)
    overdue = overdue_q(today)
    blocked = blocked_q()
    stale = Q(_is_stale_annotated=True)
    qs = _annotate_is_stale(Card.objects.filter(board_id=board.pk).filter(open_cards_q()), cutoff)
    rows = qs.values("swimlane_id").annotate(
        open=Count("id"),
        overdue=Count("id", filter=overdue),
        stale=Count("id", filter=stale),
        blocked=Count("id", filter=blocked),
        flagged=Count("id", filter=overdue | stale | blocked),
    ).order_by()
    return {row.pop("swimlane_id"): {k: row[k] for k in COUNT_KEYS} for row in rows}


def status_for_counts(counts, off_track_cards):
    """The computed status for one lane's counts (absolute-count rule, see module doc)."""
    if not counts or not counts.get("open"):
        return None
    flagged = counts.get("flagged", 0)
    if flagged >= max(1, off_track_cards):
        return HealthStatus.OFF_TRACK.value
    if flagged >= 1:
        return HealthStatus.AT_RISK.value
    return HealthStatus.ON_TRACK.value


def lane_effective(lane):
    """A lane's effective status: its pin, else its computed value (lanes never inherit)."""
    return valid_health_status(lane.health_status) or valid_health_status(lane.computed_health_status)


def worst_of(lanes):
    """``(status, reason)``: the worst effective lane status, ignoring lanes with none."""
    by_status = {}
    for lane in lanes:
        eff = lane_effective(lane)
        if eff:
            by_status.setdefault(eff, []).append(lane.name)
    if not by_status:
        return None, "Auto: no lane has a status"
    worst = max(by_status, key=lambda s: SEVERITY[s])
    parts = []
    for status in (HealthStatus.OFF_TRACK, HealthStatus.AT_RISK):
        names = by_status.get(status.value)
        if names:
            noun = "lane" if len(names) == 1 else "lanes"
            parts.append(f"{len(names)} {noun} {_LABEL[status]} ({', '.join(names)})")
    if not parts:
        parts.append("every lane on track")
    return worst, "Auto: " + "; ".join(parts)


def _sum_counts(per_lane):
    total = dict(EMPTY_COUNTS)
    for counts in per_lane:
        for k in COUNT_KEYS:
            total[k] += counts.get(k, 0)
    return total


def _write_board_rollup(board, lanes, *, counts=None, now=None, user=None, broadcast_board=True):
    """Store the board's roll-up from ``lanes`` (locked, current); record and broadcast a change.

    Returns whether the board's computed status changed. The caller holds the
    board row lock. ``counts=None`` keeps the stored counts (a roll-up after a
    lane pin change reads no cards).
    """
    from ..models import Board, BoardHealthChange

    status, reason = worst_of(lanes)
    old = valid_health_status(board.computed_health_status)
    values = {}
    if now is not None:
        values["health_computed_at"] = now
    if counts is not None:
        values["health_computed_counts"] = counts
    changed = old != status
    if changed:
        values["computed_health_status"] = status
    if values:
        # A queryset update: no save() side effects, and no updated_at bump.
        Board.objects.filter(pk=board.pk).update(**values)
        for name, value in values.items():
            setattr(board, name, value)
    if changed:
        record_computed_health_change(
            board, change_model=BoardHealthChange, from_status=old, to_status=status,
            reason=reason, user=user,
        )
        if broadcast_board:
            from .board_events import record_board_updated, system_board_payload

            record_board_updated(
                board.pk, system_board_payload(board.pk),
                old_group_id=board.group_id, new_group_id=board.group_id, actor_id=None,
            )
    return changed


def _broadcast_lanes(board_id, lane_ids):
    """Queue one ``swimlane.updated`` (no actor) per lane in ``lane_ids``, sent after commit.

    Only the ids are collected under the row locks; the lanes are read and
    serialized in the ``on_commit`` callback, in one prefetched query, so the
    lock is never held while payloads are built (one query per lane before).
    A rolled-back run queues nothing, as ``record_board_event`` guarantees for
    the events themselves.
    """
    ids = list(lane_ids)
    transaction.on_commit(lambda: _send_lane_updates(board_id, ids))


def _send_lane_updates(board_id, lane_ids):
    from .. import broadcast as _broadcast
    from ..models import Swimlane
    from ..serializers import SwimlaneSerializer, _swimlane_custom_field_prefetch

    lanes = (
        Swimlane.objects.filter(board_id=board_id, pk__in=lane_ids)
        .prefetch_related(_swimlane_custom_field_prefetch())
        .order_by("position", "pk")
    )
    for lane in lanes:
        _broadcast.record_board_event(
            board_id, _broadcast.EVT_SWIMLANE_UPDATED, SwimlaneSerializer(lane).data, actor_id=None,
        )


def compute_board_health(board_id, *, broadcast_board=True):
    """Compute and store ``board_id``'s lane and board health; the one code path (see module doc).

    Returns a :class:`ComputeResult`, or ``None`` when the board is gone or
    auto health is off (re-read under the lock: a run racing "turn off" writes
    nothing). Broadcasts ``swimlane.updated`` for each lane whose computed
    status or counts changed and ``board.updated`` only when the board's
    computed status changed (``broadcast_board=False`` when the caller sends
    its own ``board.updated``, e.g. the PATCH that turned auto on), all with
    no actor and on commit. Opens its own atomic block, so a caller's
    transaction (the PATCH) nests it.
    """
    from ..models import Board, Swimlane

    board = Board.objects.filter(pk=board_id).only(
        "id", "health_auto_enabled", "staleness_threshold_days",
    ).first()
    if board is None or not board.health_auto_enabled:
        return None
    per_lane = lane_counts(board)  # outside the lock: the expensive read
    now = timezone.now()
    with transaction.atomic():
        board = Board.objects.select_for_update(no_key=True).filter(pk=board_id).first()
        if board is None or not board.health_auto_enabled:
            return None
        lanes = list(
            Swimlane.objects.select_for_update(no_key=True).filter(board_id=board_id).order_by("pk")
        )
        changed_lane_ids = []
        for lane in lanes:
            counts = per_lane.get(lane.pk, dict(EMPTY_COUNTS))
            status = status_for_counts(counts, board.health_off_track_cards)
            if (valid_health_status(lane.computed_health_status), lane.health_computed_counts) != (status, counts):
                changed_lane_ids.append(lane.pk)
            lane.computed_health_status = status
            lane.health_computed_counts = counts
            lane.health_computed_at = now
        if lanes:
            Swimlane.objects.bulk_update(
                lanes, ["computed_health_status", "health_computed_counts", "health_computed_at"],
            )
        board_changed = _write_board_rollup(
            board, lanes, counts=_sum_counts(per_lane.get(lane.pk, EMPTY_COUNTS) for lane in lanes),
            now=now, broadcast_board=broadcast_board,
        )
        if changed_lane_ids:
            _broadcast_lanes(board_id, changed_lane_ids)
    return ComputeResult(
        board_id=board_id, board_status=board.computed_health_status,
        board_changed=board_changed, changed_lane_ids=changed_lane_ids,
    )


def rollup_board_health(board, *, user=None):
    """Re-derive an auto board's computed status from its stored lane values (no card query).

    Called inside a lane pin write (``PATCH`` with ``health_status``) or a lane
    delete, after the write, by a caller that holds the board row lock. A
    no-op on a board with auto health off. The lanes' own computed values are
    left as the last run stored them.
    """
    from ..models import Board, Swimlane

    if not board.health_auto_enabled:
        return False
    board = Board.objects.get(pk=board.pk)
    if not board.health_auto_enabled:
        return False
    lanes = list(Swimlane.objects.filter(board_id=board.pk).only(
        "id", "name", "health_status", "computed_health_status",
    ))
    return _write_board_rollup(board, lanes, user=user)


def clear_computed_health(board, *, user=None):
    """Clear every computed column of ``board`` and its lanes (auto health turned off).

    Records a ``computed`` history row when the board had a computed status,
    so the history shows when the computed value stopped applying. The caller
    holds the board row lock and sends its own ``board.updated``; lanes whose
    computed value is cleared broadcast ``swimlane.updated``.
    """
    from ..models import Board, BoardHealthChange, Swimlane

    old = valid_health_status(board.computed_health_status)
    lane_ids = list(
        Swimlane.objects.filter(board_id=board.pk).filter(
            Q(computed_health_status__isnull=False) | Q(health_computed_at__isnull=False)
        ).values_list("pk", flat=True)
    )
    Swimlane.objects.filter(pk__in=lane_ids).update(
        computed_health_status=None, health_computed_at=None, health_computed_counts=None,
    )
    values = {"computed_health_status": None, "health_computed_at": None, "health_computed_counts": None}
    Board.objects.filter(pk=board.pk).update(**values)
    for name, value in values.items():
        setattr(board, name, value)
    if old is not None:
        record_computed_health_change(
            board, change_model=BoardHealthChange, from_status=old, to_status=None,
            reason="Auto health status turned off", user=user,
        )
    if lane_ids:
        _broadcast_lanes(board.pk, lane_ids)
