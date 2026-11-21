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
from django.db.models import Count, F, Q

from visiban.request_shape import id_in_db_range

from .. import broadcast as _broadcast
from ..models import (
    Card, CardGateTransition, Column, CustomFieldDefinition, StageTrack, SubColumn,
    Swimlane, SwimlaneTrackException,
)
from .cards import build_gate_transitions
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
    out, names = [], set()
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
        out.append((by_id.pop(sid), name))
    # Kept sub-columns may be reordered (#2368). A card follows its own
    # sub-column to the new index (``_remap``), so a reorder is a re-index,
    # not a pass: no gate is crossed and no history is written.
    #
    # A reorder plus a removal in one save is refused: a card in the removed
    # sub-column falls back to the nearest kept one before it in the OLD
    # order, but that sub-column's NEW index can be at or after the card's,
    # so the "back" move would be recorded as a forward pass (or a fall-back
    # that leaves the index unchanged would write no row at all).
    kept_new_order = [e.pk for e, _ in out if e is not None]
    kept_old_order = [s.pk for s in existing if s.pk in set(kept_new_order)]
    if by_id and kept_new_order != kept_old_order:
        raise StageValidationError({
            "sub_columns": "Reorder and remove sub-columns in separate saves",
        })
    return out


def _clean_tracks(board, raw):
    if not isinstance(raw, list) or any(
        isinstance(x, bool) or not isinstance(x, int) for x in raw
    ):
        raise StageValidationError({"tracks": "Must be a list of field ids."})
    if len(set(raw)) != len(raw):
        raise StageValidationError({"tracks": "A track can appear once."})
    if not all(id_in_db_range(x) for x in raw):
        # Same 400 as an unknown id; an out-of-range int would overflow the
        # integer parameter in the query below (a 500).
        raise StageValidationError({
            "tracks": "Each track must be a dimension field on this board.",
        })
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
    if not all(id_in_db_range(i) for i in lane_ids):
        raise StageValidationError({
            "not_applicable": "A swimlane does not belong to this board.",
        })
    if Swimlane.objects.filter(board=board, pk__in=lane_ids).count() != len(lane_ids):
        raise StageValidationError({
            "not_applicable": "A swimlane does not belong to this board.",
        })
    return pairs


def _remap(cards, old_subs, plan):
    """Return ``{card_pk: (new_index, fell_back)}`` for every card whose index changes.

    ``fell_back`` is True only when the card's own sub-column was removed;
    a pure re-index (a sub-column inserted or removed ahead of a kept one)
    passes no gate and writes no history (#2360).

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
        own_removed = bool(old_pk_at) and old_pk_at[min(p, len(old_pk_at) - 1)] not in new_index_of
        if plan:
            for q in range(min(p, len(old_pk_at) - 1), -1, -1):
                if old_pk_at[q] in new_index_of:
                    new = new_index_of[old_pk_at[q]]
                    break
        if new != p:
            out[card.pk] = (new, own_removed)
    return out


def stage_card_counts(*, board, column_id):
    """Cards in each sub-column of a stage, archived ones counted apart (#2368).

    The Stage settings panel warns "N cards will move" before a save. The
    client only holds active cards, but ``_remap`` moves archived cards too
    (they carry ``gates_passed`` and come back where they were), so the panel
    reads the server's counts. A card's sub-column is
    ``min(gates_passed, last)``, the clamp ``_remap`` uses. One aggregate
    query; a plain column returns ``[]``.

    Authorization is the caller's (board admin only, like the save).
    """
    # The URL only says \d+; an id past the column type's range would overflow
    # the query parameter (a 500), so it is the same 404 as an unknown id.
    if not id_in_db_range(int(column_id)):
        raise ColumnNotFound()
    column = Column.objects.filter(board=board, pk=column_id).first()
    if column is None:
        raise ColumnNotFound()
    subs = list(SubColumn.objects.filter(column=column).order_by("position", "id"))
    if not subs:
        return []
    out = [{"id": s.pk, "cards": 0, "archived_cards": 0} for s in subs]
    rows = (
        Card.objects.filter(board=board, column=column)
        .values("gates_passed")
        .annotate(
            active=Count("pk", filter=Q(archived_at__isnull=True)),
            archived=Count("pk", filter=Q(archived_at__isnull=False)),
        )
        .order_by()
    )
    for row in rows:
        entry = out[min(max(row["gates_passed"], 0), len(subs) - 1)]
        entry["cards"] += row["active"]
        entry["archived_cards"] += row["archived"]
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
            # Bulk writes (#2362): one INSERT for every transition and one
            # UPDATE per target sub-column for the remapped cards, so the column lock is held for a
            # constant number of queries however many cards the stage holds.
            # The cards were locked first above, so lock order is unchanged.
            transitions, updated = [], []
            for card in cards:
                if card.pk not in changes:
                    continue
                new, fell_back = changes[card.pk]
                # A re-index passes no gate, so it writes no row (flow
                # metrics would count a phantom pass); only a card whose own
                # sub-column was removed falls back and is recorded.
                if fell_back:
                    transitions.extend(build_gate_transitions(
                        card=card, column=column, sub_columns=new_subs,
                        from_index=card.gates_passed, to_index=new, actor=actor,
                        cause=CardGateTransition.Cause.STAGE_EDITED,
                    ))
                # The card rows are locked, so the version read above is
                # current and +1 is the value the UPDATE writes.
                card.gates_passed = new
                card.version += 1
                updated.append(card)
                remapped.append({"id": card.pk, "gates_passed": new, "version": card.version})
            if transitions:
                CardGateTransition.objects.bulk_create(transitions)
            # One conditional UPDATE per target index rather than bulk_update's
            # CASE chain (a statement that grows with the card count, and that
            # SQLite splits at its parameter limit). Every remapped card's
            # version goes up by one, so only gates_passed differs, and a stage
            # has at most four sub-columns: at most four UPDATEs.
            by_target = {}
            for card in updated:
                by_target.setdefault(card.gates_passed, []).append(card.pk)
            for new, pks in sorted(by_target.items()):
                Card.objects.filter(pk__in=pks).update(gates_passed=new, version=F("version") + 1)

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
            _swimlane_custom_field_prefetch(), "track_exceptions", "team_members",
        ).order_by("position", "pk")
        for lane in lanes:
            _broadcast.record_board_event(
                board.id, _broadcast.EVT_SWIMLANE_UPDATED, SwimlaneSerializer(lane).data,
                actor_id=actor.id,
            )
