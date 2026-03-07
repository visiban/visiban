# Card History

Every card maintains a full audit trail of movements and field changes.

## Movement history

A `CardMovement` record is created whenever a card changes column or swimlane. Each record captures:

- From column / to column
- From swimlane / to swimlane
- Who moved it (`moved_by`)
- When (`moved_at`)
- Optional notes

Pure position reorders within the same cell do **not** create a movement record.

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

Movement entries display the full column and swimlane names, preserved even if those columns or swimlanes have since been renamed or deleted.

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

Movement records include `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name`, `moved_by`, and `moved_at` — all denormalised so historical data remains accurate regardless of future renames.
