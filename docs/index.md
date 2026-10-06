# Visiban

!!! warning "Pre-release"
    **1.2.0-alpha.4** is a pre-release development build of the upcoming release — expect bugs and breaking changes. [Report issues](https://gitlab.com/visiban/visiban/-/issues) or see the [installation guide](getting-started/installation.md) if you want to try it early.

An open-source Kanban board where every row is an entity and every move is on the record. Each swimlane is a customer, account, or project, with typed fields of its own, WIP limits, card aging and dwell-time analytics, and a permanent audit trail of every card movement. An API and [MCP server](features/mcp-server.md) let you connect your own tools.

**In one line: kill the spreadsheet, see how work actually moves, interrogate it with your own AI — every move on the record.** Rows are entities with typed fields of their own, so the data that used to live in a side-spreadsheet lives on the board. Every card movement is recorded permanently. And a first-class [MCP server](features/mcp-server.md) lets any AI agent you already run query and update the board through a token you issue — Visiban ships the interface, not a model, so nothing leaves your install.

New here, or comparing options? [Why Visiban](getting-started/why-visiban.md) covers what makes it different and, honestly, when to pick something else.

## Highlights

- **Swimlanes** — rows represent entities (customers, projects, teams); columns are pipeline stages
- **Custom fields** *(1.2)* — typed fields on cards and on swimlane rows (text, number, date, dropdown, checkbox, URL, multi-select), pinned to the card face or lane label
- **WIP limits** — soft or hard limits per column, enforced on move, create, and restore
- **Card aging** — cards tint as they sit; per-board staleness thresholds and stale-card notifications
- **Movement history** — every drag logs from/to column, from/to swimlane, who moved it, and when; board-level History tab with search and filters
- **Real-time updates** — board state syncs live across all open tabs via WebSocket (Django Channels + Valkey)
- **Analytics** *(beta)* — summary view (card counts, velocity, average cycle time) and analytics view (per-lane dwell-time heatmap, stalled cards)
- **Board sharing** — generate a read-only public link; anyone with the URL can view the board without logging in
- **Saved filters** — save and restore filter presets per board; private to each user
- **Notifications** — assignee alerts on card assignment; @mention alerts; staleness alerts when cards haven't moved in N days
- **Groups** — organize boards into groups and sub-groups with inherited membership
- **RBAC** — five roles with fine-grained per-board and per-group permissions; moderator entitlement for content moderation
- **OAuth & OIDC** — Google, GitHub, and GitLab login out of the box; connect any OIDC provider via environment variables
- **Personal access tokens** — token-based API access for scripts and integrations; scopes are new in 1.2
- **MCP server** *(1.2, off by default)* — let an AI agent you already run query and update boards with a scoped token
- **Trello import** *(1.2)* — create a board from a Trello JSON export
- **Invite links** — shareable URLs with configurable role, expiry, and single-use options
- **Production-ready** — Nginx reverse proxy with flexible TLS (`letsencrypt`, `selfsigned`, or `none`) via `docker-compose.prod.yml` and `init-prod.sh`

## Quick links

| | |
|---|---|
| [Installation](getting-started/installation.md) | Get up and running with Docker or locally |
| [First Boot](getting-started/first-boot.md) | Bootstrap your first site admin |
| [Roles & Permissions](features/rbac/roles.md) | Understand who can do what |
| [Analytics](features/analytics.md) | Summary, velocity, and bottleneck views |
| [Notifications](features/notifications.md) | Assignment and staleness alerts |
| [Real-time Updates](features/realtime.md) | WebSocket live sync |
| [CI/CD Pipeline](architecture/overview.md#cicd-pipeline) | Build verification and testing in GitLab CI |
| [Board Sharing](features/board.md#board-sharing) | Public read-only share links |
| [Personal Access Tokens](features/personal-access-tokens.md) | Token-based API access |
| [API Reference](api/boards.md) | Full endpoint documentation |
