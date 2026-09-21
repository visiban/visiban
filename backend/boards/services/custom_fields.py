"""Persistence for per-card custom field values (#371).

This module owns *writing* values, not validating them. Validation and casting
live at the serializer boundary — the project rule — in
``boards.serializers.CustomFieldValuesField``, which hands this function a list
of ``(definition, normalized_value)`` pairs that are already known to be legal
for their types and to belong to the card's board.

What is here, and why it is not in the serializer:

* the **diff**, so that a submitted value identical to the stored one writes
  nothing and sends no signal — the difference between "the client echoed the
  representation it was given" and "the user changed something";
* the ``custom_field_value_changed`` signal fan-out, which is an OSS extension
  point (the enterprise field-change audit trail consumes it) and therefore
  must fire from exactly one place;
* the delete-on-empty rule, so that "unset" has a single representation.

It is called from inside ``boards.services.cards.update_card`` /
``create_card``'s transaction (the serializer's ``save()`` runs there), so every
write here rolls back with the card if any later step fails, and the
``card.updated`` broadcast the service defers already reflects it.
"""

from ..models import CustomFieldValue, SwimlaneCustomFieldValue
from ..signals import (
    custom_field_value_changed, swimlane_custom_field_value_changed,
)


def _apply_values(*, value_model, owner_field, owner, pairs, signal, signal_kwarg, actor):
    """Shared diff-and-write for card (#371) and swimlane (#1140) field values.

    The two callers differ only in which model holds the rows, which column
    points at the owner, and which signal announces a change — everything that
    actually carries risk (the diff, the delete-on-empty rule, the bulk write
    shape, firing the signal exactly once per real change) is identical, so it
    lives here once rather than in two copies free to drift apart.

    Returns the list of ``(definition, old_value, new_value)`` triples that
    changed, so callers can distinguish a real edit from an echo.
    """
    definitions = {definition.pk: definition for definition, _ in pairs}
    existing = {
        row.field_definition_id: row
        for row in value_model.objects.filter(
            **{owner_field: owner}, field_definition_id__in=definitions
        )
    }

    changed = []
    to_create = []
    to_update = []
    to_delete = []
    for definition, new_value in pairs:
        row = existing.get(definition.pk)
        old_value = row.value if row is not None else ""
        if old_value == new_value:
            continue
        if new_value == "":
            # Clearing: drop the row so "unset" is always the absence of a row
            # and never a row holding "".
            to_delete.append(row.pk)
        elif row is None:
            to_create.append(
                value_model(
                    **{owner_field: owner}, field_definition=definition, value=new_value
                )
            )
        else:
            row.value = new_value
            to_update.append(row)
        changed.append((definition, old_value, new_value))

    # Bulk-written so an owner carrying the board's full field set costs three
    # queries rather than one per field.
    if to_delete:
        value_model.objects.filter(pk__in=to_delete).delete()
    if to_create:
        value_model.objects.bulk_create(to_create)
    if to_update:
        value_model.objects.bulk_update(to_update, ["value"])

    for definition, old_value, new_value in changed:
        # Sent inside the caller's transaction — see the signal's own docs in
        # boards/signals.py for what a receiver may and may not do there.
        signal.send(
            sender=value_model,
            field_definition=definition,
            old_value=old_value,
            new_value=new_value,
            actor=actor,
            **{signal_kwarg: owner},
        )
    return changed


def apply_custom_field_values(*, card, pairs, actor=None):
    """Write *pairs* onto *card*, returning the definitions that changed.

    ``pairs`` is a list of ``(CustomFieldDefinition, value)`` tuples, where
    ``value`` is the normalized string to store; an empty string means "clear
    this field", which deletes the row rather than storing a blank one.

    Only the definitions named in ``pairs`` are touched — a PATCH that submits
    one field does not clear the others. That is what makes the field usable
    from a partial update, which is how the card endpoint is used in practice.

    Returns the list of definitions whose stored value actually changed, so a
    caller can tell a real edit from an echo of the current representation.
    """
    if not pairs:
        return []
    changed = _apply_values(
        value_model=CustomFieldValue,
        owner_field="card",
        owner=card,
        pairs=pairs,
        signal=custom_field_value_changed,
        signal_kwarg="card",
        actor=actor,
    )
    return [definition for definition, _, _ in changed]


def apply_swimlane_custom_field_values(*, swimlane, pairs, actor=None):
    """Write *pairs* onto *swimlane*, returning the definitions that changed.

    The row-level counterpart to :func:`apply_custom_field_values`, with the
    same contract: ``pairs`` holds ``(SwimlaneCustomFieldDefinition, value)``
    tuples already normalized and validated at the serializer boundary, an
    empty string clears (and deletes) the row, and unnamed definitions are left
    alone so a partial update stays partial.

    Called from inside ``SwimlaneViewSet.perform_update``'s transaction, so
    every write here rolls back with the swimlane if a later step fails, and
    the ``swimlane.updated`` event that view records already reflects it.
    """
    if not pairs:
        return []
    changed = _apply_values(
        value_model=SwimlaneCustomFieldValue,
        owner_field="swimlane",
        owner=swimlane,
        pairs=pairs,
        signal=swimlane_custom_field_value_changed,
        signal_kwarg="swimlane",
        actor=actor,
    )
    return [definition for definition, _, _ in changed]
