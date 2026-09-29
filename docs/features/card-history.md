# Card History

Every card keeps a full audit trail of movements and field changes. **Why it matters:** you can see who moved a card and when — the record incident retros and audits need.

## Movement history

A `CardMovement` record captures every column or swimlane change. Each record includes:

- From column / to column (FK, nullable after deletion)
- From swimlane / to swimlane (FK, nullable after deletion)
- From column UID / to column UID — stable even after the column is deleted or renamed
- From swimlane UID / to swimlane UID — stable even after the swimlane is deleted or renamed
- Denormalized names at the time of the move (from_column_name, to_column_name, etc.)
- Who moved it (`moved_by`)
- When (`moved_at`) — indexed for query performance
- Optional notes
- **Movement type** (`movement_type`) — one of `move` (standard drag-and-drop or API move), `archived` (card was archived), or `unarchived` (card was unarchived from the Archived panel)

Pure position reorders within the same cell don't create a movement record.

`archived` and `unarchived` events appear in the card's own timeline and in the board-level History view.

Find the movement timeline in the card detail panel's **Activity** tab.

## Activity log

The activity log also tracks field changes:

| Event | Recorded |
|---|---|
| Title change | Old and new title |
| Priority change | Old and new priority |
| Weight change | Old and new weight |
| Assignee change | Old and new assignee name |
| Description change | Flagged (content not stored) |
| Label change | Labels added (+) and removed (-) |
| Comment added | Flagged |
| Attachment added / deleted | Flagged |
| Checklist item added / checked / unchecked / deleted | Item text |
| Due date change | Old and new date (or "none" if cleared) |

!!! note
    Due date change tracking was added in 1.0.

## Viewing history

Open a card and click **Activity** in the side panel. The timeline shows movements and field changes in reverse chronological order. Each entry shows:

- What changed (from → to)
- Who made the change
- When it happened (relative time, e.g. "3 days ago")

Movement entries keep the full column and swimlane names, even after those columns or swimlanes are renamed or deleted. A deleted column's name shows in italic red with a **Deleted —** prefix and a hover tooltip, so you can tell live columns from removed ones at a glance.

### Duration between entries

Each movement entry shows how long the card stayed in that column before the next move — "Spent 3h here" or "Spent 2d here" on the right side of the entry. Durations come from the gap between consecutive movement timestamps, shown in the most readable unit (minutes, hours, or days). The last entry has no duration label, because the card is still there.

### Checklist event grouping

Sequential checklist events of the same type collapse into one grouped entry instead of one row per item — for example, "Added checklist items: "item a", "item b", "item c"". This keeps the timeline compact when bulk checklist edits would otherwise dominate it.

The UID fields on each movement record (`from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`) are also preserved permanently. Use them, not the name or ID fields, to correlate movement history in an external system. See [Stable UIDs](stable-uids.md).

## How dwell time is calculated

Dwell time is the gap between two consecutive `CardMovement` records. The Analytics view uses these gaps to compute median dwell time per stage and flag outliers. See [Analytics](analytics.md).

## Stale card detection

A card is stale if its most recent `CardMovement` is older than the board's `staleness_threshold_days` (default: 7 days) — it gets an amber tint overlay with reduced opacity in the board view. See [Notifications](notifications.md).

## API access

Movement history and the activity log are accessible via the API:

```
GET /api/v1/boards/{board_id}/cards/{card_id}/movements/
GET /api/v1/boards/{board_id}/cards/{card_id}/activities/
```

Movement records include `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name`, `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`, `moved_by`, `moved_at`, and `movement_type`. The name and UID fields are denormalized — captured at write time, accurate regardless of future renames or deletions. See [Stable UIDs](stable-uids.md) for the full field reference and integration examples.

## Board-level movement history

> **Added in 1.0**

The board toolbar's **History** tab shows movements across every card on the board, alongside the per-card timeline. See [Board & Cards — History view](board.md#history-view) for the UI description.

### API

```
GET /api/v1/boards/{id}/movements/
```

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `moved_by_id` | integer | Filter by the user who performed the move |
| `moved_after` | ISO date | Lower bound (inclusive) |
| `moved_before` | ISO date | Upper bound (inclusive) |
| `exclude_type` | comma-separated string | Exclude movement types — e.g. `archived,unarchived` |
| `offset` | integer | Pagination offset (default `0`) |

Page size is fixed at 50. With no date range, the endpoint returns the full movement history. The API returns all movement types, including archive/unarchive, unless you pass `exclude_type=archived,unarchived`. The History view UI doesn't send that parameter, so it shows everything.
