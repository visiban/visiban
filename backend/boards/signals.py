from django.db.models.signals import post_save
from django.dispatch import Signal, receiver

from accounts.models import User
from .models import CardMovement, Card, Notification

# Custom field value change signal (#371) — an OSS extension point for the
# enterprise field-change audit trail, which is out of scope for this repo.
#
# sender:           boards.models.CustomFieldValue
# card:             the Card whose value changed
# field_definition: the CustomFieldDefinition it belongs to
# old_value:        the previous stored value, "" when the field was unset
# new_value:        the new stored value, "" when the field was cleared
# actor:            the User who made the change, or None for a non-HTTP caller
#
# Sent from ``boards.services.custom_fields.apply_custom_field_values`` inside
# the card-mutation transaction, once per value that actually changed — a
# submitted value identical to the stored one sends nothing. Receivers run
# inside that transaction, so a receiver that raises rolls the card update back;
# a receiver that must not be able to do that should defer its own work with
# ``transaction.on_commit``.
#
# Stability: this signal's name and keyword arguments are part of the 1.0+
# extension surface. Arguments may be added; none may be removed or renamed
# without a major version bump.
custom_field_value_changed = Signal()

# Swimlane custom field value change signal (#1140) — the row-level counterpart
# to the card-level signal above, and likewise an OSS extension point for the
# enterprise field-change audit trail.
#
# sender:           boards.models.SwimlaneCustomFieldValue
# swimlane:         the Swimlane whose value changed
# field_definition: the SwimlaneCustomFieldDefinition it belongs to
# old_value:        the previous stored value, "" when the field was unset
# new_value:        the new stored value, "" when the field was cleared
# actor:            the User who made the change, or None for a non-HTTP caller
#
# **Why a second signal rather than a `swimlane=` kwarg on the card signal:**
# `custom_field_value_changed` guarantees its `card` argument above, and
# reusing it for rows would mean sending `card=None`. That is additive on the
# signature and breaking in meaning — an existing receiver doing `card.board`
# starts raising the moment a row value changes, and the receivers live in a
# private repo this one cannot grep. A separate signal makes enterprise
# adoption an opt-in second `connect()` and breaks nothing that exists.
#
# Sent from ``boards.services.custom_fields.apply_swimlane_custom_field_values``
# inside the swimlane-mutation transaction, once per value that actually
# changed. Receivers run inside that transaction, with the same caveat as
# above: a receiver that raises rolls the swimlane update back.
#
# Stability: this signal's name and keyword arguments are part of the 1.0+
# extension surface. Arguments may be added; none may be removed or renamed
# without a major version bump.
swimlane_custom_field_value_changed = Signal()


@receiver(post_save, sender=CardMovement)
def notify_on_card_moved(sender, instance, created, **kwargs):
    if not created:
        return
    # Re-fetch card with needed relations. The just-created CardMovement instance
    # carries only integer FKs (card_id, assignee_id, etc.), so accessing
    # instance.card, card.assignee, or card.board each issue a live DB query.
    # A single select_related fetch eliminates 4–5 lazy-FK queries per card move.
    try:
        card = Card.objects.select_related("assignee", "board").get(pk=instance.card_id)
    except Card.DoesNotExist:
        return
    if not card.assignee:
        return
    # Don't notify the person who moved it
    if card.assignee_id == instance.moved_by_id:
        return
    if not card.assignee.notif_card_moved:
        return
    # Use the denormalized to_column_name (migration 0016) — avoids a FK query.
    to_col = instance.to_column_name or "a new stage"
    # Resolve the mover username via a targeted PK fetch (#991).  The raw
    # ``CardMovement`` instance delivered by ``post_save`` does not pre-load
    # ``moved_by``; ``instance.moved_by.username`` would issue an extra lazy FK
    # query on every notification path.  Fetch the bare username column so the
    # query is as cheap as possible and the FK relation stays unused.
    if instance.moved_by_id:
        try:
            mover = User.objects.only("username").get(pk=instance.moved_by_id).username
        except User.DoesNotExist:
            mover = "Someone"
    else:
        mover = "Someone"
    Notification.objects.create(
        recipient=card.assignee,
        actor_id=instance.moved_by_id,
        action_type=Notification.ActionType.CARD_MOVED,
        verb=f"{mover} moved \"{card.title}\" to {to_col}",
        card=card,
        board=card.board,
    )


@receiver(post_save, sender=Card)
def notify_on_card_assigned(sender, instance, created, **kwargs):
    if created:
        return
    # Detect assignee change via update_fields hint (not always present)
    # We use a post_save approach: compare with DB state isn't possible here,
    # so we rely on the CardViewSet emitting a signal via update() tracking.
    # This signal fires on every save; the view layer calls notify_assignee()
    # directly to avoid spurious notifications.
    pass
