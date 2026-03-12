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

## Card detail

Click any card to open a side panel with full context:

- **Priority** — low / medium / high / urgent, shown as a color-coded left border
- **Assignee** — any board member; triggers a notification on assignment
- **Labels** — board-scoped tags for filtering and grouping
- **Due date** — optional deadline
- **Weight** — numeric effort estimate for WIP and capacity tracking
- **Checklist** — sub-tasks with progress tracking
- **Attachments** — upload files directly to a card (up to 10 MB each)
- **Comments** — threaded discussion visible to collaborators and above
- **History tab** — full movement timeline and activity log

→ [Card History](card-history.md)

---

## Bulk operations & data portability

Select multiple cards at once and apply bulk actions — move to a column, assign, set priority, or delete — all from a toolbar that appears at the bottom of the board.

Export your board as CSV or JSON for backup or analysis, or import a previously exported board to recreate it with all its structure and cards.

→ [Board & Cards](board.md#bulk-card-operations) · [Export & Import](board.md#export--import)

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

Four board roles let you grant exactly the right level of access: **admin**, **member**, **collaborator** (comment-only), and **viewer** (read-only).

→ [Groups](groups.md) · [Roles & Permissions](../rbac/roles.md)

---

## Navigation

The application sidebar gives you persistent access to your full group and board hierarchy from any page. It collapses to a 48 px icon rail to save space, expands back to 220 px, and remembers both states across reloads via `localStorage`. The active board is highlighted automatically based on the current route.

The sidebar is visible only on desktop (1024 px and wider). On mobile, use the top navigation bar instead.

→ [Navigation](navigation.md)

---

## What to read next

New to Visiban? We recommend this order:

1. [Board & Cards](board.md) — understand the grid, cards, and how to move things
2. [Card History](card-history.md) — see what the audit trail captures
3. [Groups](groups.md) — organize your boards and invite your team
4. [Analytics](analytics.md) — find bottlenecks and track velocity
5. [Notifications](notifications.md) — stay on top of stale work
