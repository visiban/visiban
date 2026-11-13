# See who moved a card, and when

<a id="card-history"></a>

Open a card's **History** tab to see every movement and field change, newest first. (Before 1.3 this tab was called **Activity**.)

**Why it matters:** You can see who moved a card and when. It is the record incident retros and audits need.

**The big picture:** every card keeps a full audit trail of movements and field changes. Movement records are append-only, and deleting a card keeps them.

**Go deeper:** the board-level **History** tab shows movements across every card; see [Board-level movement history](#board-level-movement-history).

## Viewing history

Open a card and click **History** in its detail panel. The timeline lists movements and field changes in reverse chronological order. Each entry shows:

- what changed (from → to)
- who made the change
- when it happened (relative time, for example "3 days ago")

Movement entries keep the full column and swimlane names even after those are renamed or deleted. A deleted column's name shows in italic red with a **Deleted —** prefix and a hover tooltip, so you can tell live columns from removed ones at a glance.

### Tabs, counts and the last-activity line

*Since 1.3 (#967).* The card detail panel has three tabs: **Details**, **Comments** and **History**. **Comments** and **History** show how many entries they hold, for example "Comments 4" and "History 23". While a count is still loading, the tab shows its name only, never a 0.

The panel opens on the tab you chose last. That choice lasts until you reload the page, and moving between cards keeps it, so you can step through cards on the History tab. A link that names a tab, such as `?card=42&tab=comments`, opens that tab instead.

The **Details** tab ends with a **Last activity** line, for example "Last activity: Jordan moved to Review · 2h ago". Click it to open **History** at the newest entry.

You can also move between tabs from the keyboard: with a tab focused, the Left and Right arrows move to the previous or next tab, and Home and End go to the first and last one.

### Filter by event type

*Since 1.3 (#967).* Above the timeline, six toggle buttons choose what the timeline shows: **Column moves**, **Comments**, **Field changes**, **Checklist**, **Attachments** and **System events**. Each one shows how many entries of that type the card has. They all start on. Click one to hide that type, and click it again to show it. At least one type always stays shown, so the last button that is on can't be switched off.

This replaces the filter menu and the **Show full history** setting of earlier versions. A **Show full history** choice saved before 1.3 is ignored.

### Duration between entries

Each movement entry shows how long the card stayed in that column before the next move, such as "Spent 3h here" or "Spent 2d here", on the right. Durations come from the gap between consecutive movement timestamps, in the most readable unit (minutes, hours, or days). The last entry has no duration, because the card is still there.

### Checklist event grouping

Sequential checklist events of the same type collapse into one entry, for example "Added checklist items: "item a", "item b", "item c"". This keeps the timeline compact during bulk checklist edits.

The UID fields on each movement record (`from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`) are also preserved permanently. Use them, not the name or ID fields, to correlate movement history in an external system. See [Stable UIDs](stable-uids.md).

## Movement history

A `CardMovement` record captures every column or swimlane change. Pure position reorders within the same cell don't create one. Each record includes:

- From column / to column (FK, nullable after deletion)
- From swimlane / to swimlane (FK, nullable after deletion)
- From column UID / to column UID: stable even after the column is deleted or renamed
- From swimlane UID / to swimlane UID: stable even after the swimlane is deleted or renamed
- Denormalized names at the time of the move (from_column_name, to_column_name, etc.)
- Who moved it (`moved_by`)
- When (`moved_at`), indexed for query performance
- Optional notes
- **Movement type** (`movement_type`): one of `move` (standard drag-and-drop or API move), `archived` (card was archived), or `unarchived` (card was unarchived from the Archived panel)

`archived` and `unarchived` events appear in the card's own timeline and in the board-level History view. The movement timeline is in the card detail panel's **History** tab.

## Activity log

The activity log also tracks field changes:

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
| Due date change | Old and new date (or "none" if cleared) |

!!! note
    Due date change tracking was added in 1.0.

## Deleted cards keep their history

> **Changed in 1.2** (#1469)

Movement records are append-only: once written, they are not edited, and they are removed only with their board or by a superuser's `purge_card_history` run (since 1.2; see [Card History Retention](../administration/card-history-retention.md)). Before 1.2, deleting a card also deleted its movement history.

- **Deleting a card keeps its movements.** This covers deleting the card itself and deleting the column or swimlane it is in. Each record keeps the card's UID and title (`card_uid`, `card_title`) as of when it was recorded (for movements from before 1.2 and for imported ones, as of the upgrade or import), so the board's **History** view still lists it under the original card. A deleted card no longer appears under the **Swimlane** filter, which filters by the card's current swimlane.
- **Each movement keeps the title recorded with it.** While a card exists, its history is listed under its current title. Once it is deleted, each movement is listed under the title the card had at that move, so a card renamed before it was deleted appears under its earlier titles too.
- **Deleting the board removes all of its movements**, including those of cards deleted earlier. Apart from that, since 1.2 only a superuser can remove them, with the `purge_card_history` command (see [Card History Retention](../administration/card-history-retention.md)). Since 1.3 that command also blanks the card's title, description and other content in the board's change feed.
- **Metrics are unchanged.** The Summary and Analytics views and the stale-card check count only cards that still exist, as before. A deleted card's movements do not count toward throughput, cycle time or dwell time.
- **Exports don't include them yet.** JSON and CSV board export write movements per card, so a deleted card's history is not exported (#1796).

In the Django admin (`/admin/`), movement records can be viewed but not added, edited or deleted; earlier releases allowed edits and deletes there. The admin list shows, and searches, the card UID and the card's title **as recorded at the time of each move**, not a renamed card's current title. Moving a card to another board in the admin keeps its movement history attached to the card's current board.

A deleted card's title and any movement notes stay visible to the board's members until the board is deleted or a superuser purges them on request (since 1.2, #1797). [Card History Retention](../administration/card-history-retention.md) covers the purge command and the other places a deleted card's title can remain.

## Imported history

> **Changed in 1.2** (#1675)

A board created by a [JSON import](board.md#import) with **Card history** included brings the file's movements and activity entries with it. Each imported entry:

- keeps the time the file gives it, so the timeline reads in its original order;
- is recorded under the user who ran the import (`moved_by` / `actor`);
- keeps the username the file named as plain text in `imported_from_username`. It is shown next to the importer's name: "by Kelly · imported, originally alice" in the card's **History** tab, and "imported, originally alice" under the mover in the board's **History** view. When the file named nobody, the entry just says "imported".

The source name is never matched to an account here: imported entries are shown under the importer's name. Entries recorded on the board after the import have `imported_from_username: null` and show no note. History imported by earlier versions also carries `null`, since the original name was not kept.

Imported comments work the same way (since 1.2, #1702): a comment created by a JSON or [Trello import](trello-import.md#comment-authors) is posted under the importer, keeps its original time, and keeps the source's author name in `imported_from_username`, shown after the time in the card's comment list ("imported, originally alice"). Comments posted on the board carry `null`.

Exports carry the field too: JSON export writes `imported_from_username` on every movement, activity, and comment, and re-importing such a file keeps the original source name (not the name of whoever imported it first). CSV export appends the note to the mover in **Movement History**, for example `…|Kelly (imported, originally alice)`.

## How dwell time is calculated

**Dwell time:** how long a card stayed in one column, from entering it to leaving it, or until now if it is still there. Moving to another swimlane does not end a stay. Archiving ends it, and restoring starts a new one.

That definition comes from the [flow metric definitions](../architecture/decisions.md#flow-metric-definitions) decision record (accepted in 1.3, #1532). Today the Analytics view still measures the gap between two consecutive `CardMovement` records and averages those gaps per stage to flag outliers. See [Analytics](analytics.md#flow-metric-definitions).

## Stale card detection

A card is stale if its most recent `CardMovement` is older than the board's `staleness_threshold_days` (default: 7 days), or, for a card that has never moved, if it was created longer ago than that. See [Notifications](notifications.md) for the daily stale-card digest.

### Card aging tint

> **Changed in 1.2** (#1841, #1843, #1863)

A card's tint shows how long it has been idle, in multiples of the board's threshold. Idle time counts from the card's last move. A card that has never moved, such as one imported from Trello or CSV, counts from its creation date, the same rule the stale check uses. The tint deepens in fixed steps:

| Idle time (multiples of the threshold) | Tint |
|---|---|
| Below the warning point | None. A fresh card is never colored. |
| Warning point up to 1× | Faint yellow |
| 1× up to 2× | Orange |
| 2× up to 3× | Red |
| 3× and beyond | Deep red with a red inset outline |

- **Edges:** each step starts exactly at its edge. With a 14-day threshold, a card idle exactly 28 days is red, not orange.
- **Fixed multiples:** 1×, 2×, 3× are not a board setting.
- **No green step:** the tint marks cards that need a look, never cards that are "good".
- **Age only:** the tint does not mean a card is stuck. A card waiting on an outside party ages the same way.
- **Done columns:** cards there never age. They get no tint and no "Stale" badge, however long ago they last moved, and the daily stale-card digest skips them too.

Color is never the only signal:

- Card text fades slightly as the card ages.
- The darkest step adds an outline inside the card's border, so the border color stays visible (the priority color, or the urgency hue on overdue/due-soon cards at Comfortable).
- At Comfortable and Standard density, a stale card's badge states its idle days, for example `Stale · 41d`.
- Wherever that badge is not shown, a small bar meter appears at the start of an aging card's title. This covers the Compact card layout at every density, Dense density, and cards whose badge shows an overdue or due-soon date instead. One solid bar means 1× the threshold, two mean 2×, and three mean 3× or more, so the steps differ by shape as well as color. Screen readers announce the meter with the idle days, for example "Idle 41 days, at least 2 times the stale threshold". The meter sits inside the title line, so it never makes a card taller, though a long title is shortened a little sooner.
- The yellow warning step never shows the badge, so its meter appears on every warning card, in every layout and density. It has no solid bar: the shortest bar is drawn as an outline, the step before one solid bar. Screen readers announce it as, for example, "Idle 9 days, approaching the stale threshold".
- Hovering a tinted card shows the idle days and the threshold. A stale card also shows how many multiples of the threshold it has reached and any cards blocking it, for example `Stale · 41d · 2.9× the 14d threshold · blocked by 2 cards`.

The **warning point** is the board's `stale_warning_pct`: the percentage of the threshold a card has used before the yellow tint appears. With a 14-day threshold and 75%, the yellow tint starts at 10.5 days. `0` turns the yellow step off, and `100` makes it coincide with the threshold. Both values are set in **Board Settings → Card aging settings**, and the [analytics heatmap](analytics.md#color-coding) uses the same warning point.

!!! note "Before 1.2"
    The tint had two steps, and every card past the threshold looked the same however long it had been idle. Before 1.2, `stale_warning_pct` was also applied inverted, so the warning point was `100 − stale_warning_pct` percent of the threshold. For example, a board set to 75% showed the warning after 25% of the threshold. Boards on the default 50% are unaffected. Boards with any other value see the warning point move to the percentage the setting states.

## API access

Movement history and the activity log are available through the API:

```
GET /api/v1/boards/{board_id}/cards/{card_id}/movements/
GET /api/v1/boards/{board_id}/cards/{card_id}/activities/
```

Movement records include `card_uid`, `card_title`, `from_column_name`, `to_column_name`, `from_swimlane_name`, `to_swimlane_name`, `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, `to_swimlane_uid`, `moved_by`, `moved_at`, and `movement_type`. The column and swimlane name and UID fields are denormalized: captured at write time, accurate regardless of future renames or deletions. `card_uid` and `card_title` show the card's current values while the card exists, and the values kept on the record once it is deleted. See [Stable UIDs](stable-uids.md) for the full field reference and integration examples.

## Board-level movement history

> **Added in 1.0**

The board toolbar's **History** tab shows movements across every card on the board, alongside the per-card timeline. See [Board & Cards — History view](board.md#history-view) for the UI description.

### API

```
GET /api/v1/boards/{id}/movements/
```

| Parameter | Type | Description |
|---|---|---|
| `swimlane_id` | integer | Filter by the card's current swimlane |
| `to_column_id` | integer | Filter by destination column |
| `moved_by_id` | integer | Filter by the user who performed the move |
| `moved_after` | ISO date | Lower bound (inclusive) |
| `moved_before` | ISO date | Upper bound (inclusive) |
| `exclude_type` | comma-separated string | Exclude movement types — e.g. `archived,unarchived` |
| `offset` | integer | Pagination offset (default `0`) |

Page size is fixed at 50. With no date range, the endpoint returns the full movement history. The API returns all movement types, including archive/unarchive, unless you pass `exclude_type=archived,unarchived`. The History view UI doesn't send that parameter, so it shows everything.
