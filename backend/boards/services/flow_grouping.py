"""Flow metrics split by swimlane, label, or one card custom field (#2265).

Grouping is additive: an endpoint builds its ungrouped payload exactly as it
does without ``group_by``, then one of the ``group_*`` functions here attaches
a top-level ``grouping`` envelope and per-sample group keys. Nothing already in
the payload is changed, so a client that ignores the new keys reads the same
numbers either way.

Every aggregate is the existing pure metric in ``flow_metrics`` re-run on a
sub-flow holding one group's cards. That keeps one definition per number (a
group's p85 is computed exactly like the board's, under the same ADR #1532
sample-size rule) and costs no queries: the only query here is the one that
reads each card's group keys.
"""

import dataclasses

from boards.models import Card, CustomFieldDefinition, CustomFieldValue
from boards.services import flow_metrics as fm

SWIMLANE = "swimlane"
LABEL = "label"
CUSTOM_FIELD = "custom_field"
GROUP_BY_CHOICES = (SWIMLANE, LABEL, CUSTOM_FIELD)
# Only types with a small closed set of values make a legible breakdown.
GROUPABLE_FIELD_TYPES = (CustomFieldDefinition.FieldType.DROPDOWN, CustomFieldDefinition.FieldType.CHECKBOX)
# The five categorical chart colors (spec "Chart colors"); the rest is "Other".
MAX_NAMED_GROUPS = 5
# How a checkbox value is stored. "true" sorts first on a tie.
_CHECKBOX_KEYS = ("true", "false")


@dataclasses.dataclass(frozen=True)
class Grouping:
    """Each card's group keys under one ``group_by``, read in one query."""

    by: str
    field_id: int | None
    # card id -> the card's keys (strings). Empty: the card has no group and is
    # counted in ``excluded``.
    keys_by_card: dict
    # key -> display name, or None (checkbox values have no name of their own).
    names: dict
    # key -> tie-break sort value when two groups have as many active cards.
    order: dict


def load_grouping(board, flow, by, definition=None):
    """Read the current group keys of every card the flow was loaded under.

    ADR #1532 "Filters": groups use each card's current swimlane, labels and
    field value, like the filters do. ``definition`` is the custom field the
    query serializer already validated against this board; it is not refetched.
    """
    cards = fm._base_cards(board, flow.swimlane_id, flow.label_id).values("id")
    keys_by_card = {}
    if by == SWIMLANE:
        lanes = list(board.swimlanes.values_list("id", "name", "position"))
        names = {str(pk): name for pk, name, _ in lanes}
        order = {str(pk): (position, pk) for pk, _, position in lanes}
        for card in flow.cards:
            key = str(card.swimlane_id)
            if key in names:
                keys_by_card[card.id] = (key,)
        return Grouping(by, None, keys_by_card, names, order)
    if by == LABEL:
        rows = Card.labels.through.objects.filter(card_id__in=cards, label__board=board).values_list(
            "card_id", "label_id", "label__name",
        )
        names, order, keys = {}, {}, {}
        for card_id, label_id, name in rows:
            key = str(label_id)
            names[key] = name
            order[key] = (name.casefold(), label_id)
            keys.setdefault(card_id, set()).add(key)
        for card_id, card_keys in keys.items():
            keys_by_card[card_id] = tuple(sorted(card_keys, key=order.__getitem__))
        return Grouping(by, None, keys_by_card, names, order)
    if definition.field_type == CustomFieldDefinition.FieldType.CHECKBOX:
        valid = list(_CHECKBOX_KEYS)
        names = {key: None for key in valid}
    else:
        valid = []
        for choice in definition.choices_json:
            if isinstance(choice, str) and choice not in valid:
                valid.append(choice)
        names = {key: key for key in valid}
    order = {key: index for index, key in enumerate(valid)}
    rows = CustomFieldValue.objects.filter(field_definition=definition, card_id__in=cards).values_list(
        "card_id", "value",
    )
    for card_id, value in rows:
        # A value that is not (or no longer) a choice has no group: excluded,
        # like a card with no value row at all.
        if value in order:
            keys_by_card[card_id] = (value,)
    return Grouping(by, definition.id, keys_by_card, names, order)


def _is_active(flow, flow_range, card):
    """The card can appear on at least one grouped endpoint for this range."""
    # Started and not yet done: a never-started backlog card is a sample on no
    # endpoint, so it must not rank its group.
    if card.is_in_progress(flow.done_uids):
        return True
    if card.completion_at is not None and (
        flow_range.contains(card.completion_at)
        # Throughput buckets whole UTC days, and on a rolling range the first
        # day starts at midnight, before ``start``: a completion there is a
        # throughput sample that ``contains`` would miss.
        or flow_range.first_day <= fm._utc_date(card.completion_at) <= flow_range.last_day
    ):
        return True
    return any(
        visit.end is not None and visit.key not in flow.done_uids and flow_range.contains(visit.end)
        for visit in card.visits
    )


@dataclasses.dataclass
class _Slot:
    key: str | None
    name: str | None
    member_keys: list
    cards: list = dataclasses.field(default_factory=list)

    def base(self):
        return {"key": self.key, "name": self.name, "member_keys": list(self.member_keys)}


class GroupedFlow:
    """The ranked groups, shared by all four endpoints so they agree on order and colors.

    Ranking reads the active cards (in progress: started and not done; first
    completion in the range or on one of its bucketed days; or a visit closed in
    the range), not any one endpoint's samples, so a group keeps its place, and its color, across the charts. A
    group may therefore be listed with size 0 on one endpoint.
    """

    def __init__(self, flow, flow_range, grouping):
        self.flow = flow
        self.grouping = grouping
        active = {}
        for card in flow.cards:
            if _is_active(flow, flow_range, card):
                for key in grouping.keys_by_card.get(card.id, ()):
                    active[key] = active.get(key, 0) + 1
        ranked = sorted(active, key=lambda key: (-active[key], grouping.order[key]))
        self.rank = {key: index for index, key in enumerate(ranked)}
        named = ranked if len(ranked) <= MAX_NAMED_GROUPS else ranked[:MAX_NAMED_GROUPS]
        self.slots = [_Slot(key, grouping.names[key], [key]) for key in named]
        if len(ranked) > len(named):
            self.slots.append(_Slot(None, None, ranked[len(named):]))
        slot_of_key = {key: index for index, slot in enumerate(self.slots) for key in slot.member_keys}
        self.excluded_cards = []
        self.slots_by_uid = {}
        self.keys_by_uid = {}
        for card in flow.cards:
            keys = [k for k in grouping.keys_by_card.get(card.id, ()) if k in slot_of_key]
            keys.sort(key=self.rank.__getitem__)
            # A card lands once in each slot: a card whose several labels all
            # collapse into "Other" counts once there.
            slots = sorted({slot_of_key[k] for k in keys})
            self.keys_by_uid[card.uid] = keys
            self.slots_by_uid[card.uid] = slots
            if not slots:
                self.excluded_cards.append(card)
            for index in slots:
                self.slots[index].cards.append(card)

    def sub_flow(self, cards):
        return dataclasses.replace(self.flow, cards=cards)

    def per_slot(self, metric):
        """``metric(sub_flow)`` for each slot, then for the cards with no group."""
        return [metric(self.sub_flow(slot.cards)) for slot in self.slots], metric(self.sub_flow(self.excluded_cards))

    def envelope(self, groups, excluded):
        return {"by": self.grouping.by, "field_id": self.grouping.field_id, "excluded": excluded, "groups": groups}


def group_cycle_time(payload, flow, flow_range, grouping):
    grouped = GroupedFlow(flow, flow_range, grouping)
    results, rest = grouped.per_slot(lambda sub: fm.cycle_time(sub, flow_range))
    for sample in payload["samples"]:
        sample["group_keys"] = list(grouped.keys_by_uid.get(sample["card_uid"], []))
    payload["grouping"] = grouped.envelope(
        [
            {**slot.base(), "sample_size": result["sample_size"], "percentiles": result["percentiles"]}
            for slot, result in zip(grouped.slots, results)
        ],
        rest["sample_size"],
    )
    return payload


def group_throughput(payload, flow, flow_range, grouping, period):
    grouped = GroupedFlow(flow, flow_range, grouping)
    results, rest = grouped.per_slot(lambda sub: fm.throughput(sub, flow_range, period))
    for index, sample in enumerate(payload["samples"]):
        sample["by_group"] = [
            {
                "key": slot.key,
                "count": result["samples"][index]["count"],
                "card_uids": result["samples"][index]["card_uids"],
            }
            for slot, result in zip(grouped.slots, results)
        ]
    payload["grouping"] = grouped.envelope(
        [
            {**slot.base(), "total": result["total"], "median": result["median"]}
            for slot, result in zip(grouped.slots, results)
        ],
        rest["total"],
    )
    return payload


def group_wip_age(payload, flow, flow_range, grouping):
    # age() is not re-run per group: it queries the blocked cards. The samples
    # are already the in-progress cards, so each group's size is a count.
    grouped = GroupedFlow(flow, flow_range, grouping)
    sizes = [0] * len(grouped.slots)
    excluded = 0
    for sample in payload["samples"]:
        uid = sample["card_uid"]
        sample["group_keys"] = list(grouped.keys_by_uid.get(uid, []))
        slots = grouped.slots_by_uid.get(uid, [])
        if not slots:
            excluded += 1
        for index in slots:
            sizes[index] += 1
    payload["grouping"] = grouped.envelope(
        [{**slot.base(), "sample_size": size} for slot, size in zip(grouped.slots, sizes)], excluded,
    )
    return payload


def group_dwell(payload, flow, flow_range, grouping):
    grouped = GroupedFlow(flow, flow_range, grouping)
    results, rest = grouped.per_slot(lambda sub: fm.column_dwell(sub, flow_range))
    payload["grouping"] = grouped.envelope(
        [
            {**slot.base(), "sample_size": result["sample_size"], "columns": result["columns"]}
            for slot, result in zip(grouped.slots, results)
        ],
        rest["sample_size"],
    )
    return payload
