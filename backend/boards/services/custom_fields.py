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

from ..models import CustomFieldValue
from ..signals import custom_field_value_changed


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

    definitions = {definition.pk: definition for definition, _ in pairs}
    existing = {
        row.field_definition_id: row
        for row in CustomFieldValue.objects.filter(
            card=card, field_definition_id__in=definitions
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
                CustomFieldValue(
                    card=card, field_definition=definition, value=new_value
                )
            )
        else:
            row.value = new_value
            to_update.append(row)
        changed.append((definition, old_value, new_value))

    # Bulk-written so a card carrying the board's full 30 fields costs three
    # queries rather than thirty.
    if to_delete:
        CustomFieldValue.objects.filter(pk__in=to_delete).delete()
    if to_create:
        CustomFieldValue.objects.bulk_create(to_create)
    if to_update:
        CustomFieldValue.objects.bulk_update(to_update, ["value"])

    for definition, old_value, new_value in changed:
        # Sent inside the caller's transaction — see the signal's own docs in
        # boards/signals.py for what a receiver may and may not do there.
        custom_field_value_changed.send(
            sender=CustomFieldValue,
            card=card,
            field_definition=definition,
            old_value=old_value,
            new_value=new_value,
            actor=actor,
        )
    return [definition for definition, _, _ in changed]
