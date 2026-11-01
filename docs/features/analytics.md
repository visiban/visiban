# Find bottlenecks and measure velocity

<a id="analytics-summary-beta"></a>

Switch the toolbar toggle (**Board**, **Summary**, **Analytics**) to see where cards stall and how fast work finishes. **Beta.**

**Why it matters:** The two views turn your board's movement history into bottleneck and velocity data, for anyone checking pipeline health rather than moving cards.

!!! warning "Done columns must be marked before analytics data is accurate"
    The dwell-time heatmap excludes columns that are marked as done. If your "Done" or "Released" column is not marked, closed work continues to accumulate dwell cycles and distorts the heatmap.

    To mark a column as done: **Board → Column header overflow menu → Edit → "Mark as done column" checkbox**.

    The Summary view's velocity counts rely on this flag too: only movements into marked-done columns are counted as completed work. See [Board Setup](../getting-started/board-setup.md) for a step-by-step walkthrough.

## Flow metric definitions

These are the definitions every flow metric follows. They are quoted verbatim from the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions) decision record, which also covers reopened cards, missing history, percentiles and time zones.

- **Lead time:** the time from when a card was created to its first entry into a done column. A card created in a done column has no lead time.
- **Cycle time:** the time from a card's first move out of the column it was created in, to a column that is not done, until its first entry into a done column. A card created in a done column, or moved straight from its first column to done, has no cycle time.
- **Dwell time:** how long a card stayed in one column, from entering it to leaving it, or until now if it is still there. Moving to another swimlane does not end a stay. Archiving ends it, and restoring starts a new one.
- **Age:** how long an in-progress card has been in progress: the time since it first moved out of the column it was created in, or since it last left a done column, whichever is later.
- **Throughput:** the number of cards whose first entry into a done column falls in a period.
- **WIP:** the number of cards, not archived, currently in each column that is not done.
- **Cumulative flow:** for each day, the number of cards in each column at the end of that day.

!!! note "Decided in 1.3 (#1532)"
    The Summary and Analytics views below were built before these definitions, and some of their numbers differ. For example, the Summary view's `avg_cycle_days` starts at a card's first movement, and the heatmap's **Age** mode shows current dwell time. The decision record lists each difference. The 1.3 metrics dashboard (#448) brings them in line.

## Summary view

A table of all swimlanes with:

- the total card count and an inline proportional bar
- **7-day velocity:** moves into any column marked `is_done = true` in the last 7 days, for cards that are not archived. It counts moves, not cards: a card that enters a done column twice counts twice, and a card archived since leaves the count.
- **30-day velocity:** the same over 30 days
- **Blocked** *(1.3+)*: how many active cards in the swimlane are [blocked](blocked-cards.md) right now, manually or by a relation

Mark columns as done in the **Edit Column** modal ("Mark as done column"). Multiple done columns are supported: a board with both "Done" and "Released" counts movements into either as completed. See [Board & Cards — Columns](board.md#columns).

Use it for a quick health check across all active pipelines.

**API:** `GET /api/v1/boards/{id}/summary/`

### Extension panels

<span class="vb-version" title="Added in 1.1">1.1+</span>

The summary response includes an `extension_panels` field (always an empty list in the OSS edition). Enterprise extensions can register additional panels here.

> **Added in 1.2** (#1770)

The Summary tab renders `stats` and `table` panels below the swimlane table. See the [extension panel payload](../api/boards.md#extension-panel-payload) for the shape. With no extensions registered, the Summary tab looks the same as before.

> **Changed in 1.2** (#1826)

Each panel declares the lowest board role that may see it. A member below that role does not get the panel, and a panel that declares nothing is shown to board admins only. See [panel visibility by role](../api/boards.md#panel-visibility-by-role).

## Analytics view

Time-in-stage data derived from `CardMovement` records. The heatmap is pinned at the top and always visible. The stalled cards list scrolls independently below it, separated by an engraved divider.

### Dwell time heatmap

Swimlanes are rows and active columns are columns. Each cell shows the average days cards spent in that stage during the selected period.

#### Done column exclusion

Columns marked `is_done = true` are excluded from dwell-time calculations and hidden from the heatmap, because time in a done column is post-completion idle time. The API response lists the excluded column names in `done_columns`, and a footer note reads "N done column(s) not shown".

#### Velocity column

The rightmost column shows **Velocity** per swimlane: the average `deal_velocity_days`, the number of days from a card's first movement ever to its most recent movement, for cards whose most recent movement falls in the selected period. It counts cards whether or not they reached a done column, so it is not cycle time. A dash (`—`) means no velocity data for that swimlane.

#### Color-coding

Cells are colored from the board's `staleness_threshold_days` and `stale_warning_pct`. The warning boundary is `threshold * stale_warning_pct / 100`, the share of the threshold a card has used.

- With the defaults (7 days, 50%), the boundary is 3.5 days. With 75%, it is 5.25 days.
- A value of `0` turns the yellow band off, so cells are green until the threshold.
- The card [aging tint](card-history.md#card-aging-tint) uses the same boundary.

!!! note "Changed in 1.2 (#1841)"
    Before 1.2 the boundary was computed as `threshold * (1 - stale_warning_pct / 100)`, the inverse of what the setting says. Boards on the default 50% are unaffected. Boards with any other value see the yellow band move.

| Color | Marker | Condition |
|---|---|---|
| Green | ● OK | Average dwell time is below the warning boundary |
| Yellow | ◆ Warning | Average is at or above the warning boundary but below the full threshold |
| Red | ▲ High | Average is at or above `staleness_threshold_days` (outlier / bottleneck) |
| Grey / dash | none | No data for that swimlane-column combination |

Color is never the only signal: each colored cell shows its marker next to the value, screen readers announce the level text ("OK", "Warning", "High") after the value, and a legend below the heatmap maps each marker and color to its level.

!!! tip
    Both `staleness_threshold_days` and `stale_warning_pct` are configurable per board in the board settings modal. Changes recolor the heatmap on the next analytics load.

### Period toggle

Switch between **7 days**, **30 days**, and **90 days** to choose which movements count. The toggle appears only in **Throughput** mode (see [View mode: Age vs Throughput](#view-mode-age-vs-throughput)); **Age** mode always reflects the current moment, so there is no period to pick.

### View mode: Age vs Throughput

A button pair in the analytics toolbar toggles the heatmap mode. The choice persists per board in localStorage (`board:{boardId}:analytics-view-mode`) and defaults to **Age**.

| Mode | What the heatmap shows | Use it to |
|---|---|---|
| **Age** | Average time (days) cards have currently been sitting in each stage: a snapshot of in-flight work. High values mean cards blocked or idle right now. | Find current bottlenecks |
| **Throughput** | Average time cards that **exited** a stage during the selected period spent there before moving on. Reflects historical flow efficiency, not current queue depth. | Compare historical flow across periods |

In **Throughput** mode the column footer row shows how many cards contributed to each average (for example "5 cards"), and stages with zero throughput show a dash (`—`). The green/yellow/red thresholds apply to both modes, using the same `staleness_threshold_days`.

### Dwell time and archived cards

Analytics includes archived cards as part of the historical record.

- **Archived card:** dwell time in its most recent stage uses the **archive timestamp** as the exit time, not the current date. Dwell stops accumulating when the card is archived.
- **Active card:** keeps accumulating dwell time in its current stage until it moves again.
- **Archive and restore events:** these are recorded as movements in the card's current column, and the heatmap does not skip them yet. A restored card's archived period is counted as time in its stage, and an archived card adds a near-zero stay to **Throughput** mode. The [flow metric definitions](../architecture/decisions.md#flow-metric-definitions) treat archiving as the end of a stay and restoring as the start of a new one. The 1.3 metrics dashboard (#448) applies them.

### Stalled cards

Below the heatmap, a paginated table (25 rows per page) lists cards that haven't moved in more than the effective stalled-days threshold: **Swimlane**, **Card** (title), and **Days Stalled**. A count badge on the section header (for example "3 cards stalled") shows the total. Click a row to open the card detail panel directly.

- **Default threshold:** the board's `staleness_threshold_days`.
- **Override:** pass the `stalled_days` query parameter. It affects only the stalled list, not the heatmap coloring.
- **Excluded:** archived cards and cards in done columns, since they are no longer in flight and flagging them would mislead.

### Blocked time

<span class="vb-version" title="Added in 1.3">1.3+</span>

Below the heatmap, **Blocked time (last N days)** shows how long cards were [manually blocked](blocked-cards.md) during the selected period, and why:

- **Per column:** blocked days and number of blocks, by the column each card was in when it was blocked. Only columns with a block in the period are listed.
- **Top reasons:** the ten most common reasons, with how many blocks and how many days each one cost. Reasons that differ only in capitals or spacing count as one.

A block counts for the part of it inside the period. A block that is still open counts up to now; one on a card archived while blocked stops at the archive. Blocks by another card (relations) are not timed. The section is hidden when nothing was blocked in the period.

### Empty period

When the selected window has no movement data at all (a new board, or a period before any activity), the view shows an informational message instead of an empty heatmap. Widen the period or add some card movements.

### CSV export

Click **Export CSV** to download the heatmap data for spreadsheets. It includes all active columns, the velocity column, and a stalled card count per swimlane. The button is visible only to **admin** and **site_admin** users.

### API reference

**API:** `GET /api/v1/boards/{id}/analytics/?days=30`

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | `1`–`365`. Returns `400` if non-integer or out of range. |
| `stalled_days` | integer | Board's `staleness_threshold_days` | Optional override, `1`–`90`. Returns `400` if non-integer or out of range. When omitted, the board setting is used. |

The response includes two threshold fields:

| Field | Meaning |
|---|---|
| `staleness_threshold_days` | The board's configured threshold, used for heatmap cell coloring. Always reflects the board setting regardless of any `stalled_days` override. |
| `stalled_threshold_days` | The effective threshold used for the stalled cards list. Equals the board setting by default, or the `stalled_days` query parameter value when provided. |
| `stale_warning_pct` | The board's warning percentage (0--100). Controls the yellow/green boundary in the heatmap. |
| `done_columns` | List of column names excluded from the heatmap because they are marked as done. |
