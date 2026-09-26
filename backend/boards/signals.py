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
#
# NOTE: ``post_notification_created`` below uses the *opposite* dispatch
# convention (post-commit, ``send_robust``). Do not assume one from the other.
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
#
# Same in-transaction dispatch convention as the card-level signal above, and
# the same contrast with ``post_notification_created`` below.
swimlane_custom_field_value_changed = Signal()


# Notification created signal (#356) — the OSS extension point for additional
# notification *delivery* backends. OSS ships email; the enterprise repo attaches
# Slack, Teams and webhook delivery here without editing any OSS file.
#
# sender:       boards.models.Notification
# notification: the Notification row, with its pk populated
# recipient:    the recipient User, pre-fetched so a receiver needs no FK query
# actor:        the User who triggered the event, or None for system events
#               (staleness and due-date scans). Also pre-fetched.
# context:      a dict of best-effort structured detail about the originating
#               event, keyed per ``action_type``. It exists because
#               ``Notification`` stores only a prose ``verb`` plus card/board FKs
#               — there is no FK to the comment or the card movement behind the
#               event, so without this a delivery backend would have to parse
#               English out of ``verb``. Keys currently populated:
#                 mentioned  → source ("comment"|"description"),
#                              comment_id, comment_body (comment source only)
#                 card_moved → from_column_name, to_column_name
#                 due_soon   → due_date (ISO date string)
#               Treat every key as optional and absent-by-default: keys may be
#               added, and no key may be removed or retyped without a major bump.
#
# Dispatch convention — READ THIS, it differs from the two signals above:
#
# * Sent from ``boards.services.notifications.create_notifications`` via
#   ``transaction.on_commit``, so the row is committed and visible before any
#   receiver runs. A delivery backend must not be able to roll back the very
#   notification it is reporting, and must not re-query a row that may vanish.
# * Sent with ``send_robust``, so a receiver that raises is logged (with its
#   module and qualified name) and dropped. It cannot fail the request or
#   affect other receivers. A delivery failure is never allowed to break the
#   write that caused it.
# * When no atomic block is open — both notification management commands, and
#   ``notify_new_mentions``, which is itself already called from an on_commit
#   hook — ``on_commit`` runs the callback **immediately and synchronously**.
#   A receiver doing network I/O therefore blocks the caller and owns its own
#   timeout. OSS email does this via ``NOTIFICATION_EMAIL_TIMEOUT``.
# * Sent once per notification row, not once per batch, even though the rows are
#   created with ``bulk_create``.
#
# Stability: this signal's name and keyword arguments are part of the 1.0+
# extension surface. Arguments may be added; none may be removed or renamed
# without a major version bump.
post_notification_created = Signal()


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
    # Imported here, not at module scope: boards.services.notifications imports
    # this module for ``post_notification_created``, so a top-level import would
    # be circular.
    from .services.notifications import create_notifications

    create_notifications(
        [
            Notification(
                recipient=card.assignee,
                actor_id=instance.moved_by_id,
                action_type=Notification.ActionType.CARD_MOVED,
                verb=f"{mover} moved \"{card.title}\" to {to_col}",
                card=card,
                board=card.board,
            )
        ],
        context={
            "from_column_name": instance.from_column_name or "",
            "to_column_name": instance.to_column_name or "",
        },
    )
