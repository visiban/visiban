# Field Enforcement

Some API fields read as rules rather than values: `wip_limit`, `allowed_priorities`, `default_board_member_role`, `is_required`. A client that reads one of them will assume the server enforces it. Since 1.2 some of those clients are AI agents talking to the [MCP server](../features/mcp-server.md), and an agent cannot notice that a rule is only advisory. It reads the schema and acts on it.

This page classifies every constraint-shaped field in the OSS models and serializers, and records what each one actually binds. *Added in 1.2 (#1077).*

## The three classes

| Class | Meaning |
|---|---|
| **Binding** | The server rejects or filters on it. Where a write path skips the check, the gap is listed below with a tracking issue |
| **Advisory** | Stored and returned, and may shape a default or the UI, but no write is ever rejected for violating it |
| **Scaffold** | Stored and editable, but no code path reads it yet |

Any field that is not binding on every write path says so in its OpenAPI description, starting with the token `Enforcement: binding`, `Enforcement: advisory`, or `Enforcement: scaffold`. The strings live in `backend/visiban/field_enforcement.py` and are attached at the serializer layer. `backend/boards/tests/test_field_enforcement_schema.py` checks that every string starts with its token and pins it to every schema component that carries the field.

Out of scope: enterprise code, env-var settings, and plain values that do not read as rules, such as `name`, `color`, `position`, `card_density`, or `staleness_threshold_days`. `Board.show_wip_at_limit` is display-only, and its description already says so.

## Gaps and scaffolds

These fields are the reason this page exists. Each gap and scaffold has a tracking issue; the `Card.version` row is by design.

| Field | Class | What it promises | What actually happens | Tracking |
|---|---|---|---|---|
| `Column.wip_limit` | Binding (move only) | At most N active cards in the column | Checked only by `POST /cards/{id}/move/` (`services/cards.py` `move_card`). Card create, restore from archive, board import, and saving a card in the Django admin (`CardAdmin.save_model`) do not check it, even with `enforce_wip_hard` on | #1428 |
| `Column.weight_limit` | Binding (move only) | Column weight stays within budget | Same as `wip_limit` (including the Django admin), and raising a card's `weight` with PATCH is not checked either | #1428 |
| `Board.enforce_wip_limits` | Binding (move only) | Over-limit placement returns 409 | Applies to moves only, for the same reason | #1428 |
| `Board.enforce_wip_hard` | Binding (move only) | No role can exceed a WIP limit | No role can *move* a card past it. Any member can still create a card in a full column or restore one into it | #1428 |
| `Board.enforce_weight_limits` | Binding (move only) | Over-budget placement returns 409 | Applies to moves only | #1428 |
| `Board.allowed_priorities` | Scaffold | Cards on this board use only the listed priorities | Validated as a list when written, then never read. Card create and update accept any priority, and no UI filters by it | #1429 |
| `Group.allowed_priorities` | Advisory | Restricts priorities on the group's boards | Copied onto `Board.allowed_priorities` when a board is created through `POST /groups/{id}/boards/`, where it is itself a scaffold | #1429 |
| `Group.default_board_member_role` | Scaffold | Role group members get on new boards | Stored, editable in the group's Settings tab, never read. Group members' board access comes from their `GroupMembership.role` through `get_board_role()` | #1430 |
| `CustomFieldDefinition.is_required` | Scaffold | A card must have a value | Not enforced. Already documented in [Custom Fields](../features/custom-fields.md) | #1433 |
| `SwimlaneCustomFieldDefinition.is_required` | Scaffold | A swimlane must have a value | Not enforced | #1433 |
| `Card.version` | Binding (opt-in, move only) | Optimistic concurrency guard | Checked only when a client sends it back as `version` on the move endpoint. PATCH and PUT do not accept or check it. This is by design, and the schema says so | — |

## Binding fields

Classified from a review of the code on 2026-10-04; see the tracking issues for known gaps. Each row names where the main check lives.

| Field | Enforced at | Notes |
|---|---|---|
| `Column.allow_card_creation` | `create_card()` in `boards/services/cards.py` (REST and MCP) | Board import creates cards directly, which is expected because import builds the board. Creating a card in the Django admin (`CardAdmin.save_model`) skips the check, along with the rest of the card service (see [Service Layer](service-layer.md)); tracked in #1428 |
| `Column.is_done` | Cycle-time and throughput analytics | Shapes metrics only. It is not a write rule and does not read as one |
| `BoardMembership.role` | `get_board_role()` / `get_board_roles()` in `boards/permissions.py`, shared by REST, WebSocket, and MCP | The per-action matrix is in [Permissions](../features/permissions.md) |
| `BoardMembership.is_moderator` | `can_modify_others_content()` in `boards/permissions.py`, called by the card service and the comment, attachment, and checklist views | Field visibility on `member.*` events is gated separately by `moderator_field_visible()` |
| `GroupMembership.role` | Inherited into board roles through `get_board_role()` (nearest ancestor wins; explicit board membership overrides) | — |
| `Board.share_token_expires_at` | `boards/views/share.py` returns `410 Gone` after expiry | — |
| `CustomFieldDefinition.show_on_card` (max 2), `SwimlaneCustomFieldDefinition.show_on_row` (max 3) | Serializer validation | — |
| `SwimlaneCustomFieldDefinition.is_admin_only` | Read filter in `SwimlaneSerializer` / `SwimlaneAdminSerializer`, REST and broadcast payloads | — |
| `SiteSetting.registration_mode` | `RegistrationAdapter` and `SocialRegistrationAdapter.is_open_for_signup` in `accounts/adapter.py` | Covers password and social signup |
| `SiteSetting.uploads_enabled` | Card attachment upload (`boards/views/cards.py`) | Scoped to attachments, as its description says. Board import (JSON, CSV, Trello) also takes a multipart file and does not consult it |
| `SiteSetting.maintenance_mode` | `MaintenanceModeMiddleware`, plus `_require_maintenance_off()` for `/mcp` | — |
| `User.is_site_admin` | `IsSiteAdmin` in `accounts/permissions.py`, which gates `/api/admin/*`; also exempts the user from the maintenance-mode write block | Binding only for the admin surface. It does **not** grant board or group access (`boards/permissions.py` `get_board_role`); that is `can_access_all_content` |
| `User.is_superuser`, `User.is_staff` | Django built-ins, not exposed by any API serializer | `is_staff` gates only the Django admin site. Setting `is_superuser` also sets `is_site_admin` (`accounts/signals.py`) |
| `User.can_access_all_content` | Board and group access helpers, WebSocket consumer, MCP tools | — |
| `User.notif_*`, `User.email_notif_*` | Notification dispatch (`boards/notifications_email.py`, `boards/signals.py`, the `notify_*` management commands) | — |
| `InviteLink.expires_at`, `single_use`, `revoked_at` | `accounts/invite_utils.py`, consumed atomically at registration | — |
| `GroupInviteLink.is_active`, `expires_at`, `single_use` | Group invite lookup and join in `groups/views.py` | — |
| `PersonalAccessToken.expires_at`, `scopes` | `accounts/authentication.py` (REST) and `mcp_server/auth.py` (`mcp:*` scopes) | — |

## Fields that do not exist

One candidate named in #1077 needed no classification:

- **`Column.automation_skip`** was proposed in #201 and never landed. When it does, it must ship either binding or with an `Enforcement: scaffold` description.

## Keeping this page true

- **New constraint-shaped field:** it ships binding on every path, or it ships with an `Enforcement:` description in `backend/visiban/field_enforcement.py`, a row on this page, and a tracking issue.
- **Closing a gap:** update the description constant, this page, and the behavioral pin in `test_field_enforcement_schema.py` (`WipGapBehaviorTests` fails on purpose once the WIP gap is fixed) in the same MR.
- **Put descriptions on the serializer, not the model.** A model `help_text` change generates an `AlterField` migration for what is a documentation-only change.
