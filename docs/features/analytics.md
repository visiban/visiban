# Analytics & Summary

Switch between board views using the toggle in the toolbar: **Board**, **Summary**, **Analytics**.

## Summary view

Shows a table of all swimlanes with:

- Total card count with an inline proportional bar
- **7-day velocity** — cards that moved into any column marked `is_done = true` in the last 7 days
- **30-day velocity** — same over 30 days

Columns are marked as done in the **Edit Column** modal ("Mark as done column" checkbox). Multiple done columns are supported — for example, boards with both a "Done" and a "Released" column will count movements into either as completed. See [Board & Cards — Columns](board.md#columns).

Useful for a quick health check across all active pipelines.

**API:** `GET /api/boards/{id}/summary/`

## Analytics view

Shows time-in-stage data derived from `CardMovement` records.

### Dwell time heatmap

A table with swimlanes as rows and columns (stages) as columns. Each cell shows the median days a card spent in that stage. Cells are color-coded:

| Color | Meaning |
|---|---|
| Green | At or below the board median |
| Yellow | Up to 2× the board median |
| Red | More than 2× the board median (outlier / bottleneck) |

### Period toggle

Switch between **7 days**, **30 days**, and **90 days** to control which card movements are included in the calculation.

### Dwell time and archived cards

Analytics includes archived cards as part of the historical record. When a card is archived, its dwell time in the most recent stage is calculated using the **archive timestamp** as the exit time — not the current date. This means archived cards accurately reflect how long they were actively worked on, and dwell times stop accumulating at the moment of archiving.

Active cards continue to accumulate dwell time in their current stage until they move again.

Dwell-time calculations use only `movement_type = move` events. Archive and restore events are excluded so that archiving a card does not distort the time-in-stage figures for surrounding cards.

### Stalled cards

Below the heatmap, cards that haven't moved in more than the configured stalled-days threshold are listed with their swimlane, column, assignee, and days since last movement. Click any row to open the card detail panel directly — no need to navigate back to the board view first.

Archived cards are excluded from stalled card detection — they are no longer in-flight and flagging them as stalled would be misleading.

### Empty period

When the selected time window contains no movement data at all (for example, a newly created board or a period before the board had any activity), the analytics view shows an informational message rather than an empty heatmap. Widen the period or add some card movements to populate the view.

### CSV export

Click **Export CSV** to download the heatmap data as a comma-separated file for use in spreadsheets. The export button is only visible to **admin** and **site_admin** users.

**API:** `GET /api/boards/{id}/analytics/?days=30&stalled_days=7`

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | Must be a positive integer (`≥ 1`). Returns `400` if non-integer or `≤ 0`. |
| `stalled_days` | integer | `7` | Must be a positive integer (`≥ 1`). Returns `400` if non-integer or `≤ 0`. |
