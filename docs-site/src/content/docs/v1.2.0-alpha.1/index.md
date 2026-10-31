---
title: "Visiban"
---

:::caution[Pre-release]
**1.2.0-alpha.1** is a pre-release development build of the upcoming release — expect bugs and breaking changes. [Report issues](https://gitlab.com/visiban/visiban/-/issues) or see the [installation guide](/v1.2.0-alpha.1/getting-started/installation/) if you want to try it early.
:::

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. A lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

**In one line: kill the spreadsheet, visualize the workflow, interrogate it with your own AI — every move on the record.** Rows are entities with typed fields of their own, so the data that used to live in a side-spreadsheet lives on the board. Every card movement is recorded permanently. And a first-class [MCP server](https://docs.visiban.com/v1.2.0-alpha.1/features/mcp-server/) lets any AI agent you already run query and update the board through a token you issue — Visiban ships the interface, not a model, so nothing leaves your install.

New here, or comparing options? [Why Visiban](/v1.2.0-alpha.1/getting-started/why-visiban/) covers what makes it different and, honestly, when to pick something else.

## Highlights

- **Swimlanes** — rows represent entities (customers, projects, teams); columns are pipeline stages
- **Movement history** — every drag logs from/to column, from/to swimlane, who moved it, and when; board-level History tab with search and filters
- **Real-time updates** — board state syncs live across all open tabs via WebSocket (Django Channels + Valkey)
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
| [Installation](/v1.2.0-alpha.1/getting-started/installation/) | Get up and running with Docker or locally |
| [First Boot](/v1.2.0-alpha.1/getting-started/first-boot/) | Bootstrap your first site admin |
| [Roles & Permissions](https://docs.visiban.com/v1.2.0-alpha.1/features/rbac/roles/) | Understand who can do what |
| [Analytics](https://docs.visiban.com/v1.2.0-alpha.1/features/analytics/) | Summary, velocity, and bottleneck views |
| [Notifications](https://docs.visiban.com/v1.2.0-alpha.1/features/notifications/) | Assignment and staleness alerts |
| [Real-time Updates](https://docs.visiban.com/v1.2.0-alpha.1/features/realtime/) | WebSocket live sync |
| [CI/CD Pipeline](https://docs.visiban.com/v1.2.0-alpha.1/architecture/overview/#cicd-pipeline) | Build verification and testing in GitLab CI |
| [Board Sharing](https://docs.visiban.com/v1.2.0-alpha.1/features/board/#board-sharing) | Public read-only share links |
| [Personal Access Tokens](https://docs.visiban.com/v1.2.0-alpha.1/features/personal-access-tokens/) | Token-based API access |
| [API Reference](https://docs.visiban.com/v1.2.0-alpha.1/api/boards/) | Full endpoint documentation |
