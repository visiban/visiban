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

When creating a new board you choose from six purposeful templates — Sales Pipeline, Customer Support, Customer Success, Simple Kanban, Product Roadmap, or Project Delivery — each pre-seeded with the right columns and a swimlane placeholder. A Blank Board option is also available for fully custom setups.

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

Stale cards get an ⏱ badge on the board so they're impossible to miss at a glance.

→ [Notifications](notifications.md)

---

## Real-time collaboration

When multiple people are working on a board simultaneously, changes appear instantly without a page refresh. A green **Live** dot in the toolbar confirms the WebSocket connection is active.

Powered by Django Channels and Redis — no configuration required in the default Docker Compose setup.

→ [Real-time Updates](realtime.md)

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

## Stable UIDs

Every board, column, swimlane, label, and card carries a stable 16-character hex UID that never changes even after renames or moves. UIDs are included in JSON exports and are safe to reference in external integrations, webhooks, and scripts.

→ [Stable UIDs](stable-uids.md)

---

## Navigation

The application sidebar gives you persistent access to your full group and board hierarchy from any page. Starred boards and groups appear at the top of the sidebar in dedicated **Favorite Boards** and **Favorite Groups** sections. The sidebar collapses to a 48 px icon rail (with hover tooltips), expands back to 220 px, and remembers both states across reloads via `localStorage`.

Site admins see a **Site Admin** link in the sidebar that opens the administration panel directly. The link is hidden for all other users.

The sidebar is visible only on desktop (1024 px and wider). On mobile, use the top navigation bar instead.

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

**Security** — change password.

---

## What to read next

New to Visiban? We recommend this order:

1. [Board & Cards](board.md) — understand the grid, cards, and how to move things
2. [Card History](card-history.md) — see what the audit trail captures
3. [Groups](groups.md) — organize your boards and invite your team
4. [Analytics](analytics.md) — find bottlenecks and track velocity
5. [Notifications](notifications.md) — stay on top of stale work
