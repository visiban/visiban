---
title: "Visiban"
---

:::caution[Release candidate]
**1.1.0-rc.3** is the current stable release candidate for the upcoming 1.1 release. Help test it and [report issues](https://gitlab.com/visiban/visiban/-/issues) before the stable release. See the [installation guide](/v1.1/getting-started/installation/) to get started.
:::

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. A lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

## Highlights

- **Swimlanes** — rows represent entities (customers, projects, teams); columns are pipeline stages
- **Movement history** — every drag logs from/to column, from/to swimlane, who moved it, and when; board-level History tab with search and filters
- **Real-time updates** — board state syncs live across all open tabs via WebSocket (Django Channels + Redis)
- **Analytics** — summary view (card counts, velocity) and analytics view (dwell time, bottlenecks, stalled cards)
- **Board sharing** — generate a read-only public link; anyone with the URL can view the board without logging in
- **Saved filters** — save and restore filter presets per board; private to each user
- **Notifications** — assignee alerts on card assignment; @mention alerts; staleness alerts when cards haven't moved in N days
- **Groups** — organize boards into groups and sub-groups with inherited membership
- **RBAC** — five roles with fine-grained per-board and per-group permissions; moderator entitlement for content moderation
- **OAuth & OIDC** — Google, GitHub, and GitLab login out of the box; connect any OIDC provider via environment variables
- **Personal access tokens** — token-based API access for scripts and integrations
- **Invite links** — shareable URLs with configurable role, expiry, and single-use options
- **Production-ready** — Nginx reverse proxy with flexible TLS (`letsencrypt`, `selfsigned`, or `none`) via `docker-compose.prod.yml` and `init-prod.sh`

## Quick links

| | |
|---|---|
| [Installation](/v1.1/getting-started/installation/) | Get up and running with Docker or locally |
| [First Boot](/v1.1/getting-started/first-boot/) | Bootstrap your first site admin |
| [Roles & Permissions](https://docs.visiban.com/v1.1/features/rbac/roles/) | Understand who can do what |
| [Analytics](https://docs.visiban.com/v1.1/features/analytics/) | Summary, velocity, and bottleneck views |
| [Notifications](https://docs.visiban.com/v1.1/features/notifications/) | Assignment and staleness alerts |
| [Real-time Updates](https://docs.visiban.com/v1.1/features/realtime/) | WebSocket live sync |
| [CI/CD Pipeline](https://docs.visiban.com/v1.1/architecture/overview/#cicd-pipeline) | Build verification and testing in GitLab CI |
| [Board Sharing](https://docs.visiban.com/v1.1/features/board/#board-sharing) | Public read-only share links |
| [Personal Access Tokens](https://docs.visiban.com/v1.1/features/personal-access-tokens/) | Token-based API access |
| [API Reference](https://docs.visiban.com/v1.1/api/boards/) | Full endpoint documentation |
