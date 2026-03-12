# Data Model

## Core entities

```
User
 ├── is_site_admin (bool)
 └── must_change_password (bool)

Group
 ├── owner → User
 ├── parent → Group (nullable — null = top-level)
 ├── GroupMembership → User  (role: admin | member)
 └── GroupInviteLink

Board
 ├── owner → User
 ├── group → Group (nullable — null = personal board)
 ├── BoardMembership → User  (role: admin | member | collaborator | viewer)
 ├── Column  (position, color, wip_limit, weight_limit, allow_card_creation)
 ├── Swimlane  (position, color, is_collapsed)
 └── Label  (name, color)

Card
 ├── board → Board
 ├── column → Column
 ├── swimlane → Swimlane
 ├── assignee → User (nullable)
 ├── labels → Label (M2M)
 ├── CardMovement  (from/to column + swimlane, moved_by, moved_at)
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
