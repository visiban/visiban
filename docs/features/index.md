# Features

Visiban is built around a core idea: every card's journey through your pipeline should be visible, measurable, and actionable. The features below work together to make that happen.

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

→ [Board & Cards](board.md)

---

## Board creation & templates

When creating a new board you choose from eleven purposeful templates — Sales Pipeline, Customer Support, Customer Success, Simple Kanban, Product Roadmap, Project Delivery, Content Production, Hiring & Recruiting, Legal & Compliance, Infrastructure & DevOps, or Blank Board — each pre-seeded with the right columns and a swimlane placeholder.

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
- **Comments** — threaded discussion visible to collaborators and above
- **History tab** — full movement timeline and activity log

→ [Card History](card-history.md) · [Card Descriptions](card-descriptions.md)

---

## Bulk operations & data portability

Select multiple cards at once and apply bulk actions — move to a column, assign, set priority, archive, or delete — all from a toolbar that appears at the bottom of the board.

Export your board as CSV or JSON for backup or analysis, or import a previously exported board to recreate it with all its structure and cards. Import accepts lowercase and snake_case column headers (e.g. `title`, `due_date`) so files from external tools import cleanly without manual editing.

→ [Board & Cards](board.md#bulk-card-operations) · [Export & Import](board.md#export-import)

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
- **Staleness** — cards that haven't moved in N days (configurable per board) appear with an amber indicator and trigger a daily digest

Stale cards show an amber tint overlay with reduced opacity on the board so they're impossible to miss at a glance.

→ [Notifications](notifications.md)

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

→ [Groups](groups.md) · [Roles & Permissions](rbac/roles.md)

---

## Personal Access Tokens

Create named, revocable tokens to authenticate scripts, CI pipelines, and integrations without sharing your password. Tokens use the `vbn_` prefix, are shown once at creation, and are automatically revoked when your password changes.

→ [Personal Access Tokens](personal-access-tokens.md)

---

## Stable UIDs

Every board, column, swimlane, label, and card carries a stable 16-character hex UID that never changes even after renames or moves. UIDs are included in JSON exports and are safe to reference in external integrations, webhooks, and scripts.

→ [Stable UIDs](stable-uids.md)

---

## Command palette

> **Added in 1.1**

Press <kbd>⌘K</kbd> (or <kbd>Ctrl+K</kbd>) from any authenticated page to open the global command palette. Behaviour adapts to the current surface:

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

→ [Administration](../administration/index.md)

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

**Appearance** — theme switcher: System (follows OS preference), Dark, or Light. Applied immediately and persisted in `localStorage`.

**Notifications** — per-trigger toggles (card assigned, @mentioned, due date warning, card moved, comment added).

**Behavior** — card editor preferences:

| Setting | Default | Description |
|---|---|---|
| Close editor on Enter | On | Pressing Enter in the quick card-title editor confirms and closes it. Turn off to insert a newline instead (useful when titles often span multiple lines). |

**Security** — change password.

---

## WIP limits and hard enforcement


WIP limits can now be configured in two modes: **soft** (advisory, admins can override) or **hard** (strict, no override for any role). When hard enforcement is enabled in **Board Settings → Rules → Enforce WIP hard**, moves into a full column are blocked for everyone — including board admins and site admins. The move API returns `409` with code `wip_hard_blocked`, and the board shows a `⛔` toast rather than the `⚠` used for soft blocks.

Weight limits work the same way: the corresponding **Enforce weight limits** setting blocks moves that would push a column's total weight over its budget.

→ [Board & Cards — Hard WIP enforcement](board.md#hard-wip-enforcement)

---

## Saved filters

> **Added in 1.0** · **Tab pills added in 1.1**

Save any combination of filters (search text, assignee, labels, priority, due date) under a name and restore it in one click from the **Saved** dropdown in the filter bar. Saved filters are stored server-side and persist across devices. They are private to each user — other board members cannot see or modify your presets. Any board role, including Viewer, can manage their own saved filters.

→ [Saved Filters](saved-filters.md)

---

## Card density

> **Added in 1.1**

Each board has an admin-controlled **Card density** setting (Comfortable / Standard / Dense) that controls how much metadata appears on the card face. New boards default to Comfortable — one urgency badge, one label, checklist progress, and the assignee avatar. Dense reproduces the pre-1.1 layout and is the default for boards upgraded from 1.0. Boards upgraded automatically are set to Dense; admins can adjust the setting at any time in **Board Settings → Display**.

The previous per-user per-field hide toggles (Labels / Due date / Assignee / Priority badge / Last moved) are removed in 1.1. Card density is the single layout knob, and `localStorage` values for the old keys are silently ignored.

→ [Board & Cards — Card density](board.md#card-density)

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

Within the card detail History tab, the **Show full history** toggle now persists across card opens, page refreshes, and sessions via `localStorage`. Users who prefer the expanded view no longer need to re-enable it each time.

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

→ [Authentication](../administration/authentication.md#generic-oidc-beta)

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

Connect a public GitHub or GitLab repository to a board and view its issues as a read-only kanban grid — with the swimlane dimension that native provider boards lack. Configure columns (status labels or Open/Closed) and swimlanes (milestone, label, or assignee) in board settings. The lens is off by default; operators enable it with `GIT_LENS_ENABLED=true`.

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
