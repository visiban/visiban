# Analytics & Summary

Switch between board views using the toggle in the toolbar: **Board**, **Summary**, **Analytics**.

## Summary view

Shows a table of all swimlanes with:

- Total card count with an inline proportional bar
- **7-day velocity** — cards that moved to the final column in the last 7 days
- **30-day velocity** — same over 30 days

Useful for a quick health check across all active pipelines.

**API:** `GET /api/boards/{id}/summary/`

## Analytics view

Shows time-in-stage data derived from `CardMovement` records.

### Dwell time heatmap

A table with swimlanes as rows and columns (stages) as columns. Each cell shows the median days a card spent in that stage. Cells are colour-coded:

| Colour | Meaning |
|---|---|
| Green | At or below the board median |
| Yellow | Up to 2× the board median |
| Red | More than 2× the board median (outlier / bottleneck) |

### Period toggle

Switch between **7 days**, **30 days**, and **90 days** to control which card movements are included in the calculation.

### Stalled cards

Below the heatmap, cards that haven't moved in more than the configured stalled-days threshold are listed with their swimlane, column, assignee, and days since last movement.

### CSV export

Click **Export CSV** to download the heatmap data as a comma-separated file for use in spreadsheets. The export button is only visible to **admin** and **site_admin** users.

**API:** `GET /api/boards/{id}/analytics/?days=30&stalled_days=7`
