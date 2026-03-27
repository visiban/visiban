# Card History

Every card maintains a full audit trail of movements and field changes.

## Movement history

A `CardMovement` record is created whenever a card changes column or swimlane. Each record captures:

- From column / to column (FK, nullable after deletion)
- From swimlane / to swimlane (FK, nullable after deletion)
- From column UID / to column UID — stable even after the column is deleted or renamed
- From swimlane UID / to swimlane UID — stable even after the swimlane is deleted or renamed
- Denormalized names at the time of the move (from_column_name, to_column_name, etc.)
- Who moved it (`moved_by`)
- When (`moved_at`) — indexed for query performance
- Optional notes
- **Movement type** (`movement_type`) — one of `move` (standard drag-and-drop or API move), `archived` (card was archived), or `restored` (card was restored from archive)

Pure position reorders within the same cell do **not** create a movement record.

`archived` and `restored` events appear in the individual card timeline but are excluded from the board-level History view by default.

The movement timeline is visible in the card detail panel under the **History** tab.

## Activity log

In addition to movements, the activity log tracks:

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

## Viewing history

Open a card and click the **History** tab in the side panel. The timeline shows movements and field changes in reverse chronological order. Each entry shows:

- What changed (from → to)
- Who made the change
- When it happened (relative time, e.g. "3 days ago")

Movement entries display the full column and swimlane names, preserved even if those columns or swimlanes have since been renamed or deleted. If a referenced column has been deleted since the move occurred, its name is shown in italic red with a **Deleted —** prefix and a hover tooltip, so you can distinguish live columns from removed ones at a glance.

The UID fields on each movement record (`from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`) are also preserved permanently — these are the correct identifiers to use when correlating movement history in an external system. See [Stable UIDs](stable-uids.md).

## How dwell time is calculated

The time a card spends in a column is the gap between two consecutive `CardMovement` records. The Analytics view uses these gaps to compute median dwell time per stage and flag outliers. See [Analytics](analytics.md).

## Stale card detection

If a card's most recent `CardMovement` is older than the board's `staleness_threshold_days` (default: 7 days), the card is considered stale and an amber ⏱ badge appears on the board. See [Notifications](notifications.md).

## API access

Movement history and the activity log are accessible via the API:

```
GET /api/boards/{board_id}/cards/{card_id}/movements/
GET /api/boards/{board_id}/cards/{card_id}/activities/
```

Movement records include `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name`, `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`, `moved_by`, `moved_at`, and `movement_type`. The name and UID fields are denormalized — they are captured at write time and remain accurate regardless of future renames or deletions. See [Stable UIDs](stable-uids.md) for full field reference and integration examples.

## Board-level movement history

> **Added in 1.0.0-rc.10**

In addition to the per-card timeline, the **History** tab in the board toolbar shows movements across all cards on the board. See [Board & Cards — History view](board.md#history-view) for the UI description.

### API

```
GET /api/boards/{id}/movements/
```

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `assignee_id` | integer | Filter by card assignee |
| `moved_after` | ISO date | Lower bound (inclusive) |
| `moved_before` | ISO date | Upper bound (inclusive) |
| `exclude_type` | comma-separated string | Exclude movement types — e.g. `archived,restored` |
| `offset` | integer | Pagination offset (default `0`) |

Page size is fixed at 50. When no date range is supplied, the endpoint defaults to the last 30 days. Archive and restore events are excluded by default by the History view UI (via `exclude_type=archived,restored`), but the API returns all types unless the parameter is provided.
