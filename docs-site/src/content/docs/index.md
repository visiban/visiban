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
This site is the #1271 Astro + Starlight spike. Only **Getting Started** is ported, and it is rewritten in Smart Brevity style. Every other link goes to the live mkdocs site. **1.2.0** is the current stable release; see the [release notes](https://gitlab.com/visiban/visiban/-/releases/v1.2.0).
:::

Visiban is a self-hosted Kanban board. Each swimlane is a customer, account, or project, with typed fields of its own. Every card move is recorded, permanently.

**Why it matters:** The data that used to live in a spreadsheet beside the board now lives on the board. The movement history lets you measure cycle time instead of guessing at it.

**How it works:**

- **Rows are entities.** Swimlanes carry [typed custom fields](https://docs.visiban.com/latest/features/custom-fields/) *(1.2)*, WIP limits, card aging, and dwell-time analytics.
- **Every move is on the record.** From and to column, from and to swimlane, who moved it, and when.
- **Bring your own AI.** An API and an [MCP server](https://docs.visiban.com/latest/features/mcp-server/) let an agent you already run query and update boards through a token you issue. Visiban ships the interface, not a model, so nothing leaves your install.

**Go deeper:** [Start here](/getting-started/) for the install path, or [Why Visiban](/getting-started/why-visiban/) for when to pick something else.
