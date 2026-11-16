"""Stage settings: sub-columns, tracks and lane exceptions (#1102, #1921).

One writer, ``save_stage``, behind ``PUT /boards/{id}/columns/{id}/stage/``,
so a column PATCH keeps its 1.x shape and the three parts are saved together
or not at all.

Lock order is the ``move_card`` contract: **cards, then the column**. A move
locks its source and target cells' cards, then the column rows, and only then
reads the column's sub-columns (``services.cards``). Taking the column first
here would deadlock against a move that holds a card in it and waits for the
column. As in ``move_card`` (#1567), the card set is re-read once the column
row is held, since a move may have committed a card into the column while
this save waited; the attempt is retried when that happens.
"""

from django.db import transaction

from .. import broadcast as _broadcast
from ..models import (
    Card, CardGateTransition, Column, CustomFieldDefinition, StageTrack, SubColumn,
    Swimlane, SwimlaneTrackException,
)
from .cards import write_gate_transitions
from .errors import ColumnNotFound, VersionConflict

_ATTEMPTS = 3

SUB_COLUMN_NAME_MAX = 100


class StageValidationError(Exception):
    """A 400 for the stage action, keyed like a serializer error."""

    def __init__(self, errors):
        self.errors = errors
        super().__init__(errors)


class _CellGainedCard(Exception):
    pass


def _clean_sub_columns(column, raw, existing):
    """Validate the submitted sub-column list; return ``[(existing_or_None, name)]``."""
    if not isinstance(raw, list):
        raise StageValidationError({"sub_columns": "Must be a list."})
    if len(raw) == 1:
        raise StageValidationError({
            "sub_columns": "A stage has no sub-columns or at least two.",
        })
    if len(raw) > SubColumn.MAX_PER_COLUMN:
        raise StageValidationError({
            "sub_columns": f"A stage can have at most {SubColumn.MAX_PER_COLUMN} sub-columns.",
        })
    by_id = {s.pk: s for s in existing}
    out, names, kept_positions = [], set(), []
    for entry in raw:
        if not isinstance(entry, dict):
            raise StageValidationError({"sub_columns": "Each sub-column must be an object."})
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise StageValidationError({"sub_columns": "Each sub-column needs a name."})
        name = name.strip()
        if "\x00" in name or len(name) > SUB_COLUMN_NAME_MAX:
            raise StageValidationError({
                "sub_columns": (
                    f"Sub-column names are at most {SUB_COLUMN_NAME_MAX} characters "
                    "without NUL (0x00) characters."
                ),
            })
        if name.casefold() in names:
            raise StageValidationError({"sub_columns": "Sub-column names must be unique."})
        names.add(name.casefold())
        sid = entry.get("id")
        if sid is None:
            out.append((None, name))
            continue
        if isinstance(sid, bool) or not isinstance(sid, int) or sid not in by_id:
            raise StageValidationError({
                "sub_columns": "A sub-column id does not belong to this column.",
            })
        kept_positions.append(by_id[sid].position)
        out.append((by_id.pop(sid), name))
    # No reorder in phase 1: kept sub-columns stay in their order.
    if kept_positions != sorted(kept_positions):
        raise StageValidationError({"sub_columns": "Sub-columns cannot be reordered."})
    return out


def _clean_tracks(board, raw):
    if not isinstance(raw, list) or any(
        isinstance(x, bool) or not isinstance(x, int) for x in raw
    ):
        raise StageValidationError({"tracks": "Must be a list of field ids."})
    if len(set(raw)) != len(raw):
        raise StageValidationError({"tracks": "A track can appear once."})
    fields = {
        f.pk: f for f in CustomFieldDefinition.objects.filter(
            board=board, pk__in=raw, is_dimension=True,
        )
    }
    if len(fields) != len(raw):
        raise StageValidationError({
            "tracks": "Each track must be a dimension field on this board.",
        })
    return [fields[x] for x in raw]


def _clean_exceptions(board, raw, track_field_ids):
    if not isinstance(raw, list):
        raise StageValidationError({"not_applicable": "Must be a list."})
    pairs = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise StageValidationError({"not_applicable": "Each entry must be an object."})
        lane, field = entry.get("swimlane_id"), entry.get("field_id")
        if any(isinstance(v, bool) or not isinstance(v, int) for v in (lane, field)):
            raise StageValidationError({
                "not_applicable": "Each entry needs integer swimlane_id and field_id.",
            })
        if field not in track_field_ids:
            raise StageValidationError({
                "not_applicable": "A not-applicable entry must name one of this stage's tracks.",
            })
        pairs.add((lane, field))
    lane_ids = {lane for lane, _ in pairs}
    if Swimlane.objects.filter(board=board, pk__in=lane_ids).count() != len(lane_ids):
        raise StageValidationError({
            "not_applicable": "A swimlane does not belong to this board.",
        })
    return pairs


def _remap(cards, old_subs, plan):
    """Return ``{card_pk: new_index}`` for every card whose index changes.

    A card keeps its sub-column when that sub-column is kept, at its new
    index. A card in a removed sub-column falls back to the nearest kept
    sub-column before it, or 0, so removing sub-column i moves each card at
    p >= i (p > 0) to p - 1, as #1102 specifies. A column that stops being a
    stage puts every card at 0.
    """
    new_index_of = {}
    for idx, (existing, _name) in enumerate(plan):
        if existing is not None:
            new_index_of[existing.pk] = idx
    old_pk_at = [s.pk for s in old_subs]
    out = {}
    for card in cards:
        p = card.gates_passed
        new = 0
        if plan:
            for q in range(min(p, len(old_pk_at) - 1), -1, -1):
                if old_pk_at[q] in new_index_of:
                    new = new_index_of[old_pk_at[q]]
                    break
        if new != p:
            out[card.pk] = new
    return out


def save_stage(*, actor, board, column_id, data):
    """Save a column's stage settings atomically; return ``(column, remapped, lanes)``.

    ``data`` keys, each optional (omitted = unchanged):

    * ``sub_columns``: ``[{"id"?: int, "name": str}]`` in order. An entry with
      an ``id`` keeps (and may rename) that sub-column; one without is new.
      ``[]`` turns the stage back into a plain column.
    * ``tracks``: ordered dimension field ids. Removing a track unbinds it only.
    * ``not_applicable``: ``[{"swimlane_id", "field_id"}]``, replacing the
      exceptions for this stage's tracks (other dimensions are untouched).

    Authorization is the caller's (board admin only).
    """
    for _attempt in range(_ATTEMPTS):
        try:
            return _save_stage_attempt(actor=actor, board=board, column_id=column_id, data=data)
        except _CellGainedCard:
            continue
    raise VersionConflict(None, detail=(
        "Cards kept moving into this column while its stage was being saved. "
        "Nothing was changed. Please try again."
    ))


def _save_stage_attempt(*, actor, board, column_id, data):
    with transaction.atomic():
        # Cards first (pk order, archived included: they carry gates_passed too).
        locked_ids = list(
            Card.objects.filter(board=board, column_id=column_id)
            .select_for_update(of=("self",)).order_by("pk").values_list("pk", flat=True)
        )
        column = (
            Column.objects.select_for_update(no_key=True)
            .filter(board=board, pk=column_id).first()
        )
        if column is None:
            raise ColumnNotFound()
        cards = list(Card.objects.filter(board=board, column=column).order_by("pk"))
        if {c.pk for c in cards} - set(locked_ids):
            raise _CellGainedCard()

        old_subs = list(SubColumn.objects.filter(column=column).order_by("position", "id"))
        remapped = []
        if "sub_columns" in data:
            plan = _clean_sub_columns(column, data["sub_columns"], old_subs)
            changes = _remap(cards, old_subs, plan)
            kept = {e.pk for e, _ in plan if e is not None}
            SubColumn.objects.filter(column=column).exclude(pk__in=kept).delete()
            # Two passes, like CustomFieldDefinition reorders: move kept rows
            # off every final (position, name) first, then write the finals.
            for existing, _name in plan:
                if existing is not None:
                    SubColumn.objects.filter(pk=existing.pk).update(
                        position=existing.position + 100, name=f"~{existing.uid}",
                    )
            new_subs = []
            for idx, (existing, name) in enumerate(plan):
                if existing is None:
                    new_subs.append(SubColumn.objects.create(column=column, position=idx, name=name))
                else:
                    SubColumn.objects.filter(pk=existing.pk).update(position=idx, name=name)
                    existing.position, existing.name = idx, name
                    new_subs.append(existing)
            for card in cards:
                if card.pk not in changes:
                    continue
                new = changes[card.pk]
                write_gate_transitions(
                    card=card, column=column, sub_columns=new_subs,
                    from_index=card.gates_passed, to_index=new, actor=actor,
                    cause=CardGateTransition.Cause.STAGE_EDITED,
                )
                card.gates_passed = new
                card.version += 1
                Card.objects.filter(pk=card.pk).update(gates_passed=new, version=card.version)
                remapped.append({"id": card.pk, "gates_passed": new, "version": card.version})

        if "tracks" in data:
            fields = _clean_tracks(board, data["tracks"])
            StageTrack.objects.filter(column=column).exclude(
                field_definition__in=fields,
            ).delete()
            existing = {t.field_definition_id: t for t in StageTrack.objects.filter(column=column)}
            for idx, field in enumerate(fields):
                if field.pk in existing:
                    StageTrack.objects.filter(pk=existing[field.pk].pk).update(position=idx)
                else:
                    StageTrack.objects.create(column=column, field_definition=field, position=idx)

        changed_lanes = set()
        if "not_applicable" in data:
            track_ids = set(
                StageTrack.objects.filter(column=column).values_list("field_definition_id", flat=True)
            )
            pairs = _clean_exceptions(board, data["not_applicable"], track_ids)
            current = set(
                SwimlaneTrackException.objects.filter(
                    swimlane__board=board, field_definition_id__in=track_ids,
                ).values_list("swimlane_id", "field_definition_id")
            )
            for lane, field in current - pairs:
                SwimlaneTrackException.objects.filter(
                    swimlane_id=lane, field_definition_id=field,
                ).delete()
                changed_lanes.add(lane)
            for lane, field in pairs - current:
                SwimlaneTrackException.objects.create(
                    swimlane_id=lane, field_definition_id=field, created_by=actor,
                )
                changed_lanes.add(lane)

        _broadcast_stage(board, column, remapped, changed_lanes, actor)
    return column, remapped, changed_lanes


def _broadcast_stage(board, column, remapped, changed_lanes, actor):
    """Existing ``column_updated`` / ``swimlane_updated`` events, additive keys.

    ``record_board_event`` defers the WebSocket send to ``on_commit``.
    """
    from ..serializers import ColumnSerializer, SwimlaneSerializer, _swimlane_custom_field_prefetch

    fresh = Column.objects.prefetch_related(
        "sub_columns", "stage_tracks__field_definition",
    ).get(pk=column.pk)
    payload = {**ColumnSerializer(fresh).data, "remapped": remapped}
    _broadcast.record_board_event(
        board.id, _broadcast.EVT_COLUMN_UPDATED, payload, actor_id=actor.id,
    )
    if changed_lanes:
        lanes = Swimlane.objects.filter(pk__in=changed_lanes).prefetch_related(
            _swimlane_custom_field_prefetch(), "track_exceptions",
        ).order_by("position", "pk")
        for lane in lanes:
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_SWIMLANE_UPDATED, SwimlaneSerializer(lane).data,
                actor_id=actor.id,
            )
