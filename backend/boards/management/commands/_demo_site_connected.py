"""Connected boards, the flagship sales overlay and the full activity vocabulary (#2598, #2599, #2607).

Used only by ``seed_demo_data --demo-site``, after every board in
``_demo_site_data.BOARDS`` exists. Three things happen, in this order:

1. **The overlay board is built out** (#2599). It is imported from the shipped
   ``sales_overlay`` sample, which the in-app gallery also serves, so the sample
   file itself stays as it is. The seeder adds on top: about 55 more deals
   (the largest showcase board), a dwell hot spot in Commercial, stages with
   sub-columns, tracks, field sets, WIP and weight limits and a health status.
2. **Boards are connected** (#2598): the overlay board gets Customer
   Implementation below it, and Platform Program gets Software Team below it.
   Links are written directly (the seed is not a request), with the same rows
   the link service writes: a ``CardParentLink`` and one ``parent_linked`` /
   ``child_linked`` activity per end. Children mode reads real work.
3. **The activity vocabulary is completed** (#2607): every
   ``CardActivity.EventType`` appears at least once in the seeded corpus; the
   test derives the list from the model's choices.

Entry requirements (#1923, MR B) are not seeded: ``CardOverride.Kind`` reserves
the kind but no column field or enforcement exists on main, so there is
nothing to seed. Everything here is deterministic (no ``random``; the only
clock read caps event times just before now), so the hourly reset reproduces it.
"""

import datetime

from django.utils import timezone

from boards.models import (
    Board,
    Card,
    CardActivity,
    CardBlock,
    CardChecklist,
    CardOverride,
    CardParentLink,
    CustomFieldDefinition,
    CustomFieldValue,
)

from ._demo_site_data import (
    IMPLEMENTATION_BOARD_NAME,
    PROGRAM_BOARD_NAME,
    SIMPLE_BOARD_NAME,
    days_from_today,
)
from ._seed_history import history_window, write_activity_trail

OVERLAY = "Sales Territory (Overlay)"
SOFTWARE = "Software Team"

# --- The overlay board (#2599) ----------------------------------------------

#: How many generated deals land in each column of the overlay board. Validate
#: and Commercial end over their limits (8 and 3, from the sample); the other
#: limits below sit above their counts.
OVERLAY_COLUMN_COUNTS = {
    "Identify": 6, "Discover": 8, "Qualify": 8, "Shape": 7,
    "Validate": 3, "Commercial": 3, "Commit": 5, "Won": 15,
}

#: Days since each generated deal's last move, per column, cycled. Commercial
#: is the hot spot: its deals have waited two to three weeks, where every other
#: open column reads under a fortnight. 3 and 7 are avoided for the same reason
#: as in _demo_site_data (they straddle a staleness boundary at any hour).
_OVERLAY_AGES = {
    "Identify": (1, 2, 4, 0, 5, 1), "Discover": (2, 5, 1, 6, 4, 0, 2, 1),
    "Qualify": (1, 4, 6, 2, 5, 0, 2, 1), "Shape": (2, 5, 1, 4, 0, 6, 2),
    "Validate": (5, 6, 4), "Commercial": (15, 19, 24), "Commit": (1, 4, 2, 5, 0),
}
_OVERLAY_DUES = {
    "Identify": (None, 30, None, 21, 45, None), "Discover": (None, 18, 40, None, 25, None, 33, None),
    "Qualify": (14, None, 28, None, 9, 21, None, 35), "Shape": (12, None, -3, 20, None, 6, 15),
    "Validate": (-4, 5, -9), "Commercial": (-6, 2, -12), "Commit": (4, 9, 1, 12, 6),
}
_SUBJECTS = (
    "Platform expansion", "Security add-on", "Analytics rollout", "Integration project", "Data platform pilot",
    "Observability rollout", "AI services pilot", "Support renewal", "Training program", "Reporting add-on",
    "Workflow automation", "Compliance package",
)
#: Deal sizes in dollars; the card weight is the size bucket (see _weight_for).
_DEAL_VALUES = (62000, 95000, 140000, 185000, 240000, 310000, 420000, 515000, 690000, 880000, 1100000, 75000)
_PROBABILITY = {
    "Identify": 10, "Discover": 20, "Qualify": 30, "Shape": 45, "Validate": 60, "Commercial": 75, "Commit": 90, "Won": 100,
}
_FORECAST = {
    "Identify": "Pipeline", "Discover": "Pipeline", "Qualify": "Pipeline", "Shape": "Best case",
    "Validate": "Best case", "Commercial": "Commit", "Commit": "Commit", "Won": "Closed won",
}
_CHAMPIONS = ("VP Operations", "Director of Data", "Head of Security", "Chief Information Officer", "Platform Lead")
_NEXT_STEPS = (
    "Schedule the technical deep dive", "Send the revised proposal", "Confirm the pilot success criteria",
    "Get legal review of the redlines", "Book the executive sponsor call", "Share the reference architecture",
)
_SERVICES = ("Sam Ortega", "Priya Nair", "Alex Rivera", "Jamie Chen")
_COMPETITORS = ("Incumbent", "Hyperscaler native", "Regional reseller", "Build in-house", "None identified")
_PRODUCTS = ("Data Platform", "Security", "AI Services", "Observability", "Integration")
_PRIORITIES = ("medium", "low", "high", "medium", "urgent", "low", "medium")
_ASSIGNEES = ("maya", "jordan", "admin", None, "jordan", "maya", None, "admin")
_LABELS = ("New Workload", "Expansion", "Cross-Sell", "Strategic Initiative", "Renewal", "Competitive Displacement")

_RESOLUTIONS = {
    "Security review": {"Not required": "not_applicable", "In progress": "open", "Complete": "satisfied"},
    "Legal review": {"Not needed": "not_applicable", "Redlines out": "open", "Signed off": "satisfied"},
}

OVERLAY_STRUCTURE = {
    "wip": {"Discover": (12, None), "Qualify": (14, None), "Shape": (14, None)},
    # Per-lane limits on a few account lanes; Harborview Bank and Copperline
    # Telecom each hold more deals than their limit, Granite Peak Energy does not.
    "lane_wip": {"Harborview Bank": 4, "Copperline Telecom": 5, "Granite Peak Energy": 12},
    "sub_columns": {
        "Validate": ["Technical validation", "Pilot", "Customer sign-off"],
        "Commercial": ["Pricing", "Legal review", "Approval"],
    },
    "tracks": {"Validate": ["Security review"], "Commercial": ["Legal review"]},
    "dimension_choices": {name: list(choices) for name, choices in _RESOLUTIONS.items()},
    "field_sets": [
        ("Deal", "What it is worth and where it stands",
         ["Deal value", "Forecast", "Win probability", "Expected close", "Primary competitor"]),
        ("Coverage", "Who is working the deal", ["Overlay products", "Overlay engaged", "Champion", "Services"]),
        ("Next action", "Follow-up and the reviews a deal waits on", ["Next step", "CRM opportunity", "Security review", "Legal review"]),
    ],
    "health": (
        "at_risk",
        "Commercial is over its limit and its deals have waited about three weeks; Keystone has no overlay coverage.",
    ),
}


def _weight_for(value):
    """The card weight for a deal size: a rough log scale, 1 (small) to 8 (seven figures)."""
    for ceiling, weight in ((80000, 1), (100000, 2), (200000, 3), (250000, 4), (350000, 5), (550000, 6), (800000, 7)):
        if value < ceiling:
            return weight
    return 8


def _overlay_cards(columns, lanes):
    """Deterministic deal tuples (the layout of ``_demo_site_data``) plus ``{title: field values}``.

    Interleaves the columns by each deal's fractional position in its own
    column, so ids and ages do not clump, then pairs a subject with an account.
    A (subject, account) pair never repeats within 60 deals, so titles are unique.
    """
    by_name = {c.name: i for i, c in enumerate(columns)}
    order = sorted(
        ((k + 0.5) / n, name) for name, n in OVERLAY_COLUMN_COUNTS.items() for k in range(n)
    )
    seen_in_column = {}
    tuples, values = [], {}
    for n, (_frac, col_name) in enumerate(order):
        k = seen_in_column.get(col_name, 0)
        seen_in_column[col_name] = k + 1
        lane_i = n % len(lanes)
        account = lanes[lane_i].name
        subject = _SUBJECTS[(n * 7) % len(_SUBJECTS)]
        title = f"{subject}: {account.split()[0]}"
        if col_name == "Won":
            age, due = k % 3, None
        else:
            ages, dues = _OVERLAY_AGES[col_name], _OVERLAY_DUES[col_name]
            age, due = ages[k % len(ages)], dues[k % len(dues)]
        comments = []
        if col_name == "Commercial":
            comments = [("maya", "Legal is on the second round of redlines."), ("jordan", "Pricing approval is the open item.")]
        value = _DEAL_VALUES[(n * 5) % len(_DEAL_VALUES)]
        tuples.append((
            title, f"{subject} at {account}.", by_name[col_name], lane_i, _PRIORITIES[n % len(_PRIORITIES)],
            _ASSIGNEES[n % len(_ASSIGNEES)], ("Renewal" if col_name == "Won" else _LABELS[n % len(_LABELS)],),
            comments, age, due,
        ))
        values[title] = {
            "Deal value": str(value), "Forecast": _FORECAST[col_name], "Win probability": str(_PROBABILITY[col_name]),
            "Expected close": days_from_today(10 + (n * 9) % 120), "Overlay products": [_PRODUCTS[n % len(_PRODUCTS)]],
            "Overlay engaged": "true" if n % 3 else "false", "Champion": _CHAMPIONS[n % len(_CHAMPIONS)],
            "Primary competitor": _COMPETITORS[n % len(_COMPETITORS)], "Next step": _NEXT_STEPS[n % len(_NEXT_STEPS)],
            "Services": _SERVICES[n % len(_SERVICES)], "CRM opportunity": f"https://crm.example.com/opportunities/OPP-{6000 + n}",
        }
    return tuples, values


def _build_overlay(cmd, board, cards, users, anchor):
    """Add the 1.3 build-out to the imported overlay board (#2599). Returns the new ``{title: Card}``."""
    columns = list(board.columns.order_by("position"))
    lanes = list(board.swimlanes.order_by("position"))
    labels = {label.name: label for label in board.labels.all()}
    people = [u for key, u in users.items() if key != "visitor"]

    # Two review gates as dimension fields, shown as tracks on their stage.
    definitions = {d.name: d for d in CustomFieldDefinition.objects.filter(board=board)}
    base = len(definitions)
    for pos, (name, choices) in enumerate(OVERLAY_STRUCTURE["dimension_choices"].items()):
        definitions[name] = CustomFieldDefinition.objects.create(
            board=board, name=name, field_type="dropdown", choices_json=list(choices), position=base + pos,
            show_on_card=False, help_text=f"Where the {name.lower()} stands.",
            is_dimension=True, choice_resolutions=dict(_RESOLUTIONS[name]),
        )

    tuples, field_values = _overlay_cards(columns, lanes)
    new = cmd._seed_spec_cards(board, tuples, columns, lanes, labels, users, anchor, start_idx=len(cards))
    rows = []
    for title, card in new.items():
        values = field_values[title]
        for name, value in values.items():
            definition = definitions[name]
            rows.append(CustomFieldValue(
                card=card, field_definition=definition, value=cmd._demo_site_field_value(definition, value),
            ))
        # Weight is the deal size, as on the sample's own cards.
        weight = _weight_for(int(values["Deal value"]))
        Card.objects.filter(pk=card.pk).update(weight=weight)
        card.weight = weight
    CustomFieldValue.objects.bulk_create(rows)
    cards.update(new)

    cmd._add_demo_site_structure(board, {"cards": [], "structure": OVERLAY_STRUCTURE}, columns, cards, users, anchor)

    # Soft limits on, so an over-limit column is a decision somebody made and
    # the overrides seeded below have something to have overridden.
    Board.objects.filter(pk=board.pk).update(
        enforce_wip_limits=True, enforce_weight_limits=True, cards_can_have_children=True,
    )
    # Last, once the cards are final: the activity the API would have written.
    for card in new.values():
        write_activity_trail(card, actors=people)
    return new


# --- Connected boards (#2598) ------------------------------------------------

#: (parent board, parent card, child board, child card, needed-at column on the parent board, kind).
#: ``kind``: None is a plain link ("Needed: Now"); ``planned`` is child work
#: for a later parent stage (#2371); ``released`` is a planned child whose
#: parent has reached the stage; ``relinked`` was linked, unlinked and linked
#: again, so the timeline shows both directions.
LINKS = (
    (OVERLAY, "Branch analytics renewal", IMPLEMENTATION_BOARD_NAME, "Migrate branch reporting data", None, None),
    (OVERLAY, "Branch analytics renewal", IMPLEMENTATION_BOARD_NAME, "Train branch analysts", None, None),
    (OVERLAY, "Network analytics renewal", IMPLEMENTATION_BOARD_NAME, "Connect network telemetry feeds", None, None),
    (OVERLAY, "Network analytics renewal", IMPLEMENTATION_BOARD_NAME, "Cutover plan and rollback", None, None),
    (OVERLAY, "Accessibility compliance integration", IMPLEMENTATION_BOARD_NAME, "Integrate screen reader audit tool", None, None),
    (OVERLAY, "Accessibility compliance integration", IMPLEMENTATION_BOARD_NAME, "Accessibility acceptance testing", None, None),
    (OVERLAY, "Population health dashboards", IMPLEMENTATION_BOARD_NAME, "Build cohort dashboards", None, None),
    (OVERLAY, "Population health dashboards", IMPLEMENTATION_BOARD_NAME, "Load historical encounter data", None, None),
    (OVERLAY, "Population health dashboards", IMPLEMENTATION_BOARD_NAME, "Clinician training sessions", None, None),
    (OVERLAY, "Research workspace renewal", IMPLEMENTATION_BOARD_NAME, "Provision research workspaces", None, None),
    (OVERLAY, "Research workspace renewal", IMPLEMENTATION_BOARD_NAME, "Migrate legacy notebooks", None, None),
    (OVERLAY, "Security analytics add-on", IMPLEMENTATION_BOARD_NAME, "Plan the security analytics rollout", "Won", "planned"),
    (OVERLAY, "Billing integration refresh", IMPLEMENTATION_BOARD_NAME, "Billing interface design review", "Won", "relinked"),
    (OVERLAY, "HIPAA security review", IMPLEMENTATION_BOARD_NAME, "Security control mapping workshop", "Won", "planned"),
    (OVERLAY, "Claims platform renewal", IMPLEMENTATION_BOARD_NAME, "Claims data validation", "Won", "planned"),
    (OVERLAY, "Compliance reporting add-on", IMPLEMENTATION_BOARD_NAME, "Reporting template build", "Commit", "released"),
    (PROGRAM_BOARD_NAME, "Zero-downtime upgrades", SOFTWARE, "Upgrade PostgreSQL 15 to 16", None, None),
    (PROGRAM_BOARD_NAME, "Zero-downtime upgrades", SOFTWARE, "Automated database backups to S3", None, None),
    (PROGRAM_BOARD_NAME, "Zero-downtime upgrades", SOFTWARE, "Add health check for the load balancer", None, None),
    (PROGRAM_BOARD_NAME, "Faster board loads", SOFTWARE, "Reduce frontend bundle below 200 KB gzipped", None, None),
    (PROGRAM_BOARD_NAME, "Faster board loads", SOFTWARE, "Paginate movement history", None, None),
    (PROGRAM_BOARD_NAME, "Faster board loads", SOFTWARE, "Fix pagination cursors on Safari", None, None),
    (PROGRAM_BOARD_NAME, "Operational readiness", SOFTWARE, "Write the on-call runbook", "In Delivery", "planned"),
    (PROGRAM_BOARD_NAME, "Operational readiness", SOFTWARE, "Set up preview environments for merge requests", "In Delivery", "planned"),
    (PROGRAM_BOARD_NAME, "Operational readiness", SOFTWARE, "Structured JSON logging", None, None),
    (PROGRAM_BOARD_NAME, "Secure by default", SOFTWARE, "Rate limit auth endpoints", None, None),
    (PROGRAM_BOARD_NAME, "Secure by default", SOFTWARE, "Audit endpoints for IDOR", None, None),
)

#: Which board is each board's default child board ("Add child" starts there).
DEFAULT_CHILD_BOARDS = {OVERLAY: IMPLEMENTATION_BOARD_NAME, PROGRAM_BOARD_NAME: SOFTWARE}


class _Activities:
    """Collects activity rows with explicit times and writes them in one go.

    ``CardActivity.created_at`` is ``auto_now_add``; like ``write_activity_trail``
    this bulk-inserts and then sets the times, so a row reads as it would have
    when the event happened. Times are capped just before now, so a reset in
    the first hours of the UTC day dates nothing in the future.
    """

    def __init__(self):
        self.rows = []
        self.latest = timezone.now() - datetime.timedelta(minutes=1)

    def add(self, card, event_type, at, actor, from_value="", to_value="", item_text=None):
        self.rows.append((min(at, self.latest), CardActivity(
            card=card, event_type=event_type, from_value=from_value, to_value=to_value, actor=actor,
            item_text=item_text,
        )))

    def flush(self):
        self.rows.sort(key=lambda r: r[0])
        created = CardActivity.objects.bulk_create([row for _, row in self.rows])
        for (at, _), row in zip(self.rows, created):
            row.created_at = at
        CardActivity.objects.bulk_update(created, ["created_at"])
        self.rows = []


def _at(card, frac):
    """A moment ``frac`` of the way through the card's history window."""
    start, end = history_window(card)
    return start + (end - start) * frac


def _link_boards(seeded, users, acts):
    """Write the parent/child links, planned children and their activity (#2598)."""
    admin, maya, jordan = users["admin"], users["maya"], users["jordan"]
    actors = (admin, maya, jordan)
    columns = {
        name: {c.name: c for c in seeded[name][0].columns.all()} for name in (OVERLAY, PROGRAM_BOARD_NAME)
    }
    cards = {name: seeded[name][1] for name in seeded}
    ET = CardActivity.EventType
    for n, (pboard, ptitle, cboard, ctitle, needed, kind) in enumerate(LINKS):
        parent, child = cards[pboard][ptitle], cards[cboard][ctitle]
        actor = actors[n % len(actors)]
        # Linked after both cards existed, never before either.
        linked_at = max(_at(parent, 0), _at(child, 0)) + datetime.timedelta(hours=2)
        needed_column = columns[pboard][needed] if needed else None
        link = CardParentLink.objects.create(
            parent=parent, child=child, created_by=actor, needed_at_column=needed_column,
        )
        pair_times = [linked_at]
        if kind == "relinked":
            # Linked, unlinked by mistake, linked again.
            pair_times = [linked_at, linked_at + datetime.timedelta(hours=3), linked_at + datetime.timedelta(hours=5)]
        for i, at in enumerate(pair_times):
            unlinking = i == 1
            acts.add(child, ET.PARENT_UNLINKED if unlinking else ET.PARENT_LINKED, at, actor)
            acts.add(parent, ET.CHILD_UNLINKED if unlinking else ET.CHILD_LINKED, at, actor)
        CardParentLink.objects.filter(pk=link.pk).update(created_at=min(pair_times[-1], acts.latest))
        due = child.due_date.isoformat() if child.due_date else ""
        if kind in ("planned", "relinked"):
            acts.add(child, ET.NEEDED_CHANGED, pair_times[-1] + datetime.timedelta(minutes=10), actor, "manual", "planned")
        if kind == "released":
            released_at = pair_times[-1] + datetime.timedelta(days=1)
            acts.add(child, ET.NEEDED_CHANGED, pair_times[-1] + datetime.timedelta(minutes=10), actor, "manual", "planned")
            # No actor, as the service writes it (planned_children.py): the parent's mover
            # must stay hidden on a hidden-parent timeline.
            acts.add(child, ET.PLANNED_RELEASED, released_at, None, "parent_reached", due)
            CardParentLink.objects.filter(pk=link.pk).update(planned_released_at=min(released_at, acts.latest))


def _block(acts, card, actor, reason, start_frac, resolution=None, end_frac=None):
    """A manual block (#1149), open when ``resolution`` is None: row, card mirror and activity."""
    ET = CardActivity.EventType
    blocked_at = _at(card, start_frac)
    unblocked_at = _at(card, end_frac) if resolution is not None else None
    CardBlock.objects.create(
        card=card, board_id=card.board_id, card_uid=card.uid, card_title=card.title, blocked_at=blocked_at,
        blocked_by=actor, reason=reason, unblocked_at=unblocked_at, unblocked_by=actor if resolution is not None else None,
        resolution=resolution or "", column=card.column, column_name=card.column.name, column_uid=card.column.uid,
    )
    acts.add(card, ET.BLOCKED, blocked_at, actor, "", reason)
    if resolution is None:
        Card.objects.filter(pk=card.pk).update(blocked_at=blocked_at, blocked_reason=reason)
    else:
        acts.add(card, ET.UNBLOCKED, unblocked_at, actor, reason, resolution)


def _override(acts, card, actor, kinds, reason):
    """A move forced past a soft limit (#1923): one ``CardOverride`` per kind, one ``override_used`` row."""
    column = card.column
    movement = card.movements.order_by("-moved_at", "-id").first()
    limits = {"wip": column.wip_limit, "weight": column.weight_limit}
    CardOverride.objects.bulk_create([
        CardOverride(
            card=card, board_id=card.board_id, card_uid=card.uid, card_title=card.title, column=column,
            column_name=column.name, column_uid=column.uid, kind=kind, trigger=CardOverride.Trigger.MOVE,
            actor_basis=CardOverride.ActorBasis.ADMIN, reason=reason,
            unmet=[{"kind": kind, "scope": "column", "uid": column.uid, "limit": limits[kind]}],
            movement=movement, actor=actor, created_at=movement.moved_at,
        )
        for kind in kinds
    ])
    acts.add(
        card, CardActivity.EventType.OVERRIDE_USED, movement.moved_at + datetime.timedelta(seconds=1), actor,
        CardOverride.ActorBasis.ADMIN, ",".join(kinds), item_text=reason,
    )


def _seed_vocabulary(seeded, users, acts):
    """Seed every activity type the trail and the links do not (#2607), on cards in their own history window."""
    ET = CardActivity.EventType
    admin, maya, jordan = users["admin"], users["maya"], users["jordan"]
    overlay, impl, program, software = (seeded[n][1] for n in (OVERLAY, IMPLEMENTATION_BOARD_NAME, PROGRAM_BOARD_NAME, SOFTWARE))

    # Blocked and unblocked (#1149): one open block, which also turns a child
    # into a "blocked" child in Children mode, and two that were cleared.
    _block(acts, overlay["Contract renewal at risk"], maya, "Customer legal has not returned the redlines.", 0.8)
    _block(acts, impl["Migrate legacy notebooks"], jordan, "Waiting for the customer to confirm the data-sharing terms.", 0.7)
    _block(acts, overlay["Claims automation proof of concept"], jordan, "Sandbox access not yet granted.", 0.4,
           resolution="Access granted; testing resumed.", end_frac=0.6)
    _block(acts, software["Fix pagination cursors on Safari"], maya, "Cannot reproduce without a Safari device.", 0.3,
           resolution="Reproduced on a borrowed device.", end_frac=0.5)

    # Forced past a limit (#1923). Commercial is over both limits on purpose.
    _override(acts, overlay["Underwriting workflow expansion"], admin, ("wip", "weight"), "Customer wants pricing this week.")
    _override(acts, overlay["Cross-dock pilot proposal"], admin, ("wip",), "Exec sponsor asked for it by Friday.")
    _override(acts, overlay["Claims automation proof of concept"], admin, ("wip",), "Pilot window closes at month end.")

    # Custom field changes (#1909): Forecast steps up, and the deal grew once.
    prior_forecast = {"Best case": "Pipeline", "Commit": "Best case", "Closed won": "Commit"}
    definitions = {d.name: d for d in CustomFieldDefinition.objects.filter(board=seeded[OVERLAY][0])}
    for i, title in enumerate((
        "Core ledger modernization", "Grid telemetry observability", "Clinical data platform expansion", "Security analytics add-on",
    )):
        card = overlay[title]
        forecast = CustomFieldValue.objects.get(card=card, field_definition=definitions["Forecast"]).value
        acts.add(card, ET.CUSTOM_FIELD_CHANGED, _at(card, 0.6), (maya, jordan)[i % 2],
                 prior_forecast[forecast], forecast, item_text="Forecast")
    deal = overlay["Grid telemetry observability"]
    current = int(CustomFieldValue.objects.get(card=deal, field_definition=definitions["Deal value"]).value)
    acts.add(deal, ET.CUSTOM_FIELD_CHANGED, _at(deal, 0.7), jordan, str(round(current * 0.93, -4)).removesuffix(".0"),
             str(current), item_text="Deal value")

    # Attachments (#1541-era timeline rows): attached and later removed, so no
    # card is left pointing at a file that is not there (uploads are off on the demo).
    for card, name, actor in (
        (overlay["Core ledger modernization"], "mutual-action-plan.xlsx", maya),
        (software["Reduce frontend bundle below 200 KB gzipped"], "bundle-report.html", jordan),
    ):
        acts.add(card, ET.ATTACHMENT_ADDED, _at(card, 0.45), actor, "", name)
        acts.add(card, ET.ATTACHMENT_DELETED, _at(card, 0.6), actor, name, "")

    # Renames and description edits.
    for board, title, was, actor in (
        (program, "Faster board loads", "Board load speed", maya),
        (impl, "Plan the security analytics rollout", "Security rollout plan", jordan),
    ):
        card = board[title]
        acts.add(card, ET.TITLE_CHANGE, _at(card, 0.3), actor, was, card.title)
    for card in (program["Zero-downtime upgrades"], impl["Cutover plan and rollback"]):
        acts.add(card, ET.DESCRIPTION_CHANGE, _at(card, 0.35), admin)

    # Checklist item lifecycle on one Software Team card: assigned and given a
    # due date, ticked and unticked, and one item added then deleted.
    item = (
        CardChecklist.objects.filter(card__board=seeded[SOFTWARE][0], is_checked=False, card__archived_at__isnull=True)
        .select_related("card").order_by("card_id", "position").first()
    )
    if item is None:
        raise RuntimeError("The Software Team board has no unchecked checklist item to carry the activity vocabulary.")
    card = item.card
    due = timezone.localdate() + datetime.timedelta(days=5)
    CardChecklist.objects.filter(pk=item.pk).update(assignee=maya, due_date=due)
    acts.add(card, ET.CHECKLIST_ITEM_ASSIGNED, _at(card, 0.5), admin, "", maya.username, item_text=item.text)
    acts.add(card, ET.CHECKLIST_ITEM_DUE_CHANGED, _at(card, 0.52), admin, "", due.isoformat(), item_text=item.text)
    acts.add(card, ET.CHECKLIST_ITEM_CHECKED, _at(card, 0.75), maya, "", item.text)
    acts.add(card, ET.CHECKLIST_ITEM_UNCHECKED, _at(card, 0.8), maya, "", item.text)
    acts.add(card, ET.CHECKLIST_ITEM_ADDED, _at(card, 0.55), admin, "", "Draft a rollback plan")
    acts.add(card, ET.CHECKLIST_ITEM_DELETED, _at(card, 0.7), admin, "Draft a rollback plan", "")

    # The other end's whole board was deleted (#2208): counts and nothing else.
    acts.add(overlay["Cross-dock pilot proposal"], ET.CHILDREN_REMOVED_BOARD_DELETED, _at(overlay["Cross-dock pilot proposal"], 0.5), admin, "", "2")
    standalone = impl["Standard onboarding checklist"]
    acts.add(standalone, ET.PARENT_REMOVED_BOARD_DELETED, _at(standalone, 0.5), admin)


def seed_connected(cmd, seeded, users, anchor):
    """Build out the overlay, connect the boards and complete the activity vocabulary.

    Idempotent the way the rest of the demo seed is: a board that already
    existed is skipped by the caller, and nothing here runs unless every board
    it touches was created in this run (``--wipe`` recreates them all).
    """
    needed = (OVERLAY, IMPLEMENTATION_BOARD_NAME, PROGRAM_BOARD_NAME, SOFTWARE)
    if not all(name in seeded for name in needed):
        cmd.stdout.write(cmd.style.WARNING(
            "Skipping the connected boards, the flagship overlay build-out and the activity "
            "vocabulary: some of the boards they build on already existed and were not "
            "recreated. Re-run with --wipe to seed them."
        ))
        return
    board, cards = seeded[OVERLAY]
    _build_overlay(cmd, board, cards, users, anchor)
    acts = _Activities()
    _link_boards(seeded, users, acts)
    _seed_vocabulary(seeded, users, acts)
    acts.flush()

    names = {name: seeded[name][0] for name in seeded}
    for parent_name, child_name in DEFAULT_CHILD_BOARDS.items():
        Board.objects.filter(pk=names[parent_name].pk).update(default_child_board=names[child_name], cards_can_have_children=True)


def keep_first_run_board_first(seeded):
    """Touch the first-run board last (#2600): the board list is ordered by -updated_at.

    The boards seeded after it, and everything that writes to a board while the
    rest of the seed runs, are newer than it; a new visitor still lands on it.
    """
    if SIMPLE_BOARD_NAME in seeded:
        Board.objects.filter(pk=seeded[SIMPLE_BOARD_NAME][0].pk).update(updated_at=timezone.now())
