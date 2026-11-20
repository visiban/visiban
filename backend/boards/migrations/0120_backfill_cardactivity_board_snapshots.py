# #1799 step 2 of 5: backfill CardActivity.board / card_uid / card_title on
# existing rows.
#
# ``atomic = False`` so each batch commits on its own: card_activities can be
# large, and a long single transaction would hold row locks and bloat for the
# whole run. The backfill is idempotent and resumable — it only touches rows
# that still have a card but no board, so an interrupted run picks up where it
# stopped. Batches walk the primary key (keyset), so a sparse id space costs
# nothing extra.
#
# ``card_title`` is the card's title at backfill time; rows written from this
# release on capture the title at the time of the activity.
#
# Runs before the board FK exists (0121 adds it NOT VALID, 0122 validates
# it), so the UPDATE is not FK-checked row by row; 0122's single VALIDATE
# scan covers every row this wrote.
#
# Reverse is a no-op: the columns are dropped by reversing 0119.

from django.db import migrations
from django.db.models import OuterRef, Subquery

BATCH_SIZE = 5000


def backfill(apps, schema_editor):
    CardActivity = apps.get_model("boards", "CardActivity")
    Card = apps.get_model("boards", "Card")

    pending = CardActivity.objects.filter(board__isnull=True, card__isnull=False)
    card = Card.objects.filter(pk=OuterRef("card_id"))
    values = {
        "board_id": Subquery(card.values("board_id")[:1]),
        "card_uid": Subquery(card.values("uid")[:1]),
        "card_title": Subquery(card.values("title")[:1]),
    }

    first = pending.order_by("pk").values_list("pk", flat=True).first()
    if first is None:
        return
    cursor = first
    while True:
        # The first pk past this batch, or None on the last batch.
        boundary = (
            pending.filter(pk__gte=cursor)
            .order_by("pk")
            .values_list("pk", flat=True)[BATCH_SIZE:BATCH_SIZE + 1]
        )
        end = next(iter(boundary), None)
        batch = pending.filter(pk__gte=cursor)
        if end is not None:
            batch = batch.filter(pk__lt=end)
        batch.update(**values)
        if end is None:
            return
        cursor = end


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("boards", "0119_cardactivity_retention"),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
