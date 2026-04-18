# Board & Cards

!!! note "Desktop only"
    The board view is designed for desktop browsers (1024 px and wider). Below that width, the authenticated app shows a desktop-only notice rather than a degraded layout — drag-and-drop, column resizing, and swimlane resizing require a pointer device and horizontal space that phones and portrait tablets can't provide. A mobile-optimized layout is planned for a future release.

## Board creation

When creating a new board, you can select from a set of pre-built templates in the **Create Board** modal. Each template provides a tailored column layout and a first swimlane so you can start working immediately. Eleven templates are available, covering workflows such as Sales Pipeline, Customer Support, Product Roadmap, Project Delivery, Hiring & Recruiting, and more. If no template fits your needs, select **Blank board** to start with the default columns (Backlog, To Do, Doing, Done).

Templates are applied once at creation time — after the board is created you can rename, reorder, add, or remove columns freely.

## Board layout

The board is a CSS grid with columns on the x-axis and swimlane rows on the y-axis. Each cell is a droppable zone identified as `cell:{column_id}:{swimlane_id}`.

- Column headers are sticky on horizontal scroll
- WIP limit exceeded → header turns red; when enforcement is enabled, moves into a full column are blocked
- Weight limit exceeded → header turns orange; when enforcement is enabled, moves that would exceed the budget are blocked

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane's label panel has a 4 px color stripe on its left edge (matching the swimlane's assigned color), making it easy to identify swimlanes at a glance even when the board is dense.

The swimlane label sidebar is resizable: drag its right edge to set the width (minimum ~56 px, maximum 400 px). Width is persisted per-board in localStorage.

Each swimlane row height is resizable: drag the bottom edge of any swimlane row to set a minimum height. Height is persisted per-swimlane per-board in localStorage.

Each swimlane has the following fields:

| Field | Description |
|---|---|
| Name | Required; unique per board |
| Color | Left-edge stripe color on the label panel |
| Contact email | Optional; displayed in the label panel for admins only (hidden from members and viewers) |
| Notes | Optional free-text field; visible in the Edit Swimlane modal for admins only |
| Position | Controls row order on the board |

!!! note
    The `contact_email` and `notes` fields are restricted to board admin and site admin roles. Members and viewers do not receive this data via the REST API or WebSocket events.

Each swimlane can be collapsed to save vertical space. Click the chevron on the label panel to toggle. When collapsed:

- The row shrinks to its minimum height — the stored row min-height is ignored
- Each column cell renders as a narrow compact box showing only the card count (empty cells show nothing)
- The label panel shows only the swimlane name and collapse toggle; the contact email and edit button are hidden
- Click the chevron again to expand and restore full card visibility

Admins can double-click the swimlane label to open the Edit Swimlane modal.

### Swimlane focus mode

> **Added in 1.0.0**

Focus mode collapses all other swimlane rows so you can work with a single swimlane without distraction — useful on dense boards with many swimlanes.

**Entering focus mode:**

Hover over any swimlane label panel to reveal the crosshair icon (⊙) in the top-right corner of the label. Click it to enter focus mode for that swimlane. The icon is always visible (highlighted in blue) when that swimlane is currently focused.

**What changes when focus is active:**

- All other swimlane rows are collapsed and their cards are hidden
- A blue banner appears between the board toolbar and the scroll area: "Focused on: *[swimlane name]*"
- The URL updates to include `?focus=<swimlane_id>` — focus mode can be bookmarked and shared

**Exiting focus mode:**

- Click **Exit focus** in the blue banner
- Press **Escape**
- Reload the page without the `?focus=` param

On exit, the swimlane collapse state is restored to exactly what it was before focus was entered.

**Edge cases:**

- If the focused swimlane is deleted while focus mode is active (e.g. by another session), focus mode exits automatically and the collapse state is restored
- If the `?focus=` URL param contains an ID that no longer exists on the board, it is silently ignored

## Collapsed columns

Clicking a column header collapses it to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes
- Each swimlane cell shows the card count for that specific swimlane
- The column header continues to show the aggregate total across all swimlanes
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count — so hidden results are visible without expanding every column

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **color**
- **WIP limit** — maximum number of active cards allowed. When a limit is set, the header shows `WIP N/M`; when exceeded the count turns red. If the board has **Enforce WIP limits** enabled (Board Settings → Rules), moving a card into a column at or over its limit returns a `409` error — board admins can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged. See [Hard WIP enforcement](#hard-wip-enforcement) for a stricter mode.
- **Weight limit** — maximum total card weight (story points / effort) allowed. The weight row is only shown when the column's total weight is non-zero; it turns orange when the limit is exceeded. If the board has **Enforce weight limits** enabled (Board Settings → Rules), moving a card that would push the column over its budget returns a `409` error — board admins can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged.
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected
- **Done column** — mark a column as the completion target for cycle-time and throughput metrics; multiple done columns are supported (e.g. "Done" and "Released")

Columns can be reordered by dragging the column header left or right. Admins can rename a column inline by clicking its name (Enter to confirm, Escape to cancel), open the full edit modal via the ✎ icon or by double-clicking the column header, and delete a column by dragging it to the column trash zone or by clicking the **Delete column** button at the bottom of the column settings modal.

### Adding columns and swimlanes

The 16 px separators between columns and between swimlane rows are interactive insertion handles:

- **Column separators** (vertical, between columns): hover to see a centered **+**; click to insert a new column to the right; drag left/right to resize the column to the left
- **Row separators** (horizontal, between swimlane rows): hover to see a **+** at each column's center; click to insert a new swimlane below; drag up/down to resize the swimlane above

Both handle types highlight in blue when hovered and the "+" affordance is visible across the full extent of the separator — column highlight extends through every row separator, and row highlight extends across the full board width.

The far-left separator (between the swimlane label column and the first board column) follows the same design and resizes the swimlane label sidebar on drag.

### Column trash zone

When dragging a column, a red **Delete** drop target appears at the right edge of the board. Drop the column on it to delete it. A confirmation dialog shows the number of cards that will be lost before proceeding.

### Hard WIP enforcement

> **Added in 1.0.0**

By default, WIP limit enforcement is "soft" — board admins can bypass a full column by appending `?force=true` to the move request. The **Enforce WIP hard** board setting removes this override entirely. When enabled:

- Card moves into a column at or over its WIP limit are blocked for **all roles**, including board admins and site admins.
- The `?force=true` query parameter is ignored — there is no bypass.
- The API returns a `409` error with `code: "wip_hard_blocked"`.
- The toast indicator uses a `⛔` icon instead of `⚠` to distinguish hard blocks from soft blocks.

Hard enforcement is **off by default**. Enable it in **Board Settings → Rules → Enforce WIP hard**. Toggling it on requires an inline confirmation step because the change takes effect immediately and applies board-wide.

!!! tip
    Hard WIP enforcement is useful for teams that treat WIP limits as a strict policy rather than a guideline. To unblock a column, move a card out of it or ask an admin to raise the WIP limit.

## Cards

Cards are displayed as compact tiles with a full colored border indicating priority. Cards communicate their full status at a glance — a filled priority badge (medium and above) in a color matching the border, assignee avatar, label pills showing truncated names (up to 7 characters), checklist progress, and due date are visible directly on the card face. Overdue due dates are shown in red. If a cell contains 2 or more cards, a faint card count badge appears in its top-right corner.

Empty cells show a dashed border to indicate they are valid drop targets even when no cards are present.

Click a card to open its **detail panel** on the right side. The panel contains all editable fields plus two tabs:

- **Details** — description, priority, assignee, labels, due date, weight, checklist, attachments, and comments. The Checklist and Attachments sections are collapsible via a chevron toggle; each auto-collapses when empty on load. A scroll gradient at the bottom of the panel indicates there is more content below the visible area.
- **History** — the full movement and activity timeline. See [Card History](card-history.md).

The Details tab also includes a **Move to** section at the bottom (visible to members and above). It lets you move the card to a different column and/or swimlane without closing the panel — select the destination swimlane and column from the dropdowns, then click **Move**. WIP and weight limits are enforced the same way as drag-and-drop moves.

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Rich text with a toolbar (bold, italic, code, lists, heading, blockquote); stored as markdown. See [Card Descriptions](card-descriptions.md). |
| Priority | `low` / `medium` / `high` / `urgent` — shown as a full colored border and a filled badge on the card face (low is unmarked) |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select; displayed on the card as truncated pills (up to 7 characters) |
| Due date | Optional date; past dates are disabled in the picker; shown as relative text on the card ("Today", "Tomorrow", "3d", "2d late"); overdue dates appear in red |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE`) |
| Comments | Threaded, visible to all board members; type `@` to mention a member; timestamps show relative time ("5m ago", "3h ago") for recent comments and full date + time for older ones |

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic** — the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

### Board panning

Hold **Space** and drag to pan the board in any direction. This is useful on dense boards where the visible area is smaller than the full grid. Release Space to return to normal drag-to-move mode.

## Bulk card operations

Select multiple cards by clicking the checkbox that appears in the top-right corner of each card on hover. Selected cards are highlighted with a blue ring. A **bulk action toolbar** appears fixed at the bottom of the board when one or more cards are selected.

| Action | Description |
|---|---|
| **Move to...** | Move all selected cards to a target column (each card stays in its current swimlane) |
| **Assign to...** | Set or clear the assignee on all selected cards |
| **Priority...** | Set priority on all selected cards |
| **Archive** | Archive all selected cards — they are removed from the board view and can be restored from the **Archived** panel in the toolbar |
| **Delete** | Delete all selected cards (with confirmation) |

Press **Escape** or click the **×** button to clear the selection. Selection is also cleared when starting a drag or opening a card detail panel. Bulk operations are only available to users with the **member** role or above.

Each bulk action calls the existing individual card API endpoints via `Promise.allSettled`, so partial failures are handled gracefully.

## Right-click to add

Right-click any board cell to open an inline card creation input directly in that column + swimlane.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `f` | Toggle the filter bar |
| `/` | Open the filter bar and focus the search input |
| `?` | Show / hide the keyboard shortcuts overlay |
| `Esc` | Deselect cards / close the card detail panel or any open dialog |
| `Space` + drag | Pan the board (see [Board panning](#board-panning)) |

Shortcuts are ignored when focus is inside an input, textarea, or select element.

## Card layout

The toolbar contains a **compact layout toggle** (icon button) that switches between two card display modes:

| Mode | Description |
|---|---|
| **Expanded** (default) | Full card face with title, priority border, label pills, assignee avatar, checklist progress, and due date |
| **Compact** | Narrower cards showing title and priority indicator only — useful on dense boards with many cards per cell |

The preference is stored per-user in `localStorage` under the key `user:prefs:card-layout` and persists across boards and sessions. The toggle's `aria-pressed` attribute reflects the compact state for screen reader users.

## Filtering

Click **Filters** in the toolbar (or press `f`) to open the filter bar below the toolbar. Press `/` to open the filter bar and immediately focus the search input. Filters are applied client-side (no round-trip) and stack — all conditions must match.

| Filter | Options |
|---|---|
| Search | Matches card title, description, assignee name, and label names |
| **My cards** | Quick filter — shows only cards assigned to the current user. Click the **My cards** button in the filter bar to toggle. Active state is indicated by a blue highlight on the button. |
| Assignee | Any board member, or "Unassigned" |
| Labels | One or more labels (card must have all selected) |
| Priority | One or more of low / medium / high / urgent |
| Due date | None set · Overdue · Due today · Due this week |

An active filter count badge appears on the Filters button when filters are in use. Click **Clear** to reset all filters at once.

When all filters are active and no cards match, a **"No cards match"** banner appears across the board area so it is clear the board has cards but none satisfy the current criteria.

### Saved filters

> **Added in 1.0.0**

You can save the current filter combination under a name and restore it later in one click. Saved filters are stored server-side, so they persist across devices and browsers.

**Saving a filter:**

1. Set your desired filters in the filter bar.
2. Click the **Saved** dropdown (to the right of the filter controls).
3. Click **Save current filters**, enter a name, and confirm.

**Loading a saved filter:**

Open the **Saved** dropdown and click any previously saved filter. The filter bar updates immediately.

**Deleting a saved filter:**

Hover over a saved filter in the dropdown to reveal the delete icon. Click it to remove the filter permanently.

Saved filters are private to each user — other board members cannot see or modify your saved filters. Any board member, including viewers, can create, load, and delete their own saved filters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/boards/{id}/saved-filters/` | List saved filters for the current user |
| `POST` | `/api/v1/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/v1/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |

## Views

The toolbar provides four views for the same board data:

| View | Description |
|---|---|
| **Board** | Default kanban grid with drag-and-drop |
| **Summary** | Table of swimlanes with card counts, stage distribution, and 7/30-day velocity |
| **Analytics** | Heatmap of average dwell time per stage, outlier detection, stalled card list, CSV export |
| **History** | Chronological log of all card movements across the board, filterable by swimlane, column, assignee, and date range |

See [Analytics](analytics.md) for details on the Summary and Analytics views.

### History view

> **Added in 1.0.0**

The **History** tab in the board toolbar shows a chronological log of all card movements across the entire board, newest first, paginated at 50 records per page.

#### Filters

All filters are URL-synced and persist across page reloads.

| Filter | Description |
|---|---|
| **Swimlane** | Limit results to cards currently in a specific swimlane |
| **To column** | Limit results to movements whose destination was a specific column |
| **Assignee** | Limit results to cards assigned to a specific member |
| **Moved by** | Limit results to movements performed by a specific member |
| **Moved after** | Lower bound date (inclusive) |
| **Moved before** | Upper bound date (inclusive) |

When no date range is specified, the full movement history is shown.

#### Detail panel

Click any row to open a slide-in detail panel showing the full movement record: card title, from/to column, from/to swimlane, moved by, and any notes recorded at the time of the move.

#### Archive and restore events

Archive and restore events are excluded from the History view by default. They continue to appear on the individual card's **History** tab. Use `exclude_type=archived,unarchived` in the API to control this behavior explicitly.

## Export & import

### Export

Click **Export** in the board toolbar to download the board data:

- **JSON** (recommended) — full board structure including columns, swimlanes, labels, and cards with comments, checklists, assignee, movement history (History tab), and activity log. Use JSON for backups, migrations, and any situation where full card history must be preserved.
- **CSV** — one row per card with columns for ID, title, description, column, swimlane, priority, assignee, labels, due date, weight, dates, and movement history. Cards are imported without movement history or activity log. Use CSV when you need the data in a spreadsheet.

Export requires **Member** role or above. Viewers and collaborators cannot export. The export endpoints are:

- `GET /api/v1/boards/{id}/export/` — CSV
- `GET /api/v1/boards/{id}/export/?format=json` — JSON

### Import

Click **Import** on the dashboard to create a new board from a previously exported Visiban JSON or CSV file. The import atomically creates a new board with all structure (columns, swimlanes, labels) and cards.

**JSON import** restores full card history:

- Assignee (matched by username; cards whose assignee username is not found in this instance are imported unassigned)
- Movement history — every column transition appears in the card's **History** tab
- Activity log — assignee changes, label changes, priority changes, due-date changes, checklist events, and comments all appear in the activity feed

**CSV import** creates cards with their current field values only. Movement history and activity log are not restored.

An optional board name override can be specified at import time.

!!! warning "Import limits"
    To prevent runaway server load, imports are rejected if the file exceeds any of these limits:

    | Resource | Limit |
    |----------|-------|
    | Cards | 500 |
    | Columns | 50 |
    | Swimlanes | 100 |
    | File size | 10 MB |

    Boards exported from Visiban stay well within these limits in normal use. If you are migrating from an external tool and your board exceeds a limit, split it into smaller boards before importing.

!!! note "JSON vs CSV import fidelity"
    JSON imports restore movement history, activity log, and assignees (matched by username). CSV imports create cards with their current field values only — no history or activity log is restored.

- `POST /api/v1/boards/import/` — multipart file upload

## Board member management

Admins can manage board members directly from the board toolbar via the **Members** button. This allows assigning all four roles (admin, member, collaborator, viewer) independently of group membership. Press **Escape** or click **×** to close the dialog. See [Roles & Permissions](rbac/roles.md) for what each role can do.

## Real-time indicator

The toolbar shows a pulsing green **Live** dot in the top-right area when the WebSocket connection is active. The dot is static and grey when disconnected. Board state updates automatically when other users move cards or make changes. See [Real-time Updates](realtime.md).

## Activity drawer

> **Added in 1.1.0**

A right-hand panel that streams the most recent board events — card moves, creations, and membership changes — as they happen. Open and close it with **⌘\\** (Ctrl+\\ on Linux/Windows) or the activity button in the board toolbar.

The drawer has two filter rows:

- **Kind**: *All*, *Moves* (includes creations), *Members*
- **Window**: *1h*, *24h*, *7d* — defaults to **24h** so the drawer stays focused on today's activity rather than all history. Widen to **7d** to scan back through the week, or narrow to **1h** for what's happened in the last hour.

The drawer is a live summary, not the canonical audit trail. For the full ordered history with no window filter, click **Open full history →** at the bottom of the drawer (also reachable from any card's **History** tab — see [Card History](card-history.md)).

## Board sharing

> **Added in 1.0.0**

Board admins can generate a public read-only link that lets anyone view the board without signing in.

### Enabling a share link

1. Open **Board Settings** and go to the **Sharing** tab.
2. Toggle **Enable public share link** to the on position.
3. A URL in the format `https://<host>/share/<token>` is displayed with a **Copy** button.

Share that URL with anyone — recipients do not need a Visiban account.

### What the public view shows

The public view renders the full board grid (columns, swimlane rows, and cards) in read-only mode. The following card metadata is visible:

- Title
- Labels
- Checklist progress (e.g. 2/5)
- Due date
- Weight
- Assignee name

Drag-and-drop, card click-to-open, and all editing actions are disabled in the public view.

### Revoking a share link

Toggle **Enable public share link** off to revoke the current token immediately. Any visitor who follows the old URL will see a "This board is no longer shared" page with a link to sign in. Toggling sharing back on generates a new token — the previous link cannot be restored.

### Rate limiting

The public board endpoint is rate-limited to **120 requests per hour per IP address** to prevent token enumeration.

### API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/boards/{id}/share/` | Board admin | Generate or regenerate the share token |
| `DELETE` | `/api/v1/boards/{id}/share/` | Board admin | Revoke the share token |
| `GET` | `/api/share/{token}/` | None (public) | Read-only board payload; rate-limited |
