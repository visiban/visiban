from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import CardMovement, Card, Notification


@receiver(post_save, sender=CardMovement)
def notify_on_card_moved(sender, instance, created, **kwargs):
    if not created:
        return
    card = instance.card
    if not card.assignee:
        return
    # Don't notify the person who moved it
    if card.assignee == instance.moved_by:
        return
    to_col = instance.to_column.name if instance.to_column else "a new stage"
    mover = instance.moved_by.username if instance.moved_by else "Someone"
    Notification.objects.create(
        recipient=card.assignee,
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
