"""
Extension points for enterprise add-ons.

Each list holds zero or more callables registered by enterprise code at
app startup (e.g. in an AppConfig.ready() method).  OSS code calls them at
specific hook sites; the lists are empty by default so OSS behaviour is
unchanged when the enterprise package is absent.

Stability guarantee (1.0+): hook signatures, names, and the *list* type
must not change in a minor/patch release. Enterprise code mutates these
lists in place via ``.append(...)`` — rebinding any module attribute
(e.g. ``hooks.MOVEMENT_EXPORT_BACKENDS = [...]`` or
``hooks.ANALYTICS_EXTENSIONS = [...]``) or converting to a tuple would
silently drop enterprise registrations (#820). This guarantee covers all
lists in this module. Any future change to a hook container type requires
a major version bump coordinated with the enterprise repository.
"""

# Movement history export hook (#342 / enterprise delivery-report feature).
# Callable signature: (board: Board, queryset: QuerySet, request: Request) -> HttpResponse
# Register via: from boards.hooks import MOVEMENT_EXPORT_BACKENDS
#               MOVEMENT_EXPORT_BACKENDS.append(my_exporter)
# The OSS movements view renders no export UI when this list is empty.
MOVEMENT_EXPORT_BACKENDS: list = []

# Analytics panel extension hook (enterprise advanced analytics feature).
# Callable signature: (board: Board, request: Request) -> dict
# Each callable returns a dict {"id": str, "title": str, "type": "stats" | "table",
# "description": str (optional), "data": {...}}. The payload shape per type is a public,
# additive-only contract: see docs/api/boards.md "Extension panel payload". A panel with
# no "type" (or an unknown one) is returned by the API but not rendered by the web UI.
#
# Minimum role (#1826, 1.2): declare who may see a panel with a ``min_role``
# attribute on the callable, one of "viewer", "collaborator", "member", "admin" or
# "site_admin" (the ladder in boards.invites.ROLE_RANK):
#               my_panel.min_role = "viewer"
# The summary is readable by every board member, viewers included. The view resolves
# the caller's board role once, the same role it authorized the request with (owner =
# admin, explicit membership, then group-inherited; can_access_all_content =
# site_admin), and drops every panel whose min_role ranks above it BEFORE calling
# any panel: a dropped callable is never invoked. FAIL CLOSED: no min_role (or None)
# means "admin", so a panel registered before 1.2 is admin-only until its author
# opts it in; an invalid value (unknown, miscased or not a string) is also treated
# as "admin" and logged. A bound method reads the attribute from its function; set
# it on the function or class, not on the bound method. A panel may still narrow
# what it returns by inspecting request.user, but it no longer has to gate access.
# Register via: from boards.hooks import ANALYTICS_EXTENSIONS
#               ANALYTICS_EXTENSIONS.append(my_panel)
# Every reader goes through boards.permissions.analytics_extensions_for_role(role);
# never iterate this list directly (Security Invariants Rule 12).
# The OSS summary endpoint returns an empty extension_panels list when this list is empty.
# Called from a read-only (GET) context — no transaction.on_commit wrapping.
ANALYTICS_EXTENSIONS: list = []

# Card lifecycle hook for enterprise audit-log and notification integrations.
# Callable signature: (event: str, card_id: int, board_id: int, actor_id: int | None) -> None
#
# These are *hook* event names, NOT WebSocket event names, and the two surfaces
# are deliberately not the same list (#1078). The WebSocket board-channel
# contract is the registry in ``boards.broadcast``; this list is the 1.0+
# enterprise extension contract and is frozen independently of it. They agree on
# five names and diverge on one:
#
#   hook event        WebSocket event     fired from
#   ---------------   -----------------   -------------------------------------
#   card.created      card.created        services.cards.create_card
#   card.updated      card.updated        services.cards.update_card
#   card.moved        card.moved          services.cards.move_card
#   card.deleted      card.deleted        services.cards.delete_card
#   card.archived     card.archived       services.cards.archive_card
#   card.restored     card.unarchived     services.cards.unarchive_card
#
# ``card.restored`` has no WebSocket counterpart under that name and never had
# one — do not "fix" it to card.unarchived, and do not add it to the WebSocket
# registry. Both strings are frozen (see test_card_mutation_hooks.py). The
# ws-event-reachability CI gate reads the WebSocket registry only, so nothing
# here is reachable from it; this table is the only place the mapping is stated.
#
# ``card.deleted`` hooks fire only from ``services.cards.delete_card``; admin
# card deletes and container cascades (a column, swimlane or board delete,
# #1615) fire no hook; consume the change feed to observe them.
#
# Register via: from boards.hooks import CARD_MUTATION_HOOKS
#               CARD_MUTATION_HOOKS.append(my_handler)
# Called inside transaction.on_commit — all related data is already committed when
# the handler fires. card_id / board_id are plain integers (not ORM instances) so
# handlers can safely issue their own DB queries without reference to a potentially
# stale Python object.
# A handler that raises is logged (name, ids, event, exception class — no payload)
# and swallowed: the write is already committed, so it must not 500 the request,
# and it never prevents later handlers from running (#1476).
# OSS behavior is unchanged when this list is empty: the on_commit callback is
# always registered and re-reads the list when it runs, so it calls nothing
# (#2009). A handler appended after the write but before the commit is called.
CARD_MUTATION_HOOKS: list = []

# Board template registration hook (#1115) — lets an installed package (e.g. an
# enterprise or other downstream add-on) register its own board templates
# without an OSS code change or a data migration in this repo.
# Callable signature: () -> list[dict]
# Each dict has the same shape as one entry of boards.templates.BOARD_TEMPLATES
# plus an explicit "slug" key (BOARD_TEMPLATES doesn't need one — its dict keys
# already are the slug; a provider returns free-standing dicts so it must
# include it):
#   {"slug": str, "name": str, "description": str, "icon": str,
#    "sort_order": int, "is_active": bool, "lane_label": str,
#    "lane_placeholder": str,
#    "columns": [{"name": str, "color": str, "is_done": bool}, ...]}
# Register via: from boards.hooks import TEMPLATE_PROVIDERS
#               TEMPLATE_PROVIDERS.append(my_provider)
# Consumed by boards.template_sync.sync_board_templates(), which runs at
# every `migrate` for the boards app (via a post_migrate signal connected in
# BoardsConfig.ready()) — see that module for the idempotent insert-only
# conflict policy. A provider callable that raises, or returns a dict with an
# already-registered slug, is skipped with a logged warning rather than
# failing the sync for every other provider or for the built-in templates —
# same defensive pattern as ANALYTICS_EXTENSIONS in boards/views/analytics.py.
# OSS behaviour (11 built-in templates, no others) is unchanged when this
# list is empty.
TEMPLATE_PROVIDERS: list = []

# Custom field value validation hook (#371).
# Callable signature: (definition: CustomFieldDefinition, value: str) -> str | None
# Called at the serializer boundary, once per submitted value, AFTER the built-in
# per-type validation and normalization have run — so `value` is already the
# normalized string that would be stored. A validator either:
#   * returns None (or the value unchanged) to accept it, or
#   * returns a replacement string to normalize it further, or
#   * raises django.core.exceptions.ValidationError to reject it, which the
#     serializer surfaces as a 400 on the `custom_field_values` field.
# Validators run in registration order and each sees the previous one's output.
# For a "multi_select" definition (#1391) `value` is the canonical JSON array
# string the built-in validation produced (e.g. '["EMEA","APAC"]', or "" to
# clear), never a Python list; a replacement must be a string of the same shape.
# After the last validator runs, a multi_select replacement is re-canonicalized
# (deduplicated, choice order, compact JSON) and re-checked against the
# 500-character cap; a replacement that is not a JSON array of strings is
# refused with a 400 rather than stored or silently dropped. The same applies to
# SWIMLANE_CUSTOM_FIELD_VALIDATORS below.
# Register via: from boards.hooks import CUSTOM_FIELD_VALIDATORS
#               CUSTOM_FIELD_VALIDATORS.append(my_validator)
# OSS behaviour is unchanged when this list is empty. Per the stability guarantee
# above, call sites must read the module attribute rather than a copy taken at
# import time, and must never rebind it.
CUSTOM_FIELD_VALIDATORS: list = []

# Swimlane (row) custom field value validation hook (#1140).
# Callable signature: (definition: SwimlaneCustomFieldDefinition, value: str) -> str | None
# The row-level counterpart to CUSTOM_FIELD_VALIDATORS above, with an identical
# contract: same call position (serializer boundary, after built-in per-type
# normalization), same accept / replace / raise semantics, same registration
# order rule, same read-the-module-attribute requirement.
#
# **Why a second list rather than reusing CUSTOM_FIELD_VALIDATORS**, given the
# two definition models are duck-type compatible for everything the built-in
# validation reads (`name`, `field_type`, `choices_json`):
#
# An already-registered validator was written against the signature above,
# where `definition` is always a CustomFieldDefinition. Feeding it a
# SwimlaneCustomFieldDefinition would work for a validator that only switches
# on `field_type`, and would raise AttributeError — surfacing as a 500 on a
# swimlane write — for one that reads a card-only attribute such as
# `show_on_card`, or that walks `definition.values` expecting CustomFieldValue
# rows. Those validators live in the enterprise repo, which this one cannot
# grep, so the failure could not be ruled out by inspection.
#
# This is the same reasoning, and the same resolution, as the separate
# `swimlane_custom_field_value_changed` signal in boards/signals.py: widening a
# published extension point in place is a silent break for consumers we cannot
# see, while a sibling hook makes adoption an explicit opt-in that breaks
# nothing that already exists. A validator that is genuinely generic across
# both levels is registered in both lists — one line, and deliberately visible.
#
# OSS behaviour is unchanged when this list is empty.
SWIMLANE_CUSTOM_FIELD_VALIDATORS: list = []

# Board change-feed nudge hook (#863).
# Callable signature: (board_id: int, event_type: str, event_id: int) -> None
#
# Fired once per persisted change-feed row (``boards.broadcast.persist_board_event``),
# so it covers every writer: ``record_board_event`` and every site that calls
# ``persist_board_event`` directly, bulk board import included (one call per row,
# so an import of thousands of cards makes thousands of calls).
#
# The contract:
#   * It is a NUDGE, not a delivery. The arguments are ids only and carry no
#     payload. A handler that wants the event reads it from the feed. A handler
#     that misses a call (process restart, exception) catches up from its own
#     cursor, so nothing is lost by a missed nudge.
#   * Readers MUST go through ``boards.services.feed.feed_queryset`` and
#     ``serialize_feed_rows`` with an explicit role and reader id, never
#     ``BoardEvent.data`` directly: the stored row is unredacted, and the feed's
#     two redaction layers are what keep it in line with the socket
#     (security-invariants Rules 8 and 10).
#   * Registered with ``transaction.on_commit(..., robust=True)``, so it fires
#     only after the row commits, and never for a rolled-back write.
#   * It runs SYNCHRONOUSLY on the committing request's thread, after commit.
#     No blocking I/O: an HTTP call here holds up the request that wrote the
#     row. Queue work and return.
#   * No ordering guarantee across rows: two transactions can commit in the
#     opposite order to their row ids (#2053), so a handler must not assume it
#     sees ids in increasing order. A handler that keeps a cursor must also
#     bound every read that moves it by ``boards.services.feed.feed_horizon``,
#     as the REST feed and the OSS dispatcher do. Without it, the cursor can
#     step past a lower id that commits a moment later. One exemption:
#     ``board.deleted`` draws its id without the writer lock (see
#     ``persist_board_event``), so the horizon does not cover it, and a cursor
#     can step past it when another event on that board commits first. No OSS
#     reader can see it (the REST feed answers 404 after the delete, webhooks
#     cascade and never take it); a handler that must see it should not treat
#     its feed position as proof it was not written.
#   * A handler that raises is logged (hook name, ids, exception class, no
#     payload) and swallowed; it never fails the request and never prevents the
#     next handler from running.
#
# OSS registers nothing here; the OSS webhook dispatcher polls the feed on its
# own schedule. Stable for 1.x, append-only, pinned by
# boards/tests/test_board_event_hooks.py.
# Register via: from boards.hooks import BOARD_EVENT_HOOKS
#               BOARD_EVENT_HOOKS.append(my_nudge)
BOARD_EVENT_HOOKS: list = []
