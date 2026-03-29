"""Resolve case-insensitive username collisions.

Groups users by LOWER(username). Within each collision group, the winner is
the user with the most recent last_login (NULL last_login always loses;
ties break by lowest PK). Losers get username = _rename_{pk} and
must_change_username = True.

This migration is idempotent — re-running it on a database with no collisions
is a no-op.
"""

import logging

from django.db import migrations
from django.db.models import Count
from django.db.models.functions import Lower

logger = logging.getLogger(__name__)


def resolve_collisions(apps, schema_editor):
    User = apps.get_model("accounts", "User")

    # Find usernames that collide case-insensitively.
    collisions = (
        User.objects.values(lower_username=Lower("username"))
        .annotate(cnt=Count("id"))
        .filter(cnt__gt=1)
    )

    for group in collisions:
        lower = group["lower_username"]
        users = list(
            User.objects.filter(username__iexact=lower).order_by(
                # NULL last_login sorts last (loses); most recent first wins.
                "-last_login",
                "pk",
            )
        )

        # Sort: non-null last_login descending first, then null last_login by PK.
        with_login = [u for u in users if u.last_login is not None]
        without_login = [u for u in users if u.last_login is None]
        with_login.sort(key=lambda u: u.last_login, reverse=True)
        without_login.sort(key=lambda u: u.pk)
        ordered = with_login + without_login

        winner = ordered[0]
        losers = ordered[1:]

        logger.info(
            "CI username collision '%s': winner pk=%d (username=%s, last_login=%s)",
            lower,
            winner.pk,
            winner.username,
            winner.last_login,
        )

        for loser in losers:
            old_username = loser.username
            loser.username = f"_rename_{loser.pk}"
            loser.must_change_username = True
            loser.save(update_fields=["username", "must_change_username"])
            logger.info(
                "  loser pk=%d renamed '%s' -> '%s' (last_login=%s)",
                loser.pk,
                old_username,
                loser.username,
                loser.last_login,
            )


def noop_reverse(apps, schema_editor):
    # Reverse is a no-op — we cannot restore original usernames.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0019_user_must_change_username"),
    ]

    operations = [
        migrations.RunPython(resolve_collisions, noop_reverse),
    ]
