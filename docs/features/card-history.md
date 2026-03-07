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

## API access

Movement history and the activity log are accessible via the API:

```
GET /api/boards/{board_id}/cards/{card_id}/movements/
GET /api/boards/{board_id}/cards/{card_id}/activities/
```
