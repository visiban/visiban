from django.db.models.signals import post_save
from django.dispatch import receiver

from accounts.models import User
from .models import CardMovement, Card, Notification


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
