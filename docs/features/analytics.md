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
- **Blocked time:** the time cards spent blocked, reported as its own metric: total, per column and per reason. It is never subtracted from lead time, cycle time, dwell time or age.
- **Needs attention:** the cards, not archived and not in a done column, that are blocked, have been in progress longer than the 85th percentile of cycle time, or have not moved for longer than the board's stalled threshold.

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

Time-in-stage and flow data derived from `CardMovement` records, on one scrolling page. From the top:

1. **Title row:** "Analytics", a **Beta** badge, the board name and the period shown.
2. **Filter bar:** one **Date range**, **Swimlane** and **Label** selection for the whole page (see [Filters](#filters)), and **Export CSV** for admins.
3. **Bottleneck** panel and four [headline tiles](#headline-tiles).
4. **How work flows**, with **Where the time goes** under it; its Table view is the [dwell time heatmap](#dwell-time-heatmap) (see [How work flows](#how-work-flows)).
5. **Cumulative flow** and **Throughput**, side by side.
6. **WIP aging** and the [Needs attention](#needs-attention).
7. **Cycle time** and [Why cards get blocked](#why-cards-get-blocked).
8. A footnote on days, time zone and filters.

From 1024px wide the paired panels sit side by side; below that every panel takes the full width, and the page never scrolls sideways. When the board has no flow history, or no card matches the filters, one message replaces sections 3 to 7 (see [Page states](#page-states)).

<span class="vb-version" title="Changed in 1.3">1.3+</span> Analytics is in beta: data may be incomplete in some configurations, so use the results as directional guidance.

### Swimlanes view

<span class="vb-version" title="Added in 1.3">1.3+</span>

Under the page title, two links switch between **Overview** and **Swimlanes**. The Date range and Label you picked carry over. The selected view is not kept in the URL, so a reload returns to Overview. The Swimlanes view ranks swimlanes by how long work takes:

- **Controls:** Date range, Label, **Group lanes by** (None, or a dropdown or checkbox swimlane custom field; admin-only fields are offered to admins only) and **Sort** (slowest first by default). There is no Swimlane filter, because every swimlane is shown.
- **Finding panel:** names up to two swimlanes that are slower than the board, or says none is.
- **One row per swimlane:** the name (select it to open the Overview filtered to that swimlane) with a status line; a cycle-time bar for the median, a thin line to the 85th percentile and a tick at the board median, all on one scale; eight small bars and a word for the trend inside the period; the share of elapsed time blocked; and cards in progress and finished.
- **Status:** "Slower than the board" or "Faster than the board" when the median is more than 20% away from the board median, otherwise "In line with the board". A swimlane needs 10 finished cards for a status; with 5 to 9 it shows its median and no status line. Color repeats the words and never replaces them.
- **Small samples:** under 5 finished cards a swimlane shows no median, bar or trend; with 5 or 6 it shows no 85th percentile line.
- The server computes every number. See `GET /api/v1/boards/{id}/metrics/swimlanes/` in the [API reference](../api/boards.md).

Below 1024px each row's cells wrap under the name.

### Filters

<span class="vb-version" title="Added in 1.3">1.3+</span>

One filter bar drives every panel on the page, the heatmap, stalled and blocked sections included; no panel has a period control of its own.

- **Date range:** the last 30, 90, 180 or 365 days. **90 by default**, because a weekly median needs five whole weeks and percentiles need enough finished cards.
- **Swimlane** and **Label:** use each card's current swimlane and labels.

A filter change refreshes every panel once. The panels keep showing the previous numbers, dimmed, until the new ones arrive, and an open drawer closes.

!!! note "Changed in 1.3 (#2261)"
    The heatmap's own **7 / 30 / 90 days** buttons are gone, and the 7-day window with them: the heatmap uses the filter bar's date range, so it now defaults to 90 days instead of 30. Pick **Last 30 days** for the old default.

### Break down by

<span class="vb-version" title="Added in 1.3">1.3+</span>

**Break down by** in the filter bar colors the flow charts by group. Pick **None** (the default), **Swimlane**, **Label**, or any dropdown or checkbox card custom field. With **None** the page is unchanged.

- A **legend** under the filter bar names each group with its color. Select a group to isolate it: its marks stay at full strength and the rest fade to 20%. Select it again to show every group. Changing the breakdown clears the isolation.
- **Where the time goes** shows one bar per group, on one scale, so the longest bar is the slowest group.
- **Throughput** bars stack by group. **WIP aging** marks and **Cycle time** dots take the group color; aging marks keep the ring (past the 85th percentile) and the square (blocked).
- Each chart's summary says what the color means, and its table view has a group column, so color is never the only cue. **Cumulative flow** does not change.
- Up to five groups get a color. With more, the five largest are shown and the rest collapse into a neutral **Other**.
- **Labels:** a card with several labels is counted once in each.
- **Custom fields:** cards with no value for the field are left out.
- When no card in the view has a value to break down by, a status line replaces the legend ("No cards in this view have a swimlane to break down by.", or the same for label or the field) and the charts stay uncolored.
- Groups use each card's current swimlane, labels and field values, like the filters.

### Bottleneck

The panel names the column the server reports as the bottleneck (the column that is not done and whose queue grew the most across the period, the hatched band of the cumulative flow chart; the first in-progress column, where new work arrives, is never named) and states its numbers in one sentence:

- **Median wait:** the 50th percentile of completed time in that column ([dwell](#flow-metric-definitions)).
- **Share of the cycle:** the column's median wait divided by the median cycle time, in words ("about half of the whole cycle"). It is a ratio of two medians, worked out in the browser from the numbers the server returns, so it is approximate; it is left out when either median is withheld or the median cycle time is 0.
- **Queue:** cards in the column at the start and end of the period, the column's WIP limit when one is set, and how many cards arrive and leave per week.

**See the N cards** opens the [column drawer](#column-drawer) for that column; **Open on board** goes back to the board. Without a bottleneck the panel says **Too early to say** (no 85th percentile of cycle time yet) or **No bottleneck** (no column's queue grew in the period).

### How work flows

One row, left to right, inside a box that scrolls sideways when the panel is narrower than 980px:

- **Connector** before each column: cards per week entering it, a bar whose thickness follows that rate, and a one- or two-word note ("started", "move on", "fewer leave"). Connectors are neutral, and warning-colored after the bottleneck.
- **Column box** for each in-progress column, a button that opens the [column drawer](#column-drawer): the name, one square per card in the column now, "N of limit" (plus "M over limit"), the median wait, and the queue change over the period ("Queue +7 since Aug 16" or "Queue steady"). **Squares beyond the WIP limit are hollow**, outlined in the danger color. The bottleneck's box has the warning border.
- A final connector and a **Done** box with the number of cards finished in the period.

**Where the time goes** sits under the row: one bar, "All cards" (or one bar per group under [Break down by](#break-down-by)), segmented by in-progress column. A segment's width is the column's median days, labeled with that number; the total is printed at the end. The bottleneck's segment is hatched in the warning color. When no median is available yet, the panel says so instead.

A **Chart | Table** switch on the panel changes it to the [dwell time heatmap](#dwell-time-heatmap) table.

### Column drawer

Opens from a column box or from the bottleneck panel's **See the N cards** button, and traps focus until you close it (Escape, the close button, or the backdrop); focus returns to the button that opened it. It shows the column name and "N cards in this column now, limit L", three figures (in column against the limit, median wait, cards past the 85th percentile of cycle time), the oldest card expanded with its owner, swimlane and blocked state, its time by column and an **Open card** button, then the other cards oldest first. Five show at first; **Show N more** reveals the rest. Choosing a card in the list shows its transitions, with **Back** returning to the column.

### Headline tiles

| Tile | Number | Sentence |
|---|---|---|
| **Cycle time** | Median days | The 85th percentile and how many finished cards it is based on |
| **Throughput** | Median cards per week | How many whole weeks, and how many cards finished |
| **Work in progress** | Cards in progress now | Columns over their WIP limit, and cards past the 85th percentile |
| **Blocked time** | Days blocked in the period | Number of blocks, and cards blocked now |

A tile shows only what the server returns. Without a median it shows a dash and says when the median appears ("Median appears at 5. 3 so far."); with a median but no 85th percentile it is marked **Provisional**. With too few whole weeks, Throughput shows the cards finished so far instead of a weekly median. With a swimlane or label filter on, Work in progress leaves out the over-limit count, because a WIP limit counts every card in the column.

### Flow metrics

<span class="vb-version" title="Added in 1.3">1.3+</span>

Four charts built from the movement log, so you can see how long work takes and where it piles up. Each chart has a one-sentence finding, its definition, and a **Chart | Table** toggle. They follow the page's [filters](#filters). All dates are UTC, and weekends count.

| Chart | Read it as | Marks |
|---|---|---|
| **Cycle time** | How long finished work took. "85th · 8.1d" means 85% of these cards took 8.1 days or less. | One point per finished card. 50th percentile dashed, 85th solid and heavier, 95th dotted. A hollow point was reopened after finishing, and keeps its first finish. |
| **Throughput** | How many cards finish per week. | One point per whole week, its count printed on it, the median dashed. A hollow diamond beside each point is the number of cards started that week (a legend names both), and the table has a **Started** column. Started under-reports on imported boards. Today's unfinished week is left out, so a partial week never reads as a slow one. |
| **Cumulative flow** | Whether work arrives faster than it finishes. A widening band is a queue. | One band per column, labeled at its right edge, finished work at the bottom. The hatched orange band is the bottleneck: the column that is not done and grew the most across the range, leaving out the first column that is not done (where new work arrives), named in a small key under the chart. The Done band is gray. |
| **WIP aging** | Which unfinished cards are in trouble now. | One dot per in-progress card, over its column. The shaded zones are the cycle-time percentiles. Dots are gray up to the 50th percentile, orange past it, and red past the 85th percentile. A ringed card is past the 85th percentile, a square is blocked, so color is never the only cue. A key under the chart shows each gray, orange and red tier that has a dot on screen (under a breakdown the dots take group colors, so no tier key appears) and a "Blocked card" entry for the square. |

**Too few cards.** A percentile line appears only with enough cards behind it: the 50th needs 5, the 85th needs 7 and the 95th needs 20. Until then the chart leaves that line out and says so, rather than presenting one card's time as a trend. The throughput median needs five whole weeks.

**What is left out.** A card with missing or broken history (for example, imported without its history) has no cycle time or age, and the chart says how many were left out. It still counts toward throughput once it reaches a done column. Blocked time is part of cycle time and age, never subtracted, because the wait is real.

**See the cards behind a number.** Click a point or a day, or use the table, to open a drawer with the card's owner and transitions, or the list of cards behind that week or day. From an aging dot the drawer also shows days in progress, the 85th percentile, blocked time, and time per column, counted from when the card's age started so the columns add up to the days in progress. **Open card** opens the card; an archived card has no **Open card**.

**Keyboard.** Tab reaches the filters, each chart's toggle, then the aging dots in column order, and Enter opens the drawer. The table view is the complete keyboard path: every point of every chart is a row there, with a button to open it.

### Page states

- **Loading.** Each region shows a gray skeleton the size of its final panel (a chart panel gets a title, a summary line, the 260px chart and two note lines), the first chart panel says "Loading flow metrics…", and the filters stay usable. The pulse stops under reduced motion. A refetch keeps the previous numbers on screen, dimmed.
- **Nothing has moved yet.** A board with no card movement shows a short explanation, a dimmed example bar labeled as an example, and **Go to board**.
- **Too little data.** The page still renders. The bottleneck panel says "Too early to say" with the reason, and a tile marks its value **Provisional** and says what is withheld and when it appears.
- **No cards match these filters.** The message names the active swimlane, label and period, with one removable chip per filter. **Show last 90 days** appears when the period is shorter than 90 days, and **Clear all filters** resets everything. It does not predict how many cards a wider filter would match.

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

The heatmap follows the page's [filters](#filters): its period is the filter bar's date range, and the swimlane and label filters are sent with the request.

### Table modes: Current vs In period

The heatmap is the **Table** view of [How work flows](#how-work-flows). A button pair above it toggles its mode. The choice persists per board in localStorage (`board:{boardId}:analytics-view-mode`) and defaults to **Current**.

| Mode | What the table shows | Use it to |
|---|---|---|
| **Current** | Average time (days) cards have currently been sitting in each stage: a snapshot of in-flight work. High values mean cards blocked or idle right now. | Find current bottlenecks |
| **In period** | Average time cards that **left** a stage during the selected period spent there, each stay at its full length. Reflects historical flow efficiency, not current queue depth. | View historical time in each stage over the filter bar's date range |

Neither mode measures [throughput](#flow-metric-definitions) (cards finished per period); both measure dwell time. In **In period** each cell's tooltip shows how many stays are behind its average (for example "5 stays"; a card that visits a stage twice is two stays), and stages with no stay in the period show a dash (`—`). The green/yellow/red thresholds apply to both modes, using the same `staleness_threshold_days`.

### Dwell time and archived cards

Analytics includes archived cards as part of the historical record.

- **Archived card:** dwell time in its most recent stage uses the **archive timestamp** as the exit time, not the current date. Dwell stops accumulating when the card is archived.
- **Active card:** keeps accumulating dwell time in its current stage until it moves again.
- **Archive and restore events:** archiving ends a stay and restoring starts a new one, so the archived period is not counted as time in the stage, in either mode.
- **Swimlane moves:** moving a card to another swimlane does not end its stay, in either mode.

> **Changed in 1.3** (#448)

**Current** and **In period** follow the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions). Before, a swimlane-only move reset a card's age and split its stay in **In period**, a restored card's archived period counted as time in its stage, an archived card added a near-zero stay, and a stay that began long before the selected period was lost. A column deleted and recreated under the same name no longer inherits the old column's history, done flag or blocked time.

### Needs attention

Next to WIP aging, one list shows each card that is blocked now, has not moved for longer than the stalled threshold, or is older than the 85th percentile of cycle time. A card appears once; cards in progress come first, by age, then the rest by days without movement. Each row shows the title, then its column, swimlane and reason, with its age in days on the right: red past the 85th percentile, orange otherwise. A [manually blocked](blocked-cards.md) card names its block's reason, as in "blocked: waiting on security review", after any other reasons so a long one does not hide them; the line is cut to fit the row, and hovering it or opening the card shows it in full. A card blocked only by another card shows just "blocked". Five rows show at first; **All N cards** expands the list in place, 25 per page. Select a row, with the mouse or the keyboard, to open the card.

- **Default threshold:** the board's `staleness_threshold_days`.
- **Override:** none. This list always uses the board's threshold. The `stalled_days` query parameter applies only to the analytics endpoint's own stalled list, not to this list or to the heatmap coloring.
- **Filters:** the list follows the page's [filters](#filters); it is built from `GET /api/v1/boards/{id}/metrics/attention/`.
- **Excluded:** archived cards and cards in done columns, since they are no longer in flight and flagging them would mislead.

### Why cards get blocked

<span class="vb-version" title="Added in 1.3">1.3+</span>

Next to Cycle time, **Why cards get blocked** ranks the reasons cards were [manually blocked](blocked-cards.md) during the selected period, longest first:

- **Each reason:** the days it cost, the number of blocks, and a red bar sized against the longest reason. A footnote says which column most blocks started in. At most ten reasons show. The subtitle reads "Every blocked day had the same reason" when there is one reason, "One reason accounts for more than half of all blocked time" when the top reason is 50% or more of blocked days, and "One reason accounts for nearly half of all blocked time" from 40% up to 50%. Otherwise it names the period. Reasons that differ only in capitals or spacing count as one.

A block counts for the part of it inside the period. A block that is still open counts up to now; on a card that is archived it stops at the archive, and if the card is restored it counts up to now again, archived period included. A deleted card's finished blocks still count, and their reasons still appear, as its movements do in the heatmap; a block that was still open when the card was deleted is left out, reason included. Times under a day show in hours. Blocks by another card (relations) are not timed. The section is hidden when nothing was blocked in the period.

### Empty period

When the selected window has no movement data at all (a new board, or a period before any activity), the view shows an informational message instead of an empty heatmap. Widen the period or add some card movements.

### CSV export

Click **Export CSV**, at the right of the filter bar, to download the heatmap data for spreadsheets: the rows of the mode last chosen, in a file named `analytics-{mode}-{days}d.csv`. It includes all active columns, the velocity column, and a stalled card count per swimlane. The button is visible only to **admin** and **site_admin** users.

### API reference

**API:** `GET /api/v1/boards/{id}/analytics/?days=30`. The charts use the [flow metrics endpoints](../api/boards.md#flow-metrics).

| Parameter | Type | Default | Constraint |
|---|---|---|---|
| `days` | integer | `30` | `1`–`365`. Returns `400` if non-integer or out of range. |
| `stalled_days` | integer | Board's `staleness_threshold_days` | Optional override, `1`–`90`. Returns `400` if non-integer or out of range. When omitted, the board setting is used. |
| `swimlane_id` | integer | None | Optional, 1.3+. Narrows every section to one swimlane. Returns `400` if malformed or not a swimlane on this board. |
| `label_id` | integer | None | Optional, 1.3+. Narrows every section to cards with this label. Returns `400` if malformed or not a label on this board. Combined with `swimlane_id`, both must match. |

The response includes two threshold fields:

| Field | Meaning |
|---|---|
| `staleness_threshold_days` | The board's configured threshold, used for heatmap cell coloring. Always reflects the board setting regardless of any `stalled_days` override. |
| `stalled_threshold_days` | The effective threshold used for the stalled cards list. Equals the board setting by default, or the `stalled_days` query parameter value when provided. |
| `stale_warning_pct` | The board's warning percentage (0--100). Controls the yellow/green boundary in the heatmap. |
| `done_columns` | List of column names excluded from the heatmap because they are marked as done. |
