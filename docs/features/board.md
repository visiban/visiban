# Work the board: grid, cards, and settings

<a id="board-cards"></a>

Pick a template in the **Create Board** modal, then drag cards between cells. Everything else on this page shapes that grid.

**Why it matters:** This is the core workspace for anyone who works a board day to day, from quick status checks to full admin control.

**The big picture:** the board is a grid. Columns are pipeline stages, swimlanes are the entities moving through them (customers, projects, epics), and each card sits in exactly one cell. Every move is logged to the audit trail.

!!! note "Small screens"
    Visiban works on phones and tablets: below 1024 px the sidebar becomes a hamburger drawer, and below 640 px the board shows one column at a time (see [Phone layout](#phone-layout)). On a tablet, press and hold a card to drag it (see [Touch screens](#touch-screens)). Column/swimlane resizing is easiest with a pointer, so a desktop browser is still the best fit for heavy board editing. See [Navigation → Mobile behavior](navigation.md#mobile-behavior).

## Board creation

Pick a template in the **Create Board** modal. Ten are available (Sales Pipeline, Customer Support, Product Roadmap, Project Delivery, Hiring & Recruiting, and more), each with a tailored column layout and a first swimlane so you can start working right away.

No template fit? Select **Blank Board**. It creates no columns at all, so you build the layout yourself.

Templates apply once, at creation. Afterward you can rename, reorder, add, or remove columns freely.

### Inline board rename

<span class="vb-version" title="Added in 1.1">1.1+</span>

Board admins can rename a board without opening the settings modal: click the board name in the top-left breadcrumb to enter an inline edit field. Press **Enter** to confirm, **Escape** to cancel. Non-admins see the board name as plain text and cannot click to edit it.

**API:** `PATCH /api/v1/boards/{id}/` with `{ "name": "New name" }`

## Board layout

The board is a CSS grid with columns on the x-axis and swimlane rows on the y-axis. Each cell is a droppable zone identified as `cell:{column_id}:{swimlane_id}`.

- Column headers are sticky on horizontal scroll.
- Column headers stay visible when the board scrolls vertically, and the grid scrolls sideways inside its own box when the window is narrow.
- Columns share the board's width, with 8 px between them, and the header row, every swimlane and every collapsed swimlane use the same column grid, so columns line up in every row. Below 1240 px of board width, or once a column would get narrower than 160 px (on a board with many columns, or after one column is widened far past the rest), the grid scrolls sideways inside its own box; the page never scrolls sideways. A board nobody has resized splits its width equally; drag a column separator to resize the column to its left (its edge follows the pointer), and the column keeps that width relative to the others (a column dragged to twice the default width stays twice as wide as a default one at any window width). Column widths persist per board in localStorage. *Changed in 1.3 (#2300).*
- On a board wider than the window, each swimlane's header band stays pinned to the left edge while the grid scrolls sideways, so the lane name, its fields and its counts at the right stay in view. *Changed in 1.3 (#2305).*
- Each column header is a panel tinted with the column color: color dot, name (it wraps rather than truncating), an add-card button, a thin WIP meter and a count line. With no limit the line reads `2 cards` and there is no meter; under a limit it reads `2 / 4` with the meter in the column color; at the limit `4 / 4` with a full meter; over the limit `8 / 6 over` in warning text with a full warning-colored meter. A weight budget that is exceeded adds `Weight 14/10` to the same line. *Changed in 1.3 (#2270).*
- When enforcement is enabled, moves into a full column are blocked (`409` error); board admins can override with `?force=true` (soft) or are denied entirely under hard mode.

### Adding a card to a cell

> **Changed in 1.1** — empty cells now read as a discoverable click target instead of hiding the **+ Add card** affordance in the bottom-left corner.

An empty cell shows one quiet **+**; the whole cell is the add target. A populated cell's blank space below the cards is the add target too (see below). On hover or keyboard focus it gains a dashed edge and the label **Add card**. The empty cell and the populated cell's button share the accessible name `Add card to {column} in {swimlane}`, so a screen reader says where the card goes. A lane is as tall as its tallest cell, so one tall cell does not stretch the cards in the others.

- Click anywhere in the cell, or press **Tab** to focus it then **Enter**/**Space**, to open the inline new-card input.
- In a populated cell, the **+ Add card** button fills the blank space below the cards, so clicking anywhere in that space adds a card. On hover or keyboard focus it shows a dashed edge and the label **Add card**; it is at least 44px tall, so it stays easy to tap when cards fill the cell, and it is hidden during a card drag (keyboard focus on it is kept). The **+** button in a column header adds to that column: on a board with one visible swimlane it opens the new-card input directly; with several it opens an **Add card to which swimlane?** menu listing every visible swimlane in board order (swimlanes you hid or a lane filter removed are not offered), and picking one opens the input in that swimlane's cell. A collapsed swimlane is listed as "(collapsed)" and is expanded when you pick it. Escape closes the menu and returns focus to the **+**.
- Double-click and right-click on a cell still work for power users. Since 1.3 a right-click **on a card** opens that card's [actions menu](#card-actions-menu) instead; right-click the empty space in the cell to add a card.

> **Changed in 1.3 (#2319)** — the **+ Add card** button in a populated cell used to be a small strip at the bottom; it now fills the blank space below the cards.

Card creation requires the column's *Allow card creation* setting and at least the Member role.

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane has a full-width **header band** tinted with the swimlane's color. Left to right it holds:

- a collapse chevron (it points down when expanded and turns to point right when collapsed);
- a small square in the swimlane color, then the name in larger semibold type (admins also see the contact email, and a set [health status](health-status.md#lane-status) follows the name);
- the swimlane's first two field values as `Label value` pairs, then an **N fields** button (it opens an aligned grid of every field, with labels in a fixed column and **—** for an unset value, under the band; see [Swimlane fields in the lane band](custom-fields.md#swimlane-fields-in-the-lane-band));
- at the right: **N overdue** and **N stale** (each omitted when zero), the [row limit](#swimlane-limits) line when the row has one, and the swimlane rollup total (`$413k open`) when the board has chosen one.

The band wraps onto a second line when it runs out of room. The name is cut short only when it alone is wider than the band; the full name shows when you hover it. The drag handle, the **Focus** button and, for admins, the **⋮** menu sit next to the swimlane name and appear when you hover over the band or move keyboard focus to them. On a touch device, which has no hover, they are always shown. **Focus** shows only that swimlane. The **⋮** menu (**Actions for swimlane**) holds **Edit swimlane…** and **Change field order…**. On a phone, the swimlane's action row has **Edit** and **Field order** buttons for admins.

> **Changed in 1.3 (#2328, #2335)** — the band no longer shows the swimlane's card count. A lane over its WIP limit still shows the count in its limit line (`WIP 5 / 4 over`), and the collapsed strip shows the count per column. The edit button is now hidden until you hover the band or focus it, like the drag handle and the focus button. The old left label panel is gone, so the cards start at the left edge of the board.

**Resizing:**

- **Column width:** drag the separator to the right of a column header (or the same separator in any swimlane row). Width persists per column per board in localStorage. Hidden and collapsed columns keep their narrow stub and are not resized.
- **Row height:** drag the bottom edge of any swimlane row to set a minimum height. Height persists per swimlane per board in localStorage.

Each swimlane has the following fields:

| Field | Description |
|---|---|
| Name | Required; unique per board |
| Color | Tint and color square on the header band. Pick a preset or a [custom color](#custom-colors) |
| Contact email | Optional; set when you create the swimlane. Displayed in the header band for admins only (hidden from members and viewers) |
| Notes | Optional free-text field on the data model; not currently exposed in the UI |
| Health status | Optional; set by board admins on each lane. Separate from the board's own status. See [Lane status](health-status.md#lane-status) |
| Position | Controls row order on the board |

!!! note
    The `contact_email` and `notes` fields are restricted to board admin and site admin roles. Members and viewers do not receive this data via the REST API or WebSocket events.

!!! note "Contact email isn't editable after creation yet"
    Contact email can only be set in the **Add Swimlane** dialog. The **Edit Swimlane** modal covers name, color, swimlane field values and [limits](#swimlane-limits), not contact email — to change it, delete and recreate the swimlane, or wait for that gap to close.

Click the chevron on the band to collapse a swimlane and save vertical space. When collapsed:

- The band stays, with its fields, counts and health status, and the cells are replaced by one strip aligned to the columns. The stored row min-height is ignored.
- Under each column the strip shows the swimlane's card count (an en dash when there are none) and one small square per card: red for overdue, orange for stale, blue otherwise. The number is always there, so the squares never carry meaning alone; screen readers read `Qualified: 4 cards, 1 overdue, 2 stale`. A card in a done column never counts as stale.
- While a filter is active, the strip counts only the matching cards, and a column with matches pulses (unless you prefer reduced motion).
- A calm row-limit line is hidden, and an over-limit one stays.
- The **⋮** menu, drag handle and focus-mode crosshair remain.
- Click the chevron again to expand and restore full card visibility. Collapse state is saved per user per board, as before. **Collapse all** and **Expand all** for swimlanes live in the toolbar's **View** menu (**Collapse all** and **Expand all** under swimlanes), and the **Show** row has a matching [**Collapse all lanes** button](#show-chips).

Admins can double-click the swimlane band, or choose **Edit swimlane…** from its **⋮** menu, to open the Edit Swimlane modal.

### Swimlane limits

> **Added in 1.3** (#1150)

A swimlane can carry its own WIP limit and weight limit, the same way a column does. On a board whose rows are customers, projects or candidates, this is the limit you usually want: "no more than three in flight for this client."

Set them in the **Edit Swimlane** modal (board admins), under **Limits**:

- **WIP limit** and **Weight limit.** Leave a field empty, or enter `0`, for no limit. The helper under each field shows the row's current count ("Now 4"). When the new limit is already below that count, a note says so and says what happens next for the enforcement you selected: nothing already in the row moves; with **Block, admins can override** new cards are refused unless a board admin overrides, with **Block for everyone** they are refused for everyone, and when the limit is not enforced (**Follow board settings** on a board that enforces nothing) it only shows on the row.
- **Columns that count.** Only cards in the checked columns count toward the row's limits. By default every column not marked as done counts, so a finished card stops counting the moment it reaches a done column. Deleting a column removes it from every row's selection; a row left with none goes back to the default.
- **When the row is full.** **Follow board settings** (the default) applies the board's **Enforce WIP limits**, **Enforce WIP hard** and **Enforce weight limits** rules, exactly as for columns. **Block, admins can override** refuses the move and lets a board admin move anyway. **Block for everyone** is the hard mode: nobody, board admins included, can add a card past the row's WIP limit. A weight limit can always be overridden by a board admin, as on columns.

**What the row shows.** Once a row has a limit, its band shows one state line in the right-hand stats, worst state first:

| State | Line |
|---|---|
| Under the limit | `WIP 4 / 6` |
| At the limit | `WIP 5 / 5 · at limit`, only when the board's **Show at-limit WIP indicator** setting is on; otherwise the line reads `WIP 5 / 5` |
| Over the WIP limit | `WIP 5 / 4 over` in warning (orange) text, like an over-limit column header (`⛔ WIP 5 / 4 over` when the row is in hard mode) |
| Over the weight limit | `Weight 18 / 12 over` in warning text |

The words carry the state. A collapsed row hides the calm states but keeps the two over-limit ones. *Changed in 1.3 (#2275): the line matches the column header's `n / limit over` format and warning color; before, an over-limit row read `⚠ Over WIP · 5/4` in red with a red line across the top of the band.*

### Swimlane rollup

*Added in 1.3 (#2275).* A board can show, in every swimlane band, the total of one card [number field](custom-fields.md) over the lane's open cards, for example `$413k open` on a sales board whose cards carry a deal amount. "Open" means every card in the lane that is not in a column marked done; archived cards never count. Cards without a value add nothing. The total uses the field's prefix, suffix and decimal places, so a field with prefix `$` and suffix `k` reads `$413k open`. It sits after the WIP line in the band and updates live as cards are created, moved, edited and archived.

To choose the field, a board admin opens **Board Settings → Rules → Limit enforcement → Swimlane rollup** and picks one of the board's number fields, or **None** (the default, which shows no total). Other members see the choice as a read-only line. Deleting the field turns the rollup off. Changing the field to another type hides the totals until it is a number field again; the settings then say why.

The lane's own WIP limit is set in **Edit Swimlane** (see [Swimlane limits](#swimlane-limits) above); the rollup does not affect limits or moves.

**What a move does.** A move is checked against a row only when it adds to the row's count: the card enters one of the row's counted columns from another row, from a column of this row that does not count, or by being created or restored there. Moving a card between two counted columns of the same row never trips the row's limit. While you drag a card over a cell whose column or row is full, the cell turns amber with a dashed edge and names the limit (for example `⚠ WIP limit 5/5 · Payouts`). With the keyboard, the screen reader announcement for each cell includes the same verdict. If you drop anyway, the move is refused with the same toast as a column limit, naming the row; when a column limit and a row limit both trip, the toast names both. Board admins get **Move anyway (admin override)** for a soft limit, never for a hard one.

Board import restores row limits as exported and does not check them, as with column limits.

### Swimlane focus mode

> **Added in 1.0**

Focus mode collapses all other swimlane rows so you can work with a single swimlane without distraction, which helps on dense boards with many swimlanes.

**Entering focus mode:** hover over any swimlane band to reveal the crosshair icon (⊙) at its right end, and click it. The icon is always visible (highlighted in blue) when that swimlane is currently focused.

**What changes when focus is active:**

- All other swimlane rows are collapsed and their cards are hidden.
- A blue banner appears between the board toolbar and the scroll area: "Focused on: *[swimlane name]*".
- The URL updates to include `?focus=<swimlane_id>`, so focus mode can be bookmarked and shared.
- [Lane filters](#lane-filters) keep applying while a lane is focused: the rules decide which lanes show, and focus decides which one is expanded. Other lanes that match stay as collapsed rows with their counts, and lanes that don't match stay hidden. The focused lane always shows; if it doesn't match the rules, the banner adds "· doesn't match lane filters". With no lane filters, other lanes are simply collapsed. Editing or clearing the rules takes effect immediately, and on exit the collapse state is restored while the rules keep applying.

**Exiting focus mode:**

- Click **Exit focus** in the blue banner.
- Press **Escape**.
- Reload the page without the `?focus=` param.

On exit, the swimlane collapse state is restored to exactly what it was before focus was entered.

**Edge cases:**

- If the focused swimlane is deleted while focus mode is active (e.g. by another session), focus mode exits automatically and the collapse state is restored.
- If the `?focus=` URL param contains an ID that no longer exists on the board, it is silently ignored.

## Child cards setting

*Added in 1.3 (#2208).* Cards can be linked parent to child across boards, and the hierarchy is two-tier by design: a board is either a parent board, whose cards can have child cards on another board, or a child board, which can only hold children. A board never plays both roles.

A board admin chooses which one in **Board Settings → Rules → Child cards** with the **Cards can have child cards** switch. It is off by default, so every existing board is a child board and nothing changes until an admin turns it on. Other members see the choice as a read-only line. Linking cards is not available yet; this setting is the prerequisite for it. Once links exist, the switch cannot be changed while links depend on it.

## Collapsed columns

Click a column header to collapse it to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes.
- Each swimlane cell shows the card count for that specific swimlane.
- The column header continues to show the aggregate total across all swimlanes.
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count, so hidden results are visible without expanding every column. With your operating system's "reduce motion" setting on, matching cells show a static highlight instead of pulsing.

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **color** — a preset or a [custom color](#custom-colors)
- **WIP limit** — maximum number of active cards allowed. The column header shows `count / limit` with a meter; when the limit is exceeded the line reads `count / limit over` in warning text and the meter turns warning-colored, so the over-limit state is visible at a distance (#963, #2270). If the board has **Enforce WIP limits** enabled (Board Settings → Rules), moving a card into a column at or over its limit, creating a card in it, or restoring an archived card into it returns a `409` error — board admins can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged. See [Hard WIP enforcement](#hard-wip-enforcement) for a stricter mode. Optionally, the **Show at-limit WIP indicator** board setting (off by default) surfaces the *at*-limit case too — see [At-limit WIP indicator](#at-limit-wip-indicator) below.
- **Weight limit** — maximum total card weight (story points / effort) allowed. When the limit is exceeded (and the column is not also over WIP — that state wins) the count line adds `Weight weight/limit` in warning text. If the board has **Enforce weight limits** enabled (Board Settings → Rules), moving, creating, or restoring a card that would push the column over its budget — or raising a card's weight so that it would — returns a `409` error; board admins can override with `?force=true`. Lowering a card's weight is never blocked. Enforcement is **on by default** for newly created boards; existing boards are unchanged.
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected
- **Done column** — mark a column as the completion target for cycle-time and throughput metrics; multiple done columns are supported (e.g. "Done" and "Released")
- **Intake column note** (since 1.3) — the board's first column that is not done is its intake column, where new work arrives. Its **Edit settings** shows a short note under the **Done column** setting: Analytics never names that column as the bottleneck, because a growing queue there is demand, not a hold-up. It still appears in cumulative flow, WIP, WIP aging, dwell, and cycle-time. **More** explains why and links to [how the bottleneck is chosen](analytics.md#bottleneck). The role follows position: reordering columns, or adding a not-done column to the left of the intake column, moves it to the new first not-done column. **Add Column** tells you when the new column will take over the role.
- **Not named as the bottleneck checkbox** (since 1.3) — on the intake column, **Edit settings** also shows a checked, grayed-out **Not named as the bottleneck** checkbox in the **Analytics behavior** section. It is informational and cannot be changed; it moves with the intake role.
- **Done column More** (since 1.3) — a Done column's **Count as completed** checkbox has a **More** disclosure: completion feeds throughput, lead time, and cycle time, while dwell time and the heatmap skip that column.
- **Policy** (since 1.3) — the column's entry criteria and definition of done, shown from a **Policy** button in its header. See [Column Policies](column-policies.md).

**Managing a column:**

- Drag a column header left or right to reorder it.
- Use the **`⋮` kebab** on its header. It appears when you hover over the header or move keyboard focus to it; on a touch device, which has no hover, it is always shown. It offers **Rename**, **Edit settings…**, **Add policy…** (only on a column without a policy), **Delete column**. Double-click the column name to rename directly.
- The kebab is the keyboard-accessible path; mouse users can also drag a column onto the trash zone (see *Column trash zone* below) for the same delete confirmation.

### Adding columns and swimlanes

The separators between columns (8 px, 16 px at the board's outer edges) and between swimlane rows (16 px) are interactive insertion handles:

- **Column separators** (vertical, between columns): hover to see a centered **+**; click to insert a new column to the right; drag left/right to resize the column to its left. Since 1.3 (#2300) a drag sets the column's share of the board's width, so the header and every swimlane row move together.
- **Row separators** (horizontal, between swimlane rows): hover to see a **+** at each column's center; click to insert a new swimlane below; drag up/down to resize the swimlane above.

Both handle types highlight in blue when hovered and the "+" affordance is visible across the full extent of the separator: the column highlight extends through every row separator, and the row highlight extends across the full board width.

The far-left separator (before the first board column) follows the same design. There is no swimlane sidebar to resize, so it only inserts a column at the first position on click.

### Column trash zone

> **Changed in 1.1** — the trash zone is now opt-in, gated behind ⌥ (Alt). Reorder is the default; deletion is a deliberate gesture. The new column kebab menu (`⋮`) is the discoverable, keyboard-accessible alternative.

Dragging a column shows a **Hold ⌥ to delete** hint on the drag overlay.

- Hold ⌥ (Alt) to reveal a red **Delete** drop target at the right edge of the board; the hint flips to **Drop on trash to delete**. Release ⌥ to hide it again.
- Dropping a column there opens the same confirmation as the kebab's `Delete column` action: type the column name to confirm if it holds cards, or delete an empty column with a single click.

### Hard WIP enforcement

> **Added in 1.0**

By default, WIP limit enforcement is "soft": board admins can bypass a full column by appending `?force=true` to the request. The **Enforce WIP hard** board setting removes this override entirely. When enabled:

- Moving a card into a column at or over its WIP limit, creating a card in it, and restoring an archived card into it are blocked for **all roles**, including board admins and site admins.
- The `?force=true` query parameter is ignored. There is no bypass.
- The API returns a `409` error with `code: "wip_hard_blocked"`.
- The toast indicator uses a `⛔` icon instead of `⚠` to distinguish hard blocks from soft blocks.

Hard enforcement is **off by default**. Enable it in **Board Settings → Rules → Enforce WIP hard**. Toggling it on requires an inline confirmation step because the change takes effect immediately and applies board-wide.

!!! tip
    Hard WIP enforcement is useful for teams that treat WIP limits as a strict policy rather than a guideline. To unblock a column, move a card out of it or ask an admin to raise the WIP limit.

**Where limits are checked:** WIP and weight limits, soft or hard, are checked whenever a card is moved into a column, created in it, or restored into it from the archive, and weight limits also when a card's weight is raised. *Changed in 1.2 (#1428): before 1.2 only moves were checked.* Since 1.3 the same paths also check a swimlane's own limits; see [Swimlane limits](#swimlane-limits).

- [Board import](#import) is the one exception: it restores a board as it was exported, so an imported column can start out over its limit.
- When a new card or a restore is refused, the add-card field or the **Archived** tab of the Activity drawer says which limit was reached, and the card stays where it was.
- When a weight increase is refused, the card detail shows the reason under the weight control and the weight reverts.

See [Field Enforcement](../architecture/field-enforcement.md).

### At-limit WIP indicator

<span class="vb-version" title="Added in 1.2">1.2+</span>

**As of 1.3 (#2270) the column header always shows `count / limit` and a full meter at the limit, so this setting no longer changes the header.** It is kept so existing boards and the API are unchanged. Before 1.3 the column header only flipped out of its calm `N cards` state for the *over*-limit case, and the **Show at-limit WIP indicator** board setting (off by default, admin-only, in **Board Settings → Rules → Limit enforcement**) added the at-limit state:

- **Off (default):** a column at its WIP limit shows `N cards`, unchanged from the calm state.
- **On:** a column at its WIP limit shows `WIP N/N` in place of the card count, styled the same as the calm state (`text-fg-muted`, no accent strip, no glyph) — deliberately quieter than the over-limit warning so the two states stay visually distinct. Hovering shows the tooltip "Column is at its WIP limit (N/N)".
- Columns **over** their limit are unaffected: the existing `⚠ Over WIP` treatment always takes precedence.
- Columns under the limit are unaffected: always `N cards`.

This setting is purely ambient: it does not change limit enforcement, which is controlled independently by **Enforce WIP limits** / **Enforce WIP hard** above (#973).

## Custom colors

> **Added in 1.3**

Columns, swimlanes, new card labels and a [group's shared labels](groups.md#group-shared-labels) keep their preset swatches and add a custom color control at the end of the row, a dashed circle with a plus. It opens a panel with a saturation square, a hue slider and hex and R, G, B fields.

- **Nothing changes until you choose Apply.** The preview in the panel shows your draft; the row and the board do not. Cancel, Escape, clicking elsewhere or tabbing away discards the draft. Whatever you typed in the dialog or card behind it stays as it was: a first click on the area outside closes only the panel, and a second click there closes the dialog or card. The exception is clicking another card on the board, which replaces the open card straight away, so a label name you were typing in it is gone.
- **On this board:** in the column and swimlane dialogs the panel also lists colors already used by this board's columns, swimlanes and labels under **On this board**; choosing one applies it. <span class="vb-version" title="Added in 1.3">1.3+</span>
- **Hex takes 3 or 6 digits** (`#ABC` is saved as `#AABBCC`). **R, G and B go from 0 to 255.** Apply stays unavailable and a message explains why until the values are valid.
- **When you apply a custom color, it fills the control**, so you can see it and change it later. A value that matches a preset selects that preset instead.
- **In the new-label row on a card**, once the label has a name, the button reads **Create label** and applying creates the label in that color, as clicking a preset swatch does.
- **From the keyboard:** Tab to the control and press Enter or Space to open it; focus starts on the square. Arrow keys move the square and the hue slider. Tab reaches the fields and buttons in order, and Enter in any field or slider applies.

## Cards

Cards are calm so the urgent ones stand out. The bold title is the text before ` -- ` (a company name, for example) and the text after it is a subtitle at Comfortable density. Only an **overdue** card has a colored (red) border; every other card keeps a neutral border, and priority is read from the card's accessible name and the peek. The status line is the one place a card's status shows: **Overdue Nov 12** (red text, flag icon), **Stale 39d** (amber text, clock icon) or **Due in 3 days** (secondary text, flag icon). Every status carries words and an icon as well as color. **How much metadata appears on each card depends on the board's *Card density* setting** (Comfortable / Standard / Dense; see [Card density](#card-density) below). The assignee avatar sits at the end of the label row (at the bottom-right under Classic). Under the **Classic** [preset](#board-presets), cards keep their earlier colored priority border and urgency badge.

### Card density

> **Added in 1.1** — replaces the previous per-user *hide field* toggles (Labels / Due date / Assignee / Priority badge / Last moved).

A board admin chooses one of three layouts in **Board Settings → Display → Card density**. Density does not change the swimlane band, which shows the first two lane fields at every tier (since 1.3, #2303):

| Tier | Best for | What appears on the card face |
|---|---|---|
| **Comfortable** *(default for new boards)* | Sam-style occasional users; teams who want a clean glanceable board | One status line (Overdue · Due soon · Stale) under the details, one primary label + `+N` overflow pill, checklist progress, assignee avatar |
| **Standard** | Mid-density boards — extra signal without the full wall | Adds a second label, due date (when not folded into the status line), weight pill (when `>1`), attachment count |
| **Dense** *(default for boards upgraded from 1.0)* | Power users who use every field every day | A single row: the title, a short status (*Overdue*, *Due soon* or *39d*) and the first pinned field with a value, with the assignee avatar at the end. Labels, checklist, attachments, due date, weight and the rest move to the hover peek (Classic keeps the pre-1.1 layout) |

<a id="overdue"></a>**Overdue:** a card is overdue when it has a due date, that date is before today, and the card is still open: a card in a done column or an archived card is never overdue, and has no *Due soon* status either. "Today" is the date in the instance time zone (`INSTANCE_TIMEZONE`, UTC unless your administrator sets it; see [Instance time zone](../administration/configuration.md#instance-time-zone)), so a card due today is *Due soon* until midnight in that zone, then *Overdue*. The card's Overdue status line and border, the Show chips, the lane counts, the **Overdue** filter and [auto health status](health-status.md) use this rule (*changed in 1.3*, #2313: before, the card face called a card overdue from midnight UTC at the start of its due day, and kept the cue on cards in a done column). Three things still follow your personal time zone, pending #871: the due date's own label (*Due today*, *Due tomorrow*), the due pill's overdue color and glyph (and the red due text under Classic), and the **Due today** and **Due this week** filters, so around midnight a card can match neither **Overdue** nor **Due today**. The card list's `?overdue=` API filter applies only the date part, as it always has, so combine it with the column and archive filters for the full rule. The due-soon notification skips cards in a done column too (*changed in 1.3*).

!!! note "Proposed, pending owner confirmation"
    These #2313 choices are implementer proposals, not settled decisions: a done or archived card is never overdue; a card due today reads *Due soon* until midnight in the instance zone; the instance zone is served to anonymous clients on site-config.

**Status line:** it picks the most urgent of Overdue, then Due soon (within 72 h), then Stale (server-flagged from the board's staleness threshold). At Comfortable it sits on its own row under the card's details; at Standard it shares the row with labels and fields; at Dense it shortens to *Overdue*, *Due soon* or the idle days (*39d*). A card that is on track has no status line. A "Just moved" (within 24 h) cue still appears as a small badge. Under **Classic** or no preset the earlier urgency badge with ⚑ / ⏱ text symbols is kept.

### Show chips

A **Show** row above the column headers has four chips: **All cards**, **Overdue**, **Stale** and **Due soon**, each with the number of cards on the whole board. Click one to hide every card that does not match, in every swimlane and sub-column. The colored squares on a collapsed swimlane use the same colors as the chip swatches. The active chip is shown by bolder text and a blue border, not by color alone. A chip is a quick view rather than a saved filter: it is kept in the page address (`?show=overdue`, `?show=stale` or `?show=due_soon`) so you can share it, it is not remembered between visits, and it combines with the Filter panel. The Show row also appears under the Classic preset. Column counts, WIP meters and lane counts keep counting the whole column or lane. The board totals (swimlanes, columns and cards) are shown at the right of the row. A **Collapse all lanes** button in the same row mirrors the **View** menu's **Collapse all** and **Expand all** items for swimlanes; its label changes to **Expand all lanes** when every lane is collapsed. Screen readers announce "Collapsed all N lanes" or "Expanded all N lanes" when you use it; the **View** menu's swimlane **Collapse all** and **Expand all** items, and the **Expand all swimlanes** button on the strip that appears when lanes are collapsed, announce the same "Collapsed all N lanes" or "Expanded all N lanes" message ("Collapsed all lanes" when the count is not known). <span class="vb-version" title="Added in 1.3">1.3+</span>

Fields hidden from the card face at Comfortable / Standard (weight, attachment count) still appear on the **card peek** (hover for 600 ms) as a single muted line — `Weight 5 · 3 attachments`. The full detail panel always shows everything.

**Upgrading from 1.0:** existing boards are migrated to **Dense** so they keep their compact density until an admin chooses otherwise. Per-user per-field hide preferences from 1.0 (browser-stored) are silently dropped. The board admin's setting is now the default density for everyone, unless a member sets their own personal override (see below).

#### Personal density override

<span class="vb-version" title="Added in 1.2">1.2+</span>

Any board member, not just admins, can flip **Use my own density** in **Board Settings → Display** and choose Comfortable, Standard, or Dense for their own view. This overrides the board's admin-set default without changing it for anyone else, including other admins. The override is stored in the browser (not synced across devices) and is board-scoped: turning it off, or clearing it, reverts that device to the board's admin-set default (#974). Since 1.3 a [board preset](#board-presets) you apply can set this override too, and the Display tab then says which preset set it. An override you set yourself, including one from before 1.3, is never attributed to a preset, even when its value matches one. When the board has a default preset that sets a density, turning the override off returns you to that preset's density.

Empty cells show a dashed border to indicate they are valid drop targets even when no cards are present.

### Card peek sheet

*New in 1.3 (#2273, #2358).* Hold **Shift** and click a card, or focus it and press **Shift+Enter**, to open its **peek sheet**. A plain click, **Enter** or **Space** opens the [detail panel](#card-detail-panel) as in 1.2. You can also choose **Show summary** in the card's [actions menu](#card-actions-menu), or press the **Show summary** (eye) button on the card face, which appears on hover or focus and, on touch screens, next to **⋯ More actions**. The peek sheet is a 400 px read-only sheet over the right side of the board. It floats over the grid and never resizes it. At 640 px and narrower it fills the screen. Top to bottom it shows:

- the swimlane name and a **Close** button, then the title and a short description;
- a banner when the card is overdue (**Was due Nov 12**) or stale (**No movement for 39 days**);
- **Status**: the previous stage, the current stage (marked, with a border and bold text, not color alone) and the next stage;
- **Fields**: every custom field on the board, with **Not set** for an empty one, plus the assignee, due date and when the card last moved (**Never moved** for a card that has not), and, when the board has custom fields, a note such as **2 of 8 pinned to the card**;
- **Time in each column**: one segmented bar and a list of days per column, with the current column in bold. A column the card visited twice is added up;
- **History**: the card's moves, newest first, each with a relative time (**39 d ago**) and the exact date and time on hover;
- **Open card** (opens the full [detail panel](#card-detail-panel)) and **Move** (a column and swimlane picker; shown to people who can edit the card).

The open card is marked on the board with the same ring as the detail panel. Click another card (or Shift+click it) to swap the peek to it; click an empty part of the board, press **Escape** or select **Close** to close it, and focus returns to the card. Only one of the peek sheet, the detail panel and the [Activity drawer](#activity-drawer) is open at a time: opening one closes the others. While the detail panel is open, clicking another card switches the panel, and Shift+click does too (it does not open the peek). Opening a card from a link, the command palette or a relation opens the detail panel directly.

### Card detail panel

Click a card to open its **detail panel** (from the peek sheet, click **Open card**; focus lands on that button when the peek opens). Where it opens depends on the window width. *Changed in 1.2 (#1914): before 1.2 the panel always opened at the right edge of the window, over a dimmed board.*

- **1280 px and wider:** the panel opens next to the card's column, to its right if there is room, otherwise to its left. A small tail on the panel's outer edge points at the card (the panel gets a thin blue outline), and the card gets a thick blue border and ring while it is open. The board is not dimmed. If neither side has room (the panel never covers the swimlane names), the card's column is scrolled off to the side, or the card isn't on the board (for example, it is filtered out or its swimlane is collapsed), the panel opens at the right edge instead. A card scrolled out of view up or down keeps the panel next to its column; the tail then becomes a wedge near the panel's top or bottom corner, pointing up or down toward the card.
- **641 to 1279 px:** the panel opens at the right edge of the window, over a lightly dimmed board.
- **640 px and narrower:** the panel fills the screen, with a **‹ Board** button to go back.

**Dock to edge** *(new in 1.3, #1915)*: above 640 px, the panel header has a **Dock to edge** button just left of **×**. Click it to keep the panel at the right edge of the window at any width instead of next to the card's column; the button then reads **Open next to card** and shows a short underline bar, a border, and a different icon. Your choice is remembered in this browser and applies to every card you open afterward, including when you switch cards. The button is not shown at 640 px and narrower, where the panel fills the screen.

**Key facts and section counts** *(new in 1.3, #1916)*: a row of small buttons sits under the card title and stays in view while the body scrolls. It shows the card's column (with the swimlane when the board has more than one), the assignee, and the due date (marked with ⚑ when overdue), followed by any [pinned custom fields](custom-fields.md) that have a value, such as a deal value. A fact that does not apply to the card is left out. Click a fact to jump to its field: the panel switches to **Details** if needed, scrolls the field to the top of the body, and moves keyboard focus to the field (or to the section itself when you can't edit it, for example as a viewer). The column fact opens the same **Move** popover as the Move button; people who cannot move the card see it as plain text. Viewers can use every other fact, because jumping is reading. If the facts need more than two lines, the rest collapse into a **+N** button that expands the row in place. In a window shorter than 720 px the row is limited to one line, so the details keep at least half of the panel; the full-screen panel on a phone keeps two lines.

Section headings show how many items they hold, for example **Attachments 2** and **Relations 0**. A zero is shown. While a count is still loading, or if it failed to load, the heading shows no number. The counts update as you add and remove items. The **Comments** and **History** tabs show their counts too. The Checklist heading is unchanged.

While the panel is open, click another card to switch the panel to it, or click an empty part of the board to close it. Escape and the **×** button also close it, and focus returns to the card you opened. Cards can't be dragged while the panel is open. The panel stays put when you scroll the board: the tail follows the card, and the panel moves to the card's column again when you stop scrolling or resize the window.

The panel contains all editable fields plus three tabs:

- **Details** — description, priority, assignee, labels, due date, weight, checklist, and attachments. The Checklist and Attachments sections are collapsible via a chevron toggle; each auto-collapses when empty on load. While a card's checklist, attachments and comments load, those sections show placeholders and **Archive card** waits until they finish. The title, key facts, tabs and footer stay in place while the details scroll, and a fade at the top or bottom shows there is more content in that direction.
- **Comments** — the card's discussion thread.
- **History** — the full movement and activity timeline. See [Card History](card-history.md).

**Move button:** the panel header includes a **Move** button next to the column name in the breadcrumb row (visible to members and above). It opens a **Move to** popover to move the card to a different column and/or swimlane without closing the panel: select the destination swimlane and column from the dropdowns, then click **Move**.

- WIP and weight limits are enforced the same way as drag-and-drop moves.
- When a limit blocks the move, the popover names the column and shows the limit's numbers.
- For a soft WIP or weight limit, board admins also get a **Move anyway (admin override)** link right there, which forces the move to the selected destination. Hard WIP limits have no override.

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Rich text with a toolbar (bold, italic, code, lists, heading, blockquote); stored as markdown. See [Card Descriptions](card-descriptions.md). |
| Priority | `low` / `medium` / `high` / `urgent`; shown as a colored border and a filled badge on the card face under the Classic preset, and otherwise read from the card's accessible name and the peek (only overdue cards have a colored border; Dense shows an explicit badge) |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select; displayed on the card as truncated pills (up to 7 characters) |
| Due date | Optional date; past dates are disabled in the picker; shown on the card in the status line (for example *Overdue Nov 12* or *Due in 3 days*) with a flag icon; only an overdue card has a colored (red) border |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state, an optional assignee and due date per item, and a progress bar with a session-only **Hide completed** toggle |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE_BYTES`) |
| Comments | Threaded, visible to all board members; type `@` to mention a member; timestamps show relative time ("5m ago", "3h ago") for recent comments and full date + time for older ones |

### Card peek

<span class="vb-version" title="Added in 1.1">1.1+</span>

Hover over a card for 600 ms to open a read-only **peek popover** showing the card's description (rendered as markdown), checklist progress (`done / total`), and the last-activity timestamp. The popover closes as soon as the pointer leaves the card or any movement begins. No interaction is possible inside it; click the card to open its detail panel, or Shift+click it for the [peek sheet](#card-peek-sheet). The popover footer carries the hint "Shift+click for summary".

- The peek is not shown on any card while the card detail panel is open, so it never covers the fields you are editing. Closing the panel does not bring a peek back; hover a card again to see it.
- The 600 ms delay means casual scrolling and rapid drag-and-drop do not trigger the popover unintentionally.

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic**: the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

While you drag, the card tilts slightly and lifts, and the cell under it gets a dashed outline and tint. A cell that would go over a limit shows the reason in text before you drop. With reduced motion turned on in your system settings, the tilt and lift are dropped.

### Touch screens

> **Changed in 1.2**

On a tablet, **press and hold** a card for about a quarter of a second, then drag it. A quick swipe scrolls the board instead, so you can still pan a wide board with one finger. The same press-and-hold picks up a column header or swimlane handle (board admins) and reorders custom fields in Board Settings.

To move a card without dragging, open it and tap **Move** next to the column name at the top of the panel. On touch screens this button is larger and shows its label. Or tap the **⋯ More actions** button on a selected card, or on the card you just closed, and choose **Move to…** from its [actions menu](#card-actions-menu).

On a phone (below 640 px) cards are not draggable; use Move as above. A Bluetooth mouse paired with a tablet drags exactly as on a desktop.

### Phone layout

> **Changed in 1.3**

Below 640px wide the board shows one column at a time instead of the grid. A row of column buttons (color dot, name, card count) selects the column; scroll it sideways if the columns do not fit. Under it, the selected column's limit line and meter appear when the column has a limit.

The limit line shows the card count against the WIP limit (with ⛔ when the board enforces a hard limit and the column is over it) and, when the column is over its weight budget, **Weight** total/budget, as the column header does on a larger screen. Beside it, a column with a policy shows a **Policy** button for everyone; it opens the policy, and board admins can edit it from there.

Swimlanes stack. Each lane has a band showing its name and how many cards it has in this column ("2 here"); tap that line to collapse or expand the lane. A second line shows the lane's first two field values, an **N fields** button (it opens the same aligned grid, one column wide), the overdue and stale counts, the lane's [row limit](#swimlane-limits) line and the rollup total, the same as on a larger screen. Under each band are the lane's actions: its health status (board admins set it; everyone else sees a set status read-only), **Add card** (people who can edit, in columns that allow new cards), **Edit** (board admins) and **Focus**. Board admins also get **Edit column** beside the column's limit line, and **Add swimlane** and **Add column** at the end of the board. These open the same dialogs as on a larger screen. The Show chips sit in one row that scrolls sideways, and every button and card on the board is at least 44px tall.

Cards cannot be dragged at this width. Tap a card to open it, then tap **Move**, or use the **⋯ More actions** button on a selected card (see [Touch screens](#touch-screens)). Reordering, a drag on a larger screen, uses buttons instead:

- **Move earlier** / **Move later** beside the column's limit line move the selected column one place (board admins).
- **Move earlier** / **Move later** under a lane band move the lane one place (board admins).
- **Move earlier** / **Move later** in the card's peek sheet, and on a phone in the card detail panel a tap opens (1.3+), move the card one place within its lane and column (people who can edit). With a filter on, the step counts only the cards the filter shows, so the card always moves past a card you can see.

Each is disabled at the first or last place and saves the same way a drag does, so everyone on the board sees the new order.

At this width the header and toolbar use icon buttons. The navigation menu button sits at the start of the app header, in the same row as the board name, **Search**, **Notifications** and your account menu, so there is no separate navigation bar above it. **Filters** and **Activity** show only their icon (screen readers still announce their names). The **Filters** button also opens the View options: tap it, then **View options** in the Filter panel's heading row. Screen readers announce the button as "Filters and view options"; with a keyboard, Shift+Tab from **Find a field** reaches **View options**, and Escape in the View options returns focus to the **Filters** button. The board toolbar is one row (1.3+): the tabs (Board, Summary, History, Analytics) scroll sideways in their own box, with **Filters**, **Activity** and **More board actions** after them. The connection status shows on a phone only when it is not healthy (offline, reconnecting, stale), and tapping it still opens the details. The header and the toolbar together take about 92px at 390px. On phones the header no longer links from a board to its group; the group stays reachable from the navigation drawer and the group page shows its own breadcrumb. Every header and toolbar control, including **Search**, **Notifications**, the navigation menu, the filter bar, **More board actions** and the **Show all cards** and **Exit focus** banner buttons, is at least 44px tall and wide when closed. So is every control inside the panels they open: the Filter panel, the View options, the **More board actions** menu, the account menu, the navigation drawer and the notification rows. So are the filter bar's facet menus, the Activity drawer, the Board Health popover and the command palette (1.3+). The pencil beside the board name is hidden; tap the name to rename the board.

Not built yet on phones: the sub-column switcher for a split column and track chips on cards (#2330).

### Board panning

Hold **Space** and drag to pan the board in any direction. This helps on dense boards where the visible area is smaller than the full grid. Release Space to return to normal drag-to-move mode. Space on a focused card opens the card instead of panning; Space anywhere else pans.

## Bulk card operations

Select multiple cards by clicking the checkbox that appears in the top-right corner of each card on hover. Selected cards get a blue ring, and a **bulk action toolbar** appears fixed at the bottom of the board.

| Action | Description |
|---|---|
| **Move to...** | Move all selected cards to a target column (each card stays in its current swimlane) |
| **Assign to...** | Set or clear the assignee on all selected cards |
| **Priority...** | Set priority on all selected cards |
| **Archive** | Archive all selected cards — they are removed from the board view and can be restored from the **Archived** tab of the Activity drawer (<kbd>Y</kbd>, or toolbar **View** menu, **Show archived cards**; a separate panel before 1.3) |
| **Delete** | Delete all selected cards (with confirmation) |

On the shared demo, the toolbar's **Archive** and **Delete** are dimmed with the demo notice and do nothing.

**When an edit is refused.** For **Assign to...**, **Priority...**, **Archive** and **Delete**, a member can act only on cards they created (a moderator or admin can act on any card). **Move to...** is different: any member can move an unassigned card, and a card assigned to someone else is refused unless you created it or are its assignee. When none of the selected cards can take an action, its button is dimmed and stays focusable: hover it to read why (screen readers announce it on focus), and activating it with a click, tap, Enter or Space shows the reason in the toolbar's message area (for example "2 of 2 cards could not be assigned — you can only assign cards you created.") without sending anything. When only some can, the action runs on the rest (for **Delete**, the confirmation says how many will be skipped), and the message counts the skipped cards as failed with the same reason. The selection stays so you can adjust it. The card right-click menu and the command palette give the same reasons; when they act on your whole selection, a refusal appears in the toolbar's message area too.

Press **Escape** or click the **×** button to clear the selection. Selection is also cleared when starting a drag or opening a card detail panel. Bulk operations are available only to users with the **member** role or above.

**Yes, but:** each bulk action calls the existing individual card API endpoints, so each card succeeds or fails on its own.

- When some cards fail, a message in the toolbar says how many failed and why, and the selection stays so you can retry. This applies to Move, Assign, Priority, Archive, and Delete.
- Assign, Priority, Archive, and Delete fire their requests concurrently via `Promise.allSettled`. **Move to...** runs sequentially instead, to avoid database deadlocks from concurrent position-reorder transactions.

## Notifications

<span class="vb-version" title="Added in 1.3">1.3+</span>

Short notices about what just happened appear at the bottom center of the screen: a refused move, the result of an import, an archived or unblocked card, a preset you just applied (with **Undo**), a card link that no longer points to a card on the board, the result of a card action, the confirmation after you join a board or group from an invite, or (on the shared demo) a change that cannot be saved. Up to three show at once, stacked upward, with the most important one nearest the bottom. When the bulk action toolbar is showing, notices sit just above it so they never cover its buttons or its result message.

- **How long they stay.** A success notice stays 4 seconds (5 for "Card archived"), other information 6 seconds (8 for the import and preset notices, 20 for a preset applied from a link), and a warning 8 seconds (4 for a card that is no longer on the board). A refused move stays until you dismiss it or make another move, a failed card action stays until you dismiss it, and so does the "You've joined" confirmation. Moving the pointer over a notice, tabbing into it, or switching to another browser tab pauses the countdown, which starts over when you come back.
- **When more than three arrive**, a less important notice makes room, and a refused move is never pushed out. Notices that cannot fit yet wait, and a **+N waiting** line shows how many.
- **Dismissing.** Every notice has a **×**. With the keyboard, press **Tab** from the board to reach the notices, and **Escape** dismisses the one that has focus; focus then returns to where you were.
- **Screen readers** hear each notice once, politely, except refused moves and failures, which are announced right away. A notice raised from inside the card detail panel (for example after **Unblock card**) is announced by the panel itself, so it is not read twice.

## Right-click to add

Right-click the empty space in any board cell to open an inline card creation input directly in that column + swimlane. A right-click on a card opens the card's actions menu instead (see below).

## Card actions menu

<a id="card-actions-menu"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

Right-click a card to act on it without opening it: show its read-only summary (**Show summary**, the touch path to the peek sheet), move it, assign it, set its priority, block it, archive it, and more.

**How to open it:**

- **Mouse:** right-click a card.
- **Keyboard:** focus a card and press the <kbd>Menu</kbd> key or <kbd>Shift+F10</kbd>.
- **Touch screen:** tap the **⋯ More actions** button. It shows on a selected card, and on the card that has focus, for example the one whose detail panel you just closed. A long press still picks the card up to drag it.

**Which cards it acts on:** right-click a card that is part of your current selection and the menu acts on every selected card. Right-click any other card and it acts on that one card only, without changing your selection; that card is outlined while the menu is open.

| Item | One card | Several cards |
|---|---|---|
| **Open card** | Opens the card detail panel | Select one card |
| **Copy link to card** | Copies a link that opens this card | Select one card |
| **Move to… ▸** | Moves to a column (the card keeps its swimlane), or one place earlier or later in its cell | Moves each card to a column |
| **Assign to… ▸** | Sets or clears the assignee | Same, for each card |
| **Set priority ▸** | Sets the priority | Same, for each card |
| **Block card…** / **Unblock card** | Opens the card with the [block form](blocked-cards.md) ready | Select one card |
| **Archive card** | Archives the card | Same, for each card |
| **Delete card…** | Asks first, then deletes | Same, for each card |

- Items you cannot use stay in the menu, dimmed, with the reason underneath (for example *Viewers can't block cards*, *Select one card*, or the maintenance or shared-demo notice), so you know why. On the shared demo, **Block card…**, **Archive card** and **Delete card…** are dimmed with the demo notice; the card detail panel does not offer them there at all.
- Copy link and Delete confirm what they did in a notification, because nothing else on the board shows it. Move, Assign and Priority change the board in view, so on the board they are only announced to screen readers; from the Summary, History, Analytics or Lens views they show a notification too. Archive shows the "Card archived" notification.
- Use <kbd>↑</kbd> / <kbd>↓</kbd> to move, <kbd>→</kbd> to open a submenu, <kbd>←</kbd> to close it, and a letter to jump to the item that starts with it. <kbd>Esc</kbd> closes a submenu, then the menu, and returns you to the card.
- The menu is not offered while a card detail panel is open; use the [command palette](keyboard-shortcuts.md#card-actions-in-the-command-palette) to act on the open card.
- When some cards in a multi-card action fail, a notification says how many failed and why and stays until you dismiss it, and the selection stays so you can retry, as in [bulk card operations](#bulk-card-operations).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `f` | Toggle the filter bar |
| `/` | Open the filter bar and focus the search input |
| `?` | Show / hide the keyboard shortcuts overlay |
| `.` | Open the overflow menu in the board toolbar |
| `b` / `s` / `h` / `a` | Switch to the Board / Summary / History / Analytics view |
| `l` | Switch to the Lens view (when Issue Board Lens is connected) |
| `e` | Collapse or expand every swimlane and column at once; screen readers hear "Collapsed all N lanes and M columns" or "Expanded all N lanes and M columns" |
| `c` | Collapse the swimlane you last hovered |
| `y` | Toggle the Archived tab of the Activity drawer |
| `Esc` | Deselect cards / close the card detail panel or any open dialog |
| `⌘K` / `Ctrl+K` | Open the command palette |
| `Menu` / `Shift+F10` | Open the focused card's [actions menu](#card-actions-menu) |
| `⌘\` / `Ctrl+\` | Toggle the activity drawer |
| `⌘⇧E` / `Ctrl+Shift+E` | Open the Export board dialog (when export is permitted) |
| `⌘,` / `Ctrl+,` | Open the Board settings dialog (admins only) |
| `⌘⇧L` / `Ctrl+Shift+L` | Toggle card layout between Expanded and Compact |
| `Space` + drag | Pan the board (see [Board panning](#board-panning)) |

Bare single-key shortcuts (`f`, `/`, `?`, `.`, `b`, `s`, `h`, `a`, `l`, `e`, `c`, `y`) are ignored when focus is inside an input, textarea, select, or contenteditable element. Modifier-combo shortcuts (`⌘K`, `⌘\`, `⌘⇧E`, `⌘,`, `⌘⇧L`) fire from any focus location. The in-app overlay (`?`) is the source of truth if this list drifts.

### Board toolbar layout

The board toolbar (Row 2) is one row that wraps onto a second line on narrow screens instead of scrolling sideways. From left to right it holds:

- **View tabs** (Board / Summary / History / Analytics)
- **Filter** button, which opens the [Filter panel](#filter-panel) (press `f` to toggle the filter bar instead)
- **View** button, which opens the View menu
- **Activity** button, which opens the activity drawer
- The overflow menu (`...`) and the connection status, always visible

**View menu:** a panel with the display controls, in order: **Preset**, card density, card layout (Expanded or Compact), **Overlay**, **Collapse all** / **Expand all** for swimlanes, **Hide all** / **Show all** for columns, and **Show archived cards**. Press Escape to close an open picker first, then the panel. Screen readers announce the bulk lane and column items: "Collapsed all N lanes" / "Expanded all N lanes" and "Hid all N columns" / "Showed all N columns" ("1 lane", "1 column" in the singular, and no number when the count is not known).

**Overflow menu (`...`):** contains Export, Board settings (admins), and Keyboard shortcuts. To replay the onboarding tour, use **Restart tour** in the keyboard shortcuts overlay or **Restart onboarding tour** in Settings. A small first-run dot marks the menu until you open it.

## Card layout

The **Card layout** control in the toolbar's **View** menu switches between two card display modes:

| Mode | Description |
|---|---|
| **Expanded** (default) | Full card face with title, label pills, assignee avatar, checklist progress, and a status line (only an overdue card has a colored border) |
| **Compact** | Narrower cards showing title and priority indicator only — useful on dense boards with many cards per cell. An aging card's title starts with a small bar meter that shows its aging step, since compact cards have no `Stale · Nd` badge (see [Card aging tint](card-history.md#card-aging-tint)) |

The preference is stored per user in `localStorage` under the key `user:prefs:card-layout` and persists across boards and sessions. The control's `aria-pressed` state reflects the compact layout for screen reader users.

## Filter panel

The toolbar's **Filter** button opens a panel with:

- A **Find a field** box (focused on open) that narrows the rows below it by name.
- One row per filterable field: **Assignee**, **Label**, **Priority**, **Due date**, **Blocked**, **Lanes** (when the board has a swimlane field you can filter on, two or more lanes, or a lane filter set) and each custom field. A row shows its current value, or **Any** when it is not filtering. Click a row to expand its choices in place; only one row is open at a time. A number field's row also has an operator menu (**equals**, **between**, **at least**, **at most**, **is empty**, **has a value**; 1.3+): see [Number filter operators](custom-fields.md#number-filter-operators).
- A **Filtered by** row at the top while any filter is active: one chip per active filter (click the **x**, or focus a chip and press Enter, Space or Delete, to remove it), **Clear all**, and **Save filter**, which asks for a name and saves like the filter bar does. Lane rules appear as **Lanes** chips.
- Your **saved filters**. Click one to load it and close the panel. Deleting stays in the filter bar.
- A footer button, **Show filter bar** (or **Hide filter bar**), for search, scope, **My cards** and saving a filter.

The **Lanes** row closes the panel and opens the lane filter rules. Escape closes the panel and returns focus to the Filter button. The panel edits the same filters as the filter bar, so a change in one shows in the other, in the URL and in saved filters. Pressing `f` still toggles the filter bar, not the panel.

## Filtering

Click **Filter** in the toolbar to open the [Filter panel](#filter-panel), then choose **Show filter bar** in its footer to open the full filter bar. Press `f` to toggle the filter bar directly. Press `/` to open it and focus the search input at once. Filters apply client-side (no round-trip) and stack: all conditions must match.

| Filter | Options |
|---|---|
| Search | Matches card title, description, assignee name, and label names. Search runs on the server and fetches every match in pages of 200 (up to 5,000); if a very broad search exceeds that, a notice above the board says "Showing the first N of M matches" so cards are never hidden silently. The same notice appears if a later page fails to load (for example, when rate limited), showing the matches loaded so far |
| **My cards** | Quick filter — shows only cards assigned to the current user. Click the **My cards** button in the filter bar to toggle. Active state is indicated by a blue highlight on the button. |
| Assignee | Any board member, or "Unassigned" |
| Labels | One or more labels (card must have all selected) |
| Priority | One or more of low / medium / high / urgent |
| Due date | None set · Overdue · Due today · Due this week |

> **Changed in 1.2** — Assignee, Labels, Priority, and Due date no longer sit in the filter bar as always-visible dropdowns. Click **+ Filter** to pick which one(s) you want to set; picking a filter reveals its own dropdown in the bar, which collapses again once you close it. Once a filter has a value, it shows as a removable chip (e.g. `backend ×`) below the filter bar — click the **×** on a chip to clear just that value. The **+ Filter** button shows a count badge for how many filters currently have a value.

An active filter count badge appears on the Filters button when filters are in use. Click **Clear** to reset all filters at once.

When filters are active and no cards match, every lane shrinks to a **No matching cards** band and a line below the lanes names the cause, so it is clear the board has cards but none satisfy the current criteria. See [Board states](#board-states).

The filter row is a search landmark named **Board filters** (it was "Card filters" before 1.3, when it gained lane filters). Next to the chips, a status line reads, for example, "2 lanes hidden · 5 cards hidden"; screen readers announce it as it changes.

#### Lane filters

<span class="vb-version" title="Added in 1.3">1.3+</span>

On a board with many swimlanes (one per account, say), **Lanes** in the filter bar hides the lanes whose name, contact email, or own [swimlane field](custom-fields.md#swimlane-row-custom-fields) values don't match your rules. Card filters still apply inside the lanes that remain; the two are combined with And.

1. Click **Lanes** to open the rule builder, then **+ Add filter**.
2. Pick a field, then a value or range. The field list starts with two **built-in** fields ([#2336](https://gitlab.com/visiban/visiban/-/issues/2336)), **Lane name** and **Contact email**, then the board's swimlane fields in board order; when both kinds are listed they sit under **Built-in** and **Custom fields** headings. If a swimlane field has the same name as a built-in, the built-in reads, for example, **Lane name (built-in)**.
    - **Lane name** and **Contact email**: the same five text operators as a text field, for example *Lane name is Acme Corp* or *Contact email contains @acme.com*. **Contact email** is offered to board admins only (see below). A lane with no contact email never matches **is**, **contains** or **matches wildcard**, and always matches **is not** and **does not contain**.
    - **Dropdown** fields: **is** or **is not** a choice.
    - **Number** and **Date** fields: **between** two values. Leave either end as **Any** for "or more" / "up to" (numbers) or "on or after" / "on or before" (dates). Both ends are inclusive.
    - **Text** and **URL** fields ([#2226](https://gitlab.com/visiban/visiban/-/issues/2226)): **is** or **is not** one of the values your lanes already carry for that field (listed alphabetically), or one of three operators that take text you type (up to 500 characters): **contains**, **does not contain**, and **matches wildcard**, for example *AE is Ethan Ross*, *AE contains ross*, or *AE matches wildcard Ethan\**. Matching ignores case and leading or trailing spaces. See [Text operators and wildcards](#text-operators-and-wildcards). A value no lane carries any more (from a saved filter or a shared link) stays in the list, marked "(no lane has this)", until you change it. An empty text box is an incomplete filter.
3. Add more filters, or **+ Add group** to bracket several together. Between every two filters or groups, an **And / Or** toggle sets how they combine. **And** binds tighter than **Or**, the way it does in arithmetic, and groups go one level deep.
4. The **Reads as** line spells out the result in words, for example: *Reads as: (AE is Priya and Deal value 50,000 or more) or Client Director is Jo*.

Rules apply as soon as they are complete; **Done** just closes the builder. A filter with no value yet is ignored (the Reads as line counts it as an incomplete filter), so a half-built rule never hides anything.

- **Lanes with no value:** a lane with no value for the field, or a value that isn't a valid number or date, fails **is**, **contains**, **matches wildcard**, and **between**, and passes **is not** and **does not contain**.
- **Admin-only fields**, and the built-in **Contact email**, are offered only to board admins. Their values are never sent to other roles, so members and viewers can't filter on them. For them, a rule on one (from a saved filter or a shared link) is dropped as if it were not there: the remaining rules still apply, so the result can show more lanes or, when the dropped rule was one side of an **Or**, fewer.
- **Checkbox and multi-select** swimlane fields can't be filtered on yet. **Lanes** is shown when you can see a swimlane field it can filter on, when the board has two or more lanes, or when a lane filter is already set (so you can clear it).
- **Chips:** each complete filter or group shows as a chip tagged **Lanes**, joined by "and" / "or". Dismissing a chip removes that filter or group. The **Lanes** button shows how many rules are active; the Filters badge and **Clear all** count all lane rules together as one filter.
- **Lanes with no matching cards** stay visible by default. To hide them, turn on **Hide lanes with no matching cards** at the bottom of the lane filter rules (1.3+). It takes effect only while a card filter or a Show chip is active (otherwise it is grayed out but keeps its setting), hides every lane with no card that matches, and is not a rule: it does not count toward the **Lanes** badge, and **Clear lane filters** leaves it on. The focused lane always shows. It travels in the URL as `f_hide_unmatched=1` and in saved filters.
- **Rules you can't use:** a shared link or saved filter can carry rules on fields only board admins can use (an admin-only swimlane field or **Contact email**). For members and viewers those rules are ignored, and the lane filter rules say so, for example "2 filters ignored: you cannot use these fields", both above and in the **Reads as** line. The rules stay in the link, so an admin opening it still gets them.
- **In focus mode** the rules still apply: see [Swimlane focus mode](#swimlane-focus-mode). The focused lane always shows, even if it doesn't match.
- **When every lane is hidden,** the board says "No lanes match your lane filters." with a **Clear lane filters** button.
- **When a lane stops matching** because its values changed while you were working in it (you edited it, your keyboard focus was in it, or its card is open in the detail panel), it hides at once and a notice says so, with **Edit lane filters** and a dismiss button. A lane a teammate changes elsewhere hides without a notice; the status count still updates.

Lane filters are saved with the rest of the filter state in your browser, in the URL (`f_lanes`), and in [saved filters](saved-filters.md).

#### Text operators and wildcards

<span class="vb-version" title="Added in 1.3">1.3+</span>

Text and URL swimlane fields, and the built-in **Lane name** and **Contact email**, offer five operators in a lane filter:

| Operator | Matches a lane when its value... |
|---|---|
| **is** / **is not** | equals the value you pick, exactly |
| **contains** | has your text anywhere inside it. `*` and `?` are ordinary characters here |
| **does not contain** | does not have your text inside it (the opposite of **contains**) |
| **matches wildcard** | has a part that matches your pattern, where `*` stands for any run of characters (including none) and `?` for exactly one character |

All of them ignore case and leading or trailing spaces. A **contains**, **does not contain**, or **matches wildcard** filter with a blank box is incomplete and is ignored.

With **matches wildcard** the pattern may match any part of the value, just as **contains** does, so a `*` at either end is unnecessary: `ethan` and `*ethan*` behave the same. A lone `*` matches any lane that has a value. There is no "starts with" or "ends with" yet (see [#1847](https://gitlab.com/visiban/visiban/-/issues/1847)).

| You type | Matches | Doesn't match |
|---|---|---|
| `e*ross` | Ethan Ross, Eve Gross | Ross Ethan |
| `j?n` | Jan, Jon, Jan Smith | Jean, Jn |
| `ethan` | Ethan Ross, Seth Ethan | Eth |
| `a*c` | abc, xxabbcxx | cba |

- **Email domains:** **Contact email** is matched on the whole stored address. Because a wildcard can match any part of it, `*@acme.com` also matches `pat@acme.com.example`; to narrow by domain, **contains** `@acme.com` is the simpler rule, with the same caveat.
- **A literal `*` or `?`:** use **contains**, where they are plain characters.
- **Lanes with no value** fail **matches wildcard** and **contains**, and pass **does not contain** (as they pass **is not**).
- Wildcard patterns are never treated as regular expressions, so no other character has a special meaning.

#### URL-serialized filter state

<span class="vb-version" title="Added in 1.1">1.1+</span>

Active filters are serialized into the page URL as query parameters, so filter combinations can be bookmarked and shared:

| Parameter | Filter |
|---|---|
| `?f_search=` | Search term |
| `?f_assignees=` | Comma-separated user IDs |
| `?f_labels=` | Comma-separated label IDs |
| `?f_priorities=` | Comma-separated priority values (e.g. `high,urgent`) |
| `?f_due=` | Due-date filter value (`overdue`, `today`, `this_week`, `none`) |
| `?f_lanes=` | [Lane filters](#lane-filters) (1.3+): `1.` followed by compact JSON. A malformed value is ignored |
| `?f_hide_unmatched=1` | [Hide lanes with no matching cards](#lane-filters) (1.3+); any other value reads as off |

The filter state is restored from the URL on page load and persists across reloads. Share the URL with any board member to hand off a pre-filtered view.

### Saved filters

> **Added in 1.0** · **Tab pills added in 1.1**

Save the current filter combination under a name and restore it later in one click. Saved filters are stored server-side, so they persist across devices and browsers.

**Saving a filter:**

1. Set your desired filters in the filter bar.
2. Click the **Saved** dropdown (to the right of the filter controls).
3. Click **Save current filters**, enter a name, and confirm.

**Loading a saved filter:** saved filters appear as one-click **tab pills** above the filter bar (added in 1.1). Click any pill to apply that preset immediately, with no dropdown. The active pill is highlighted. Open the **Saved** dropdown to manage presets (save, rename, delete).

**Deleting a saved filter:** hover over a saved filter in the dropdown to reveal the delete icon. Click it to remove the filter permanently.

Saved filters are private to each user; other board members cannot see or modify yours. Any board member, including viewers, can create, load, and delete their own saved filters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/boards/{id}/saved-filters/` | List saved filters for the current user |
| `POST` | `/api/v1/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/v1/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |

## Grid overlays

<span class="vb-version" title="Added in 1.2">1.2+</span>

Pick an **Overlay** from the dropdown in the board toolbar's **View** menu, to shade each cell of the grid from a single number per cell. An overlay is a reading layer drawn *on top of* the grid, not a different view of it. The grid keeps its exact layout when an overlay is on: nothing moves, nothing is hidden, and drag-and-drop, card creation, and filtering all behave the same.

| Overlay | What it shows |
|---|---|
| **None** (default) | No overlay — the board renders unchanged |
| **Card count** | How many visible cards sit in each cell, relative to the busiest cell on the board |
| **Dwell time** *(1.3+)* | The median time the visible cards in each cell have been in their column, to show where work is stuck. See [Dwell time](#dwell-time) |

The choice is remembered per board in `localStorage` under `board:{boardId}:grid-overlay`, so it survives a reload but never follows you to another board. A [board preset](#board-presets) also sets it. It is a personal reading preference available to every role, including viewers: turning an overlay on changes nothing for your teammates and writes nothing to the server.

### How a cell is shaded

Every overlay shades on the same four levels. By default they are measured against the largest value currently visible on the board; [Dwell time](#dwell-time) uses fixed steps in days instead.

On the default scale:

- A cell whose value is zero is left completely untouched.
- When every cell with a value has the *same* value, the whole board is drawn at the quietest step, because a board where nothing stands out should not look alarming.

Neither applies to fixed steps, where a value keeps its meaning whatever the other cells hold: a card that has just arrived reads `0.0d`, and equal values stay on the step they belong to.

Each step is encoded **three** ways, so the ordering never depends on telling colors apart:

1. **Tint** — a single-hue blue wash that deepens with the value. It is deliberately not a green→amber→red gradient: a busy cell is not a problem, and the board already uses amber and red for card aging and over-limit columns.
2. **A bar along the cell's bottom edge** — 1px, 2px, 3px, or 4px tall. Height, not hue.
3. **The value itself**, in a small tab at the cell's top-right corner, clear of the cards' words. While an overlay is on it replaces the usual card-count badge, so the corner never shows two different numbers.

Screen readers get the reading in words — for example "Card count: 4 cards, level 3 of 4" — and selecting an overlay is announced ("Overlay: Card count" / "Overlay off").

A legend floats in the bottom-right corner of the grid whenever an overlay is active. It names the overlay, describes it briefly, and lists each step with the range of values actually observed in it; a step no cell landed in shows `—`.

- When the active overlay has nothing to show, the legend says so instead of showing an empty ramp. If a filter is what left it with nothing to scale, it says that rather than claiming the board is empty.
- The legend is passive: it never intercepts a click, and it fades out while you drag.

Because the overlay reads the cards that are currently *visible*, narrowing the filter bar re-scales it and the labels switch to "matching cards", so the shading always agrees with what is on screen. Hidden columns and swimlanes are excluded from the scale, so a card parked out of sight cannot wash out every tint on the board.

### Dwell time

<span class="vb-version" title="Added in 1.3">1.3+</span>

The **Dwell time** overlay shows where work has stopped moving while you are looking at the board. Each cell shows the median of how long its visible cards have been in their current column, for example `4.0d`. It answers "where is the queue?" without opening a report, and it uses the median so that one forgotten card does not repaint a whole cell.

The steps are fixed, so the same shade means the same thing on every board:

| Median in the cell | Tint and bottom bar |
|---|---|
| Under 1 day | None, just the value |
| 1 to 3 days | Lightest, 1px bar |
| 3 to 5 days | 2px bar |
| 5 to 8 days | 3px bar |
| 8 days or more | Darkest, 4px bar |

A step includes its lower bound, and the step follows the number shown, so a cell reading `3.0d` is always in "3 to 5 days". The shade is one color that deepens, not a warning color: a long dwell is something to look at, not a verdict, and a column of waiting work can be doing its job.

What counts:

- **Time in the column, not in the cell.** Moving a card to another swimlane does not restart its time, and neither does reordering it. Moving it to another column does.
- **Archiving ends the time, and restoring starts it again.** Reopening a card out of a done column also starts it again.
- **Done columns and empty cells show nothing.** Time spent in a done column is not waiting. No shade there means no value, not "all clear".
- **Cards with no usable history are left out.** A card imported without history, or moved by a direct admin edit, has no measured time in its column. The legend counts them, for example "2 cards with no recorded time in this column left out", and a cell's screen-reader reading says so too: "median dwell 3.0 days, 2 of 3 cards measured". If no card on the board can be measured, the legend says there are no values yet.
- **One card is enough.** A cell with a single card shows that card's time. The overlay describes what is on screen, so it does not need the minimum sample a chart's percentile does.

The overlay is live and follows the filter bar. It updates when a card moves, on your screen or anyone else's, and it keeps counting while the board stays open: values refresh every few minutes, and at once when you return to the tab. With a filter on, each median covers only the cards that match.

Dwell time here is the same definition the rest of Visiban uses: see [Flow metric definitions](../architecture/decisions.md#flow-metric-definitions). This overlay shows *current* dwell, the cards still in the column. It has no date range, because it describes the board as it is now.

### Notes

- Overlays are **stackable with views, not a replacement for them** — Analytics is a tab, an overlay is a layer, and both can be on at once
- The **Card count** and **Dwell time** overlays are computed from the cards the board already loaded. They issue no extra requests and no per-cell queries
- Collapsed columns and collapsed swimlanes render their compact count stubs rather than full cells, so they carry no shading — but they still count toward the scale, so folding a lane never silently re-shades the rest of the board
- The cell being dragged over is never shaded, so the drop-target highlight stays unambiguous
- A cell's value fades while a keyboard user is on a control inside one of its cards, so it never covers the focus ring. Screen readers can still reach it

## Board presets

<span class="vb-version" title="Added in 1.3">1.3+</span>

A **preset** is a named way of reading a board: it sets the card density and the grid overlay together, so you can switch between them in one step. Applying a preset changes only how the board looks to you. It never changes cards, columns, or board settings, so it is always safe to try, and every apply can be undone.

Two presets ship with Visiban:

| Preset | What it sets |
|---|---|
| **Classic** | The board as it looked before presets existed, except the Comfortable urgency border tint and its screen-reader priority text (#977, owner decision 2026-11-13), the redesigned column headers, grid cells and the swimlane band (#2270, #2271), and the Show chip row, which appears under Classic too (#2272). The swimlane band shows the first two lane fields and `+N` like every preset (#2271, superseding #1417): the board's own [card density](#card-density), no overlay. Classic also keeps the earlier urgency badge and due date (the ⚑ / ⏱ text symbols and the lighter amber due-soon text); the flag and stopwatch icons appear under any other preset. A board with no preset looks the same as Classic. |
| **Default** | Standard density, no overlay, and the flag and stopwatch [urgency icons](#card-density). |

Presets are built in; you cannot create or edit your own yet.

### Choosing a preset

Pick a preset from the **Preset** dropdown (bookmark icon) at the top of the board toolbar's **View** menu. Each option shows a one-line summary, and the board's default preset is labeled **Board default**. The trigger reads **Preset** when no preset is active and the preset's name when one is.

Choosing a preset saves its density as your [personal density override](#personal-density-override) and its overlay as your [overlay](#grid-overlays) choice for that board, and records which preset you chose, all in this browser. A notice confirms the change, for example **Applied “Default”**, with an **Undo** button that puts back your previous settings. The notice closes by itself after a few seconds (longer when a link applied the preset), and waits while your pointer or keyboard focus is on it. While it is showing, the **Preset** dropdown also offers **Undo**, so you can reach it from the keyboard.

You can also apply a preset from the [command palette](keyboard-shortcuts.md) (⌘K / Ctrl+K): type **Apply preset: Classic** or **Apply preset: Default**, or **Reset to preset: …** when the active preset is modified. These work exactly like the dropdown, including the Undo notice, in every view of the board (Board, Summary, History, Analytics and the Lens).

Choosing the preset that is already active, and unmodified, changes nothing and shows a short notice, **“Default” is already applied**, so you know the choice registered. A long preset name is shortened on the trigger; hover it to see the full name.

The trigger names a preset only when one is actually in use: one you chose, or the board's default preset. A density or overlay you set yourself, including settings from before 1.3, is not shown as a preset even when its values match one.

### Modified and Reset

If you change the density or the overlay after choosing a preset, the trigger adds a **Modified** tag. Open the dropdown to see what differs from the preset, for example `Overlay: Card count (preset: No overlay)`, and choose **Reset to “Default”** to go back to it. Choosing the modified preset again does the same. Reset also shows a notice with **Undo**.

**Board Settings → Display** says when a preset set your density: the **Use my own density** toggle reads `Set by preset “Default” for your view only`, and turning it off returns you to the board default preset's density if the board has one that sets a density, otherwise to the board's own density; the toggle says which, and says the preset will show as Modified when that density differs. Turning the toggle on starts from the density you see now, so it never changes your view by itself. When the density comes from the board's default preset instead, the tab reads `Set by preset “Default”: your view shows standard density.`

### Sharing a preset link

While a preset is applied, the board's URL carries it, for example `?preset=default`, so you can share the link. Opening such a link applies that preset for you, replacing your own density and overlay choices on that board, and shows a notice, **Applied “Default” from the link**, whose **Undo** puts your previous choices back and removes `?preset=` from the URL. Once you modify the preset, `?preset=` is removed from the URL, because the link would no longer show what you see; reloading the page then keeps your changes. Reloading a page whose link names the preset you are already using changes nothing and shows no notice. An unknown preset name in a link is ignored.

### Board default preset

Board admins can choose a default preset in **Board Settings → Display → Board default preset**: **None**, **Classic**, or **Default**. Members who have not picked a preset on that board see the board default. Everyone else sees the read-only setting.

Which preset applies, highest first:

1. A `?preset=` link
2. Your own choices on this board: a preset you picked, your personal density override, or your overlay choice, each of which wins over the board default for that setting (the trigger then shows the board default as **Modified** where they differ)
3. The board's default preset
4. The board's own density setting, with no overlay

With no board default (the setting for every board created or upgraded before 1.3) and no link, the board looks exactly as it did before presets existed. Choosing the board default yourself clears your personal density and overlay choices for that board, so you follow the board default again if an admin changes it later, in an open tab as after a reload. A preset you chose that is not the board default stays yours when the board default changes. Each board keeps its own preset: moving to another board never carries one over.

## Board states

- **Loading:** a skeleton of column headers, a lane band and cards, announced to screen readers as "Loading board".
- **No cards yet:** the column headers stay, and below them a panel says "No cards yet" with **Add a card** for people who can add cards and **Import cards** for people who can create boards in the board's group. **Import cards** opens the group's import dialog, which imports a file as a new board in that group. The sentence leaves out what you can't do: "Add the first card to Prospect, or import cards from a file." when you can do both.
- **Filters or a Show chip match nothing:** on a desktop each swimlane shrinks to its band, reading **No matching cards** (on a phone each lane's empty note reads **No matching cards in** the column name while a filter is active, and the line below sits above the lanes), and below the lanes a line names the cause: the chip ("No cards are due soon", "No cards are overdue", "No cards are stale") when the chip alone empties the board, or "No cards match the active filters" otherwise. **Show all cards** clears the card filters, the selected saved filter and the Show chip; it keeps your lane filters, including **Hide lanes with no matching cards**. With **Hide lanes with no matching cards** on, the bands are hidden and only the line shows. This never shows on an empty board, which shows only "No cards yet" (unless lane filters hide every lane; then "No lanes match your lane filters" takes precedence), or when lane filters, together with **Hide lanes with no matching cards**, hide every lane while some card matches, which shows "No lanes match your lane filters" with **Clear lane filters**. When no card matches, the line and **Show all cards** show instead.
- **Offline:** while the live connection is down, the banner reads "Offline. Reconnecting. Moves are paused until the board is live again." and the connection status in the toolbar reads **Offline**. Moves are paused so a move never lands on a board that other people changed meanwhile: you cannot drag cards, columns or lanes, and **Move to…** (card menu, ⌘K and bulk toolbar) and **Move** (card details and the card peek) are disabled with "Moves are paused while the board is offline" written beside them. Everything else still works. If reconnecting gives up, the banner reads "Offline. Live updates are off and moves are paused. Reload the page to reconnect."
- **Dragging:** the card you drag tilts and casts a deep shadow (no tilt or lift with reduced motion), and its place in the cell stays dimmed. The cell under it gets a blue dashed edge, and a dashed placeholder after the last card shows where it will land; a cell that would put a column or lane over its limit turns amber instead and names the limit.
- **Load error:** "The board didn't load." with **Try again**, which fetches the board again without reloading the page.
- **Keyboard:** every way of moving a card by dragging has a keyboard equivalent, with no new shortcut keys. Focus a card and press <kbd>Menu</kbd> or <kbd>Shift+F10</kbd>, then choose **Move to…**: **Move earlier in this cell** and **Move later in this cell** reorder the card one place among the cards shown in its cell (each appears only when there is a card that way), and the columns below them move it to another column. To change swimlane, open the card and use **Move** in its details. Select several cards with the checkbox on each card and use **Move to…** in the bulk toolbar, which moves them to a column. Sub-columns have no keyboard stops yet: they wait on the sub-column work (#1102, #2278).
- **View only:** people who cannot edit the board (viewers and collaborators) see a line saying they can open cards and filter but not move or edit them.

## Views

The toolbar provides four views for the same board data:

| View | Description |
|---|---|
| **Board** | Default kanban grid with drag-and-drop |
| **Summary** | Table of swimlanes with card counts, stage distribution, and 7/30-day velocity |
| **Analytics** | Heatmap of average dwell time per stage, outlier detection, stalled card list, CSV export |
| **History** | Chronological log of all card movements across the board, filterable by swimlane, column, assignee, and date range |

See [Analytics](analytics.md) for details on the Summary and Analytics views.

### History view

> **Added in 1.0**

The **History** tab in the board toolbar shows a chronological log of all card movements across the entire board, newest first, paginated at 50 records per page.

#### Filters

All filters are URL-synced and persist across page reloads.

| Filter | Description |
|---|---|
| **Swimlane** | Limit results to cards currently in a specific swimlane |
| **Column** | Limit results to movements whose destination was a specific column |
| **User** | Limit results to movements performed by a specific member ("moved by") |
| **Moved after** | Lower bound date (inclusive) |
| **Moved before** | Upper bound date (inclusive) |

When no date range is specified, the full movement history is shown. There's no separate assignee filter; filter by swimlane or column to narrow the list instead.

#### Detail panel

Click any row to open a slide-in detail panel showing the full movement record: card title, from/to column, from/to swimlane, moved by, and any notes recorded at the time of the move.

The table is keyboard-friendly:

- The rows form a single <kbd>Tab</kbd> stop. Once focus is on the table (or nothing is focused), <kbd>↑</kbd> / <kbd>↓</kbd> move between rows, and <kbd>Enter</kbd> opens the detail panel for the focused row.
- Arrow keys leave the filter controls and the panel's buttons alone, and <kbd>Enter</kbd> only opens a row while that row has focus.
- <kbd>Esc</kbd> closes an open filter menu first, then the detail panel (focus returns to its row), and only then leaves the History view for the board.

#### Archive and restore events

Archive and restore events **are included** in the board History view by default, alongside column-to-column moves. The API supports narrowing this with `exclude_type=archived,unarchived`, but the board toolbar's History view doesn't expose a control for it. Use the API directly, or check the individual card's **History** tab, if you want moves only.

## Export & import

### Export

Open the overflow menu (`...`) in the board toolbar and choose **Export** to download the board data:

- **JSON** (recommended) — full board structure including columns, swimlanes, labels, and cards with comments, checklists, assignee, movement history (History tab), and activity log. Use JSON for backups, migrations, and any situation where full card history must be preserved.
- **CSV** — one row per card with columns for ID, title, description, column, swimlane, priority, assignee, labels, due date, weight, dates, and movement history. Cards are imported without movement history or activity log. Use CSV when you need the data in a spreadsheet.

> **Added in 1.1** — export permission threshold and audit history (#842, #843)

By default, any board member can export. Admins can raise the threshold per board under **Board Settings → Data → Export permission** to restrict exports to collaborators, members, or admins only; owners and site admins always bypass it. The threshold limits only the export action and file formats; it does not change what members can read on the board.

Below the threshold, the **Export** button is hidden and direct API calls return `403 export_restricted`. The export endpoints are:

- `GET /api/v1/boards/{id}/export/` — CSV
- `GET /api/v1/boards/{id}/export/?format=json` — JSON

#### Export audit history

Every successful export is recorded in an audit log capturing the actor, the role they held at export time, the format (`csv` / `json`, or `movements_<format>` for movement-history exports, shown as "Movements (CSV)"), and the number of rows exported (cards for a board export, movements for a movement export). Admins can review the log under **Board Settings → Data → Export history**, or via `GET /api/v1/boards/{id}/export-history/` (admin-only). Failed exports (permission denied, rate limited) are not logged.

This per-board export log is a data-exfiltration safeguard scoped to individual board admins, and it is part of the open-source core. It is intentionally distinct from the site-wide, compliance-oriented **audit log** in Visiban Enterprise, which records administrative activity across the whole instance.

### Import

Click **Import** on the dashboard to create a new board from a previously exported Visiban JSON or CSV file. The import atomically creates a new board with all structure (columns, swimlanes, labels) and cards.

**JSON import** restores full card history:

- Assignee (matched by username; cards whose assignee username is not found in this instance are imported unassigned)
- Movement history — every column transition appears in the card's **History** tab
- Activity log — assignee changes, label changes, priority changes, due-date changes, checklist events, and comments all appear in the activity feed
- Imported history keeps its original times and is recorded under your name, the person who ran the import. The username the file gave for each movement and activity entry is kept as text, and the card's **History** tab and the board's **History** view show it next to your name, for example "by Kelly · imported, originally alice" — so imported entries can always be told apart from history recorded on this board. The name is not matched to an account on this instance. See [Imported history](card-history.md#imported-history).
- Card creation date (since 1.2, #1906) — each card keeps the `created_at` from the file, so it is dated before its own history. If the file has none, or the date is in the future or later than the card's first movement, activity, or comment, the card is dated to the import instead. Files without the field import as before.
- Comments — posted under your name with their original times. Since 1.2 the comment's `author` from the file is kept as text the same way and shown after the time in the card's comment list ("imported, originally alice").
- Custom fields (since 1.2) — the board's card and swimlane custom field definitions, with their number formatting and choice colors, and every card's and swimlane's values. A value the field's type would refuse is skipped; the rest of the import goes ahead

**CSV import** creates cards with their current field values only. Movement history and activity log are not restored.

**Board name:** the new board is named **Imported: &lt;name&gt;**, where the name is the board name stored in a JSON file, or the filename without its extension for a CSV file (for example, `Q3 plan.csv` becomes **Imported: Q3 plan**).

- If a board with that name already exists in the same place (the group you import into, or — without a group — any board you can access that is not in a group, as listed under **My Boards**), a number is added: **Imported: Q3 plan - 1**, then **- 2**, and so on.
- To choose the name yourself, type it in **Board name** when importing; it is used exactly as typed.

!!! note "Changed in 1.2"
    Earlier releases named a JSON import after the file's board name unchanged, and every CSV import **Imported Board**.

#### Choosing what to import

<span class="vb-version" title="Added in 1.2">1.2+</span>

Once you pick a file, an **Include** list lets you leave parts of the export out. Board structure — the name, columns, swimlanes, and (from JSON) custom field definitions — is always imported. Swimlane custom field values come with the structure; card custom field values come with **Cards**.

| Option | What it covers | Formats |
|---|---|---|
| **Cards** | Cards. From JSON: with their assignees and due dates. From CSV: title, description, priority, weight, due date, and assignee. | JSON, CSV |
| **Comments** | Card comments | JSON |
| **Checklist items** | Card checklist items | JSON |
| **Card history** | Movements, imported activity entries, and the "weight changed" entry recorded for a card with a non-default weight | JSON |
| **Labels** | Label definitions and the labels on cards | JSON, CSV |

Comments, checklist items, and card history belong to cards: unchecking **Cards** turns them off too, and checking it again restores your earlier choices.

- Leaving **Labels** out also leaves out the "label added" activity entries the import would otherwise record; the same applies to checklist items ("checklist item added"), and leaving **Card history** out also leaves out the "weight changed" entry recorded for a card with a non-default weight.
- The import records those three entries itself only when the file has no history of its own for them: a card whose imported history already includes a label, checklist or weight change keeps the original entries, with their original times and source names, and gets no second copy.
- A line under the list shows what will be imported, for example "Importing: structure, cards, labels". Everything is included by default ("Importing: everything"), so an import where you change nothing behaves exactly as before.

**Skipped-items notice:** when an import leaves out cards or anything on them, the new board opens with a short notice counting what was skipped, for example "Board imported. Skipped: 12 cards, 30 comments, 4 card labels."

- It counts cards, comments, checklist items, labels on cards, and history entries (movements and activity entries together). Label definitions that no card uses are not counted, so leaving **Labels** out of a file whose labels are unused shows no notice.
- New in 1.3: it also reports **unmatched assignees** in a sentence of their own, before the skipped list, for example "Board imported. 2 assignees didn't match a user and were left unassigned." A card or checklist item whose assignee is not someone you already share a board or group with (or who has no account here) is still imported, unassigned, and each one is counted, in JSON and CSV imports alike. A notice that reports them stays open until you dismiss it, so you can note what to reassign by hand.
- The notice closes by itself after a few seconds, and stays open while you hover over it or focus it.
- CSV imports can also report warnings: a column skipped because its field name is empty, a custom-field value that was too long, contained an unsupported character or was refused for its field type, or a swimlane whose values conflicted (one value is kept). They are listed in the same notice (at most 20, then "…and N more").
- A notice that lists warnings stays open until you dismiss it, and the list can be scrolled and focused with the keyboard. A CSV import with no warnings shows the notice exactly as before, or none at all.

#### Dates on import

> **Added in 1.2** (#1949)

A JSON file can carry a top-level `date_anchor`: the day its dates were made around. Every [sample board](../getting-started/sample-boards.md) file has one, whether you pick the sample under **Start from a sample** or choose a downloaded sample file. Such a file is dated around the day you import it: due dates, date custom fields, card creation, comments, and history all move forward together, keeping their spacing, so the board does not open mostly overdue. A board you exported yourself has no `date_anchor`, and its dates always import as written.

When the file has an anchor, a **Dates** section appears below **Include**:

- **Move dates to today** is checked by default. Uncheck it to import the dates exactly as written.
- **Adjust dates** opens a **Date the board around** field set to today. Pick an earlier day to date the board around that day instead. A day after today is refused with "Pick today or an earlier day." The day is sent only when you change it.

The line under the checkbox says which applies, for example "Dated around 06/01/2026 instead of today." API callers use the `shift_dates` and `shift_dates_to` import options; see [Date shifting](../api/boards.md#date-shifting).

!!! tip "Coming from Trello?"
    Use **Import a Trello export** instead. See [Import from Trello](trello-import.md).

!!! warning "Import limits"
    To prevent runaway server load, imports are rejected if the file exceeds any of these limits:

    | Resource | Limit |
    |----------|-------|
    | Cards | 500 |
    | Columns | 50 |
    | Swimlanes | 100 |
    | File size | 10 MB |

    A JSON import also limits labels, comments, checklist items, movements, and activity entries per card, the number of distinct usernames, and the total number of rows the import writes (50,000). See the [import limits in the API reference](../api/boards.md#post-apiv1boardsimport) for every cap.

    Most boards exported from Visiban fit within these limits, but a very large or long-lived board can exceed one, and its export is then refused like any other file. If your board exceeds a limit, whether it comes from Visiban or an external tool, split it into smaller boards before importing.

!!! note "JSON vs CSV import fidelity"
    JSON imports restore movement history and activity log (recorded under the importing user, with the source username kept as text) and assignees (matched by username). CSV imports create cards with their current field values only, including the **Assignee** column (matched by username, case-insensitively) — no history or activity log is restored. A blank Assignee, or a username that does not exist on this instance, imports the card unassigned. As with JSON, a username matches only an active account you can already see — you, people who share a board or group with you, or members of the group you import into (site administrators and users with all-content access match any active account); deactivated accounts never match, and any other name imports the card unassigned.

- `POST /api/v1/boards/import/` — multipart file upload

## Board member management

Admins manage board members from the board toolbar's **Members** button. It assigns all four roles (admin, member, collaborator, viewer) independently of group membership. Press **Escape** or click **×** to close the dialog. See [Roles & Permissions](rbac/roles.md) for what each role can do.

## Real-time indicator

The board toolbar shows a **ConnectionStatus** indicator in the top-right corner:

- **Healthy** — quiet: a small dot with the word "Live" (visible at wider viewports)
- **Degraded or lost** — prominent: an amber pill for reconnecting/stale, a red pill for failed

Board state updates automatically when other users move cards or make changes. See [Real-time Updates](realtime.md).

## Activity drawer

<span class="vb-version" title="Added in 1.1">1.1+</span>

A right-hand panel that streams the most recent board events — card moves, creations, and membership changes — as they happen. Open and close it with **⌘\\** (Ctrl+\\ on Linux/Windows) or the activity button in the board toolbar.

<span class="vb-version" title="Added in 1.3">1.3+</span> The drawer has two tabs: **Recent** (the live board events described below) and **Archived** (the board's archived cards, with **Unarchive**; see [Card archiving](card-archiving.md#viewing-archived-cards)). Press <kbd>Y</kbd> or choose **Show archived cards** in the **View** menu to open the drawer straight on the Archived tab. The drawer and the card detail sheet are never open together: opening one closes the other.

<span class="vb-version" title="Added in 1.3">1.3+</span> Each Recent row shows the actor's avatar, the card title, what happened beneath it (for a move, "Qualified to Discovery"; "Created" for a new card) and the time on the right. Membership events show the person's name with "joined the board" or "was removed from the board". The sentence "Live · board events" no longer appears under the title.

The **Filter** button beside the tabs opens a small panel with two choices. Select a choice with the mouse or with <kbd>Tab</kbd> and <kbd>Enter</kbd>; <kbd>Escape</kbd> closes the panel and returns focus to the button (a second <kbd>Escape</kbd> closes the drawer):

- **Kind**: *All*, *Moves* (includes creations), *Members*
- **Window**: *1h*, *24h*, *7d*. It defaults to **24h** so the drawer stays focused on today's activity rather than all history. Widen to **7d** to scan back through the week, or narrow to **1h** for what's happened in the last hour.

While either choice differs from its default (*All* and *24h*), the button is highlighted and shows how many are active, so a filtered feed is never mistaken for a quiet board.

The drawer is a live summary, not the canonical audit trail. For the full ordered history with no window filter, click **Open the full History view** at the bottom of the drawer (also reachable from any card's **History** tab — see [Card History](card-history.md)).

## Board sharing

> **Added in 1.0**

Board admins can generate a public read-only link that lets anyone view the board without signing in.

### How fresh the public view is

> **Added in 1.3** (#1965)

The board an anonymous visitor sees is cached for up to 15 seconds, which keeps a widely shared link from loading the database on every visit. A change to a card, column, swimlane or label shows on the next visit after it is saved. A change that does not announce itself to the board's live feed, and time-based fields such as a card turning stale, can lag by up to the cache window.

The cache never keeps a link alive: turning sharing off, rotating the link, its expiry, and the enabling admin losing admin standing or being deactivated all take effect on the very next visit. Operators can change the window with the `SHARE_BOARD_CACHE_TTL_SECONDS` environment variable (a whole number of seconds; `0` or a negative value turns the cache off; set it through the Compose/`.env` path, as the Helm chart does not currently expose it; see [Configuration](../administration/configuration.md#variables-documented-on-other-pages)). For a board that is shared widely and read far more often than it changes, leave it on.

### Enabling a share link

1. Open **Board Settings** and go to the **Sharing** tab.
2. Toggle **Enable public share link** to the on position.
3. Optionally change the **expiry** — choose 7 days, 30 days, 90 days, or **Never**. *(1.2+)* The tab pre-selects **30 days**; pick **Never** for a link that does not expire. (In 1.0 and 1.1 the pre-selected choice was no expiry. The API default is unchanged: a request without an expiry still creates a link that never expires — see the [API reference](../api/boards.md#post-apiv1boardsidshare).)
4. A URL in the format `https://<host>/share/<token>` is displayed with a **Copy** button. *(1.2+)* Copy it now: the link is shown only this once. Click **Done** when you have it.

Share that URL with anyone — recipients do not need a Visiban account.

### Rotating a share link

> **Added in 1.2** (#1935)

When you open the **Sharing** tab later, it shows that a public share link is active and when it expires, but not the link itself. To get a link you can copy again, choose an expiry under **New link expires in** and click **Rotate link**. Rotating creates a new link, shows it once, and stops the previous link working straight away, so send the new one to anyone who still needs it. (In 1.0 and 1.1 the tab showed the current link every time it was opened.)

> **Added in 1.1** — share link expiry options (#804)

When a share link expires, visitors who follow the URL receive a `410 Gone` response and a "This link has expired" page. Toggling sharing back on after expiry generates a new token — the expired token cannot be restored.

### When a share link ends automatically

> **Added in 1.2** (#1865)

If the admin who turned sharing on leaves the board or loses admin rights, the link stops working. Visitors see the same "This board is no longer shared" page as for a link that was turned off by hand.

In detail, the link is turned off automatically, as if that admin had toggled it off, when their account is:

- deactivated or deleted,
- changed to a role below board admin, or removed from the board,
- added to the board directly with a role below board admin while they were an admin through a group (a direct board role takes precedence over a group role),
- demoted or removed in the group that made them an admin of the board, or joined a group nearer the board with a lower role, or that group arrangement changes (the board moves to another group or out of one, or a group is moved or deleted),
- no longer given access to all content (site admin), when that is how they administered the board.

An admin who still administers the board another way (for example as its owner, or through a direct board admin role) keeps the link.

- For the changes listed above, the **Sharing** tab shows sharing as off straight away, even if it is open at the time. *(1.3+, #1967)* In 1.2 it showed the change only once the board page was reloaded.
- The public page also checks this every time it is opened, so the link never stays usable after the admin's role ends, however that happens.
- Another board admin can turn sharing back on, which creates a new link.

A link turned on before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier) has no recorded admin, so it stops working at the upgrade to 1.2 (#1939). The **Sharing** tab shows sharing as off on such a board. A board admin restores sharing by turning **Enable public share link** on, which creates a new link and shows it once; the old URL does not come back. See the [upgrade notes](../administration/upgrade.md#upgrading-to-12x).

### What the public view shows

The public view renders the full board grid (columns, swimlane rows, and cards) in read-only mode. The following card metadata is visible:

- Title
- Labels
- Checklist progress (e.g. 2/5)
- Due date
- Weight
- Assignee name

Drag-and-drop, card click-to-open, and all editing actions are disabled in the public view.

### Revoking a share link

Toggle **Enable public share link** off to revoke the current token immediately. Any visitor who follows the old URL will see a "This board is no longer shared" page with a link to sign in. Toggling sharing back on generates a new token; the previous link cannot be restored.

*(1.3+, #1967)* Other board admins who have the board open see the change without a reload, including in a **Sharing** tab they already have open: it switches to off when you revoke the link, and to on, with the new expiry, when you enable or rotate it. If you revoke or rotate the link while another admin still has its one-time copy on screen, that copy is removed and the tab says why, because the link no longer works.

### Rate limiting

The public board endpoint is rate-limited to **120 requests per hour per IP address** to prevent token enumeration, with a separate, higher per-token limit (240/hour) layered on top for a legitimately busy shared link.

### API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/boards/{id}/share/` | Board admin | Generate or regenerate the share token |
| `DELETE` | `/api/v1/boards/{id}/share/` | Board admin | Revoke the share token |
| `GET` | `/api/share/{token}/` | None (public) | Read-only board payload; rate-limited |
