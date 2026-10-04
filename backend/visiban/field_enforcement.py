"""OpenAPI descriptions for constraint-shaped fields that do not bind everywhere (#1077).

A field whose name reads as a rule (``wip_limit``, ``allowed_priorities``,
``default_board_member_role``) is a promise to every API client, and since 1.2
that includes AI agents talking to the MCP server. If the server does not keep
the promise on every write path, the schema has to say so, because nothing else
an agent reads will.

Every string here starts with ``Enforcement: <class>`` so a client (or a test)
can tell the three classes apart without parsing prose:

* ``binding`` -- enforced, but the description names the paths it covers
  because at least one write path skips it (each gap has a tracking issue).
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
    "Enforcement: binding on the card move endpoint only. Maximum number of "
    "active (non-archived) cards in this column; null means unlimited. A move "
    "into a column at its limit returns 409 when the board's enforce_wip_limits "
    "or enforce_wip_hard is on. Creating a card in the column, restoring an "
    "archived card into it, and board import do NOT check this limit, so a "
    "column can hold more cards than wip_limit."
)

COLUMN_WEIGHT_LIMIT = (
    "Enforcement: binding on the card move endpoint only. Maximum total weight "
    "of active (non-archived) cards in this column; null means unlimited. A "
    "move that would exceed it returns 409 when the board's "
    "enforce_weight_limits is on. Creating a card in the column, restoring an "
    "archived card into it, raising a card's weight with PATCH, and board "
    "import do NOT check this limit."
)

# -- Board -------------------------------------------------------------------

BOARD_ENFORCE_WIP_LIMITS = (
    "Enforcement: binding on the card move endpoint only. When true, moving a "
    "card into a column at or over its wip_limit is blocked with 409; board "
    "admins can override with ?force=true. Card creation, restore from "
    "archive, and board import are not checked."
)

BOARD_ENFORCE_WIP_HARD = (
    "Enforcement: binding on the card move endpoint only. When true, WIP limits "
    "become a hard stop on moves for every role, including board admins; no "
    "override is possible. Active regardless of enforce_wip_limits. Card "
    "creation, restore from archive, and board import are not checked, so a "
    "column can still exceed its limit through those paths."
)

BOARD_ENFORCE_WEIGHT_LIMITS = (
    "Enforcement: binding on the card move endpoint only. When true, moving a "
    "card into a column that would exceed its weight_limit is blocked with "
    "409; board admins can override with ?force=true. Card creation, restore "
    "from archive, weight changes via PATCH, and board import are not checked."
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
    "Group members' access to the group's boards comes from their group "
    "membership role, not from this value."
)
