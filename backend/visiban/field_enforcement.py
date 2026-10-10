"""OpenAPI descriptions for constraint-shaped fields that do not bind everywhere (#1077).

A field whose name reads as a rule (``wip_limit``, ``allowed_priorities``,
``default_board_member_role``) is a promise to every API client, and since 1.2
that includes AI agents talking to the MCP server. If the server does not keep
the promise on every write path, the schema has to say so, because nothing else
an agent reads will.

Every string here starts with ``Enforcement: <class>`` so a client (or a test)
can tell the three classes apart without parsing prose:

* ``binding`` -- enforced, but the description names the paths it covers
  because at least one write path skips it (each gap has a tracking issue,
  or is a documented by-design exemption such as board import for the
  WIP/weight limits, #1428).
* ``advisory`` -- stored and surfaced, but no write is ever rejected for
  violating it.
* ``scaffold`` -- stored and editable, but no code path consumes it yet.

The full classification, including the fields that are binding everywhere, lives
in ``docs/architecture/field-enforcement.md``. Update both together.

These strings are attached at the **serializer** layer, never as model
``help_text``: a model ``help_text`` change emits an ``AlterField`` migration
for what is a documentation-only change.
"""

# -- Column ------------------------------------------------------------------

COLUMN_WIP_LIMIT = (
    "Enforcement: binding on every API card write path except board import. "
    "Maximum number of active (non-archived) cards in this column; null means "
    "unlimited. Moving a card into the column, creating a card in it, and "
    "restoring an archived card into it return 409 at the limit when the "
    "board's enforce_wip_limits or enforce_wip_hard is on. Board import (JSON, "
    "CSV, Trello) restores a board as exported and is not checked, so an "
    "imported column can hold more cards than wip_limit."
)

COLUMN_WEIGHT_LIMIT = (
    "Enforcement: binding on every API card write path except board import. "
    "Maximum total weight of active (non-archived) cards in this column; null "
    "means unlimited. Moving or restoring a card into the column, creating a "
    "card in it, and raising a card's weight with PATCH return 409 when the "
    "total would exceed it and the board's enforce_weight_limits is on. "
    "Lowering a weight is never blocked. Board import is not checked."
)

# -- Board -------------------------------------------------------------------

BOARD_ENFORCE_WIP_LIMITS = (
    "Enforcement: binding on every API card write path except board import. When "
    "true, moving, creating or restoring a card into a column at or over its "
    "wip_limit is blocked with 409; board admins can override with "
    "?force=true. Board import is not checked."
)

BOARD_ENFORCE_WIP_HARD = (
    "Enforcement: binding on every API card write path except board import. When "
    "true, WIP limits become a hard stop for every role, including board "
    "admins, on card move, create and restore; no override is possible. "
    "Active regardless of enforce_wip_limits. Board import restores a board as "
    "exported and is not checked."
)

BOARD_ENFORCE_WEIGHT_LIMITS = (
    "Enforcement: binding on every API card write path except board import. When "
    "true, moving, creating or restoring a card, or raising its weight with "
    "PATCH, so that a column would exceed its weight_limit is blocked with "
    "409; board admins can override with ?force=true. Board import is not "
    "checked."
)

BOARD_ALLOWED_PRIORITIES = (
    "Enforcement: scaffold -- stored and returned, but not enforced. Card "
    "create and update accept any priority regardless of this list, and no "
    "client filters the priority picker by it. An empty list is intended to "
    "mean all priorities are allowed."
)

# -- Card --------------------------------------------------------------------

CARD_VERSION = (
    "Enforcement: binding only when a client sends it back as `version` on the "
    "card move endpoint (409 version_conflict on mismatch). PATCH/PUT do not "
    "accept or check it. Optimistic concurrency counter; increments on every "
    "card mutation."
)

# -- Custom field definitions ------------------------------------------------
# The model help_text already says "Declared but NOT enforced in v1"; these
# restate it with the class token without touching the model (no migration).

CUSTOM_FIELD_IS_REQUIRED = (
    "Enforcement: scaffold -- stored and returned, but not enforced. A card "
    "write that leaves this field empty is accepted. Enforcing it later would "
    "turn currently valid card writes into 400s, so it will ship with a "
    "release note."
)

SWIMLANE_CUSTOM_FIELD_IS_REQUIRED = (
    "Enforcement: scaffold -- stored and returned, but not enforced. A "
    "swimlane write that leaves this field empty is accepted. Enforcing it "
    "later would turn currently valid swimlane writes into 400s, so it will "
    "ship with a release note."
)

# -- Group -------------------------------------------------------------------

GROUP_ALLOWED_PRIORITIES = (
    "Enforcement: advisory -- copied onto a board's allowed_priorities when the "
    "board is created through the group's boards endpoint, and not consulted "
    "afterwards. The board-level field it seeds is itself not enforced, so "
    "this does not restrict card priorities."
)

GROUP_DEFAULT_BOARD_MEMBER_ROLE = (
    "Enforcement: scaffold -- stored and editable, but no code path reads it. "
    "Deprecated (#1430): this field has no effect and is kept only for API "
    "compatibility. Group members get their group membership role on every "
    "group board, not this value."
)
