"""Health status change history (#2242): the one writer of history rows.

Every write of a board's or group's ``health_status`` that should be
attributed goes through :func:`record_health_change`. It appends one history
row and updates the entity's denormalized last-change columns
(``health_status_changed_at`` / ``_by`` / ``_note``) in the caller's
transaction.

Callers hold the entity's row lock (``lock_board_row_or_404`` for a board,
``recheck_parent_under_lock`` for a group) and pass ``from_status`` read from
the locked, refreshed row, so two concurrent writers record a consistent
from -> to chain. There is no model ``save()`` hook and no signal on purpose:
a write that bypasses the service (shell, data migration) is not attributed
to anyone, rather than attributed to the wrong person.

Reconfirm rule (owner decision, 2026-11-14): only the explicit "Confirm
status" action (``POST .../health-status/``) records a row with
``from_status == to_status`` or carries a note. Every other writer (PATCH,
PUT, create, Django admin) calls this only when the value changed, with no
note; :func:`record_if_changed` encodes that.

This module imports nothing from ``boards``: the board caller passes its own
history model (``boards`` imports ``groups``, never the reverse).
"""

from __future__ import annotations

from django.utils import timezone

from .health import valid_health_status

#: Most rows ``GET .../health-history/`` returns. Display cap only: rows are
#: kept until the entity is deleted (they cascade with it).
HEALTH_HISTORY_LIMIT = 20


def record_health_change(entity, *, change_model, from_status, to_status, user, note=None):
    """Append one history row for ``entity`` and update its last-change columns.

    ``change_model`` is the concrete history model (``GroupHealthChange`` or
    ``boards.BoardHealthChange``); its FK to the entity is the field named after
    the entity's model. ``user`` may be ``None`` (system change, #2245). Writes
    ``health_status`` too, so the POST action needs no separate save; the
    PATCH path passes the value its serializer just saved. Uses a queryset
    ``update()`` so no ``save()`` side effect (``auto_now``, signals) runs.
    """
    user = user if getattr(user, "is_authenticated", False) else None
    now = timezone.now()
    entity_field = entity._meta.model_name
    change = change_model.objects.create(
        **{entity_field: entity},
        from_status=from_status,
        to_status=to_status,
        changed_by=user,
        changed_at=now,
        note=note,
    )
    values = {
        "health_status": to_status,
        "health_status_changed_at": now,
        "health_status_changed_by": user,
        "health_status_note": note,
    }
    type(entity).objects.filter(pk=entity.pk).update(**values)
    for name, value in values.items():
        setattr(entity, name, value)
    return change


def record_if_changed(entity, *, change_model, from_status, user):
    """Record a change from ``from_status`` to ``entity.health_status`` if they differ.

    For the generic writers (PATCH/PUT/create/admin): same value means no row
    and no timestamp refresh; only the explicit action reconfirms. Unknown
    stored strings compare as unset (``valid_health_status``), matching how
    the resolver reads them.
    """
    before = valid_health_status(from_status)
    after = valid_health_status(entity.health_status)
    if before == after:
        return None
    return record_health_change(
        entity, change_model=change_model, from_status=before, to_status=after, user=user,
    )


def history_page(queryset):
    """``(rows, has_more)`` for the newest ``HEALTH_HISTORY_LIMIT`` rows, in one query."""
    rows = list(
        queryset.select_related("changed_by").order_by("-changed_at", "-id")[: HEALTH_HISTORY_LIMIT + 1]
    )
    return rows[:HEALTH_HISTORY_LIMIT], len(rows) > HEALTH_HISTORY_LIMIT
