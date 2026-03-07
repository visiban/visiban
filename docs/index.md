# Visiban

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. Lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

## Highlights

- **Swimlanes** — rows represent entities (customers, projects, teams); columns are pipeline stages
- **Movement history** — every drag logs from/to column, from/to swimlane, who moved it, and when
- **Real-time updates** — board state syncs live across all open tabs via WebSocket (Django Channels + Redis)
- **Analytics** — summary view (card counts, velocity) and analytics view (dwell time, bottlenecks, stalled cards)
- **Notifications** — assignee alerts on card assignment; staleness alerts when cards haven't moved in N days
- **Groups** — organize boards into groups and sub-groups with inherited membership
- **RBAC** — five roles with fine-grained per-board and per-group permissions
- **OAuth** — Google, GitHub, and GitLab login out of the box

## Quick links

| | |
|---|---|
| [Installation](getting-started/installation.md) | Get up and running with Docker or locally |
| [First Boot](getting-started/first-boot.md) | Bootstrap your first site admin |
| [Roles & Permissions](rbac/roles.md) | Understand who can do what |
| [Analytics](features/analytics.md) | Summary, velocity, and bottleneck views |
| [Notifications](features/notifications.md) | Assignment and staleness alerts |
| [Real-time Updates](features/realtime.md) | WebSocket live sync |
| [API Reference](api/boards.md) | Full endpoint documentation |
