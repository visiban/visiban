# Why Visiban

> **Reflects 1.2**

!!! info "Competitive claims are dated"
    Every statement about another product below carries the date it was verified. Projects change
    their licensing and feature gating without notice — if a claim here is more than a few months
    old, check it yourself before relying on it. We would rather you catch us out of date than
    trust a stale page.

## The one-sentence answer

**Visiban is a self-hosted Kanban board where rows are entities — customers, projects, teams — every
card movement is permanently recorded, and any AI agent you already run can query and update the
board through your own API token.**

Or, compressed: *kill the spreadsheet, visualize the workflow, interrogate it with your own AI —
every move on the record.*

If you need a sentence for your manager: *"It's the board, but each row is one client, it keeps a
full audit trail of what moved when, and it runs on our own infrastructure with our own SSO."*

## What actually makes it different

Four things. Everything else Visiban does, something else also does.

### 1. Rows are entities, and rows carry data

Most boards give you columns (stages) and treat rows as an afterthought — a label, or nothing at
all. In Visiban a swimlane is a first-class object: one customer, one project, one team. It has a
name, a position, and — as of 1.2 — **typed custom fields of its own**.

That last part is the reason teams stop keeping a spreadsheet next to their board. The spreadsheet
usually exists because the board can hold *cards* but not *the thing the cards are about*. A renewal
date, an account tier, a contract value, a region — that data belongs to the row, not to any single
card in it.

See [Custom Fields](../features/custom-fields.md).

### 2. Movement history is not an activity log

Plenty of tools log activity. Visiban records every card movement as structured data — from-column,
to-column, from-swimlane, to-swimlane, actor, timestamp — and keeps it permanently, as the substrate
for cycle-time and bottleneck analysis rather than as a human-readable feed.

The practical difference shows up in an incident retrospective: you can ask *"how long did this
actually sit in Review, and how does that compare to the last thirty cards?"* and get an answer, not
a scroll-back.

See [Card History](../features/card-history.md) and [Analytics](../features/analytics.md).

### 3. Bring your own agent — nothing leaves your install

Visiban ships a first-class [MCP server](../features/mcp-server.md). Any MCP-capable assistant you
already run can list boards, query cards, and make changes, authenticated with a
[scoped personal access token](../features/personal-access-tokens.md) you issue and can revoke.

The distinction worth being precise about: **Visiban does not ship AI features.** There is no bundled
model, no vendor relationship, no telemetry, and no data egress. What Visiban ships is the
*interface*. You bring the model — including a local one — and your board data never leaves the
machine you installed it on.

For a self-hosting team, that is usually the point. If you want a tool that summarizes your standup
for you out of the box, Visiban is the wrong choice and you should pick something else.

### 4. SSO is in the open-source core, free

OIDC and OAuth — Google, GitHub, GitLab, and any OIDC-compliant provider such as Keycloak, Okta, or
Authentik — are part of the Apache-2.0 core. Not a paid tier, not an add-on.

This is a deliberate position, and it is worth checking against the alternatives: identity is the
feature most commonly moved behind a paywall in self-hosted project tools, and it is the one that
most often forces a team onto a commercial tier they otherwise would not need.

See [OAuth Setup](oauth.md).

## How it compares

The honest version. Each of these tools is better than Visiban at something, and this section says
what.

### vs. Trello

*Checked 2026-09.*

**Pick Trello if** you want zero setup, you are fine with SaaS, and your team's needs are covered by
cards in columns. Trello's power-up ecosystem is enormous and Visiban has nothing like it.

**Pick Visiban if** you need self-hosting, entity-shaped rows with their own data, or a real audit
trail. Trello's swimlanes are a view option rather than a data model, and its activity log is not
built for cycle-time analysis.

Visiban imports Trello JSON exports directly — see [Installation](installation.md).

### vs. Linear

*Checked 2026-09.*

**Pick Linear if** you are a cloud-native product team. Linear's interface and keyboard model are
genuinely excellent, its cycle/triage workflow is more opinionated and more polished than anything
Visiban offers, and for a software team that does not need self-hosting it is very hard to beat.

**Pick Visiban if** self-hosting is a requirement, or your rows are customers rather than sprints.
Linear is cloud-only and models work around engineering cycles, not per-account pipelines.

### vs. GitLab / GitHub issue boards

*Checked 2026-09.*

**Pick the native board if** all your work already lives in one repository. It is free, it is where
your issues already are, and adding another tool is real operational cost for marginal gain. This is
the right call more often than vendors like us admit.

**Pick Visiban if** work spans repositories, accounts, or teams that do not map to a repo; if you
need per-account swimlanes; or if you need cycle-time data the native boards do not compute.

Visiban can also *mirror* a repository's issues as a read-only board — see
[Issue Board Lens](../features/issue-board-lens.md) — which is often the better first step than
migrating anything.

### vs. Monday / ClickUp / Asana

*Checked 2026-09.*

**Pick these if** you need breadth: forms, docs, time tracking, dashboards, portfolio rollups, and a
large integrations catalog in one product. Their reporting is more mature than Visiban's and will
stay that way — this is not a gap we are trying to close.

**Pick Visiban if** you want one thing done well, self-hosted, without per-seat pricing, and the
breadth is cost rather than value.

### vs. Notion

*Checked 2026-09.*

**Pick Notion if** the board is one view of a flexible database and the writing matters as much as
the workflow.

**Pick Visiban if** you need WIP enforcement and movement history. Notion's board is a presentation
of a database; it does not track how long something sat in a state, and it will not stop you
overloading a column.

### vs. Vikunja / Plane

*Checked 2026-09.*

**Pick these if** you want a broader self-hosted task suite — Gantt charts, sprints, multiple project
views. They cover more surface than Visiban does.

**Pick Visiban if** you want Kanban specifically and want it to go deeper rather than wider. Visiban
[deliberately does not ship Gantt, sprints, or capacity planning](../architecture/overview.md) and
is not planning to. If those are on your list, one of these is a better fit and we would rather you
knew now.

### vs. Planka

*Checked 2026-09. Verify before relying on this — it is the claim most likely to change.*

**Pick Planka if** you want a close, mature Trello clone and its licensing works for you.

**Pick Visiban if** you need SSO without a commercial tier — Planka moved OIDC support to its Pro
offering in August 2026 — or if you need the swimlane data model and movement history.

### vs. WeKan / Kanboard / Focalboard

*Checked 2026-09.*

**Pick these if** they already work for you. WeKan and Kanboard are long-lived and battle-tested, and
a tool your team already knows has real value.

**Consider the maintenance question:** Focalboard is unmaintained following Mattermost's
discontinuation, and Kanboard is in maintenance mode. For a tool you intend to run for years, that
belongs in the evaluation.

### vs. a real CRM

*Checked 2026-09.*

Worth stating plainly, because Kanban boards get pressed into service as sales pipelines constantly:
**if you are running a sales pipeline, use a CRM.** EspoCRM, Twenty, and self-hosted Odoo are free,
self-hostable, and will beat any board on contact management, email sync, quoting, and revenue
reporting — because those are not things a board is shaped to do.

Visiban is a reasonable fit for a *lightweight* pipeline where the stages matter more than the
contact history. It is the wrong tool the moment you need to know who you emailed last Tuesday.

## Who Visiban is not for

- Teams that need Gantt charts, sprint ceremonies, or capacity planning — that is a deliberate scope
  boundary, not a roadmap gap
- Teams that want AI features rather than an AI interface
- Anyone who needs a mature third-party integration marketplace
- Sales teams who need a CRM (see above)

## Related

- [Installation](installation.md) — get it running
- [Board Setup](board-setup.md) — swimlanes and columns
- [Custom Fields](../features/custom-fields.md) — typed data on cards and rows
- [MCP Server](../features/mcp-server.md) — connect an agent
- [Analytics](../features/analytics.md) — what the movement history buys you
