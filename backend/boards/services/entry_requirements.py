"""Column entry requirements: the server evaluator (#1923).

A column's ``ColumnEntryRequirement`` rows are AND-ed conditions a card must
meet when it moves *forward* into the column, is created in it, or is
restored into it. This module is split in two on purpose:

* ``applies_in_lane`` and ``condition_met`` are pure functions over plain
  values. They are the whole rule, and the shared fixture table
  (``frontend/src/test/fixtures/entry-requirements-cases.json``, #2582) is
  asserted against them, so the client evaluator (MR C) can be held to the
  same cases.
* ``unmet_requirements`` loads what the pure functions need for one card in
  at most three queries, and is called by ``enforce_column_limits`` while the
  caller holds the card row lock, so a concurrent value clear (``update_card``
  locks the card before writing values) cannot race the move.

The unmet list names requirements, fields and sets, and carries the
requirement's own ``operand``; it never carries a card's field value.
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation

from django.db.models import Exists, OuterRef

from ..models import (
    ColumnEntryRequirement, CustomFieldDefinition, CustomFieldSet, CustomFieldValue,
    SwimlaneTrackException,
)

_Op = ColumnEntryRequirement.Operator
_FT = CustomFieldDefinition.FieldType

#: Field types whose values a set-complete requirement ignores. A checkbox has
#: no "unfilled" state the board shows (unset reads as unchecked), so it can
#: neither be required on its own nor hold a set back (owner, 2026-11-24).
SET_COMPLETE_IGNORED_TYPES = frozenset({_FT.CHECKBOX})

#: Operators each field type accepts. Checkbox accepts none in 1.3. A
#: dimension (a dropdown with ``is_dimension``) also accepts ``satisfied``.
OPERATORS_BY_TYPE = {
    _FT.TEXT: frozenset({_Op.FILLED}),
    _FT.URL: frozenset({_Op.FILLED}),
    _FT.DATE: frozenset({_Op.FILLED}),
    _FT.DROPDOWN: frozenset({_Op.FILLED}),
    _FT.NUMBER: frozenset({_Op.FILLED, _Op.GT, _Op.GTE}),
    _FT.MULTI_SELECT: frozenset({_Op.FILLED, _Op.MIN_COUNT}),
    _FT.CHECKBOX: frozenset(),
}


def operators_for(field_type, *, is_dimension=False):
    ops = set(OPERATORS_BY_TYPE.get(field_type, ()))
    if is_dimension:
        ops.add(_Op.SATISFIED)
    return ops


def applies_in_lane(*, set_scope, set_lane_ids, lane_id):
    """Whether a requirement applies to a card in ``lane_id``.

    Lane scope is derived, never stored: a requirement follows the field set
    it belongs to (its own set for set-complete, else its field's set). An
    ungrouped field (``set_scope`` None) and an ``all`` set apply everywhere;
    a ``swimlanes`` set applies only in its listed lanes. Deleting the set, or
    moving the field out of it, therefore widens the requirement to every
    lane (owner Q3); the confirm on those paths lists the affected rows.
    """
    if set_scope is None or set_scope == CustomFieldSet.Scope.ALL:
        return True
    return lane_id is not None and lane_id in set_lane_ids


def is_filled(field_type, value):
    """"Filled" has one meaning everywhere: a stored, non-blank value.

    A cleared field has no row (``CustomFieldValue`` docstring), so ``None``
    is the usual unset; a blank string or an empty multi-select array (only a
    raw write could store either) also reads as unset.
    """
    if value is None:
        return False
    text = str(value).strip()
    if not text:
        return False
    if field_type == _FT.MULTI_SELECT:
        return _choice_count(text) > 0
    return True


def _choice_count(value):
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return 0
    return len(parsed) if isinstance(parsed, list) else 0


def _number(value):
    if value is None:
        return None
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def condition_met(
    *, operator, operand=None, field_type=None, value=None, choice_resolutions=None,
    lane_not_applicable=False, set_values=(),
):
    """Whether one requirement is met, from plain values.

    ``set_values`` is ``[(field_type, value), ...]`` for the set's fields, used
    only by ``set_complete``. ``lane_not_applicable`` is true when the card's
    lane marks the dimension not applicable (``SwimlaneTrackException``), which
    counts as satisfied. A card's own choice that resolves to
    ``not_applicable`` counts as satisfied too: "not applicable" is never a
    reason to hold a card back. An unknown operator is never met (fail closed).
    """
    if operator == _Op.FILLED:
        return is_filled(field_type, value)
    if operator == _Op.MIN_COUNT:
        threshold = _number(operand)
        return value is not None and threshold is not None and _choice_count(value) >= threshold
    if operator in (_Op.GT, _Op.GTE):
        number, threshold = _number(value), _number(operand)
        if number is None or threshold is None:
            return False
        return number > threshold if operator == _Op.GT else number >= threshold
    if operator == _Op.SATISFIED:
        if lane_not_applicable:
            return True
        if value is None:
            return False
        resolution = (choice_resolutions or {}).get(value, "open")
        return resolution in ("satisfied", "not_applicable")
    if operator == _Op.SET_COMPLETE:
        return all(
            is_filled(ft, v) for ft, v in set_values if ft not in SET_COMPLETE_IGNORED_TYPES
        )
    return False


def format_operand(operand):
    """The operand as a plain decimal string ("50000", "2.5"), or None."""
    if operand is None:
        return None
    text = format(Decimal(operand).normalize(), "f")
    return text


def describe(requirement):
    """The public ``unmet`` item for one requirement: ids, operator, operand
    and names. Never a card's value."""
    field = requirement.field_definition
    field_set = requirement.field_set or (field.field_set if field is not None else None)
    return {
        "requirement_uid": requirement.uid,
        "operator": requirement.operator,
        "operand": format_operand(requirement.operand),
        "field_uid": field.uid if field is not None else None,
        "field_name": field.name if field is not None else None,
        "field_set_uid": field_set.uid if field_set is not None else None,
        "field_set_name": field_set.name if field_set is not None else None,
    }


def unmet_requirements(*, column, card, swimlane_id):
    """The requirements of ``column`` that ``card`` would not meet in lane
    ``swimlane_id``, as ``describe()`` items in requirement order.

    At most three queries: the requirements (with lane membership and lane
    N/A resolved by ``Exists`` annotations), the fields of any set-complete
    set, and the card's values for every field involved.
    """
    through = CustomFieldSet.swimlanes.through
    requirements = list(
        ColumnEntryRequirement.objects.filter(column_id=column.pk)
        .select_related("field_definition__field_set", "field_set")
        .annotate(
            _own_set_in_lane=Exists(through.objects.filter(
                customfieldset_id=OuterRef("field_set_id"), swimlane_id=swimlane_id,
            )),
            _field_set_in_lane=Exists(through.objects.filter(
                customfieldset_id=OuterRef("field_definition__field_set_id"), swimlane_id=swimlane_id,
            )),
            _lane_na=Exists(SwimlaneTrackException.objects.filter(
                field_definition_id=OuterRef("field_definition_id"), swimlane_id=swimlane_id,
            )),
        )
        .order_by("position", "id")
    )
    in_scope = []
    for req in requirements:
        field_set = req.field_set or (req.field_definition.field_set if req.field_definition else None)
        in_lane = req._own_set_in_lane if req.field_set_id else req._field_set_in_lane
        lane_ids = {swimlane_id} if in_lane else set()
        if applies_in_lane(
            set_scope=field_set.scope if field_set is not None else None,
            set_lane_ids=lane_ids, lane_id=swimlane_id,
        ):
            in_scope.append(req)
    if not in_scope:
        return []

    set_ids = {r.field_set_id for r in in_scope if r.operator == _Op.SET_COMPLETE}
    set_fields = {}
    def_ids = {r.field_definition_id for r in in_scope if r.field_definition_id}
    if set_ids:
        for pk, set_id, field_type in CustomFieldDefinition.objects.filter(
            field_set_id__in=set_ids,
        ).values_list("pk", "field_set_id", "field_type"):
            set_fields.setdefault(set_id, []).append((pk, field_type))
            def_ids.add(pk)
    values = dict(
        CustomFieldValue.objects.filter(card_id=card.pk, field_definition_id__in=def_ids)
        .values_list("field_definition_id", "value")
    ) if def_ids else {}

    unmet = []
    for req in in_scope:
        field = req.field_definition
        met = condition_met(
            operator=req.operator, operand=req.operand,
            field_type=field.field_type if field else None,
            value=values.get(req.field_definition_id),
            choice_resolutions=field.choice_resolutions if field else None,
            lane_not_applicable=bool(req._lane_na),
            set_values=[(ft, values.get(pk)) for pk, ft in set_fields.get(req.field_set_id, ())],
        )
        if not met:
            unmet.append(describe(req))
    return unmet


def snapshot(unmet):
    """The ``CardOverride.unmet`` form: ids and operators only."""
    return [
        {
            "kind": "entry_requirements", "requirement_uid": u["requirement_uid"],
            "operator": u["operator"], "field_uid": u["field_uid"],
            "field_set_uid": u["field_set_uid"],
        }
        for u in unmet
    ]


# ---------------------------------------------------------------------------
# Replace-all write (PUT .../columns/{id}/entry-requirements/)
# ---------------------------------------------------------------------------

class EntryRequirementsInvalid(Exception):
    """A 400 for the replace-all write; ``errors`` is the response body."""

    def __init__(self, errors):
        self.errors = errors
        super().__init__(errors)


def _clean_operand(operator, raw, index):
    if operator not in ColumnEntryRequirement.OPERAND_OPERATORS:
        if raw not in (None, ""):
            raise EntryRequirementsInvalid({"requirements": {index: "This operator takes no operand."}})
        return None
    number = _number(raw) if not isinstance(raw, bool) else None
    if number is None:
        raise EntryRequirementsInvalid({"requirements": {index: "Enter a number for this condition."}})
    if abs(number) >= Decimal("1e14"):
        raise EntryRequirementsInvalid({"requirements": {index: "That number is too large."}})
    if operator == _Op.MIN_COUNT and (number != number.to_integral_value() or number < 1):
        raise EntryRequirementsInvalid({"requirements": {index: "Enter a whole number of at least 1."}})
    return number.quantize(Decimal("0.000001"))


def clean_requirements(*, board, column, data):
    """Validate a replace-all body; return ``(mode, [unsaved rows])``.

    ``entry_enforcement`` is optional: when absent, a column that gains its
    first requirements starts in ``warn`` (the owner default) and one whose
    list is emptied goes back to NULL. An explicit ``null`` with rows keeps
    the rows and turns evaluation off (owner ruling). Every field and set is
    resolved by uid *on this board*, so a uid from another board is a 400,
    not a cross-board reference.
    """
    from ..models import Column

    if not isinstance(data, dict):
        raise EntryRequirementsInvalid({"detail": "Expected a JSON object."})
    items = data.get("requirements", [])
    if not isinstance(items, list):
        raise EntryRequirementsInvalid({"requirements": "Must be a list."})
    if len(items) > ColumnEntryRequirement.MAX_PER_COLUMN:
        raise EntryRequirementsInvalid({
            "requirements": (
                f"A column can have up to {ColumnEntryRequirement.MAX_PER_COLUMN} requirements."
            ),
        })
    modes = {c.value for c in Column.EntryEnforcement}
    if "entry_enforcement" in data:
        mode = data["entry_enforcement"]
        if mode is not None and not (isinstance(mode, str) and mode in modes):
            raise EntryRequirementsInvalid({"entry_enforcement": "Choose warn, block or hard, or null."})
    else:
        # Only the FIRST save starts in warn. A column that already has rows
        # keeps its mode, including null (switched off), so a PUT that omits
        # the key never switches evaluation back on.
        if column.entry_requirements.exists():
            mode = column.entry_enforcement
        else:
            mode = Column.EntryEnforcement.WARN.value if items else None
    if not items:
        mode = None

    # Only strings are valid uids; a list or dict from a malformed body must
    # fall through to the per-row 400, never an unhashable-type TypeError.
    field_uids = {
        i["field_uid"] for i in items
        if isinstance(i, dict) and isinstance(i.get("field_uid"), str) and i["field_uid"]
    }
    set_uids = {
        i["field_set_uid"] for i in items
        if isinstance(i, dict) and isinstance(i.get("field_set_uid"), str) and i["field_set_uid"]
    }
    # Locked so a concurrent delete either finishes first (the uid is then
    # unknown: a 400) or waits for this write, never an FK error at COMMIT.
    fields = {
        f.uid: f for f in CustomFieldDefinition.objects.select_for_update(no_key=True)
        .filter(board_id=board.pk, uid__in=list(field_uids))
    } if field_uids else {}
    sets = {
        s.uid: s for s in CustomFieldSet.objects.select_for_update(no_key=True)
        .filter(board_id=board.pk, uid__in=list(set_uids))
    } if set_uids else {}

    rows = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise EntryRequirementsInvalid({"requirements": {index: "Each requirement must be an object."}})
        operator = item.get("operator")
        field_uid, set_uid = item.get("field_uid"), item.get("field_set_uid")
        if not isinstance(operator, str):
            raise EntryRequirementsInvalid({"requirements": {index: "Choose an operator."}})
        if (field_uid is not None and not isinstance(field_uid, str)) or (
            set_uid is not None and not isinstance(set_uid, str)
        ):
            raise EntryRequirementsInvalid({"requirements": {index: "Field and set uids must be strings."}})
        if bool(field_uid) == bool(set_uid):
            raise EntryRequirementsInvalid({"requirements": {index: "Name exactly one field_uid or field_set_uid."}})
        if set_uid:
            field_set = sets.get(set_uid)
            if field_set is None:
                raise EntryRequirementsInvalid({"requirements": {index: "Unknown field set on this board."}})
            if operator != _Op.SET_COMPLETE:
                raise EntryRequirementsInvalid({"requirements": {index: "A field set takes set_complete."}})
            rows.append(ColumnEntryRequirement(
                column=column, field_set=field_set, operator=operator,
                operand=_clean_operand(operator, item.get("operand"), index), position=index,
            ))
            continue
        field = fields.get(field_uid)
        if field is None:
            raise EntryRequirementsInvalid({"requirements": {index: "Unknown field on this board."}})
        allowed = operators_for(field.field_type, is_dimension=field.is_dimension)
        if operator not in allowed:
            message = (
                "Checkbox fields can't be required yet." if not allowed
                else f"A {field.field_type} field takes: {', '.join(sorted(allowed))}."
            )
            raise EntryRequirementsInvalid({"requirements": {index: message}})
        rows.append(ColumnEntryRequirement(
            column=column, field_definition=field, operator=operator,
            operand=_clean_operand(operator, item.get("operand"), index), position=index,
        ))
    return mode, rows


def save_requirements(*, board, column, data):
    """Replace ``column``'s requirements and mode. The caller holds the board
    and column row locks (``lock_board_and_row_or_404``): the cap is a count
    over the column's rows, and a move evaluating them locks the column."""
    mode, rows = clean_requirements(board=board, column=column, data=data)
    ColumnEntryRequirement.objects.filter(column=column).delete()
    ColumnEntryRequirement.objects.bulk_create(rows)
    if column.entry_enforcement != mode:
        column.entry_enforcement = mode
        column.save(update_fields=["entry_enforcement"])
    return column


def affected_requirements_for_fields(fields):
    """``affected_requirements`` for several fields in one query (a membership
    dry run would otherwise run one query per field). Same item shape and
    ordering as the single-field form."""
    ids = [
        f.pk for f in fields
        if f.field_set is not None and f.field_set.scope == CustomFieldSet.Scope.SWIMLANES
    ]
    if not ids:
        return []
    qs = ColumnEntryRequirement.objects.select_related("column", "field_definition", "field_set").filter(
        field_definition_id__in=ids,
    )
    return _affected_items(qs)


def _affected_items(qs):
    return [
        {
            "requirement_uid": r.uid, "column_uid": r.column.uid, "column_name": r.column.name,
            "operator": r.operator,
            # A set_complete row has no field: field_uid/field_name are null
            # and field_set_name names the set (additive key, #1923).
            "field_uid": r.field_definition.uid if r.field_definition else None,
            "field_name": r.field_definition.name if r.field_definition else None,
            "field_set_name": r.field_set.name if r.field_set else None,
        }
        for r in qs.order_by("column__position", "position", "id")
    ]


def affected_requirements(*, field_set=None, field=None):
    """Requirements whose lane scope would widen to every lane if ``field_set``
    were deleted or ``field`` moved out of its set (owner Q3), as
    ``{requirement_uid, column_uid, column_name, operator, field_uid,
    field_name}`` items. Only a lane-scoped set narrows anything, so an
    ``all`` set returns nothing."""
    if field_set is None and field is not None:
        field_set = field.field_set
    if field_set is None or field_set.scope != CustomFieldSet.Scope.SWIMLANES:
        return []
    qs = ColumnEntryRequirement.objects.select_related("column", "field_definition", "field_set")
    if field is not None:
        qs = qs.filter(field_definition=field)
    else:
        # A set's own set-complete rows are deleted with it (CASCADE); only
        # its fields' conditions survive and widen.
        qs = qs.filter(field_definition__field_set=field_set)
    return _affected_items(qs)


def affected_set_complete_requirements(field_set):
    """The set's own ``set_complete`` rows. A scope change keeps the set, so
    these widen with it (``unmet_requirements`` reads the set's scope); a
    delete removes them, which is why ``affected_requirements`` omits them."""
    qs = ColumnEntryRequirement.objects.select_related("column", "field_definition", "field_set").filter(
        field_set=field_set,
    )
    return _affected_items(qs)
