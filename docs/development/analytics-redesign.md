# Analytics tab redesign: what to build
<a id="analytics-redesign"></a>

This page is the build spec for the redesigned Analytics tab. It records the design so that an implementer who cannot open the design canvas can still build it exactly.

**Why it matters:** The current tab has three sections with three filter models, buries the bottleneck in a chart footnote, and puts the most actionable list last. The redesign answers "where is work stuck and what should I look at" before it shows a chart.

**Status:** Design only. Nothing on this page is implemented. The work is tracked in #2257 (page restructure) and #458 (swimlane comparison and breakdowns), both labeled `analytics-redesign`.

**Watch out:** Every number in the screenshots is sample data. The screenshots approximate charts with plain boxes; build the real charts on `components/Common/Chart.tsx`.

## What wins when sources disagree

1. `frontend/CLAUDE.md`, including § Charts. The design was revised to follow it; if a conflict remains, the rule wins and the conflict is a bug in this page.
2. This page.
3. The screenshots in `docs/development/analytics-redesign/`.
4. The artboard sources in `docs/development/analytics-redesign/artboards/`, for exact copy, order and spacing.

## Screenshots

| File | Shows |
|---|---|
| `overview-dark.png` | Overview tab, dark theme, 1440px |
| `overview-light.png` | Overview tab, light theme |
| `overview-drawer.png` | Overview with the Review column drawer open |
| `overview-by-swimlane.png` | Overview broken down by swimlane, first group highlighted |
| `overview-phone.png` | Overview at 390px |
| `swimlanes.png` | Swimlanes tab |
| `states.png` | Loading, no history, too little data, filters match nothing |

![Overview tab, dark theme](analytics-redesign/overview-dark.png)

![Overview broken down by swimlane](analytics-redesign/overview-by-swimlane.png)

![Swimlanes tab](analytics-redesign/swimlanes.png)

## Page structure

The tab has two views, **Overview** and **Swimlanes**, switched by a row of two links under the page title.

- Build the switch as a `<nav>` of links with `aria-current="page"` on the active one, not an ARIA tablist. The active link is bold with an underline, so color is not the only cue.
- The Period and Label selections carry over when switching views.

Overview, top to bottom:

| # | Region | Width at 1024px and up | Issue |
|---|---|---|---|
| 1 | Title row: "Analytics", Beta badge, board name and date range | full | #2257 |
| 2 | View tabs: Overview, Swimlanes | full | #458 adds Swimlanes |
| 3 | Filter bar | full | #2257 |
| 4 | Highlight picker (only when a breakdown is on) | full | #458 |
| 5 | Bottleneck panel and four headline tiles | 2 : 3 | #2257 |
| 6 | How work flows, with Where the time goes | full | #2257 |
| 7 | Cumulative flow and Throughput | 1 : 1 | #2257 |
| 8 | Aging work in progress and Needs attention | 1 : 1 | #2257 |
| 9 | Cycle time and Why cards get blocked | 1 : 1 | #2257 |
| 10 | Footnote on days, time zone and current-value filters | full | #2257 |

Chart rows are two equal columns from `lg` and one column below, and a chart frame never grows past 760px, as § Charts requires.

## Filter bar

- **Period**, **Swimlane** and **Label** dropdowns, in that order, using `SingleSelectDropdown` with `portalMenu`. One selection drives every panel on the Overview.
- The Swimlanes view has Period and Label only. It has no Swimlane filter and no Break down by, because it already shows every swimlane.
- **Period options:** last 30, 90, 180 and 365 days. Default 90.
- **Break down by:** a segmented group with None, Swimlane, Label, and one entry per eligible card custom field (#458). The active segment carries `ActiveMark`.
- **Export CSV**, admin and site admin only, as today.
- The heatmap's own period pills and Age/Throughput toggle are removed.

## Bottleneck panel

- Eyebrow "Bottleneck", then the column name as the panel heading.
- One sentence built from returned numbers: median wait in the column, its share of the cycle, queue size at the start and end of the period, the WIP limit when one is set, and cards arriving and leaving per week.
- Two buttons: a primary button that opens the column drawer ("See the N cards"), and "Open on board".
- The panel uses the warning border, because a named bottleneck is a system signal.
- **No bottleneck returned:** heading "Too early to say" or "No bottleneck", with the reason. See [States](#states).

## Headline tiles

Four tiles, each with a label, one large number with its unit, and one supporting sentence.

| Tile | Number | Supporting sentence |
|---|---|---|
| Cycle time | Median, in days | The 85th percentile and the sample size |
| Throughput | Median cards per week | Number of weeks and total finished |
| Work in progress | Cards in progress now | Columns over their limit and cards past the 85th percentile |
| Blocked time | Total days blocked | Number of blocks and cards blocked now |

### Withholding rules

These come from the flow-metric ADR (#1532) and `backend/boards/services/flow_metrics.py`. The server applies them; the page only reports the result.

| Value | Shown when | Otherwise |
|---|---|---|
| Median (50th percentile) | at least 5 finished cards | withheld, with the count so far |
| 85th percentile | at least 7 finished cards | withheld, with the count so far |
| 95th percentile | at least 20 finished cards | withheld |
| Weekly throughput median | the API returns one | withheld, with the reason |
| Bottleneck | a column's queue grew over the period | "No bottleneck" or "Too early to say" |

**Where the sample size shows:** on the Cycle time tile; in each chart's notes, as `ChartPanel` does today ("102 cards."); and as the "finished" count on each Swimlanes row.

## How work flows

One row, left to right, inside a box that scrolls sideways when the panel is narrower than 980px.

- **Connector** before each column: cards per week entering it, a bar whose thickness is proportional to that rate, and a one- or two-word note.
- **Column box** for each in-progress column, as a button that opens the drawer:
    - column name
    - one square per card in the column now; squares beyond the WIP limit are hollow
    - "N of limit", plus "M over limit" when over
    - median wait
    - queue change over the period ("Queue +7 since Aug 16" or "Queue steady")
- The bottleneck column box has the warning border.
- A final connector and a **Done** box with the number finished in the period.

### Where the time goes

Under the flow row, in the same panel.

- One horizontal bar per group. With no breakdown there is one bar, "All cards".
- Each bar is segmented by in-progress column; a segment's width is the median days in that column and it is labeled with that number.
- The bar's total length is proportional to the group's total, so the longest bar is the slowest group. The total is printed at the end.
- The bottleneck column's segment is hatched.
- This replaces the dwell heatmap on this tab. The board overlay keeps the per-cell view.

## Charts

All four charts keep the `ChartPanel` behavior they have today: summary sentence, Chart | Table switch, notes, table alternative, and drill-down.

| Chart | What changes |
|---|---|
| Cumulative flow | Layout position only. Bands in one hue with alpha steps, 1px separators, direct labels at the right edge, hatched bottleneck. |
| Throughput | Adds a "started" marker per week next to the finished bar. Median dashed, labeled in the right margin. |
| Aging work in progress | Layout position only. 50th percentile dashed, 85th solid and heavier, both labeled in the right margin. Ringed past the 85th, square when blocked. |
| Cycle time | Layout position only. Same reference-line vocabulary. |

No chart uses a status color or a categorical palette.

## Needs attention

One list that replaces the stalled-cards table.

- **Membership:** a card is listed once if it is blocked now, has not moved for longer than the stalled threshold, or is older than the 85th percentile.
- **Order:** oldest first.
- **Row:** card title, then column, swimlane and the reason; age in days on the right. Selecting a row opens the card.
- **Age color:** `text-danger` when the card is past the 85th percentile, `text-warning` otherwise. Every card on this list is already flagged, so there is no neutral tier.
- Shows five rows. "All N cards" expands the list in place, 25 per page, like the stalled table today.

## Why cards get blocked

- A ranked list of block reasons, longest total first.
- Each row: reason, days blocked and number of blocks, and a bar proportional to days blocked.
- A footnote says where most blocks started.
- Renders nothing when no block overlapped the period, as today.

## Column drawer

Opens from a column box or from the bottleneck panel's primary button. Reuse `FlowDrillDrawer`.

- Heading: column name, and "N cards in this column now, limit L".
- Three figures: in column against the limit, median wait, cards past the 85th percentile.
- The oldest card expanded: title, age, swimlane and blocked state, a bar of its time by column, one sentence naming the time in this column, and an "Open card" button that opens the card detail (`onOpenCard`).
- The screenshot also shows a "Movement history" button. Do not build it; "Open card" already leads there.
- The remaining cards, oldest first. Five show at first; a "Show N more" button reveals the rest. The screenshot shows this as plain text.
- Opening, closing and focus return follow `FlowDrillDrawer` as it works today.

![Column drawer open on Review](analytics-redesign/overview-drawer.png)

## Breakdowns (#458)

Charts stay one hue. A breakdown never colors marks by group.

- **Where the time goes** shows one bar per group.
- A **Highlight** picker appears under the filter bar: one chip per group, exactly one active, marked with `ActiveMark`. It defaults to the first group.
- In Throughput, Aging and Cycle time, the highlighted group's marks are at full strength and the rest are dimmed. In Throughput the highlighted group is the bottom part of each bar.
- Each chart's summary sentence names the highlighted group.
- Cumulative flow does not change with a breakdown.
- **Labels:** a card with several labels counts once in each group; the picker's note says so. More than six groups collapse to the six largest plus "Other".
- **Custom fields:** card fields of type dropdown or checkbox only. Cards with no value are left out, and the note says so.
- Breakdowns and filters use each card's current swimlane, labels and field values.

## Swimlanes tab (#458)

- Same title row and view links. Controls: Period, Label, "Group lanes by" (None, or a swimlane custom field) and "Sort" (slowest first by default).
- A finding panel at the top names up to two swimlanes whose status is "slower", slowest first, in one heading and one sentence. When none is slower it says so.
- One row per swimlane:

| Cell | Content |
|---|---|
| Name | Swimlane name, linking to the Overview filtered to it, and a status line: slower than, in line with, or faster than the board |
| Cycle time | A bar for the median, a thin line reaching the 85th percentile, and a tick at the board median; then the two numbers in words |
| Trend in period | Eight small bars of the rolling median, and a word: slower, steady or faster, with the first and last values |
| Time blocked | A bar and "N% of elapsed time" |
| Counts | Cards in progress and cards finished |

- **Status** compares the swimlane's median with the board median: "Slower than the board" when more than 15% above, "Faster than the board" when more than 15% below, otherwise "In line with the board". The 15% is a proposed threshold for `architect` to confirm.
- **Trend** compares the first and last rolling medians in the period with the same 15% threshold: "Slower, A to B days", "Faster, A to B days" or "Steady".
- **Bar scale** is shared by every row and runs from 0 to the largest 85th percentile on the page, rounded up to a round number. The board-median tick sits on that scale.
- A swimlane with fewer than five finished cards shows no median, no bar and no trend. Its cycle-time text says how many cards have finished and its trend text is "Not enough cards".
- A swimlane with five or six finished cards shows the median but no 85th-percentile line.
- A legend under the rows explains the board-median tick, the solid bar, the thin line and the trend.
- Status is carried by the words, not by color.
- Below 1024px each row's cells wrap under the name.

## States

![Page states](analytics-redesign/states.png)

| State | What shows |
|---|---|
| Loading | Skeleton blocks the size of the final panels. Filters stay usable. |
| No history yet | Heading, one sentence on what the page will show, a dimmed example bar labeled as an example, and "Go to board". |
| Too little data | The page renders. The bottleneck panel says "Too early to say" with the reason. Tiles mark values "Provisional" and say what is withheld and when it will appear. |
| Filters match nothing | Heading, a sentence naming the active filters, a removable chip per filter, a suggestion when widening the period would match cards, and "Clear all filters". |

## Design tokens

The screenshots use literal colors. Build with the tokens.

| In the design | Token |
|---|---|
| Page background | `bg-sunken` |
| Panel | `bg-surface border border-line rounded-lg` |
| Inset box (column box, tile inside drawer, list row) | `bg-sunken border border-line` |
| Control border | `border-line-strong` |
| Primary text | `text-fg` |
| Secondary text | `text-fg-secondary` |
| Labels, axis text, captions | `text-fg-tertiary` (never `fg-muted`) |
| Primary button | `bg-button-primary hover:bg-button-primary-hover text-on-primary` |
| Active segment | `bg-primary text-on-primary` with `ActiveMark` |
| Link | `text-info` |
| Bottleneck border, over-limit and queue-growth text | `border-warning`, `text-warning` |
| Age past the 85th percentile in a list | `text-danger` |
| Every chart mark, bar and square | `CHART_HUE` and `chartTint(alpha)` |
| Bar track | `bg-surface-hover` |

Smallest text is 12px everywhere.

### Alpha steps

Every mark is `chartTint(alpha)`. The design uses these values; keep the order of strengths even if `ux-review` adjusts a number.

| Mark | Alpha |
|---|---|
| Cumulative flow and time bars: Done | 0.12 |
| Ready | 0.22 |
| In progress | 0.42 |
| QA | 0.7 |
| Bottleneck column (hatched) | 0.62 with 0.3 stripes |
| Throughput bars | 0.6; highlighted group 0.7, the rest 0.22 |
| Aging marks | 0.85; highlighted group 0.95, the rest 0.22 |
| Cycle time dots | 0.8; highlighted group 0.95, the rest 0.2 |
| Flow-row squares | 0.7; over the limit, hollow with a 0.9 outline |
| Blocked-reason and Swimlanes bars | 0.7 |

Cumulative flow bands stack bottom to top in board order from Done back to the first in-progress column.

## Phone width

![Overview at 390px](analytics-redesign/overview-phone.png)

- No sideways page scroll at 390px.
- Filter controls wrap. Tiles sit two per row. Every two-column row becomes one column.
- The flow row scrolls sideways inside its panel.

## What the API must return

All additions are additive; no existing field, endpoint or parameter changes. The `architect` gate decides field names and which endpoint carries each.

| Needed by | Number | Exists today |
|---|---|---|
| Bottleneck sentence, flow row | Cards per week entering and leaving each column | No |
| Bottleneck sentence, flow row | Queue size per column at the start and end of the period | Derivable from cumulative flow days |
| Flow row | WIP limit per column | Yes, on the column |
| Where the time goes | Median days per column for the selected filters | No (the heatmap returns averages) |
| Throughput | Cards started per week | No |
| Blocked tile and list | Blocked totals and reasons for the same period and filters as the flow charts | Partly: the analytics endpoint accepts 1 to 365 days, but takes no swimlane or label filter |
| Needs attention | Stalled cards for the same period and filters | Partly: not filtered by swimlane or label |
| Breakdowns (#458) | Each flow metric grouped by swimlane, label or custom field | No |
| Swimlanes tab (#458) | Rolling median and share of elapsed time blocked, per swimlane | No |

Percentiles and medians come from the server. The browser never computes one.

## What is removed from the tab

- The dwell heatmap and its Age/Throughput toggle.
- The stalled-cards table.
- The blocked-time table per column.

These are UI removals only. The analytics endpoint keeps every field it returns today. Run `sunset-check` on the heatmap before removing it.

## Not part of this design

- #458's "card detail: show the card's own cycle time against its swimlane" has no design here. Leave it out unless it is designed separately.

## Docs to update when this is built

- `docs/features/analytics.md`: it describes the heatmap, the Age/Throughput toggle, the 7/30/90 pills, the stalled table and the blocked table, and uses "Throughput" for dwell time. After the change "Throughput" means cards finished per week everywhere.
- `docs/api/`: every added field and parameter.
- `frontend/CLAUDE.md` § Charts: any new rule `ux-review` surfaces, and a pointer to this page.

## Open decisions

- **Trend and the open-core boundary.** The Swimlanes trend compares rolling medians inside the selected period. Confirm this is not "cross-period comparison", which is enterprise.
- **Heatmap removal.** Pending `sunset-check`.
- **Needs attention and the attention queue.** If #1358 ships first, this list should use its ranking.
- **"Widening would match N cards".** Needs a second, cheap count query; drop the hint if it is not worth one.

## Review checklist

For `ux-review` and `completeness-check` on the implementing MRs:

- [ ] One period, swimlane and label selection drives every panel on both tabs
- [ ] Region order and column split match [Page structure](#page-structure) and the screenshots
- [ ] The bottleneck panel names the returned column and opens its drawer
- [ ] Every percentile states its sample size or the reason it is withheld
- [ ] No chart uses a status color or a per-group color
- [ ] Every segmented control and chip marks its active member with `ActiveMark`
- [ ] Each chart keeps its table, notes and drill-down
- [ ] All four states render as in `states.png`
- [ ] No sideways page scroll at 390px
- [ ] Light and dark themes both pass the contrast rules in `frontend/CLAUDE.md`
- [ ] `docs/features/analytics.md`, `docs/api/` and `frontend/CLAUDE.md` § Charts are updated in the same MR

## Artboard sources

`docs/development/analytics-redesign/artboards/` holds the design canvas files as published: `Main.dc.html` is the Overview, `Lanes.dc.html` the Swimlanes tab, and `States.dc.html` the states. The other four files load `Main.dc.html` with different settings. They are reference material for copy, order and spacing, not code to port: they are excluded from the docs site, need the canvas runtime to render, and draw charts with plain boxes.
