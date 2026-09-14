"""Idempotent sync of board templates into the BoardTemplate table.

Consolidates the two historical sources of truth for board templates — the
``BOARD_TEMPLATES`` dict (previously read directly by column-creation code)
and the ``BoardTemplate`` table (read by the list endpoint) — into one: this
module is the only writer of BoardTemplate rows outside the Django admin.
``BoardViewSet.perform_create``, ``GroupViewSet.boards()``, and
``BoardTemplateListView`` all read the table exclusively (#1115).

``sync_board_templates()`` runs at two points, both idempotent and safe to
repeat:

1. Indirectly, via ``boards/migrations/0023_seed_board_templates.py`` and
   ``0029_seed_board_templates_v2.py``, which seed the 11 built-in templates
   using the same insert-only pattern (this module didn't exist yet when
   those were written, so they inline their own literal data — see
   ``boards/migrations/0054_fix_board_template_drift.py`` for why a later
   migration corrects two of them rather than editing history in place).
2. At every ``manage.py migrate`` for the ``boards`` app, via a
   ``post_migrate`` signal connected in ``BoardsConfig.ready()`` — this is
   what actually makes ``boards.hooks.TEMPLATE_PROVIDERS`` useful: an
   installed package registers a provider in its own ``AppConfig.ready()``
   (which Django guarantees runs before any ``post_migrate`` signal fires),
   and the next ``migrate`` inserts its templates with no OSS-side migration
   required.

Conflict policy: a slug is only ever inserted, never updated. If a row for a
slug already exists — from an earlier release's migration, from a previous
sync run, or because two providers raced on the same slug — this function
leaves it untouched and logs nothing (the collision is silent by design,
same as ``get_or_create``). To change a built-in template's columns for
existing installs, ship a new migration that updates that slug explicitly
(see ``0029`` and ``0054`` for the pattern) — sync only fills gaps, it never
reconciles drift after the fact. A provider wanting to change its own
previously-registered template must do the same: ship its own migration (or
management command) that updates the row by slug.

A provider callable that raises is logged and skipped — same defensive
pattern as ``ANALYTICS_EXTENSIONS`` in ``boards/views/analytics.py`` — so one
misbehaving provider cannot fail ``migrate`` for the whole app.
"""

import logging

logger = logging.getLogger(__name__)


def _row_from_seed(slug, data):
    """Build a BoardTemplate field dict from one BOARD_TEMPLATES-shaped entry.

    Raises KeyError/TypeError on malformed input — callers are responsible
    for catching and skipping (see iter_seed_rows()); the built-in
    BOARD_TEMPLATES entries are trusted and never hit that path.
    """
    return {
        "slug": slug,
        "name": data["name"],
        "description": data.get("description", ""),
        "icon": data.get("icon", ""),
        "lane_label": data.get("lane_label", ""),
        "lane_placeholder": data.get("lane_placeholder", ""),
        "columns_json": data.get("columns", []),
        "sort_order": data.get("sort_order", 0),
        "is_active": data.get("is_active", True),
    }


def iter_seed_rows():
    """Yield (slug, row_dict) for every built-in template, then every
    boards.hooks.TEMPLATE_PROVIDERS entry (built-ins first, so a provider can
    never race a built-in slug into existing first — though get_or_create is
    atomic per row regardless of ordering)."""
    from .templates import BOARD_TEMPLATES

    for slug, data in BOARD_TEMPLATES.items():
        yield slug, _row_from_seed(slug, data)

    from .hooks import TEMPLATE_PROVIDERS

    for provider in TEMPLATE_PROVIDERS:
        try:
            entries = provider() or []
        except Exception:
            logger.warning("TEMPLATE_PROVIDERS callable %r raised an exception", provider, exc_info=True)
            continue
        for entry in entries:
            entry = dict(entry)
            # Guard the whole per-entry conversion, not just the "slug" pop —
            # a provider entry missing any other required key (e.g. "name")
            # must be skipped the same way, not abort every remaining
            # template/provider in this sync pass (the module docstring
            # promises "one misbehaving provider cannot fail migrate for the
            # whole app"; that has to hold per-entry, not just per-provider).
            try:
                slug = entry.pop("slug")
                row = _row_from_seed(slug, entry)
            except (KeyError, TypeError):
                logger.warning(
                    "TEMPLATE_PROVIDERS callable %r returned a malformed entry: %r", provider, entry, exc_info=True,
                )
                continue
            yield slug, row


def sync_board_templates(model=None):
    """Insert any BoardTemplate rows that don't exist yet. Never updates an
    existing row — see the module docstring for the conflict policy.

    ``model`` lets a migration pass the historical model from
    ``apps.get_model("boards", "BoardTemplate")`` instead of importing the
    live model (required inside a RunPython operation). Defaults to the live
    ``BoardTemplate`` model for the post_migrate-signal call site.
    """
    if model is None:
        from .models import BoardTemplate as model

    for slug, row in iter_seed_rows():
        # Guarded per-slug: a single bad row (oversized field, wrong type —
        # most plausible from a provider, but a hand-edited admin row could
        # do it too) must not abort the sync for every other template.
        try:
            model.objects.get_or_create(slug=slug, defaults=row)
        except Exception:
            logger.warning("Could not sync BoardTemplate row for slug %r", slug, exc_info=True)
