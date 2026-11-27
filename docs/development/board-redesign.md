# Board view redesign: what to build
<a id="board-redesign"></a>

This page is the build spec for the redesigned Board view. It records the design so that an implementer who cannot open the design canvas can still build it exactly.

**Why it matters:** The current board puts about 16 controls in one toolbar row, spends roughly 325px of every row on a mostly empty swimlane label, and draws a red border on most cards, so nothing stands out. The redesign makes lanes scannable, keeps red for overdue only, and gives every control one home.

**Status:** Design only. Nothing on this page is implemented. The work is tracked in #2259 and its child issues #2269 to #2279, all labeled `board-redesign`.

**Watch out:** Every card, name and number in the screenshots is sample data (`board-redesign/sample-board.json`). Probability, weighted value, the lane fields "Team size" and "Forecast", and the track states are invented for the sample.

## What wins when sources disagree

The owner ruled on 2026-11-14 that this design is the standard for the Board view. For work labeled `board-redesign`:

1. This page.
2. The screenshots in `docs/development/board-redesign/`.
3. The artboard sources in `docs/development/board-redesign/artboards/`, for exact copy, order and spacing.
   Note: the swimlane band's `+N`/`Less` expansion in these artboards is superseded by #2354 (the "N fields" toggle and aligned grid).
4. `frontend/CLAUDE.md` and the `frontend/ui-conventions/` topic files it indexes. Their token, contrast, focus, motion and accessibility rules still apply in full. Their board layout sections listed under [Rules to rewrite](#rules-to-rewrite) describe the board being replaced; each child issue rewrites its section in the same MR.

An older board issue that describes a different look, including #871, follows this page.

## Screenshots

All are 1440px wide unless noted, dark theme unless noted.

| File | Shows |
|---|---|
| `board-dark.png` | The board: toolbar, Show chips, column headers, three lanes, a split Discovery stage |
| `board-light.png` | The same board in the light theme |
| `board-peek.png` | Card peek open on a Discovery card |
| `board-collapsed.png` | Every lane collapsed to its count strip |
| `board-activity.png` | Activity drawer open |
| `board-phone.png` | 390px wide, Discovery selected, sub-column switcher |
| `components.png` | Every card, column header, lane band, cell, drag and chip state |
| `menus.png` | Filter panel, View menu, overflow menu, and the filter chip row |
| `board-states.png` | Loading, empty board, filter matches nothing, offline, load error, view-only |
| `stages-settings.png` | Stage settings panel (bottom of the image). The board above it is an earlier draft; use `board-dark.png` for the board |

## Page structure

Top to bottom:

1. App header (Row 1): the menu button (opens the navigation drawer, `[`), the breadcrumb rooted at "Home" whose last crumb is the page's only `h1` (on a board, a button with the board name and a chevron that opens the board switcher), star, board status pill, board search, notifications, account. There is no sidebar (#2473): navigation is the on-demand drawer described in `frontend/CLAUDE.md` § App shell.
2. Board toolbar (Row 2): view tabs on the left; Filter, View, Activity, overflow menu and the connection status on the right.
3. Filter chip row: only when a filter is active.
4. Show chips, with the board totals and "Collapse all lanes" on the right.
5. Column headers, one grid row.
6. One section per swimlane: a header band, then one cell per column.

The landmarks in `frontend/ui-conventions/shell-and-navigation.md` § Top chrome do not change: `banner`, `navigation: Breadcrumb`, `navigation: Board toolbar`, `search: Board filters`, `main`.

The column grid is one CSS grid template shared by the header row, every lane's cells and every collapsed strip: one `minmax(0, 1fr)` track per column and one column's width per sub-column for a split stage (`minmax(0, 2fr)` for two, `3fr` for three, `4fr` for four; #2531). Gap 8px. Below 1240px of board width the grid scrolls sideways inside its own box; the page does not.

## Toolbar and header

Screenshots: `board-dark.png`, `menus.png`.

- **Tabs:** Board, Summary, History, Analytics. History stays a full view and keeps its URL. The active tab is bold with a 2px `primary` underline.
- **Buttons, right-aligned:** Filter, View, Activity, Export (download icon), Settings (gear icon), then the `⋯` kebab. No divider: Row 2 has none. Bordered, 36px tall, icon plus label. Export shows when the viewer can export and Settings for admins; tooltips read "Export board ⌘⇧E" and "Board settings ⌘," (#2435). A button whose panel is open, or Filter while any filter is active, takes the selected treatment (see [Design tokens](#design-tokens)); Filter also shows the count of active filters.
- **Overflow menu:** Export board (when the viewer can export), Board settings (admins) and Keyboard shortcuts, as the reference draws it (#2450). Export and Settings also stay as toolbar buttons (#2435), so the menu repeats them.
- **Connection status:** the existing `ConnectionStatus` component, last in the row.
- **Board name:** the last breadcrumb crumb, inside the `h1`: a button labeled "<board>, switch board" that opens the 360px "Switch board" popover (Starred, Recent on this device, then the rest of the group; a bottom sheet on phones). Admins rename through the Rename button beside it (#2473).
- **Board status pill:** beside the star in Row 1. Same data and menu as today.
- **Board search:** in Row 1, centered, a 38px field with placeholder "Search cards, people, labels, fields" and the ⌘K keycap. Off a board the same field reads "Jump to a board or action" (#2473).
- **Keyboard shortcuts:** the overflow menu's item and `?` open the same help, which leads with the global keys (⌘K, `[`, `g` `u`, `?`) and then lists the board's own (#2473).

Preset, card density, overlay, collapse all and expand all move into the View menu. Archived cards move into the Activity drawer.

## Menus

Screenshot: `menus.png`.

- **Filter panel:** a "Search fields and values to filter" input, then one row per filterable field showing its current value or "Any" (Assignee, Label, Swimlane, Due date, Last moved, Track state, then each custom field). An active row is tinted and bold. Saved filters are listed at the bottom.
- **Filter chip row:** "Filtered by", one removable chip per active filter, "Clear all", and "Save filter" at the right.
- **View menu** (in Children mode, #2370, only the Children options render): Preset (select), Card density (segmented: Comfortable, Standard, Dense, active member marked with `ActiveMark`), Overlay (select), Swimlanes (Collapse all, Expand all), "Show sub-columns" (checkbox, as the reference draws it; #2388), and an "On the card: <fields> Change" line naming the fields pinned to the card, where Change opens Board settings on Card fields. The Overlay select shows its value ("None"), not its name.

All three use the existing dropdown primitives and focus containment rules.

## Show chips

Screenshots: `board-dark.png`, `components.png`.

All cards, Overdue, Stale, Due soon. Each shows a color swatch, a label and a count for the whole board. Exactly one is active; All cards is the default.

- Choosing a chip hides non-matching cards. Column counts, WIP meters and lane counts keep showing the whole column and lane.
- The swatches are the legend for collapsed-lane squares.
- The active chip is marked by weight and border as well as fill.
- A chip is a quick view, not a saved filter. It combines with the Filter panel (both apply).

## Column headers

Screenshot: `components.png`.

Each header is a panel tinted with the column color: color dot, name (one line, truncated with an ellipsis and the full name as its title, #2389), an add-card button, the collapse chevron (hidden until hover or focus; always shown on a device with no hover), a 3px meter, then the count line.

| State | Count line | Meter |
|---|---|---|
| No limit | "2 cards" | none |
| Under limit | "2 / 4" | column color, proportional |
| At limit | "4 / 4" | column color, full |
| Over limit | "8 / 6 over" in warning text | warning color, full |
| Split stage | "8 / 8", then one row of sub-columns aligned to the lane's sub-column dividers (dashed, `border-line-boundary`). Each shows its name (bold, wraps to two lines) above its count. Working sub-columns show the bare count, and the last shows "N waiting" | as above |

Headers stay visible when the board scrolls vertically.

## Swimlane bands

Screenshots: `board-dark.png`, `board-collapsed.png`, `components.png`.

A full-width band replaces the left label panel. Left to right:

- collapse toggle (chevron, turns 90° when collapsed, `aria-expanded`);
- lane color square and lane name (17px, semibold);
- the lane's health status (the pill when set, the unset icon when not: one slot), then the lane actions beside the name (#2353): **Focus** (everyone) and a `⋮` menu (admins) holding "Edit swimlane…" and "Change field order…". Two additions (#2370): **Children** (everyone, on every band of a board where cards can have children, with the lane's in-progress count, "Children 12 in progress"; it opens Children mode at that lane) and **Copy link** (Children mode only; copies `?show=children&lane=<lane id>`). The Children-mode band keeps Focus (it shows only that lane) and the admin `⋮`, in the order Focus, Copy link, `⋮`. There is no action cluster at the far right;
- lane fields as "Label value": the first two on a legacy board; on a board with Show tiers, the Band fields (below);
- on a legacy board (#2439), an "N fields" toggle (rotating chevron) that opens an aligned definition grid of every field on its own line in the band (#2354);
  on a board whose fields have a Show tier (#2439), the band shows its **Band** fields (up to 6, as many as the screen fits, #2663) and the toggle reads "Show N more" / "Hide details" (N = Band fields that did not fit + Details + Hidden the viewer may see); open, it shows the Details grid (`LaneFieldGrid`, capped by `Board.lane_details_cap`), a muted "Hidden on band" group labeled with `aria-labelledby`, and the footer "N in details · N hidden on band · Manage swimlane fields" (the link is admin-only). A board whose tiers are all null keeps the #2354 band unchanged. Tiers resolve through `resolveLaneTiers` (`utils/laneBand.ts`), pinned to the backend by `backend/boards/tests/fixtures/lane_field_tiers.json`;
  - Until #2356 ships, the toggle sits after the name and health pill and renders only when eligible fields exceed the two inline ones. The truncated-slot rule and the fixed-x-on-every-lane rule arrive with #2356 (fixed left zone, K slots, toggle track).
- at the right: overdue count (danger text), stale count (warning text), lane WIP "WIP 9 / 10" (warning text and the word "over" when over), and the number rollup "$413k open".

The band is tinted with the lane color and wraps to a second line when it runs out of room, except on a lane showing more than two Band fields (#2663), which keeps to one line. Overdue and stale counts are omitted when zero. Lane WIP and the rollup shipped with #2275: the lane WIP line uses the existing swimlane `wip_limit` (#1150), and the rollup sums the card number field chosen in `Board.swimlane_rollup_field` (Board settings → Rules & limits → Swimlane rollup); each is omitted when unset. The band ends at the rollup, as in `board-dark.png`: the card count was removed in #2328 (owner ruling 2026-11-16).

**Information hierarchy (#2335).** What wins when the band runs out of room, for every band at every width. The phone band follows the same tiers (§ Phone width).

| Tier | Content | Behavior |
|---|---|---|
| Primary | Lane name, health pill | Always visible, including collapsed. The name is truncated only when it alone is wider than the band; everything else wraps first. On a lane showing more than two Band fields the band is one line instead: fields truncate and the name stops at 24rem (#2663). |
| Secondary | Overdue, stale (and blocked, if a blocked count ever joins the band) | Shown only when nonzero; danger and warning text; survive collapse. |
| Tertiary | Band fields (legacy board: the first two lane fields), lane WIP or weight line, number rollup; the card count only as part of a violated limit | Quiet: neutral text, no hue or glyph. A calm limit line folds away when the lane collapses. A violated limit turns to warning text with the word "over" and survives collapse; `WIP 5 / 4 over` already carries the count, so the count never returns on its own. |
| On demand | The full lane field grid, drag handle, Focus, the `⋮` lane menu (Edit swimlane…, Change field order…), unset-health icon | On a legacy board (every field `band_visibility` null, #2439) the grid is behind the "N fields" toggle (admins also get "Change field order" after the open grid); a board with tiers uses "Show N more" and its own manage link instead. The controls are revealed on hover and focus, and are always shown on a device with no hover (touch), since there is no hover to reveal them. They keep their space while hidden, so nothing shifts. |

"Quiet" matches `board-dark.png` as drawn: the calm `WIP 9 / 10` and `$413k open` are neutral text, and only `WIP 10 / 8 over` is colored. Band content states its tier in its issue: #2275 (WIP, rollup) and #2328 (card count) are tertiary; #1851 (computed aggregates) sits with the rollup in the tertiary tier; #2217/#2219 (threshold marks) ride on the lane field they mark and take its tier, so a mark on a field only in the "N fields" grid stays there. Whether a crossed threshold should promote its field out of the grid is left open for #2217.

**30 to 50 lanes, long names, several fields (#2335).** A band stays one line when its name, fields and stats fit, and wraps when they do not, unless the lane shows more than two Band fields. On a legacy board (pre-1.3, every field `band_visibility` null, #2439) it never grows past two inline fields: the "N fields" toggle holds the rest. A board with explicit tiers shows its Band fields plus "Show N more". An admin may mark up to six Band fields (#2663, replacing the maximum of two drawn on the #2439 canvas; the default stays two), and each screen shows K of them: `clamp(2 + floor((viewW - 1320) / 160), 2, 6)` of the board view width, so 2 below 1480px, 3 from 1480, 4 from 1640, 5 from 1800 and 6 from 1960; a phone always shows 2. The rest come first in the lane details. A lane showing more than two Band fields switches to a one-line layout: the fields truncate to stay on one line with the stats, and the name stops at 24rem. With two or fewer shown, and on a legacy board, the band wraps as before: a long name wraps the fields and stats onto the next line before it is truncated. For a board this tall, Collapse all lanes (#2308) is the overview: a collapsed band keeps the primary and secondary tiers and any violated limit, so 50 collapsed lanes scan by health and overdue. No usability evidence backs this yet (#1590 has not been run); revisit it when it is.

**Collapsed:** the cells are replaced by one strip aligned to the column grid. Each strip cell shows the card count (an en dash when zero) and one 10px square per card: danger for overdue, warning for stale, primary tint otherwise. A split column shows two counts with the dashed divider.

## Cells

Screenshot: `components.png`.

- A cell is a well (the deepest surface) with 6px padding and 6px between cards.
- Lane height follows the tallest cell. An empty cell is 56px tall.
- An empty cell shows a quiet plus sign and the whole cell is the add target. On hover or focus it gains a dashed border and the label "Add card". A populated cell's blank space below the cards is a full-height "+ Add card" button with the same hover look.
- A split cell is one well with a dashed vertical divider between its sub-columns. In a populated split cell an empty sub-column shows its own name in muted text; a fully empty cell shows no names. While a card is dragged, the hovered sub-column shows a name pill at its bottom (#2531).

## Cards

Screenshots: `board-dark.png`, `components.png`.

Rows, top to bottom, at Comfortable density:

1. Title: the text before ` -- ` in bold, the rest as a subtitle. A title without ` -- ` is all bold.
2. Track chips, only in a column that has tracks.
3. Label chip (through `colorChipStyle`), assignee avatar at the right.
4. Up to two pinned custom fields from the board preset; the first is emphasized.
5. Status line, omitted when the card is on track.

| Status | Border | Status line |
|---|---|---|
| Overdue | danger | flag icon, "Overdue Nov 12", danger text |
| Stale | neutral | clock icon, "Stale 39d", warning text |
| Due soon | neutral | flag icon, "Due in 3 days", secondary text |
| On track | neutral | none |

Overdue is the only state with a colored border. Stale and due-soon thresholds are the existing ones.

**Density:** Standard shows the title on one line, then the status line and pinned fields on one row. Dense is a single row: title, short status ("39d"), first pinned field.

**Interaction states:** hover (stronger border, lifts 1px), keyboard focus (the standard focus ring outside the card), selected while its peek or detail panel is open (selection border), dragging, and the dimmed source. All are drawn in `components.png`. Motion follows § Motion and reduced motion.

## Card peek

Screenshot: `board-peek.png`.

Shift+click, Shift+Enter, the card-face Show summary button or the card menu's Show summary opens a 400px sheet over the right side of the board. It does not push the grid. Top to bottom:

- lane name, close button;
- title and subtitle;
- status banner when overdue or stale ("No movement for 39 days", "Was due Nov 12");
- **Status:** the previous stage, the current stage or sub-columns with the current one marked, and the next stage; then one row per track with its state;
- **Fields:** every custom field, "Not set" in tertiary text for empty ones, and a note "2 of 8 pinned to the card";
- **Time in each column:** one segmented bar and a list with days per column, current column bold;
- **History:** the card's moves, newest first;
- actions: Open card (primary), Move.

Placement, focus return and Escape follow § Card detail sheet placement. Clicking another card swaps the peek (§ Swapping the open card). **Deviation (#2358):** the canvas opens the peek on a plain click; shipped, a plain click or Enter opens the detail panel and the peek is opt-in, because editing is the more frequent reason to click a card. Focus lands on Open card; a never-moved card reads "Never moved". **Deviation (#2391, owner decision 2026-11-19):** the sheet's field list carries a Labels row after Due date ("None" when the card has none), and the hover peek gains Due date and Labels rows too, because the Dense face draws no labels and the Comfortable face draws no on-track due date (#2399).

## Activity drawer

Screenshot: `board-activity.png`.

Same sheet position as the peek; only one of the two is open at a time. Two tabs: Recent (board moves, newest first: avatar, card title, "Qualified to Discovery", relative time) and Archived (archived cards with Restore). A link at the bottom opens the full History view.

## Sub-columns and tracks

Screenshots: `board-dark.png`, `components.png`.

The rule from #1102 and #1920 holds: if the order of the checks matters they are sub-columns; if not, they are tracks.

- **Sub-columns** (#1102): a stage's ordered steps. The stage takes one column's width of grid track per sub-column (two get `2fr`, four get `4fr`; floor 160px each plus the 8px gaps). One WIP limit covers the whole stage. The last sub-column is counted as waiting.
- **Tracks** (#1920): facts that finish in any order. Each track on a card is done, open or not applicable, shown as a chip: check icon on a success tint, hollow circle with a border, or dash on a neutral fill. Icon and fill both change, so the state never depends on color alone.
- The column structure is identical in every swimlane. A swimlane can only mark a track not applicable.
- With "Show sub-columns" off, a split stage renders at normal width and each card shows a segmented progress bar, as #1102 specifies.

## Stage settings

Screenshot: `stages-settings.png` (the panel at the bottom).

Opens from the column menu. Three groups:

- **Sub-columns, in order:** numbered name inputs, ↑ / ↓ reorder buttons (#2368; not in the image, a card follows its sub-column), remove buttons, "Add sub-column". Note: one WIP limit covers the whole stage; time in the last sub-column is recorded as waiting.
- **Tracks, any order:** name inputs (a rename PATCHes the dimension field before the stage save, #2382), remove buttons, "Add track". Note: each track is open, done or not applicable and shows as a chip on the card.
- **Rules and exceptions:** "Every track must be done to reach <last sub-column>" (checkbox; not built yet, #1920), a list of swimlane exceptions ("APAC: Business is not applicable") with remove buttons, "Add swimlane exception".

Save stage (primary) and Cancel. Composite editor rules in § Composite inline editors apply.

## States

Screenshot: `board-states.png`.

| State | What shows |
|---|---|
| Loading | Skeleton column headers, one lane band and card blocks at their final sizes; announced as "Loading board" |
| Empty board | Column headers with zero counts, then "No cards yet", a sentence, "Add a card" (primary) and "Import cards". Built with the board's lanes kept below the panel, so their add and edit controls stay (#2324); Import cards links to the group's import flow |
| Filter or chip matches nothing | Lanes shrink to their band with "No matching cards"; below, "No cards are due soon" and "Show all cards" |
| Offline | Warning banner while reconnecting, danger banner once failed. Reconnecting copy: "Offline. Reconnecting. Moves are paused until the board is live again." and the connection status reads Offline |
| Load error | "The board didn't load. Check your connection and try again." with "Try again" |
| View-only | An informational line; add controls, drag handles and stage settings are not rendered; the peek still opens |

## Drag and drop

Screenshot: `components.png`, "Cells and drag and drop".

- The dragged card tilts 2°, takes a deep shadow and follows the pointer. Its source stays in place at reduced opacity.
- The cell under the pointer takes a selection-colored dashed border and tint, and a placeholder shows where the card will land.
- A drop that would put a column or lane over its limit shows the warning treatment and the reason in the cell before the drop. What happens on drop follows the existing limit rules (§ Placement limits on the board, § Move-blocked toast).
- Dragging across a gate inside a stage passes or reopens gates as #1102 specifies.
- A drop always appends to the cell, so the placeholder sits after the last card, not at the top as `components.png` draws it.
- The WIP-blocked reason is a corner pill on the cell, not the centered amber line `components.png` draws (named deviation, #2326).
- With reduced motion, the tilt and lift are dropped.

## Keyboard

- No new shortcut keys. Existing board shortcuts and the command palette keep working.
- Tab order: toolbar, filter chip row, Show chips, column header add buttons, then per lane: collapse toggle, "N fields", cards in column order and, inside a split stage, sub-column order.
- Enter or Space on a card opens the detail panel, Shift+Enter opens the peek; Escape closes it and returns focus to the card.
- The existing keyboard move path gains sub-columns as stops between columns.
- Every click target here has keyboard parity (§ Click handlers need keyboard parity).

## Phone width

Screenshot: `board-phone.png`.

- One column at a time. A horizontally scrolling row of column buttons (color dot, name, count) selects it; under it, the column's limit line and meter.
- A split stage adds a segmented control with one segment per sub-column; each name truncates, the count never does, and the full name is the button's accessible name. With "Show sub-columns" off there is no switcher: the stage shows all its cards in one list, as the grid's unsplit cell does (#2531). Each card then shows the same segmented gate progress bar as on the grid (#2535).
- Lanes stack. Each lane band shows the name, "2 here", then lane fields and counts on a second line: the "N fields" toggle on a legacy board (every field `band_visibility` null, #2439; a board with tiers uses "Show N more") (then the first two lane fields while it is closed), overdue, stale, the lane WIP line and the rollup, in the desktop band's order and tiers (#2329). The first line is the one collapse target (44px); the second line sits outside it, because a URL field is a link and the "N fields" toggle is a button. Tapping an item on the second line, such as "4 overdue", does nothing; only line one collapses the lane. On a legacy board, admins get the same "Change field order" link after the open field grid as on the grid. "2 here" is the selected column's cell count, not the lane card count #2328 removed from the desktop band. Lane health, Add card and Lane actions are the band's last line, inside the tinted box behind a divider (#2277, #2498), and lanes sit further apart than a lane's own contents so each action row reads as its lane's. The second line uses the desktop band's tones (`board-dark.png`), not the dimmer `board-phone.png` draft, so a lane reads the same at every width.
- Cards show title, subtitle, track chips with their state in words ("Technical: done"), label, status and pinned fields.
- The same four tabs as desktop: Board, Summary, History, Analytics. Search is an icon button in the header; Filter, Activity, Export (when the viewer can export) and Settings (admins), then More, are icon buttons at the end of the tab strip, which is the second and last chrome row (#2348, about 92px at 390px against the png's 105). The Filters button also opens the View options. Star, Health, Notifications and the account menu stay in the header beside the board name; the png leaves them out, and this layout is an implementer proposal awaiting owner ratification in #2348, not an owner decision (the issue's ux-review proposed it, minus moving Search and folding Activity away). The board name gets about 82px at 390px beside six 44px header controls, under the 120px rule; moving Star and Health into More is the open follow-up. The tab strip scrolls (the active tab is scrolled into view and the right edge fades). With all five buttons it is 122px wide for 356px of tabs at 390px (#2435), so about one and a half tabs show at once; the toolbar stays one row (owner decision 2026-11-20). The connection status shows only when it is not healthy.
- Every target is at least 44px. No sideways page scroll at 390px.

## Design tokens

The screenshots use literal colors. Build with the tokens.

| In the design | Token |
|---|---|
| Page background behind the grid | `bg-sunken` |
| Cell well, collapsed strip cell | `bg-canvas` |
| Card, column header, lane band, sheet, menu | `bg-surface` (`bg-surface` with `shadow-xl` for sheets and menus) |
| Chip fill, kbd hint, bar track | `bg-surface-hover` with `text-fg-secondary` |
| Panel and card border | `border-line` |
| Control border, hover border | `border-line-strong` |
| Sole-separator boundary (sub-column divider, open chip, phone switcher) | `border-line-boundary` |
| Primary text, card title | `text-fg` |
| Subtitle, values, secondary text | `text-fg-secondary` |
| Field labels, captions, "Not set", sub-column notes | `text-fg-tertiary` (never `fg-muted` on the card face) |
| Primary button | `bg-button-primary hover:bg-button-primary-hover text-on-primary` |
| Active tab underline, active segment | `border-primary`; `bg-primary text-on-primary` with `ActiveMark` |
| Selected card, open-panel button, active Show chip, drop target | `border-info` with `bg-primary/20` fill |
| Overdue border and text | `border-danger`, `text-danger-on-tint` |
| Stale text, over-limit count, lane WIP over | `text-warning-on-tint` |
| Over-limit meter, drop-blocked border | `bg-warning`, `border-warning` with `bg-warning/20` |
| Track done | `text-success-on-tint` on `bg-success/20` |
| On-track square in a collapsed strip | `bg-primary/70` |
| Link | `text-info` |

Column and lane tints come from the user-assigned column or lane color: 10% of the color as the fill and 30% (column) or 35% (lane) as the border, over the page background. Add one helper for this next to `colorChipStyle`, and pin text contrast on the tint for a sample of the RGB cube in both themes, as `colorContrast.test.ts` does for label chips. Text on a tinted band or header is `text-fg` and `text-fg-secondary` only.

Sizes: radius 8px on panels, cards and wells, pill on chips, 4px on track chips. Grid gap 8px; lane sections 10px apart in the canvas (shipped at 4px between wrappers with a `py-2` band after the #2434 density pass, a deliberate departure); card padding 10px; card rows 7px apart. Type: lane name 17px semibold; column name, card title 13px semibold; card subtitle, fields, status 12px; chips 11px semibold; body 14px. Smallest text is 11px and only on chips. Where the type scale in § Typography has no exact step, use the nearest step.

## What the API must return

All additive.

- A per-board choice of the number field to roll up per lane (#2275): `Board.swimlane_rollup_field`, summed client-side from the card values. The per-lane WIP limit reuses the existing `Swimlane.wip_limit` (#1150), so it needs no new data.
- Sub-column structure and each card's gate position (#1102).
- Track definitions, per-card track states and per-lane "not applicable" exceptions (#1920).
- Per-card time in each column for the peek. Check whether the analytics drill-down endpoint already covers it before adding one.

## What changes for existing features

- **No Classic fallback.** The owner ruled on 2026-11-14 that, with no installed users to protect, the redesigned board is the only board in 1.3. The preset ids stay valid because they are stored in `Board.default_preset` and in `?preset=` links; Classic stops having its own rendering (#2279).
- **Presets** keep bundling pinned fields, density, overlay and default filter. The picker moves into the View menu.
- **History** stays a tab. Archived cards move from the toolbar to the Activity drawer.
- **Swimlane label panel** and its popover are replaced by the lane band.
- **#871** is implemented as drawn here.

## Rules to rewrite

Each child issue rewrites the frontend UI conventions section it replaces (in `frontend/CLAUDE.md` or the `frontend/ui-conventions/` topic file its index line names), in the same MR as the code:

| Section | Issue |
|---|---|
| § Board navigation bar; picker placement in § Board presets | #2269 |
| § Column headers; § Board grid cells | #2270 |
| § Swimlane label panel | #2271 |
| § Cards; § Card density; § Card border urgency tint | #2272 |
| § Card detail sheet placement, if the peek changes it | #2273 |
| § Empty states; § Placement limits on the board | #2276 |
| Classic rules in § Board presets | #2279 |

## Fidelity check

The goal is that the built board matches these screenshots in structure, tokens and layout. A mock and a real build never match pixel for pixel (fonts, real components), so the check has three layers:

1. **Fixture.** Seed one board from `board-redesign/sample-board.json` (3 lanes, 7 columns, 29 cards, Discovery split in two with two tracks). Every screenshot on this page uses that data.
2. **Assertions.** Each child issue adds tests for the rules it implements: for example only overdue cards carry `border-danger`, the count line reads "8 / 6 over" when over the limit, a collapsed lane renders one square per card, the grid template gives a split stage two tracks.
3. **Side-by-side review.** The implementing MR captures the same state at the same viewport from the fixture with Playwright (1440px dark and light; 390px for phone) and shows each next to its reference PNG. `ux-review` signs off row by row against the [review checklist](#review-checklist). After sign-off the captured image becomes the pinned baseline (`toHaveScreenshot`) in `e2e/board-redesign.spec.ts`, so later changes that drift fail CI (#2279).

## Not part of this design

- A different column structure per swimlane.
- Lead time, forecasting or any analytics panel on the board.
- Pricing, sales concepts or any domain meaning in the product: the sales pipeline is sample data only.

## Decisions

Owner decisions, 2026-11-14:

- This design is the standard for the Board view; other board designs conform to it.
- Sub-columns for ordered steps and track chips for parallel facts.
- Lanes cannot change column structure; a lane may mark a track not applicable.
- History stays a full tab; the Activity drawer is the quick look.
- No Classic fallback in 1.3.

Evidence and its limits: a simulated persona panel (not user research) and desk research informed the History and per-lane decisions. The real usability baseline (#1590) has not been run.

Decided in #2275: the lane WIP limit reuses #1150's `Swimlane.wip_limit`, and the rollup is a number field stored on the board (stale ids kept when the field is retyped, nulled when deleted), computed client-side. Open for `architect`: how tracks are stored (#1920).

Open for the owner: the default card density for new boards (#2433). The measured heights, options and an implementer recommendation are in [Technology Decisions](../architecture/decisions.md#default-card-density).

## Review checklist

For `ux-review` and `completeness-check` on the implementing MRs:

- [ ] Toolbar holds only the four tabs, Filter, View, Activity, Export, Settings, the overflow menu and the connection status
- [ ] One grid template drives headers, cells and collapsed strips; a split stage takes one column's width per sub-column
- [ ] Column names stay on one line and truncate with an ellipsis (#2389); the count line matches [Column headers](#column-headers)
- [ ] The lane band replaces the label panel and wraps without sideways scroll
- [ ] Only overdue cards have a colored border; stale is warning text with a clock icon
- [ ] Card rows appear in the order in [Cards](#cards); on-track cards have no status line
- [ ] Show chips filter cards while column and lane counts stay whole
- [ ] A collapsed lane shows one square per card in the right column and sub-column
- [ ] The peek lists every custom field and marks empty ones "Not set"
- [ ] Track state is carried by icon and fill, not color alone
- [ ] All six states render as in `board-states.png`
- [ ] Every drag state renders as in `components.png`
- [ ] No sideways page scroll at 390px; targets are at least 44px there
- [ ] Light and dark themes pass the contrast rules in `frontend/CLAUDE.md`
- [ ] The replaced frontend UI conventions section (`frontend/CLAUDE.md` or its topic file) is rewritten in the same MR

## Artboard sources

`docs/development/board-redesign/artboards/` holds the design canvas files as published. `Main.dc.html` is the board; `Peek`, `Light`, `Overview` and `Activity` load it with different settings. `Mobile`, `Components`, `Menus`, `BoardStates` and `Stages` stand alone. They are reference material for copy, order and spacing, not code to port: they are excluded from the docs site and need the canvas runtime to render.

Note: the swimlane band's `+N`/`Less` expansion in these artboards is superseded by #2354 (the "N fields" toggle and aligned grid).
