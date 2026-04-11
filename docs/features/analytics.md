# Analytics & Summary <span style="background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;vertical-align:middle;letter-spacing:0.3px;">BETA</span>

Switch between board views using the toggle in the toolbar: **Board**, **Summary**, **Analytics**.

!!! warning "Done columns must be marked before analytics data is accurate"
    The dwell-time heatmap excludes columns that are marked as done. If your "Done" or "Released" column is not marked, closed work continues to accumulate dwell cycles and distorts the heatmap.

    To mark a column as done: **Board → Column header overflow menu → Edit → "Mark as done column" checkbox**.

    The Summary view's velocity counts also rely on this flag — only movements into marked-done columns are counted as completed work. See [Board Setup](../getting-started/board-setup.md) for a step-by-step walkthrough.

## Summary view

Shows a table of all swimlanes with:

- Total card count with an inline proportional bar
- **7-day velocity** — cards that moved into any column marked `is_done = true` in the last 7 days
- **30-day velocity** — same over 30 days

Columns are marked as done in the **Edit Column** modal ("Mark as done column" checkbox). Multiple done columns are supported — for example, boards with both a "Done" and a "Released" column will count movements into either as completed. See [Board & Cards — Columns](board.md#columns).

Useful for a quick health check across all active pipelines.

The summary response includes an `extension_panels` field (always an empty list in the OSS edition). Enterprise extensions can register additional panels here.

**API:** `GET /api/v1/boards/{id}/summary/`

## Analytics view

Shows time-in-stage data derived from `CardMovement` records.

### Dwell time heatmap

The heatmap is pinned at the top of the analytics panel and remains visible at all times. The stalled cards list scrolls independently below it, separated by an engraved divider.

The heatmap table has swimlanes as rows and active columns as columns. Each cell shows the average number of days cards spent in that stage during the selected period.

#### Done column exclusion

Columns marked `is_done = true` are excluded from dwell-time calculations and hidden from the heatmap. Time spent in a done column is post-completion idle time and would distort the data if included. The API response includes a `done_columns` field listing the excluded column names, and a footer note below the heatmap reads "N done column(s) not shown".

#### Velocity column

The rightmost column of the heatmap shows **Velocity** per swimlane. This is the average `deal_velocity_days` value — the number of days between a card's first and last movement within the selected period. A dash (`—`) appears when there is no velocity data for a swimlane.

#### Color-coding

Cells are color-coded based on the board's `staleness_threshold_days` setting and its `stale_warning_pct` percentage. The warning boundary is calculated as `threshold * (1 - stale_warning_pct / 100)`. With the defaults of 7 days and 50%, the warning boundary is 3.5 days.

| Color | Condition |
|---|---|
| Green | Average dwell time is below the warning boundary |
| Yellow | Average is at or above the warning boundary but below the full threshold |
| Red | Average is at or above `staleness_threshold_days` (outlier / bottleneck) |
| Grey / dash | No data for that swimlane-column combination |

!!! tip
    Both `staleness_threshold_days` and `stale_warning_pct` are configurable per board in the board settings modal. Adjusting them changes the heatmap coloring immediately on the next analytics load.

#### Capped dwell display

When the average dwell time for a cell is equal to or greater than the selected period (the `days` value), the cell displays a `>=Nd` prefix (for example, `>=30d` on a 30-day period). This signals that the true average may be higher than the displayed value because some dwell intervals extend beyond the analysis window.

### Period toggle

Switch between **7 days**, **30 days**, and **90 days** to control which card movements are included in the calculation.

### Dwell time and archived cards

Analytics includes archived cards as part of the historical record. When a card is archived, its dwell time in the most recent stage is calculated using the **archive timestamp** as the exit time — not the current date. This means archived cards accurately reflect how long they were actively worked on, and dwell times stop accumulating at the moment of archiving.

Active cards continue to accumulate dwell time in their current stage until they move again.

Dwell-time calculations use only `movement_type = move` events. Archive and restore events are excluded so that archiving a card does not distort the time-in-stage figures for surrounding cards.

### Stalled cards

Below the heatmap, cards that have not moved in more than the effective stalled-days threshold are listed with their swimlane, column, assignee, and days since last movement. The stalled cards section scrolls independently and shows a count badge (for example, "3 cards stalled"). Click any row to open the card detail panel directly — no need to navigate back to the board view first.

The default threshold is the board's `staleness_threshold_days` setting. You can override it for a single request by passing the `stalled_days` query parameter — this affects only the stalled cards list and does not change the heatmap coloring.

Archived cards and cards in done columns are excluded from stalled card detection — they are no longer in-flight and flagging them as stalled would be misleading.

### Empty period

When the selected time window contains no movement data at all (for example, a newly created board or a period before the board had any activity), the analytics view shows an informational message rather than an empty heatmap. Widen the period or add some card movements to populate the view.

### CSV export

Click **Export CSV** to download the heatmap data as a comma-separated file for use in spreadsheets. The export includes all active columns, the velocity column, and a stalled card count per swimlane. The export button is only visible to **admin** and **site_admin** users.

### API reference

**API:** `GET /api/v1/boards/{id}/analytics/?days=30`

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | Must be a positive integer (`>= 1`). Returns `400` if non-integer or `<= 0`. |
| `stalled_days` | integer | Board's `staleness_threshold_days` | Optional override. Must be a positive integer (`>= 1`). Returns `400` if non-integer or `<= 0`. When omitted, the board setting is used. |

The response includes two threshold fields:

| Field | Meaning |
|---|---|
| `staleness_threshold_days` | The board's configured threshold, used for heatmap cell coloring. Always reflects the board setting regardless of any `stalled_days` override. |
| `stalled_threshold_days` | The effective threshold used for the stalled cards list. Equals the board setting by default, or the `stalled_days` query parameter value when provided. |
| `stale_warning_pct` | The board's warning percentage (0--100). Controls the yellow/green boundary in the heatmap. |
| `done_columns` | List of column names excluded from the heatmap because they are marked as done. |
