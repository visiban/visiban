"""Move a board export's dates by a whole number of days, either way (#1452, #1949).

The sample boards are generated around a fixed anchor date, so imported as-is
most of their cards are overdue. ``shift_board_dates`` runs on the parsed
export *before* validation, so every shifted value goes through the same
checks as an unshifted one, and a malformed date is left as it was for the
existing validators to report.

The retained history of deleted cards (``deleted_card_history``, #1796/#2413)
moves with the rest (#2580), so Board History shows one timeline.

Shifted: card ``due_date``, ``archived_at``, ``created_at`` and
``blocked_at``; checklist item ``due_date`` (#445); comment, movement, activity and gate transition timestamps (#1102); each block's
``blocked_at`` and ``unblocked_at`` (#1149); the ``from_value`` / ``to_value`` of
``due_date_change`` and ``checklist_item_due_changed`` activities (so history agrees with the shifted card), the ``to_value`` of ``planned_released`` activities (the child's due date, #2371), and of ``custom_field_changed`` activities on ``date`` fields (#1921); and
values of ``date`` custom fields on cards and swimlanes. Relative spacing between all of them is preserved.
"""

import datetime

from django.utils.dateparse import parse_date, parse_datetime


# Django's parsers raise ValueError for well-formed but impossible values
# ("2024-02-30") and adding the delta raises OverflowError near date.max. Either
# way the value is left exactly as it was so the existing validators report it as
# a 400, rather than the shift turning a bad upload into a 500.
def _shift_date(value, delta):
    if not isinstance(value, str):
        return value
    try:
        parsed = parse_date(value)
        return value if parsed is None else (parsed + delta).isoformat()
    except (ValueError, OverflowError):
        return value


def _shift_datetime(value, delta):
    if not isinstance(value, str):
        return value
    try:
        parsed = parse_datetime(value)
        return value if parsed is None else (parsed + delta).isoformat()
    except (ValueError, OverflowError):
        return value


def _date_field_names(definitions):
    if not isinstance(definitions, list):
        return set()
    # Only string names: an unhashable one (a list or object) would raise
    # TypeError building the set, a 500 before validation could report it
    # (#1507). The definitions validator rejects such a name afterwards.
    return {
        d["name"] for d in definitions
        if isinstance(d, dict) and d.get("field_type") == "date" and isinstance(d.get("name"), str)
    }


def _shift_custom_values(values, date_names, delta):
    if not isinstance(values, dict) or not date_names:
        return
    # Walk the row's own keys against the prebuilt set (#2629). ``list``
    # because the loop reassigns values in place.
    for name in list(values):
        if name in date_names:
            values[name] = _shift_date(values[name], delta)


def _shift_history(owner, card_date_fields, delta):
    """Shift every dated history row of one card, live or deleted (#2580).

    ``owner`` is a card or a ``deleted_card_history`` entry. The two carry the
    same child lists (a deleted entry has no ``comments``), so one walk keeps a
    new dated key from being shifted for one and forgotten for the other.
    """
    # Manual blocks (#1149): both ends move, so durations are unchanged and the
    # blocks stay aligned with their blocked/unblocked activities.
    blocks = owner.get("blocks")
    for block in blocks if isinstance(blocks, list) else []:
        if isinstance(block, dict):
            for key in ("blocked_at", "unblocked_at"):
                if block.get(key):
                    block[key] = _shift_datetime(block[key], delta)
    for child, key in (
        ("comments", "created_at"), ("movements", "moved_at"), ("activities", "created_at"),
        ("gate_transitions", "created_at"),  # #1102
    ):
        items = owner.get(child)
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if item.get(key):
                item[key] = _shift_datetime(item[key], delta)
            if child == "activities":
                _shift_activity_values(item, card_date_fields, delta)


def _shift_activity_values(item, card_date_fields, delta):
    """Shift the dates an activity stores as values, so history agrees with the card."""
    event_type = item.get("event_type")
    if event_type in ("due_date_change", "checklist_item_due_changed"):
        value_keys = ("from_value", "to_value")
    elif event_type == "planned_released":
        # from_value is the cause; to_value the child's own due date (#2371).
        value_keys = ("to_value",)
    elif (
        # #1921: the row's item_text is the field name; on a date field its
        # values are dates the shift already moved on the card.
        event_type == "custom_field_changed"
        and isinstance(item.get("item_text"), str)
        and item["item_text"] in card_date_fields
    ):
        value_keys = ("from_value", "to_value")
    else:
        return
    # Only keys the file set: writing None for an absent one would turn an
    # importable file into a 400 (#1507).
    for value_key in value_keys:
        if value_key in item:
            item[value_key] = _shift_date(item[value_key], delta)


def shift_board_dates(data, days):
    """Shift ``data`` (a parsed Visiban JSON export) by ``days``, in place.

    ``days`` may be negative: a ``shift_dates_to`` earlier than the source day
    moves every date backward (#1949).
    """
    if not days:
        return data
    delta = datetime.timedelta(days=days)
    card_date_fields = _date_field_names(data.get("custom_fields"))
    swimlane_date_fields = _date_field_names(data.get("swimlane_custom_fields"))

    swimlanes = data.get("swimlanes")
    for swimlane in swimlanes if isinstance(swimlanes, list) else []:
        if isinstance(swimlane, dict):
            _shift_custom_values(swimlane.get("custom_field_values"), swimlane_date_fields, delta)

    cards = data.get("cards")
    for card in cards if isinstance(cards, list) else []:
        if not isinstance(card, dict):
            continue
        if card.get("due_date"):
            card["due_date"] = _shift_date(card["due_date"], delta)
        for key in ("archived_at", "created_at", "blocked_at"):
            if card.get(key):
                card[key] = _shift_datetime(card[key], delta)
        _shift_custom_values(card.get("custom_field_values"), card_date_fields, delta)
        # Checklist item due dates (#445) are plain dates like the card's.
        checklist = card.get("checklist")
        for entry in checklist if isinstance(checklist, list) else []:
            if isinstance(entry, dict) and entry.get("due_date"):
                entry["due_date"] = _shift_date(entry["due_date"], delta)
        _shift_history(card, card_date_fields, delta)

    # Deleted cards' retained history (#2580): same row shapes as a live card's
    # blocks, movements, activities and gate transitions, with no card around them.
    deleted = data.get("deleted_card_history")
    for entry in deleted if isinstance(deleted, list) else []:
        if isinstance(entry, dict):
            _shift_history(entry, card_date_fields, delta)
    return data
