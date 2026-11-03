# Find bottlenecks and measure velocity

<a id="analytics-summary-beta"></a>

Switch the toolbar toggle (**Board**, **Summary**, **Analytics**) to see where cards stall and how fast work finishes. **Beta.**

**Why it matters:** The two views turn your board's movement history into bottleneck and velocity data, for anyone checking pipeline health rather than moving cards.

!!! warning "Done columns must be marked before analytics data is accurate"
    The dwell-time heatmap excludes columns that are marked as done. If your "Done" or "Released" column is not marked, closed work continues to accumulate dwell cycles and distorts the heatmap.

    To mark a column as done: **Board → Column header overflow menu → Edit → "Mark as done column" checkbox**.

    The Summary view's velocity counts and the flow charts rely on this flag too: a card counts as finished the first time it enters a marked-done column. See [Board Setup](../getting-started/board-setup.md) for a step-by-step walkthrough.

## Flow metric definitions

These are the definitions every flow metric follows. They are quoted verbatim from the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions) decision record, which also covers reopened cards, missing history, percentiles and time zones.

- **Lead time:** the time from when a card was created to its first entry into a done column. A card created in a done column has no lead time.
- **Cycle time:** the time from a card's first move out of the column it was created in, to a column that is not done, until its first entry into a done column. A card created in a done column, or moved straight from its first column to done, has no cycle time.
- **Dwell time:** how long a card stayed in one column, from entering it to leaving it, or until now if it is still there. Moving to another swimlane does not end a stay. Archiving ends it, and restoring starts a new one.
- **Age:** how long an in-progress card has been in progress: the time since it first moved out of the column it was created in, or since it last left a done column, whichever is later.
- **Throughput:** the number of cards whose first entry into a done column falls in a period.
- **WIP:** the number of cards, not archived, currently in each column that is not done.
- **Cumulative flow:** for each day, the number of cards in each column at the end of that day.

## Summary view

A table of all swimlanes with:

- the total card count and an inline proportional bar
- **7-day velocity:** cards that first entered a column marked `is_done = true` in the last 7 days, archived since or not. A card counts once, even if it later moves between done columns or is reopened.
- **30-day velocity:** the same over 30 days
- **Blocked** *(1.3+)*: how many active cards in the swimlane (not in a done column) are [blocked](blocked-cards.md) right now, manually or by a relation

Mark columns as done in the **Edit Column** modal ("Mark as done column"). Multiple done columns are supported: a board with both "Done" and "Released" counts the first entry into either as completion. See [Board & Cards — Columns](board.md#columns).

Use it for a quick health check across all active pipelines.

> **Changed in 1.3** (#448)

The velocity columns count cards by first completion. Before, they counted moves into done columns, so a card that bounced between done columns counted more than once and a card archived since left the count. Boards with either pattern see different numbers. `avg_cycle_days` in the API is now the mean [cycle time](#flow-metric-definitions), so it starts at a card's first move out of its creation column rather than at its creation.

**API:** `GET /api/v1/boards/{id}/summary/`

### Extension panels

<span class="vb-version" title="Added in 1.1">1.1+</span>

The summary response includes an `extension_panels` field (always an empty list in the OSS edition). Enterprise extensions can register additional panels here.

> **Added in 1.2** (#1770)

The Summary tab renders `stats` and `table` panels below the swimlane table. See the [extension panel payload](../api/boards.md#extension-panel-payload) for the shape. With no extensions registered, the Summary tab looks the same as before.

> **Changed in 1.2** (#1826)

Each panel declares the lowest board role that may see it. A member below that role does not get the panel, and a panel that declares nothing is shown to board admins only. See [panel visibility by role](../api/boards.md#panel-visibility-by-role).

## Analytics view

Time-in-stage and flow data derived from `CardMovement` records, on one scrolling page: the heatmap, then the [flow metrics](#flow-metrics), then the stalled cards, separated by engraved dividers.

### Flow metrics

<span class="vb-version" title="Added in 1.3">1.3+</span>

Four charts built from the movement log, so you can see how long work takes and where it piles up. Each chart has a one-sentence finding, its definition, and a **Chart | Table** toggle.

**Filters.** **Date range** (the last 30, 90, 180 or 365 days; 90 by default, because a weekly median needs five whole weeks and percentiles need enough finished cards), **Swimlane** and **Label**. Filters use each card's current swimlane and labels. All dates are UTC, and weekends count.

| Chart | Read it as | Marks |
|---|---|---|
| **Cycle time** | How long finished work took. "85th · 8.1d" means 85% of these cards took 8.1 days or less. | One point per finished card. 50th percentile dashed, 85th solid and heavier, 95th dotted. A hollow point was reopened after finishing, and keeps its first finish. |
| **Throughput** | How many cards finish per week. | One point per whole week, its count printed on it, the median dashed. Today's unfinished week is left out, so a partial week never reads as a slow one. |
| **Cumulative flow** | Whether work arrives faster than it finishes. A widening band is a queue. | One band per column, labelled at its right edge, finished work at the bottom. The hatched band is the bottleneck: the column that is not done and grew the most across the range. |
| **WIP aging** | Which unfinished cards are in trouble now. | One dot per in-progress card, over its column. The shaded zones are the cycle-time percentiles. A ringed card is past the 85th percentile, a square is blocked. |

**Too few cards.** A percentile line appears only with enough cards behind it: the 50th needs 5, the 85th needs 7 and the 95th needs 20. Until then the chart leaves that line out and says so, rather than presenting one card's time as a trend. The throughput median needs five whole weeks.

**What is left out.** A card with missing or broken history (for example, imported without its history) has no cycle time or age, and the chart says how many were left out. It still counts toward throughput once it reaches a done column. Blocked time is part of cycle time and age, never subtracted, because the wait is real.

**See the cards behind a number.** Click a point or a day, or use the table, to open a drawer with the card's owner and transitions, or the list of cards behind that week or day. From an aging dot the drawer also shows days in progress, the 85th percentile, blocked time, and time per column. **Open card** opens the card; an archived card has no **Open card**.

**Keyboard.** Tab reaches the filters, each chart's toggle, then the aging dots in column order, and Enter opens the drawer. The table view is the complete keyboard path: every point of every chart is a row there, with a button to open it.

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
| **Throughput** | Average time cards that **left** a stage during the selected period spent there, each stay at its full length. Reflects historical flow efficiency, not current queue depth. | View historical flow over a chosen 7, 30 or 90-day window |

In **Throughput** mode each cell's tooltip shows how many stays are behind its average (for example "5 stays"; a card that visits a stage twice is two stays), and stages with zero throughput show a dash (`—`). The green/yellow/red thresholds apply to both modes, using the same `staleness_threshold_days`.

### Dwell time and archived cards

Analytics includes archived cards as part of the historical record.

- **Archived card:** dwell time in its most recent stage uses the **archive timestamp** as the exit time, not the current date. Dwell stops accumulating when the card is archived.
- **Active card:** keeps accumulating dwell time in its current stage until it moves again.
- **Archive and restore events:** archiving ends a stay and restoring starts a new one, so the archived period is not counted as time in the stage, in either mode.
- **Swimlane moves:** moving a card to another swimlane does not end its stay, in either mode.

> **Changed in 1.3** (#448)

**Age** and **Throughput** follow the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions). Before, a swimlane-only move reset a card's **Age** and split its stay in **Throughput**, a restored card's archived period counted as time in its stage, an archived card added a near-zero stay, and a stay that began long before the selected period was lost. A column deleted and recreated under the same name no longer inherits the old column's history, done flag or blocked time.

### Stalled cards

At the end of the page, a paginated table (25 rows per page) lists cards that haven't moved in more than the effective stalled-days threshold: **Swimlane**, **Card** (title), and **Days Stalled**. A count badge on the section header (for example "3 cards stalled") shows the total. Click a row to open the card detail panel directly.

- **Default threshold:** the board's `staleness_threshold_days`.
- **Override:** pass the `stalled_days` query parameter. It affects only the stalled list, not the heatmap coloring.
- **Excluded:** archived cards and cards in done columns, since they are no longer in flight and flagging them would mislead.

### Blocked time

<span class="vb-version" title="Added in 1.3">1.3+</span>

Below the heatmap, **Blocked time (last N days)** shows how long cards were [manually blocked](blocked-cards.md) during the selected period, and why:

- **Per column:** blocked days and number of blocks, by the column each card was in when it was blocked. Only columns with a block in the period are listed. A block in a column that was since deleted has no line here, even if a new column has the same name; it still counts toward the reasons below.
- **Top reasons:** the ten most common reasons, with how many blocks and how many days each one cost. Reasons that differ only in capitals or spacing count as one.

A block counts for the part of it inside the period. A block that is still open counts up to now; on a card that is archived it stops at the archive, and if the card is restored it counts up to now again, archived period included. A deleted card's finished blocks still count, and their reasons still appear, as its movements do in the heatmap; a block that was still open when the card was deleted is left out, reason included. Times under a day show in hours. Blocks by another card (relations) are not timed. The section is hidden when nothing was blocked in the period.

### Empty period

When the selected window has no movement data at all (a new board, or a period before any activity), the view shows an informational message instead of an empty heatmap. Widen the period or add some card movements.

### CSV export

Click **Export CSV** to download the heatmap data for spreadsheets. It includes all active columns, the velocity column, and a stalled card count per swimlane. The button is visible only to **admin** and **site_admin** users.

### API reference

**API:** `GET /api/v1/boards/{id}/analytics/?days=30`. The charts use the [flow metrics endpoints](../api/boards.md#flow-metrics).

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
