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
# Event values: "card.created", "card.updated", "card.moved", "card.deleted",
#               "card.archived", "card.restored"
# Register via: from boards.hooks import CARD_MUTATION_HOOKS
#               CARD_MUTATION_HOOKS.append(my_handler)
# Called inside transaction.on_commit — all related data is already committed when
# the handler fires. card_id / board_id are plain integers (not ORM instances) so
# handlers can safely issue their own DB queries without reference to a potentially
# stale Python object.
# OSS behaviour is unchanged when this list is empty (the check is guarded by
# ``if hooks.CARD_MUTATION_HOOKS:`` at each call site).
CARD_MUTATION_HOOKS: list = []
