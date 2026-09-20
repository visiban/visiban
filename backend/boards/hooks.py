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
# Each callable returns a dict with at minimum {"id": str, "title": str, "data": any}.
# Register via: from boards.hooks import ANALYTICS_EXTENSIONS
#               ANALYTICS_EXTENSIONS.append(my_panel)
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
# Register via: from boards.hooks import CARD_MUTATION_HOOKS
#               CARD_MUTATION_HOOKS.append(my_handler)
# Called inside transaction.on_commit — all related data is already committed when
# the handler fires. card_id / board_id are plain integers (not ORM instances) so
# handlers can safely issue their own DB queries without reference to a potentially
# stale Python object.
# OSS behaviour is unchanged when this list is empty (the check is guarded by
# ``if hooks.CARD_MUTATION_HOOKS:`` at each call site).
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
# Register via: from boards.hooks import CUSTOM_FIELD_VALIDATORS
#               CUSTOM_FIELD_VALIDATORS.append(my_validator)
# OSS behaviour is unchanged when this list is empty. Per the stability guarantee
# above, call sites must read the module attribute rather than a copy taken at
# import time, and must never rebind it.
CUSTOM_FIELD_VALIDATORS: list = []
