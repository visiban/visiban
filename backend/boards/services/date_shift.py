"""Move a board export's dates by a whole number of days, either way (#1452, #1949).

The sample boards are generated around a fixed anchor date, so imported as-is
most of their cards are overdue. ``shift_board_dates`` runs on the parsed
export *before* validation, so every shifted value goes through the same
checks as an unshifted one, and a malformed date is left as it was for the
existing validators to report.

Shifted: card ``due_date``, ``archived_at``, ``created_at`` and
``blocked_at``; checklist item ``due_date`` (#445); comment, movement and activity timestamps; each block's
``blocked_at`` and ``unblocked_at`` (#1149); the ``from_value`` / ``to_value`` of
``due_date_change`` and ``checklist_item_due_changed`` activities (so history agrees with the shifted card); and
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
    if not isinstance(values, dict):
        return
    for name in date_names:
        if name in values:
            values[name] = _shift_date(values[name], delta)


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
        # Manual blocks (#1149): both ends move, so durations are unchanged
        # and the blocks stay aligned with their blocked/unblocked activities.
        blocks = card.get("blocks")
        for block in blocks if isinstance(blocks, list) else []:
            if isinstance(block, dict):
                for key in ("blocked_at", "unblocked_at"):
                    if block.get(key):
                        block[key] = _shift_datetime(block[key], delta)
        # Checklist item due dates (#445) are plain dates like the card's.
        checklist = card.get("checklist")
        for entry in checklist if isinstance(checklist, list) else []:
            if isinstance(entry, dict) and entry.get("due_date"):
                entry["due_date"] = _shift_date(entry["due_date"], delta)
        for child, key in (("comments", "created_at"), ("movements", "moved_at"), ("activities", "created_at")):
            items = card.get(child)
            for item in items if isinstance(items, list) else []:
                if isinstance(item, dict) and item.get(key):
                    item[key] = _shift_datetime(item[key], delta)
                if child == "activities" and isinstance(item, dict) and item.get("event_type") in (
                    "due_date_change", "checklist_item_due_changed",
                ):
                    # Only keys the file set: writing None for an absent one
                    # would turn an importable file into a 400 (#1507).
                    for value_key in ("from_value", "to_value"):
                        if value_key in item:
                            item[value_key] = _shift_date(item[value_key], delta)
    return data
