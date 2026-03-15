# Board & Cards

## Board layout

The board is a CSS grid with columns on the x-axis and swimlane rows on the y-axis. Each cell is a droppable zone identified as `cell:{column_id}:{swimlane_id}`.

- Column headers are sticky on horizontal scroll
- Each column shows a live card count and total weight
- WIP limit exceeded → header turns red (visual warning only — the API does not block cards)
- Weight limit exceeded → header turns orange (visual warning only)

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane can be collapsed to save vertical space.

## Collapsed columns

Clicking a column header collapses it to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes
- Each swimlane cell shows the card count for that specific swimlane
- The column header continues to show the aggregate total across all swimlanes
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count — so hidden results are visible without expanding every column

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **color**
- **WIP limit** — maximum number of cards allowed. When exceeded the column header turns red as a visual warning
- **Weight limit** — maximum total card weight allowed. When exceeded the header turns orange
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected

Columns can be reordered by dragging the column header left or right. Hover any column header to reveal **+** buttons at its left and right edges — click either one to insert a new column immediately beside it without needing to drag-reorder afterward. Admins can also edit or delete a column by clicking its header.

### Column trash zone

When dragging a column, a red **Delete** drop target appears at the right edge of the board. Drop the column on it to delete it. A confirmation dialog shows the number of cards that will be lost before proceeding.

## Cards

Cards are displayed as compact horizontal rows with a colored left border indicating priority. Hovering over a card expands it inline to show additional metadata without opening the detail panel.

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Markdown-friendly text |
| Priority | `low` / `medium` / `high` / `urgent` — shown as a colored left border |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select |
| Due date | Optional date; past dates are disabled in the picker; shown as relative text on the card ("Today", "Tomorrow", "3d", "2d late") |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE`) |
| Comments | Threaded, visible to all board members; type `@` to mention a member; timestamps show relative time ("5m ago", "3h ago") for recent comments and full date + time for older ones |

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic** — the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

## Bulk card operations

Select multiple cards by clicking the checkbox that appears in the top-right corner of each card on hover. Selected cards are highlighted with a blue ring. A **bulk action toolbar** appears fixed at the bottom of the board when one or more cards are selected.

| Action | Description |
|---|---|
| **Move to...** | Move all selected cards to a target column (each card stays in its current swimlane) |
| **Assign to...** | Set or clear the assignee on all selected cards |
| **Priority...** | Set priority on all selected cards |
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

Shortcuts are ignored when focus is inside an input, textarea, or select element.

## Filtering

Click **Filters** in the toolbar (or press `f`) to open the filter bar. Press `/` to open the filter bar and immediately focus the search input. Filters are applied client-side (no round-trip) and stack — all conditions must match.

| Filter | Options |
|---|---|
| Search | Matches card title, description, assignee name, and label names |
| Assignee | Any board member, or "Unassigned" |
| Labels | One or more labels (card must have all selected) |
| Priority | One or more of low / medium / high / urgent |
| Due date | None set · Overdue · Due today · Due this week |

An active filter count badge appears on the Filters button when filters are in use. Click **Clear** to reset all filters at once.

## Views

The toolbar provides three views for the same board data:

| View | Description |
|---|---|
| **Board** | Default kanban grid with drag-and-drop |
| **Summary** | Table of swimlanes with card counts, stage distribution, and 7/30-day velocity |
| **Analytics** | Heatmap of average dwell time per stage, outlier detection, stalled card list, CSV export |

See [Analytics](analytics.md) for details.

## Export & import

### Export

Click **Export** in the board toolbar to download the board data:

- **CSV** — one row per card with columns for ID, title, description, column, swimlane, priority, assignee, labels, due date, weight, dates, and movement history
- **JSON** — full board structure including columns, swimlanes, labels, and cards with comments and checklists

Export is available to all board members (viewer and above). The export endpoints are:

- `GET /api/boards/{id}/export/` — CSV
- `GET /api/boards/{id}/export/?format=json` — JSON

### Import

Click **Import** on the dashboard to create a new board from a previously exported Visiban JSON or CSV file. The import atomically creates a new board with all structure (columns, swimlanes, labels) and cards (including comments and checklist items for JSON imports). An optional board name override can be specified.

> **Limitation:** Card assignees are not preserved on import — all cards are imported as unassigned. Reassign cards manually after import, or use the bulk assign action.

- `POST /api/boards/import/` — multipart file upload

## Board member management

Admins can manage board members directly from the board toolbar via the **Members** button. This allows assigning all four roles (admin, member, collaborator, viewer) independently of group membership. Press **Escape** or click **×** to close the dialog. See [Roles & Permissions](rbac/roles.md) for what each role can do.

## Real-time indicator

The toolbar shows a green **Live** dot in the top-right area when the WebSocket connection is active. Board state updates automatically when other users move cards or make changes. See [Real-time Updates](realtime.md).
