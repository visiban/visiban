"""Reconcile a card's current state against its history (#1889).

Shared by the seed and sample-board tests. :func:`history_problems` returns one
line per way the card's history fails to explain the card: every value the
card holds must be backed by the movement or activity the API writes when a
person makes that change, in the API's own form, and the history must be a
single coherent chain. An empty list means the card is fully explained.

The forms come from the API's writers, not from the seeders:

* ``services.cards.create_card``: creation movement (no ``from_*``), "Card created";
* ``services.cards.move_card``: each move starts where the previous one ended;
* ``services.cards.archive_card`` / ``unarchive_card``: an in-place movement;
* ``services.cards.update_card``: ``assignee_change`` (usernames, "Unassigned"
  for none), ``label_change`` ("+A, B" / "-C"), ``priority_change`` (the model
  default is "medium"), ``weight_change`` (default "1"), ``due_date_change``
  (ISO date, "" for none), ``title_change``, ``description_change`` ("" / "");
* the checklist endpoints: added / checked / unchecked with the item text as
  ``to_value``, deleted with it as ``from_value``;
* the comment endpoint: ``comment_added`` ("" / "") by the comment's author.

A card is taken to have been created with its title and description (the
creation movement backs both); every other non-default value needs an
activity. Custom-field values, attachments, relations and MR/PR links are not
checked: the open-source API records no card activity for them (only a
``card.updated`` change-feed row with no field diff), so there is no history
form to hold them to.

``imported=True`` relaxes exactly what the importer is documented to change:
history rows are credited to the importer with the source name kept in
``imported_from_username`` (#1675, #1702). The card row is not relaxed: the
importer restores the exported ``created_at`` (#1906), so an imported card is
dated no later than its own history like any other. A file that gives no
usable ``created_at`` imports at the import time and fails that check, by design.
"""

import datetime
import re
from collections import Counter

from django.utils import timezone

from boards.models import Card, CardActivity, CardMovement

CREATED_NOTE = "Card created"
# The API writes a card and its creation movement, a comment and its
# comment_added, an archive stamp and its movement as separate rows, so their
# times differ by the microseconds between the INSERTs. Seeders write them equal.
_SAME_MOMENT = datetime.timedelta(seconds=1)
_LOST_RX = re.compile(r"lost|rejected|denied|churned", re.IGNORECASE)


def _chain(problems, label, events, start, final):
    """Values ``start -> ... -> final`` must chain, each ``from`` the previous ``to``."""
    current = start
    for act in events:
        if act.from_value != current:
            problems.append(f"{label}: from {act.from_value!r} but the value was {current!r}")
        current = act.to_value
    if current != final:
        problems.append(f"{label}: history ends at {current!r}, the card holds {final!r}")


def _replay_labels(problems, events):
    held = set()
    for act in events:
        if act.from_value != "":
            problems.append(f"label_change: from_value {act.from_value!r}, the API writes ''")
        sign = None
        for token in act.to_value.split(", "):
            if token.startswith(("+", "-")):
                sign, token = token[0], token[1:]
            if sign is None:
                problems.append(f"label_change: {act.to_value!r} is not in the API's +A / -B form")
                break
            (held.add if sign == "+" else held.discard)(token)
    return held


def history_problems(card, *, now=None, imported=False):
    """Every way ``card``'s history fails to account for its current state."""
    now = now or timezone.now()
    problems = []
    moves = list(card.movements.select_related("to_column").order_by("moved_at", "id"))
    acts = list(card.activities.order_by("created_at", "id"))
    comments = list(card.comments.order_by("created_at", "id"))
    if not moves:
        return ["no movements: the card has no creation record"]

    # ── Movements: creation, one chain, the card ends where it is ──────────
    first = moves[0]
    if first.from_column_id is not None or first.from_swimlane_id is not None or first.from_column_name:
        problems.append("first movement is not a creation (it has a from column or swimlane)")
    if first.notes != CREATED_NOTE:
        problems.append(f"creation movement notes {first.notes!r}, the API writes {CREATED_NOTE!r}")
    if abs(card.created_at - first.moved_at) > _SAME_MOMENT:
        problems.append(f"card created_at {card.created_at} is not its creation movement {first.moved_at}")
    # create_card writes created_by and the creation movement's moved_by as
    # one user. The importer credits both to the importer, so this holds there too.
    if card.created_by_id != first.moved_by_id:
        problems.append(
            f"created_by {card.created_by_id} is not the creation movement's actor {first.moved_by_id}"
        )
    archived = False
    archived_at = None
    for prev, mv in zip(moves, moves[1:]):
        if mv.moved_at <= prev.moved_at:
            problems.append(f"movement at {mv.moved_at} does not follow the previous one at {prev.moved_at}")
        if (mv.from_column_name, mv.from_swimlane_name) != (prev.to_column_name, prev.to_swimlane_name):
            problems.append(
                f"move from {mv.from_column_name}/{mv.from_swimlane_name} but the card was in "
                f"{prev.to_column_name}/{prev.to_swimlane_name}"
            )
        if mv.from_column_id != prev.to_column_id or mv.from_swimlane_id != prev.to_swimlane_id:
            problems.append(f"move to {mv.to_column_name}: from_column/from_swimlane ids break the chain")
        if mv.movement_type == CardMovement.MovementType.MOVE:
            if archived:
                problems.append(f"moved to {mv.to_column_name} while archived")
        elif mv.to_column_id != mv.from_column_id or mv.to_swimlane_id != mv.from_swimlane_id:
            problems.append(f"{mv.movement_type} movement changes the card's cell")
        if mv.movement_type == CardMovement.MovementType.ARCHIVED:
            archived, archived_at = True, mv.moved_at
        elif mv.movement_type == CardMovement.MovementType.UNARCHIVED:
            archived = False
    last = moves[-1]
    if (last.to_column_id, last.to_swimlane_id) != (card.column_id, card.swimlane_id):
        problems.append(f"history ends in {last.to_column_name}/{last.to_swimlane_name}, not the card's cell")
    if archived != bool(card.archived_at):
        problems.append("archived state does not match the archive/unarchive movements")
    elif archived and abs(archived_at - card.archived_at) > _SAME_MOMENT:
        problems.append(f"archived_at {card.archived_at} is not the archive movement's time {archived_at}")
    stops = [mv for mv in moves if mv.movement_type == CardMovement.MovementType.MOVE][:-1]
    ends_lost = card.column.is_done and _LOST_RX.search(card.column.name)
    for mv in stops:
        col = mv.to_column
        if col is not None and col.is_done and (ends_lost or _LOST_RX.search(col.name)):
            problems.append(f"passed through outcome {col.name} on the way to {card.column.name}")
    if last.moved_at > now:
        problems.append(f"movement in the future ({last.moved_at})")

    # ── Timestamps of everything else sit inside the card's life ──────────
    born = first.moved_at - _SAME_MOMENT
    for act in acts:
        if not born <= act.created_at <= now:
            problems.append(f"{act.event_type} at {act.created_at} is outside the card's life")
    for comment in comments:
        if not born <= comment.created_at <= now:
            problems.append(f"comment at {comment.created_at} is outside the card's life")

    by_type = {}
    for act in acts:
        by_type.setdefault(act.event_type, []).append(act)
    ET = CardActivity.EventType

    # ── Field values set after creation ───────────────────────────────────
    assignee = card.assignee.username if card.assignee_id else "Unassigned"
    if card.assignee_id and not by_type.get(ET.ASSIGNEE_CHANGE):
        problems.append(f"assignee {assignee} has no assignee_change")
    _chain(problems, "assignee_change", by_type.get(ET.ASSIGNEE_CHANGE, []), "Unassigned", assignee)
    if card.priority != Card.Priority.MEDIUM and not by_type.get(ET.PRIORITY_CHANGE):
        problems.append(f"priority {card.priority} has no priority_change")
    _chain(problems, "priority_change", by_type.get(ET.PRIORITY_CHANGE, []), Card.Priority.MEDIUM, card.priority)
    if card.weight != 1 and not by_type.get(ET.WEIGHT_CHANGE):
        problems.append(f"weight {card.weight} has no weight_change")
    _chain(problems, "weight_change", by_type.get(ET.WEIGHT_CHANGE, []), "1", str(card.weight))
    due = card.due_date.isoformat() if card.due_date else ""
    if due and not by_type.get(ET.DUE_DATE_CHANGE):
        problems.append(f"due date {due} has no due_date_change")
    _chain(problems, "due_date_change", by_type.get(ET.DUE_DATE_CHANGE, []), "", due)
    titles = by_type.get(ET.TITLE_CHANGE, [])
    if titles:
        _chain(problems, "title_change", titles[1:], titles[0].to_value, card.title)
    for act in by_type.get(ET.DESCRIPTION_CHANGE, []):
        if (act.from_value, act.to_value) != ("", ""):
            problems.append("description_change carries values; the API writes '' / ''")

    labels = set(card.labels.values_list("name", flat=True))
    held = _replay_labels(problems, by_type.get(ET.LABEL_CHANGE, []))
    for name in sorted(labels - held):
        problems.append(f"label {name} has no +{name} activity")
    for name in sorted(held - labels):
        problems.append(f"label {name} was added and never removed, but the card does not have it")

    # ── Checklist ─────────────────────────────────────────────────────────
    added, checked, form = Counter(), {}, []
    for act in acts:
        if act.event_type == ET.CHECKLIST_ITEM_ADDED:
            added[act.to_value] += 1
            checked.setdefault(act.to_value, False)
        elif act.event_type == ET.CHECKLIST_ITEM_DELETED:
            if act.to_value != "":
                form.append("checklist_item_deleted: the API keeps the text in from_value")
            added[act.from_value] -= 1
        elif act.event_type in (ET.CHECKLIST_ITEM_CHECKED, ET.CHECKLIST_ITEM_UNCHECKED):
            if added[act.to_value] < 1:
                problems.append(f"checklist item {act.to_value!r} toggled before it was added")
            checked[act.to_value] = act.event_type == ET.CHECKLIST_ITEM_CHECKED
    problems.extend(form)
    added_by = {}
    for act in acts:
        if act.event_type == ET.CHECKLIST_ITEM_ADDED:
            added_by.setdefault(act.to_value, set()).add(act.actor_id)
    for item in card.checklist_items.all():
        if added[item.text] < 1:
            problems.append(f"checklist item {item.text!r} has no checklist_item_added")
        elif item.created_by_id is not None and item.created_by_id not in added_by[item.text]:
            # The checklist endpoint credits the item and its "added" entry
            # to the same user. (The importer leaves created_by empty.)
            problems.append(f"checklist item {item.text!r} was created by someone its history does not credit")
        elif checked.get(item.text, False) != item.is_checked:
            problems.append(f"checklist item {item.text!r} is checked={item.is_checked}, history says otherwise")

    # The assign / due rows carry only the new username / ISO date, never the
    # item (#2199), so match on to_value: every item that has an assignee or due
    # date needs a row whose to_value is that value.
    assigned_to = {a.to_value for a in by_type.get(ET.CHECKLIST_ITEM_ASSIGNED, [])}
    due_to = {a.to_value for a in by_type.get(ET.CHECKLIST_ITEM_DUE_CHANGED, [])}
    for item in card.checklist_items.select_related("assignee"):
        if item.assignee is not None and item.assignee.username not in assigned_to:
            problems.append(
                f"checklist item {item.text!r} is assigned to {item.assignee.username} "
                "but has no checklist_item_assigned to that user"
            )
        if item.due_date is not None and item.due_date.isoformat() not in due_to:
            problems.append(
                f"checklist item {item.text!r} is due {item.due_date.isoformat()} "
                "but has no checklist_item_due_changed to that date"
            )

    # ── Comments: one comment_added each, at its time, by its author ──────
    events = by_type.get(ET.COMMENT_ADDED, [])
    for act in events:
        if (act.from_value, act.to_value) != ("", ""):
            problems.append("comment_added carries values; the API writes '' / ''")
    # Paired in time order: the n-th comment and the n-th comment_added.
    if len(events) != len(comments) or any(
        abs(a.created_at - c.created_at) > _SAME_MOMENT for a, c in zip(events, comments)
    ):
        problems.append(f"{len(comments)} comment(s) but comment_added times do not match them")
    elif any(
        (a.imported_from_username if imported else a.actor_id)
        != (c.imported_from_username if imported else c.author_id)
        for a, c in zip(events, comments)
    ):
        problems.append("comment_added actors are not the comments' authors")
    return problems


def board_history_problems(board, **kwargs):
    """``{card title: problems}`` for every card on ``board`` that has any."""
    found = {}
    cards = board.cards.select_related("column", "assignee").prefetch_related("labels", "checklist_items")
    for card in cards:
        problems = history_problems(card, **kwargs)
        if problems:
            found[card.title] = problems
    return found
