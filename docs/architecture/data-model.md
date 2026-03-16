# Data Model

## Core entities

```
User
 ├── is_site_admin (bool)
 ├── must_change_password (bool)
 ├── timezone (str)
 ├── date_format (str)
 ├── time_format (str)
 └── number_locale (str)

Group
 ├── owner → User
 ├── parent → Group (nullable — null = top-level)
 ├── GroupMembership → User  (role: admin | member | collaborator | viewer)
 ├── GroupInviteLink  (name, token, role, expires_at)
 └── GroupFavorite → User  (unique per user+group)

Board
 ├── uid  (16-char hex, unique, read-only)
 ├── owner → User
 ├── group → Group (nullable — null = personal board)
 ├── BoardMembership → User  (role: admin | member | collaborator | viewer)
 ├── BoardFavorite → User  (unique per user+board)
 ├── Column  (uid, position, color, wip_limit, weight_limit, allow_card_creation)
 ├── Swimlane  (uid, position, color, is_collapsed)
 └── Label  (uid, name, color)

Card
 ├── uid  (16-char hex, unique, read-only)
 ├── board → Board
 ├── column → Column
 ├── swimlane → Swimlane
 ├── assignee → User (nullable)
 ├── labels → Label (M2M)
 ├── CardMovement  (from/to column + swimlane FKs + UIDs + names, moved_by, moved_at)
 ├── CardComment  (author, body)
 ├── CardActivity  (event_type, from_value, to_value, actor)
 ├── CardChecklist  (text, is_checked, position)
 └── CardAttachment  (file, filename, size, uploaded_by)
```

## Key design decisions

**CardMovement is append-only.** Every time a card changes column or swimlane a new `CardMovement` row is created. Records are never updated or deleted, providing a full audit trail.

**BoardMembership is explicit per board.** A user can have different roles on different boards. Group membership is inherited automatically (see [Group Inheritance](../features/rbac/inheritance.md)) but can be overridden by an explicit `BoardMembership` row.

**Column positions use a two-pass update.** To avoid `unique_together(board, position)` conflicts when reordering, columns are first shifted to high temporary positions, then assigned final positions.

**Card positions are per-cell.** Position is scoped to `(board, column, swimlane)`. When a card moves cells, siblings in both source and target cells are renumbered.

**UIDs are stable external identifiers.** Boards, columns, swimlanes, labels, and cards each carry a `uid` field — a 16-character random hex string assigned at creation and never changed or reused. UIDs survive renames and are preserved in `CardMovement` records even after the referenced column or swimlane is deleted. They are intended as the canonical key for integrations and webhooks that need to reference Visiban objects durably. See [Stable UIDs](../features/stable-uids.md).
