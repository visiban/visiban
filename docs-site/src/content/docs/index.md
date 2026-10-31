---
title: Visiban
description: Open-source Kanban where every row is an entity and every move is on the record.
template: splash
hero:
  tagline: Kill the spreadsheet, see how work actually moves, and query it with your own AI. Every move is on the record.
  actions:
    - text: Start here
      link: /getting-started/
      icon: right-arrow
    - text: Why Visiban
      link: /getting-started/why-visiban/
      variant: minimal
---

:::caution[Prototype: this is not docs.visiban.com]
This site is the #1271 Astro + Starlight spike. Only this page and **Getting Started** are ported, rewritten in Smart Brevity style. Every other link goes to the live mkdocs site.
:::

:::note[Latest release]
**1.2.0** is the current stable release. See the [release notes](https://gitlab.com/visiban/visiban/-/releases/v1.2.0) for what's new, and the [installation guide](/getting-started/installation/) to get started.
:::

Visiban is an open-source, self-hosted Kanban board where every row is an entity and every move is on the record.

**Why it matters:** The data that used to live in a spreadsheet beside the board lives on the board. The movement history lets you measure how work moves instead of guessing.

**The big picture:**

- **Rows are entities.** Each swimlane is a customer, account, or project, with typed fields of its own, WIP limits, card aging, and dwell-time analytics.
- **Every move is on the record.** Visiban keeps a permanent audit trail of every card movement.
- **Bring your own AI.** An API and a first-class [MCP server](https://docs.visiban.com/latest/features/mcp-server/) let you connect your own tools. Any AI agent you already run can query and update the board through a token you issue. Visiban ships the interface, not a model, so nothing leaves your install.

**In one line:** kill the spreadsheet, see how work actually moves, and interrogate it with your own AI, with every move on the record.

**Comparing options?** [Why Visiban](/getting-started/why-visiban/) covers what makes it different and, honestly, when to pick something else.

<a id="highlights"></a>

## What you get

**The board:**

- **Swimlanes.** Rows represent entities (customers, projects, teams); columns are pipeline stages.
- **Custom fields <span class="vb-version" title="Added in 1.2">1.2+</span>.** Typed fields on cards and on swimlane rows (text, number, date, dropdown, checkbox, URL, multi-select), pinned to the card face or lane label.
- **WIP limits.** Soft or hard limits per column, enforced on move, create, and restore.
- **Card aging.** Cards tint as they sit; per-board staleness thresholds and stale-card notifications.
- **Saved filters.** Save and restore filter presets per board, private to each user.
- **Trello import <span class="vb-version" title="Added in 1.2">1.2+</span>.** Create a board from a Trello JSON export.

**The record:**

- **Movement history.** Every drag logs from/to column, from/to swimlane, who moved it, and when. A board-level History tab has search and filters.
- **Analytics** *(beta)*. A summary view (card counts, velocity, average cycle time) and an analytics view (per-lane dwell-time heatmap, stalled cards).

**The team:**

- **Real-time updates.** Board state syncs live across all open tabs over WebSocket (Django Channels + Valkey).
- **Notifications.** Assignee alerts on card assignment, @mention alerts, and staleness alerts when cards haven't moved in N days.
- **Board sharing.** Generate a read-only public link; anyone with the URL can view the board without logging in.
- **Groups.** Organize boards into groups and sub-groups with inherited membership.
- **RBAC.** Five roles with fine-grained per-board and per-group permissions, plus a moderator entitlement for content moderation.
- **Invite links.** Shareable URLs with configurable role, expiry, and single-use options.

**Identity and integrations:**

- **OAuth and OIDC.** Google, GitHub, and GitLab login out of the box; connect any OIDC provider through environment variables.
- **Personal access tokens.** Token-based API access for scripts and integrations; scopes are new in 1.2.
- **MCP server <span class="vb-version" title="Added in 1.2">1.2+</span>.** Off by default. Let an AI agent you already run query and update boards with a scoped token.

**Running it:**

- **Production-ready.** An nginx reverse proxy with flexible TLS (`letsencrypt`, `selfsigned`, or `none`) through `docker-compose.prod.yml` and `init-prod.sh`.

<a id="quick-links"></a>

## Go deeper

| | |
|---|---|
| [Installation](/getting-started/installation/) | Get up and running with Docker or locally |
| [First boot](/getting-started/first-boot/) | Bootstrap your first site admin |
| [Roles & Permissions](https://docs.visiban.com/latest/features/rbac/roles/) | Understand who can do what |
| [Analytics](https://docs.visiban.com/latest/features/analytics/) | Summary, velocity, and bottleneck views |
| [Notifications](https://docs.visiban.com/latest/features/notifications/) | Assignment and staleness alerts |
| [Real-time Updates](https://docs.visiban.com/latest/features/realtime/) | WebSocket live sync |
| [CI/CD Pipeline](https://docs.visiban.com/latest/architecture/overview/#cicd-pipeline) | Build verification and testing in GitLab CI |
| [Board Sharing](https://docs.visiban.com/latest/features/board/#board-sharing) | Public read-only share links |
| [Personal Access Tokens](https://docs.visiban.com/latest/features/personal-access-tokens/) | Token-based API access |
| [API Reference](https://docs.visiban.com/latest/api/boards/) | Full endpoint documentation |
