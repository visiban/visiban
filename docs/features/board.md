# Board & Cards

## Board layout

The board is a CSS grid with columns on the x-axis and swimlane rows on the y-axis. Each cell is a droppable zone identified as `cell:{column_id}:{swimlane_id}`.

- Column headers are sticky on horizontal scroll
- Each column shows a live card count and total weight
- WIP limit exceeded → header turns red
- Weight limit exceeded → header turns orange

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane can be collapsed to save vertical space.

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **colour**
- **WIP limit** — maximum number of cards allowed
- **Weight limit** — maximum total card weight allowed
- **Allow card creation** — only columns with this enabled show the add-card input

## Cards

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Markdown-friendly text |
| Priority | `low` / `medium` / `high` / `urgent` — shown as a coloured left border |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select |
| Due date | Optional date |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE`) |
| Comments | Threaded, visible to all board members |

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic** — the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

## Right-click to add

Right-click any board cell to open an inline card creation input directly in that column + swimlane.

## Filtering

The filter bar lets you narrow cards by assignee, priority, and label. Filters are applied client-side.
