---
title: Why Visiban, and when to pick something else
description: Four things set Visiban apart. This page names them, and says when another tool is the better choice.
sidebar:
  label: Why Visiban
---

> **Reflects 1.2**

<a id="the-one-sentence-answer"></a>

Visiban is an open-source, self-hosted Kanban board. Every row is an entity, such as a customer, project, or team. Every card movement is permanently recorded. Any AI agent you already run can query and update the board through your own API token.

**Why it matters:** Picking the wrong tool is expensive for a team. So this page names the four things only Visiban does, and says plainly where other tools are better.

**In short:** Kill the spreadsheet, see how work actually moves, and query it with your own AI. Every move is on the record.

**For your manager:** *"It's the board, but each row is one client, it keeps a full audit trail of what moved when, and it runs on our own infrastructure with our own SSO."*

:::note[Competitive claims are dated]
Each claim about another product carries the date it was checked. Projects change their licensing and feature gating without notice. If a claim is more than a few months old, verify it before you rely on it. We'd rather you catch us out of date than trust a stale page.
:::

<a id="what-actually-makes-it-different"></a>

## Four things that make it different

Visiban does many things, but other tools do those too. These four are what set it apart.

<a id="1-rows-are-entities-and-rows-carry-data"></a>

### 1. Rows are entities, and they carry data

**The big picture:** Most boards treat rows as an afterthought: a label, or nothing at all. In Visiban a swimlane is a first-class object, such as one customer, one project, or one team. It has a name, a position, and *(as of 1.2)* **typed custom fields of its own**.

**Why it matters:** That last part is why teams stop keeping a spreadsheet beside the board. The spreadsheet exists because most boards hold *cards* but not *the thing the cards are about*. A renewal date, an account tier, a contract value, or a region belongs to the row, not to any one card.

**Go deeper:** [Custom Fields](https://docs.visiban.com/latest/features/custom-fields/)

<a id="2-movement-history-is-not-an-activity-log"></a>

### 2. Movement history is data, not an activity log

**How it works:** Visiban records every card movement as structured data: from column, to column, from swimlane, to swimlane, actor, and timestamp. It keeps the records permanently. They are the raw material for cycle-time and bottleneck analysis, not a feed for people to read.

**Why it matters:** In an incident retrospective you can ask *"how long did this actually sit in Review, and how does that compare to the last thirty cards?"* You get an answer, not a scroll-back.

**Go deeper:** [Card History](https://docs.visiban.com/latest/features/card-history/) and [Analytics](https://docs.visiban.com/latest/features/analytics/)

### 3. Bring your own agent: nothing leaves your install

**How it works:** Visiban ships a first-class [MCP server](https://docs.visiban.com/latest/features/mcp-server/). Any MCP-capable assistant you already run can list boards, query cards, and make changes. It authenticates with a [scoped personal access token](https://docs.visiban.com/latest/features/personal-access-tokens/) that you issue and can revoke.

**Be precise about this:** **Visiban does not ship AI features.** There is no bundled model, no vendor relationship, no telemetry, and no data egress. Visiban ships the *interface*. You bring the model, which can be a local one, and your board data never leaves the machine you installed it on.

**Yes, but:** If you want a tool that summarizes your standup out of the box, Visiban is the wrong choice. Pick something else. For a self-hosting team, keeping data in-house is usually the point.

<a id="4-sso-is-in-the-open-source-core-free"></a>

### 4. SSO is in the free, open-source core

**How it works:** OIDC and OAuth are part of the Apache-2.0 core. That covers Google, GitHub, GitLab, and any OIDC-compliant provider such as Keycloak, Okta, or Authentik. SSO is not a paid tier or an add-on.

**Why it matters:** Identity is the feature self-hosted project tools most often put behind a paywall. It is also the one that most often forces a team onto a commercial tier it otherwise wouldn't need. Ours is a deliberate position, so check it against the alternatives.

**Go deeper:** [OAuth and SSO](/getting-started/oauth/)

## How it compares

This is the honest version: each of these tools is better than Visiban at something.

| Instead of | Pick it if | Pick Visiban if | Checked |
|---|---|---|---|
| <a id="vs-trello"></a>**Trello** | You want zero setup, SaaS is fine, and cards in columns cover your needs. Its power-up ecosystem is enormous, and Visiban has nothing like it. | You need self-hosting, entity-shaped rows with their own data, or a real audit trail. Trello's swimlanes are a view option, not a data model. Its activity log isn't built for cycle-time analysis. Visiban imports Trello JSON exports directly: see [Import from Trello](https://docs.visiban.com/latest/features/trello-import/). | 2026-09 |
| <a id="vs-linear"></a>**Linear** | You're a cloud-native product team. Its interface and keyboard model are genuinely excellent. Its cycle and triage workflow is more opinionated and polished than anything Visiban offers. For a software team that doesn't need self-hosting, it's very hard to beat. | Self-hosting is a requirement, or your rows are customers rather than sprints. Linear is cloud-only and models work around engineering cycles, not per-account pipelines. | 2026-09 |
| <a id="vs-gitlab-github-issue-boards"></a>**GitLab / GitHub issue boards** | All your work already lives in one repository. The native board is free and already holds your issues, and another tool is real operational cost for marginal gain. This is the right call more often than vendors like us admit. | Work spans repositories, accounts, or teams that don't map to a repo. Or you need per-account swimlanes, or cycle-time data the native boards don't compute. Visiban can also *mirror* a repository's issues as a read-only board with the [Issue Board Lens](https://docs.visiban.com/latest/features/issue-board-lens/). That is often a better first step than migrating anything. | 2026-09 |
| <a id="vs-monday-clickup-asana"></a>**Monday / ClickUp / Asana** | You need breadth: forms, docs, time tracking, dashboards, portfolio rollups, and a large integrations catalog in one product. Their reporting is more mature than Visiban's and will stay that way. We aren't trying to close that gap. | You want one thing done well, self-hosted, without per-seat pricing, and that breadth is cost rather than value to you. | 2026-09 |
| <a id="vs-notion"></a>**Notion** | The board is one view of a flexible database, and the writing matters as much as the workflow. | You need WIP enforcement and movement history. Notion's board is a presentation of a database. It doesn't track how long something sat in a state, and it won't stop you overloading a column. | 2026-09 |
| <a id="vs-vikunja-plane"></a>**Vikunja / Plane** | You want a broader self-hosted task suite with Gantt charts, sprints, and multiple project views. They cover more surface than Visiban. | You want Kanban specifically, done deeper rather than wider. | 2026-09 |
| <a id="vs-planka"></a>**Planka** | You want a close, mature Trello clone and its licensing works for you. | You need SSO without a commercial tier (Planka moved OIDC support to its Pro offering in August 2026). Or you need the swimlane data model and movement history. | 2026-09. **Verify first:** this is the claim most likely to change. |
| <a id="vs-wekan-kanboard-focalboard"></a>**WeKan / Kanboard / Focalboard** | They already work for you. WeKan and Kanboard are long-lived and battle-tested, and a tool your team already knows has real value. | You plan to run the tool for years. Focalboard is unmaintained since Mattermost discontinued it, and Kanboard is in maintenance mode. Weigh that in your evaluation. | 2026-09 |

**Yes, but: Visiban won't grow into a project suite.** Visiban [deliberately doesn't ship Gantt charts, sprints, or capacity planning](https://docs.visiban.com/latest/architecture/overview/), and there are no plans to add them. If those are on your list, Vikunja or Plane is a better fit, and we'd rather you knew now.

<a id="vs-a-real-crm"></a>

### If you're running a sales pipeline, use a CRM

*Checked 2026-09.*

**The big picture:** Kanban boards get pressed into service as sales pipelines all the time. EspoCRM, Twenty, and self-hosted Odoo are free and self-hostable. Any of them will beat a board at contact management, email sync, quoting, and revenue reporting, because a board isn't shaped to do those things.

**Yes, but:** Visiban is a reasonable fit for a *lightweight* pipeline, where the stages matter more than the contact history. It's the wrong tool the moment you need to know who you emailed last Tuesday.

## Who Visiban is not for

- Teams that need Gantt charts, sprint ceremonies, or capacity planning. This is a deliberate scope boundary, not a gap on the roadmap.
- Teams that want AI features rather than an AI interface.
- Anyone who needs a mature marketplace of third-party integrations.
- Sales teams who need a CRM (see above).

<a id="related"></a>

**Go deeper:** [Install it](/getting-started/installation/) · [Set up swimlanes and columns](/getting-started/board-setup/) · [Connect an agent](https://docs.visiban.com/latest/features/mcp-server/) · [See what the movement history buys you](https://docs.visiban.com/latest/features/analytics/)
