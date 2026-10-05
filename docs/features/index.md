# Features

Every card's journey through your pipeline should be visible, measurable, and actionable. This page is a map of the features that make that true.

---

## The board

The kanban grid is the heart of Visiban. Columns represent pipeline stages; swimlanes represent the entities moving through them — customers, projects, epics, or anything else.

```
              Backlog   │  To Do   │  Doing   │   Done
────────────────────────┼──────────┼──────────┼──────────
Acme Corp         ■     │    ■ ■   │    ■     │
────────────────────────┼──────────┼──────────┼──────────
Globex Inc              │    ■     │    ■ ■   │    ■
────────────────────────┼──────────┼──────────┼──────────
Initech           ■ ■   │          │    ■     │    ■ ■
```

Cards are dragged between cells. Every move that changes column or swimlane is logged automatically to an immutable audit trail.

Keyboard shortcuts make common actions instant: `f` toggles the filter bar, `/` focuses search, and `?` shows the full shortcut reference.

**Grid overlays** shade each cell by card count — without hiding or resizing anything, so you can spot hot spots at a glance.

→ [Board & Cards](board.md) · [Grid overlays](board.md#grid-overlays)

---

## Board creation & templates

When creating a new board you choose from ten purposeful templates — Sales Pipeline, Customer Support, Customer Success, Simple Kanban, Product Roadmap, Project Delivery, Content Production, Hiring & Recruiting, Legal & Compliance, or Infrastructure & DevOps — each pre-seeded with the right columns and a swimlane placeholder. Or start from **Blank Board**, which creates no columns at all so you can build the layout yourself.

After choosing a template you're prompted to name the first swimlane using the template's label (e.g. "Account" for Sales Pipeline). You can also mark any newly created board as your **default board** so it opens automatically after login.

→ [Board & Cards](board.md)

---

## Card detail

Click any card to open a side panel with full context:

- **Priority** — low / medium / high / urgent, shown as a color-coded left border
- **Assignee** — any board member; triggers a notification on assignment
- **Labels** — board-scoped tags for filtering and grouping
- **Due date** — optional deadline
- **Weight** — numeric effort estimate for WIP and capacity tracking
- **Checklist** — sub-tasks with progress tracking
- **Attachments** — upload files directly to a card (up to 10 MB each)
- **Description** — rich text editor with bold, italic, code, lists, headings, blockquote, and text color; type `@username` to mention a board member and send them a notification
- **Relations** — link cards as Blocked by / Blocks / Relates to, with a red indicator for unfinished blockers
- **Pull / merge request** — link a GitHub or GitLab PR/MR to the card
- **Comments** — threaded discussion visible to collaborators and above
- **Activity tab** — full movement timeline and activity log

→ [Card History](card-history.md) · [Card Descriptions](card-descriptions.md) · [Card Relations](card-relations.md) · [Pull & Merge Request Links](card-links.md)

---

## Bulk operations & data portability

Select multiple cards at once and apply bulk actions — move to a column, assign, set priority, archive, or delete — all from a toolbar that appears at the bottom of the board.

Export your board as CSV or JSON for backup or analysis, or import a previously exported board to recreate it with all its structure and cards. Import accepts lowercase and snake_case column headers (e.g. `title`, `due_date`) so files from external tools import cleanly without manual editing.

Coming from Trello? Import a Trello board JSON export into a new board, with a preview of how lists, labels, checklists, comments, and members will map before anything is created.

→ [Board & Cards](board.md#bulk-card-operations) · [Export & Import](board.md#export-import) · [Import from Trello](trello-import.md)

---

## Card archiving

Cards can be archived instead of deleted — removing them from the active board view while preserving their full history and movement audit trail. Archived cards can be restored at any time from the **Archived** panel in the board toolbar. Analytics dwell-time uses `archived_at` as the terminal timestamp so only the active period is counted.

→ [Card Archiving](card-archiving.md)

---

## Analytics & visibility

Three views are available from the board toolbar:

| View | Best for |
|---|---|
| **Board** | Day-to-day card management and drag-and-drop |
| **Summary** | Weekly standup — card counts and velocity per swimlane |
| **Analytics** | Spotting bottlenecks — which stage is slowing things down? |

The **Analytics** view computes median dwell time per stage from historical movement records, highlights outlier cells in red, and lists cards that have been stuck in the same column for too long.

→ [Analytics](analytics.md)

---

## Notifications

Visiban surfaces two types of alerts in the notification bell:

- **Assignment** — you're notified when someone assigns a card to you
- **@mentions** — you're notified when someone mentions you in a card description
- **Comments** — opt in to be notified when someone comments on a card you created or are assigned to
- **Staleness** — cards that haven't moved in N days (configurable per board) appear with an amber indicator and trigger a daily digest

Stale cards show an amber tint overlay with reduced opacity on the board so they're impossible to miss at a glance.

Five of these events — assigned to me, @mentioned, due date approaching, a watched card moved, and a comment on a watched card — can also be **delivered by email**, off by default, once an administrator configures outgoing SMTP and you turn the per-event toggle on in Settings → Notifications.

→ [Notifications](notifications.md) · [Email notifications](notifications.md#email-notifications)

---

## Real-time collaboration

When multiple people are working on a board simultaneously, changes appear instantly without a page refresh. The connection status indicator in the toolbar stays quiet when healthy — a small **Live** dot at wider viewports — and becomes a prominent amber or red pill when the connection is reconnecting, stale, or failed, so a degraded connection is obvious at a glance.

Powered by Django Channels and Valkey — no configuration required in the default Docker Compose setup.

→ [Real-time Updates](realtime.md)

---

## Real-time group updates

> **Added in 1.1**

The group detail page auto-refreshes its board list over WebSocket. Boards created, renamed, deleted, or moved into or out of the group by other users appear and disappear in real time — no manual refresh needed. A **Live / Reconnecting… / Failed** status indicator mirrors the board-view connection badge.

→ [Groups — Live board list](groups.md#live-board-list)

---

## Groups & access control

Boards can be organized into groups and subgroups (unlimited nesting). Group membership cascades down the hierarchy — add someone to "Acme Corp" and they automatically gain access to all boards in "Engineering", "Backend Team", and every other descendant group.

```
Acme Corp  ← add user here
└── Engineering  ← access inherited automatically
    ├── Backend Team   ← and here
    └── Frontend Team  ← and here
```

Four board roles let you grant exactly the right level of access:

| Role | What they can do |
|---|---|
| **Admin** | Full access — manage members, columns, swimlanes, and board settings |
| **Member** | Create, edit, and move cards |
| **Collaborator** | Comment on cards and upload files — cannot create or move cards |
| **Viewer** | Read-only — cannot comment or upload |

Assigning a user **Group Admin** automatically grants them board-admin rights on every board in that group — the recommended role for team leads.

The [RBAC guide](rbac/index.md) covers this in depth: [role definitions](rbac/roles.md), [how access inherits down the group hierarchy](rbac/inheritance.md), and [how to assign or revoke it](rbac/managing.md).

→ [Groups](groups.md) · [Roles & Permissions](rbac/roles.md)

---

## Personal Access Tokens

Create named, revocable tokens to authenticate scripts, CI pipelines, and integrations without sharing your password. Tokens use the `vbn_` prefix, are shown once at creation, and are automatically revoked when your password changes.

Tokens created from 1.2 onward carry explicit **scopes** (`read`, `write`, `admin`, `mcp:read`, `mcp:write`) that cap what the token can do — non-hierarchical, so a token must list every scope its requests need. Tokens created before 1.2 keep working unscoped.

→ [Personal Access Tokens](personal-access-tokens.md) · [Scopes](personal-access-tokens.md#scopes)

---

## MCP Server

> **Added in 1.2**

Connect Claude Desktop, Copilot, or any [Model Context Protocol](https://spec.modelcontextprotocol.io)-compatible AI agent to Visiban so it can read your boards and, with a suitably scoped token, create, move, update, and archive cards. Authenticates with the same Personal Access Token used elsewhere in the API. Off by default; operators enable it with `MCP_SERVER_ENABLED=true`.

→ [MCP Server](mcp-server.md)

---

## Stable UIDs

Every board, column, swimlane, label, and card carries a stable 16-character hex UID that never changes even after renames or moves. UIDs are included in JSON exports and are safe to reference in external integrations, webhooks, and scripts.

→ [Stable UIDs](stable-uids.md)

---

## Command palette

> **Added in 1.1**

Press <kbd>⌘K</kbd> (or <kbd>Ctrl+K</kbd>) from any authenticated page to open the global command palette. Behavior adapts to the current surface:

- **Board** — searches cards on the current board by title, plus board-scoped actions (open card history, toggle filters, switch view).
- **Dashboard / Group** — jumps to a board across the user's full board set; starred boards lead the unfiltered list (alphabetical), then recent visits.
- **Settings / Admin** — jumps to settings sub-tabs and admin pages.

The palette is the single discoverable surface for cross-board search until the dedicated cross-board search feature ships in a future release. The 🔍 button in the top chrome dispatches the same window event that opens the palette, so users can reach it by clicking as well as by keyboard.

→ [Keyboard shortcuts](keyboard-shortcuts.md)

---

## Navigation

The application sidebar gives you persistent access to your full group and board hierarchy from any page. Starred boards and groups appear at the top of the sidebar in dedicated **Favorite Boards** and **Favorite Groups** sections. The sidebar collapses to a 48 px icon rail (with hover tooltips), expands back to 220 px, and remembers both states across reloads via `localStorage`.

Site admins see a **Site Admin** link in the sidebar that opens the administration panel directly. The link is hidden for all other users.

The authenticated app is optimized for desktop (1024 px and wider). Below that width, Visiban shows a "use a larger screen" notice instead of a degraded layout. Public join, share, and account-recovery pages remain accessible on any viewport.

→ [Navigation](navigation.md)

---

## Site administration

Site admins can manage the instance from the `/admin` panel (accessible via the sidebar or directly):

- **Registration mode** — open (anyone can sign up), invite-only (registration disabled; admin creates accounts), or closed
- **User management** — create accounts, toggle active/site-admin status, and force a password reset on next login
- **Maintenance mode** — puts the instance into read-only mode for the duration of an upgrade or migration; non-admin writes are rejected while reads keep working
- **Email (SMTP) configuration** — set up the outgoing mail server for password resets, verification, and notification email straight from the admin UI, no environment variables or restart required
- **Action log** — every settings-tab toggle change is recorded with the admin who made it and when, readable via the API (added in 1.2)

→ [Administration](../administration/index.md) · [Maintenance Mode](../administration/maintenance-mode.md) · [Admin Panel](../administration/admin-panel.md)

---

## User settings

Settings are accessed from the avatar menu in the top-right navbar.

**Profile** — display name, email, username, and locale preferences:

| Setting | Options |
|---|---|
| Date format | MM/DD/YYYY · DD/MM/YYYY · YYYY-MM-DD |
| Time format | 12-hour · 24-hour |
| Number format | US (1,234.56) · European (1.234,56) · French (1 234,56) · Indian (1,23,456) |
| Timezone | Any IANA timezone; defaults to browser-detected on first save |

Usernames are unique regardless of case: if someone is already `alice`, you can't become `Alice`, though you can re-case your own username. Renaming yourself is rate-limited the same way as the forced username change.

**Changing your email address** — on an instance that requires verified email addresses (`EMAIL_VERIFICATION=mandatory`), a new address doesn't take effect when you save it. Visiban sends a confirmation link to the new address and shows *Waiting for confirmation* under the field; your current address stays in use (for sign-in, password resets, and notification email) until you open the link. If you save another new address before confirming, the most recent request replaces the earlier one. Under the note, **Resend link** emails the confirmation link again (at most once every few minutes; the link you already have keeps working), and **Cancel change** withdraws the change so your current address stays and the pending link stops working. If the link says the address is *already in use*, another account has already confirmed it; cancel the change and choose a different address. You also can't remove your email address on such an instance. On instances with the default `optional` policy, the new address takes effect immediately, as before.

**Appearance** — theme switcher: System (follows OS preference), Dark, or Light. Applied immediately and synced to your account, so it follows you to your other browsers and devices on their next load. See [Appearance](appearance.md) for the full behavior.

**Notifications** — per-trigger toggles (card assigned, @mentioned, due date warning, card moved, comment added).

**Behavior** — card editor preferences:

| Setting | Default | Description |
|---|---|---|
| Close editor on Enter | On | Pressing Enter in the quick card-title editor confirms and closes it. Turn off to insert a newline instead (useful when titles often span multiple lines). |

**Security** — change password.

---

## WIP limits and hard enforcement


WIP limits can now be configured in two modes: **soft** (advisory, admins can override) or **hard** (strict, no override for any role). When hard enforcement is enabled in **Board Settings → Rules → Enforce WIP hard**, moves into, new cards in, and restores into a full column are blocked for everyone — including board admins and site admins. The move, create, and restore APIs return `409` with code `wip_hard_blocked`, and the board shows a `⛔` toast rather than the `⚠` used for soft blocks.

Weight limits work the same way: the corresponding **Enforce weight limits** setting blocks moving, creating, or restoring a card that would push a column's total weight over its budget, and raising a card's weight past it.

A column sitting exactly *at* its WIP limit normally reads as an ordinary count — the optional **Show at-limit WIP indicator** board setting (off by default) adds ambient visibility for that at-limit case too, not just over-limit.

→ [Board & Cards — Hard WIP enforcement](board.md#hard-wip-enforcement) · [At-limit WIP indicator](board.md#at-limit-wip-indicator)

---

## Saved filters

> **Added in 1.0** · **Tab pills added in 1.1**

Save any combination of filters (search text, assignee, labels, priority, due date) under a name and restore it in one click from the **Saved** dropdown in the filter bar. Saved filters are stored server-side and persist across devices. They are private to each user — other board members cannot see or modify your presets. Any board role, including Viewer, can manage their own saved filters.

→ [Saved Filters](saved-filters.md)

---

## Custom fields

> **Added in 1.2**

Board admins can define up to 30 typed metadata fields per board — text, number, date, dropdown, checkbox, URL, or multi-select — for tracking anything specific to that board's workflow. Up to 2 fields can be pinned to the card face as small chips; checkbox and dropdown chips are editable directly from the card face. Every field also gets its own input in the card detail panel, and the filter bar can filter on any of them.

Boards can also define up to 15 separate fields scoped to **swimlanes** (rows) instead of cards, with up to 8 pinned as chips in the swimlane label panel. Swimlane fields are a fully independent per-board schema, managed on their own **Swimlane fields** tab in Board Settings, and each can be marked admin-only so only board admins see its values.

→ [Custom Fields](custom-fields.md)

---

## Card density

> **Added in 1.1**

Each board has an admin-controlled **Card density** setting (Comfortable / Standard / Dense) that controls how much metadata appears on the card face. New boards default to Comfortable — one urgency badge, one label, checklist progress, and the assignee avatar. Dense reproduces the pre-1.1 layout and is the default for boards upgraded from 1.0. Boards upgraded automatically are set to Dense; admins can adjust the setting at any time in **Board Settings → Display**.

The previous per-user per-field hide toggles (Labels / Due date / Assignee / Priority badge / Last moved) are removed in 1.1. Card density is the single layout knob, and `localStorage` values for the old keys are silently ignored.

Any member can override the board's density for their own view without changing it for anyone else — turn on **Use my own density** in Board Settings → Display (added in 1.2, browser-local, board-scoped).

→ [Board & Cards — Card density](board.md#card-density) · [Personal density override](board.md#personal-density-override)

---

## Card information at a glance


Two new fields are visible directly on the card face without opening the detail panel:

- **Weight** — shown in the card metadata row when the card's weight is above 1, letting you scan column budgets at a glance.
- **Last moved** — a relative label (e.g. "moved yesterday", "moved 3 days ago") appears on cards not moved within the last 24 hours. Cards moved within 24 hours continue to show the existing blue-dot indicator. Card metadata visibility is controlled by the **Card density** setting in **Board Settings → Display**.

→ [Board & Cards — Cards](board.md#cards)

---

## Move to from the card detail panel


The card detail panel now includes a **Move to** button in the breadcrumb row. Clicking it opens a popover where you can select a destination column and swimlane without closing the panel and without drag-and-drop. The button shows a first-encounter dot indicator for users who have not yet clicked it; the dot is dismissed permanently on first use.

→ [Board & Cards — Cards](board.md#cards)

---

## URL-addressable board tabs and card history preference


The board sub-navigation tabs (Board, Summary, Analytics, History) now reflect in the URL via a `?view=` search parameter. Tab views can be bookmarked and shared, and the browser Back button skips tab transitions.

Within the card detail Activity tab, the **Show full history** toggle now persists across card opens, page refreshes, and sessions via `localStorage`. Users who prefer the expanded view no longer need to re-enable it each time.

→ [Board & Cards](board.md) · [Card History](card-history.md)

---

## Analytics heatmap — absolute threshold coloring


The analytics heatmap colors cells using absolute board-level thresholds instead of relative (median-based) heuristics. Green means well under threshold, yellow means within the warning band, and red means at or above the stale threshold. Both values — `staleness_threshold_days` and `stale_warning_pct` — are configurable per board in **Board Settings → Card aging settings**.

→ [Analytics](analytics.md#color-coding)

---

## Onboarding tour


First-time users see an 8-step contextual tooltip walkthrough when they open a board for the first time. The tour introduces swimlanes, card movement, the audit trail, and the filter bar. Completing or skipping the tour sets a persistent server-side flag — the tour never reappears. Site admins can reset the flag for any user from the admin panel.

→ [Onboarding Tour](../getting-started/onboarding-tour.md)

---

## Board sharing


Board admins can generate a public read-only link that lets anyone view the board without a Visiban account. The link serves a static board view showing the full grid (columns, swimlanes, cards) with titles, labels, checklist progress, due dates, weights, and assignee names visible. Editing and commenting are disabled in the public view. Revoking the token immediately invalidates the link.

**Share-link expiry** (added in 1.1) — admins can set an optional TTL of 7 / 30 / 90 days when enabling a share link. Once the link expires, visitors receive a `410 Gone` response. Re-enabling sharing generates a new token; the expired token cannot be restored.

→ [Board & Cards — Board sharing](board.md#board-sharing)

---

## Sidebar explorer tree


The expanded sidebar now renders groups and their boards as a recursive tree. Subgroups appear nested under their parent group with indented chevron expand/collapse controls, and boards belonging to subgroups are shown inline under their group. The collapsed icon rail is unchanged — it continues to show one icon per top-level section.

→ [Navigation](navigation.md)

---

## Ownership-gated destructive actions


Card delete, archive, and comment delete are now ownership-gated for members. A member can only delete or archive cards they created and delete comments they authored. Board admins and members with the **moderator** entitlement can act on any content.

The **moderator** entitlement lets a board admin delegate content-moderation rights to a specific member without granting them full admin access.

→ [Board Permissions](permissions.md#moderator-entitlement)

---

## Board export and per-board threshold


By default any board member (including Collaborators and Viewers) can export the full CSV or JSON dump. Board admins can restrict exports to a higher minimum role via the `export_min_role` board setting. A per-board export history log records every successful export and is visible to board admins.

→ [Board & Cards — Export](board.md#export-import)

---

## Invite link improvements


Invite links now handle group-access-gated boards correctly. When a new user follows an invite link to a board that is protected by group membership, they see a clear explanation of the pending access request and what to expect next, rather than an error page. The admin panel invite links tab now displays and copies the full join URL (`/join/<token>`) rather than the raw token.

→ [Administration](../administration/admin-panel.md)

---

## OIDC authentication


Generic OpenID Connect (OIDC) is configurable via environment variables, making it straightforward to integrate with Keycloak, Authentik, Okta, Dex, or any other standard OIDC identity provider. Set `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_SERVER_URL` to enable it; the provider is only registered when all three are present.

!!! info "Validated against Keycloak; community feedback welcome for other providers"
    The end-to-end login flow is validated in CI against Keycloak. Other providers (Okta, Authentik, Dex) have not been tested end-to-end — report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349).

→ [Authentication](../administration/authentication.md#generic-oidc)

---

## Feature toggles


Site admins can enable or disable specific features instance-wide from the admin panel Settings tab. Toggling a feature takes effect within approximately 60 seconds and never deletes existing data. The current toggles control file uploads; additional toggles will be added as new gated features are introduced.

→ [Feature Toggles](feature-toggles.md)

---

## UI polish — wave 1 and wave 2


A focused set of usability improvements landed across two waves:

- **Focus mode** on the board toolbar — a crosshair icon on any swimlane label collapses all other rows so you can work without distraction; the `?focus=<id>` URL parameter makes focus mode bookmarkable and shareable.
- **Card move discoverability** — the **Move to** button in the card detail panel shows a first-encounter indicator for users who have not yet discovered it.
- **Onboarding and offboarding navigation refinements** — improved flows for new users joining via invite link and for board ownership transfer when a user is deactivated.

→ [Board & Cards — Swimlane focus mode](board.md#swimlane-focus-mode)

---

## Issue Board Lens

> **Added in 1.2**

Connect a public GitHub or GitLab repository to a board and view its issues as a read-only kanban grid — with the swimlane dimension that native provider boards lack. Columns default to a derived **Pipeline** view (Backlog → To Do → Doing → Review → Done) and can be changed to status labels, Open/Closed, or any label; swimlanes group by milestone, label, or assignee. The lens is off by default; operators enable it with `GIT_LENS_ENABLED=true`.

→ [Issue Board Lens](issue-board-lens.md)

---

## What to read next

New to Visiban? We recommend this order:

1. [Board & Cards](board.md) — understand the grid, cards, and how to move things
2. [Card History](card-history.md) — see what the audit trail captures
3. [Groups](groups.md) — organize your boards and invite your team
4. [Analytics](analytics.md) — find bottlenecks and track velocity
5. [Notifications](notifications.md) — stay on top of stale work
6. [Onboarding Tour](../getting-started/onboarding-tour.md) — what new users see on first login
