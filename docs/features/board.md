# Work the board: grid, cards, and settings

<a id="board-cards"></a>

Pick a template in the **Create Board** modal, then drag cards between cells. Everything else on this page shapes that grid.

**Why it matters:** This is the core workspace for anyone who works a board day to day, from quick status checks to full admin control.

**The big picture:** the board is a grid. Columns are pipeline stages, swimlanes are the entities moving through them (customers, projects, epics), and each card sits in exactly one cell. Every move is logged to the audit trail.

!!! note "Small screens"
    Visiban works on phones and tablets: below 1024 px the sidebar becomes a hamburger drawer and the board grid scrolls horizontally. On a touch screen, press and hold a card to drag it (see [Touch screens](#touch-screens)). Column/swimlane resizing is easiest with a pointer, so a desktop browser is still the best fit for heavy board editing. See [Navigation → Mobile behavior](navigation.md#mobile-behavior).

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
- Over-limit columns gain a 2 px top accent strip — red for over-WIP, amber for over-weight — visible across the room. The single stat line beneath the column name flips to the over-limit message (e.g. `⚠ Over WIP · 6/5`); when calm, only `N cards` is shown. *Changed in 1.1 (#963).*
- When enforcement is enabled, moves into a full column are blocked (`409` error); board admins can override with `?force=true` (soft) or are denied entirely under hard mode.

### Adding a card to a cell

> **Changed in 1.1** — empty cells now read as a discoverable click target instead of hiding the **+ Add card** affordance in the bottom-left corner.

An empty cell shows a dashed inset border with **+ Add card** centered; the affordance highlights on hover or keyboard focus.

- Click anywhere in the cell, or press **Tab** to focus it then **Enter**/**Space**, to open the inline new-card input.
- The dashed border disappears the moment a card lives in the cell; populated cells keep the **+ Add card** button anchored at the bottom for additional cards.
- Double-click and right-click on a cell still work for power users. Since 1.3 a right-click **on a card** opens that card's [actions menu](#card-actions-menu) instead; right-click the empty space in the cell to add a card.

Card creation requires the column's *Allow card creation* setting and at least the Member role.

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane's label panel has a 4 px color stripe on its left edge (matching the swimlane's assigned color), so you can identify swimlanes at a glance even on a dense board.

**Resizing:**

- **Label sidebar:** drag its right edge to set the width (minimum ~56 px, maximum 400 px). Width persists per board in localStorage.
- **Row height:** drag the bottom edge of any swimlane row to set a minimum height. Height persists per swimlane per board in localStorage.

Each swimlane has the following fields:

| Field | Description |
|---|---|
| Name | Required; unique per board |
| Color | Left-edge stripe color on the label panel |
| Contact email | Optional; set when you create the swimlane. Displayed in the label panel for admins only (hidden from members and viewers) |
| Notes | Optional free-text field on the data model; not currently exposed in the UI |
| Position | Controls row order on the board |

!!! note
    The `contact_email` and `notes` fields are restricted to board admin and site admin roles. Members and viewers do not receive this data via the REST API or WebSocket events.

!!! note "Contact email isn't editable after creation yet"
    Contact email can only be set in the **Add Swimlane** dialog. The **Edit Swimlane** modal covers name, color, swimlane field values and [limits](#swimlane-limits), not contact email — to change it, delete and recreate the swimlane, or wait for that gap to close.

Click the chevron on the label panel to collapse a swimlane and save vertical space. When collapsed:

- The row shrinks to its minimum height; the stored row min-height is ignored.
- Each column cell keeps the column's full width and renders as a centered count pill (empty cells show nothing).
- The contact email and edit (✎) button are hidden; the drag handle and the focus-mode crosshair remain.
- Click the chevron again to expand and restore full card visibility.

Admins can double-click the swimlane label to open the Edit Swimlane modal.

### Swimlane limits

> **Added in 1.3** (#1150)

A swimlane can carry its own WIP limit and weight limit, the same way a column does. On a board whose rows are customers, projects or candidates, this is the limit you usually want: "no more than three in flight for this client."

Set them in the **Edit Swimlane** modal (board admins), under **Limits**:

- **WIP limit** and **Weight limit.** Leave a field empty, or enter `0`, for no limit. The helper under each field shows the row's current count ("Now 4"). When the new limit is already below that count, a note says so and says what happens next for the enforcement you selected: nothing already in the row moves; with **Block, admins can override** new cards are refused unless a board admin overrides, with **Block for everyone** they are refused for everyone, and when the limit is not enforced (**Follow board settings** on a board that enforces nothing) it only shows on the row.
- **Columns that count.** Only cards in the checked columns count toward the row's limits. By default every column not marked as done counts, so a finished card stops counting the moment it reaches a done column. Deleting a column removes it from every row's selection; a row left with none goes back to the default.
- **When the row is full.** **Follow board settings** (the default) applies the board's **Enforce WIP limits**, **Enforce WIP hard** and **Enforce weight limits** rules, exactly as for columns. **Block, admins can override** refuses the move and lets a board admin move anyway. **Block for everyone** is the hard mode: nobody, board admins included, can add a card past the row's WIP limit. A weight limit can always be overridden by a board admin, as on columns.

**What the row shows.** Once a row has a limit, its label panel shows one state line under the name, worst state first:

| State | Line |
|---|---|
| Under the limit | `WIP 4/6` |
| At the limit | `WIP 5/5 · at limit`, only when the board's **Show at-limit WIP indicator** setting is on (as for columns); otherwise the line reads `WIP 5/5` |
| Over the WIP limit | `⚠ Over WIP · 5/4` in red, with a red line across the top of the label panel (`⛔` when the row is in hard mode) |
| Over the weight limit | `Over weight · 18/12` in red |

The small bar next to the text is decorative; the words carry the state. A collapsed row hides the calm states but keeps the two over-limit ones.

**What a move does.** A move is checked against a row only when it adds to the row's count: the card enters one of the row's counted columns from another row, from a column of this row that does not count, or by being created or restored there. Moving a card between two counted columns of the same row never trips the row's limit. While you drag a card over a cell whose column or row is full, the cell gets a red ring and names the limit (for example `⚠ WIP limit 5/5 · Payouts`). With the keyboard, the screen reader announcement for each cell includes the same verdict. If you drop anyway, the move is refused with the same toast as a column limit, naming the row; when a column limit and a row limit both trip, the toast names both. Board admins get **Move anyway (admin override)** for a soft limit, never for a hard one.

Board import restores row limits as exported and does not check them, as with column limits.

### Swimlane focus mode

> **Added in 1.0**

Focus mode collapses all other swimlane rows so you can work with a single swimlane without distraction, which helps on dense boards with many swimlanes.

**Entering focus mode:** hover over any swimlane label panel to reveal the crosshair icon (⊙) in the top-right corner of the label, and click it. The icon is always visible (highlighted in blue) when that swimlane is currently focused.

**What changes when focus is active:**

- All other swimlane rows are collapsed and their cards are hidden.
- A blue banner appears between the board toolbar and the scroll area: "Focused on: *[swimlane name]*".
- The URL updates to include `?focus=<swimlane_id>`, so focus mode can be bookmarked and shared.

**Exiting focus mode:**

- Click **Exit focus** in the blue banner.
- Press **Escape**.
- Reload the page without the `?focus=` param.

On exit, the swimlane collapse state is restored to exactly what it was before focus was entered.

**Edge cases:**

- If the focused swimlane is deleted while focus mode is active (e.g. by another session), focus mode exits automatically and the collapse state is restored.
- If the `?focus=` URL param contains an ID that no longer exists on the board, it is silently ignored.

## Collapsed columns

Click a column header to collapse it to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes.
- Each swimlane cell shows the card count for that specific swimlane.
- The column header continues to show the aggregate total across all swimlanes.
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count, so hidden results are visible without expanding every column. With your operating system's "reduce motion" setting on, matching cells show a static highlight instead of pulsing.

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **color**
- **WIP limit** — maximum number of active cards allowed. The column header carries a single calm `N cards` stat line when within budget; when the limit is exceeded the line flips to `⚠ Over WIP · count/limit` and the header gains a 2 px red top accent strip so the over-limit state is visible at a distance (#963). If the board has **Enforce WIP limits** enabled (Board Settings → Rules), moving a card into a column at or over its limit, creating a card in it, or restoring an archived card into it returns a `409` error — board admins can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged. See [Hard WIP enforcement](#hard-wip-enforcement) for a stricter mode. Optionally, the **Show at-limit WIP indicator** board setting (off by default) surfaces the *at*-limit case too — see [At-limit WIP indicator](#at-limit-wip-indicator) below.
- **Weight limit** — maximum total card weight (story points / effort) allowed. When the limit is exceeded (and the column is not also over WIP — that state wins) the stat line shows `Weight weight/limit` and the header gains a 2 px amber top accent strip. If the board has **Enforce weight limits** enabled (Board Settings → Rules), moving, creating, or restoring a card that would push the column over its budget — or raising a card's weight so that it would — returns a `409` error; board admins can override with `?force=true`. Lowering a card's weight is never blocked. Enforcement is **on by default** for newly created boards; existing boards are unchanged.
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected
- **Done column** — mark a column as the completion target for cycle-time and throughput metrics; multiple done columns are supported (e.g. "Done" and "Released")
- **Policy** (since 1.3) — the column's entry criteria and definition of done, shown from a **Policy** button in its header. See [Column Policies](column-policies.md).

**Managing a column:**

- Drag a column header left or right to reorder it.
- Use the **`⋮` kebab** on its header (hover or keyboard focus): **Rename**, **Edit settings…**, **Add policy…** (only on a column without a policy), **Delete column**. Double-click the column name to rename directly.
- The kebab is the keyboard-accessible path; mouse users can also drag a column onto the trash zone (see *Column trash zone* below) for the same delete confirmation.

### Adding columns and swimlanes

The 16 px separators between columns and between swimlane rows are interactive insertion handles:

- **Column separators** (vertical, between columns): hover to see a centered **+**; click to insert a new column to the right; drag left/right to resize the column to the left.
- **Row separators** (horizontal, between swimlane rows): hover to see a **+** at each column's center; click to insert a new swimlane below; drag up/down to resize the swimlane above.

Both handle types highlight in blue when hovered and the "+" affordance is visible across the full extent of the separator: the column highlight extends through every row separator, and the row highlight extends across the full board width.

The far-left separator (between the swimlane label column and the first board column) follows the same design and resizes the swimlane label sidebar on drag.

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
- When a new card or a restore is refused, the add-card field or the **Archived cards** panel says which limit was reached, and the card stays where it was.
- When a weight increase is refused, the card detail shows the reason under the weight control and the weight reverts.

See [Field Enforcement](../architecture/field-enforcement.md).

### At-limit WIP indicator

<span class="vb-version" title="Added in 1.2">1.2+</span>

The column header's stat line only flips out of its calm state to warn about the *over*-limit case (`⚠ Over WIP · count/limit`). A column sitting exactly *at* its WIP limit still reads as an ordinary `N cards` line. The **Show at-limit WIP indicator** board setting (off by default, admin-only, in **Board Settings → Rules → Limit enforcement**) adds ambient visibility for that at-limit state:

- **Off (default):** a column at its WIP limit shows `N cards`, unchanged from the calm state.
- **On:** a column at its WIP limit shows `WIP N/N` in place of the card count, styled the same as the calm state (`text-fg-muted`, no accent strip, no glyph) — deliberately quieter than the over-limit warning so the two states stay visually distinct. Hovering shows the tooltip "Column is at its WIP limit (N/N)".
- Columns **over** their limit are unaffected: the existing `⚠ Over WIP` treatment always takes precedence.
- Columns under the limit are unaffected: always `N cards`.

This setting is purely ambient: it does not change limit enforcement, which is controlled independently by **Enforce WIP limits** / **Enforce WIP hard** above (#973).

## Cards

Cards are compact tiles with a full colored border indicating priority. **How much metadata appears on each card depends on the board's *Card density* setting** (Comfortable / Standard / Dense — see [Card density](#card-density) below). At every density the colored border carries priority, the assignee avatar sits at the bottom-right, and the card count badge appears in the top-right corner of cells with 2 or more cards.

### Card density

> **Added in 1.1** — replaces the previous per-user *hide field* toggles (Labels / Due date / Assignee / Priority badge / Last moved).

A board admin chooses one of three layouts in **Board Settings → Display → Card density**:

| Tier | Best for | What appears on the card face |
|---|---|---|
| **Comfortable** *(default for new boards)* | Sam-style occasional users; teams who want a clean glanceable board | One worst-offender urgency badge (Overdue · Due soon · Stale · Just moved), one primary label + `+N` overflow pill, checklist progress, assignee avatar |
| **Standard** | Mid-density boards — extra signal without the full wall | Adds a second label, due date (when not folded into the urgency badge), weight pill (when `>1`), attachment count |
| **Dense** *(default for boards upgraded from 1.0)* | Power users who use every field every day | Today's pre-1.1 layout — all labels (up to 3 + overflow), description indicator, checklist, attachments, due date, weight, last-moved text, recently-moved dot, priority badge |

**Urgency badge:** at Comfortable / Standard it picks the most urgent of Overdue → Due soon (within 72 h) → Stale (server-flagged based on the board's staleness threshold) → Just moved (within 24 h). Only one is shown; if none apply, no badge appears. For date-based urgencies the badge carries the actual date (`⚑ 2d late` for overdue, `⏱ Tomorrow` for due-soon), so the date is never lost when the standalone date pill is suppressed. Dense intentionally keeps the per-field cues; the badge is a *replacement* at lower densities, not an addition.

Fields hidden from the card face at Comfortable / Standard (weight, attachment count) still appear on the **card peek** (hover for 600 ms) as a single muted line — `Weight 5 · 3 attachments`. The full detail panel always shows everything.

**Upgrading from 1.0:** existing boards are migrated to **Dense** so they keep their pre-1.1 visual until an admin chooses otherwise. Per-user per-field hide preferences from 1.0 (browser-stored) are silently dropped. The board admin's setting is now the default density for everyone, unless a member sets their own personal override (see below).

#### Personal density override

<span class="vb-version" title="Added in 1.2">1.2+</span>

Any board member, not just admins, can flip **Use my own density** in **Board Settings → Display** and choose Comfortable, Standard, or Dense for their own view. This overrides the board's admin-set default without changing it for anyone else, including other admins. The override is stored in the browser (not synced across devices) and is board-scoped: turning it off, or clearing it, reverts that device to the board's admin-set default (#974).

Empty cells show a dashed border to indicate they are valid drop targets even when no cards are present.

### Card detail panel

Click a card to open its **detail panel**. Where it opens depends on the window width. *Changed in 1.2 (#1914): before 1.2 the panel always opened at the right edge of the window, over a dimmed board.*

- **1280 px and wider:** the panel opens next to the card's column, to its right if there is room, otherwise to its left. A small tail on the panel's outer edge points at the card (the panel gets a thin blue outline), and the card gets a thick blue border and ring while it is open. The board is not dimmed. If neither side has room (the panel never covers the swimlane names), the card's column is scrolled off to the side, or the card isn't on the board (for example, it is filtered out or its swimlane is collapsed), the panel opens at the right edge instead. A card scrolled out of view up or down keeps the panel next to its column; the tail then becomes a wedge near the panel's top or bottom corner, pointing up or down toward the card.
- **641 to 1279 px:** the panel opens at the right edge of the window, over a lightly dimmed board.
- **640 px and narrower:** the panel fills the screen, with a **‹ Board** button to go back.

While the panel is open, click another card to switch the panel to it, or click an empty part of the board to close it. Escape and the **×** button also close it, and focus returns to the card you opened. Cards can't be dragged while the panel is open. The panel stays put when you scroll the board: the tail follows the card, and the panel moves to the card's column again when you stop scrolling or resize the window.

The panel contains all editable fields plus two tabs:

- **Details** — description, priority, assignee, labels, due date, weight, checklist, attachments, and comments. The Checklist and Attachments sections are collapsible via a chevron toggle; each auto-collapses when empty on load. While a card's checklist, attachments and comments load, those sections show placeholders and **Archive card** waits until they finish. The title, tabs and footer stay in place while the details scroll, and a fade at the top or bottom shows there is more content in that direction.
- **Activity** — the full movement and activity timeline. See [Card History](card-history.md).

**Move button:** the panel header includes a **Move** button next to the column name in the breadcrumb row (visible to members and above). It opens a **Move to** popover to move the card to a different column and/or swimlane without closing the panel: select the destination swimlane and column from the dropdowns, then click **Move**.

- WIP and weight limits are enforced the same way as drag-and-drop moves.
- When a limit blocks the move, the popover names the column and shows the limit's numbers.
- For a soft WIP or weight limit, board admins also get a **Move anyway (admin override)** link right there, which forces the move to the selected destination. Hard WIP limits have no override.

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Rich text with a toolbar (bold, italic, code, lists, heading, blockquote); stored as markdown. See [Card Descriptions](card-descriptions.md). |
| Priority | `low` / `medium` / `high` / `urgent` — shown as a full colored border and a filled badge on the card face (low is unmarked) |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select; displayed on the card as truncated pills (up to 7 characters) |
| Due date | Optional date; past dates are disabled in the picker; shown as relative text on the card ("Today", "Tomorrow", "3d", "2d late"); overdue dates appear in red |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE_BYTES`) |
| Comments | Threaded, visible to all board members; type `@` to mention a member; timestamps show relative time ("5m ago", "3h ago") for recent comments and full date + time for older ones |

### Card peek

<span class="vb-version" title="Added in 1.1">1.1+</span>

Hover over a card for 600 ms to open a read-only **peek popover** showing the card's description (rendered as markdown), checklist progress (`done / total`), and the last-activity timestamp. The popover closes as soon as the pointer leaves the card or any movement begins. No interaction is possible inside it; click the card to open the full detail panel.

- The peek is not shown on any card while the card detail panel is open, so it never covers the fields you are editing. Closing the panel does not bring a peek back; hover a card again to see it.
- The 600 ms delay means casual scrolling and rapid drag-and-drop do not trigger the popover unintentionally.

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic**: the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

### Touch screens

> **Changed in 1.2**

On a tablet or phone, **press and hold** a card for about a quarter of a second, then drag it. A quick swipe scrolls the board instead, so you can still pan a wide board with one finger. The same press-and-hold picks up a column header or swimlane handle (board admins) and reorders custom fields in Board Settings.

To move a card without dragging, open it and tap **Move** next to the column name at the top of the panel. On touch screens this button is larger and shows its label. Or tap the **⋯ More actions** button on a selected card, or on the card you just closed, and choose **Move to…** from its [actions menu](#card-actions-menu).

A Bluetooth mouse paired with a tablet drags exactly as on a desktop.

### Board panning

Hold **Space** and drag to pan the board in any direction. This helps on dense boards where the visible area is smaller than the full grid. Release Space to return to normal drag-to-move mode.

## Bulk card operations

Select multiple cards by clicking the checkbox that appears in the top-right corner of each card on hover. Selected cards get a blue ring, and a **bulk action toolbar** appears fixed at the bottom of the board.

| Action | Description |
|---|---|
| **Move to...** | Move all selected cards to a target column (each card stays in its current swimlane) |
| **Assign to...** | Set or clear the assignee on all selected cards |
| **Priority...** | Set priority on all selected cards |
| **Archive** | Archive all selected cards — they are removed from the board view and can be restored from the **Archived** panel in the toolbar |
| **Delete** | Delete all selected cards (with confirmation) |

Press **Escape** or click the **×** button to clear the selection. Selection is also cleared when starting a drag or opening a card detail panel. Bulk operations are available only to users with the **member** role or above.

**Yes, but:** each bulk action calls the existing individual card API endpoints, so each card succeeds or fails on its own.

- When some cards fail, a message in the toolbar says how many failed and why, and the selection stays so you can retry. This applies to Move, Assign, Priority, Archive, and Delete.
- Assign, Priority, Archive, and Delete fire their requests concurrently via `Promise.allSettled`. **Move to...** runs sequentially instead, to avoid database deadlocks from concurrent position-reorder transactions.

## Right-click to add

Right-click the empty space in any board cell to open an inline card creation input directly in that column + swimlane. A right-click on a card opens the card's actions menu instead (see below).

## Card actions menu

<a id="card-actions-menu"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

Right-click a card to act on it without opening it: move it, assign it, set its priority, block it, archive it, and more.

**How to open it:**

- **Mouse:** right-click a card.
- **Keyboard:** focus a card and press the <kbd>Menu</kbd> key or <kbd>Shift+F10</kbd>.
- **Touch screen:** tap the **⋯ More actions** button. It shows on a selected card, and on the card that has focus, for example the one whose detail panel you just closed. A long press still picks the card up to drag it.

**Which cards it acts on:** right-click a card that is part of your current selection and the menu acts on every selected card. Right-click any other card and it acts on that one card only, without changing your selection; that card is outlined while the menu is open.

| Item | One card | Several cards |
|---|---|---|
| **Open card** | Opens the card detail panel | Select one card |
| **Copy link to card** | Copies a link that opens this card | Select one card |
| **Move to… ▸** | Moves to a column (the card keeps its swimlane) | Same, for each card |
| **Assign to… ▸** | Sets or clears the assignee | Same, for each card |
| **Set priority ▸** | Sets the priority | Same, for each card |
| **Block card…** / **Unblock card** | Opens the card with the [block form](blocked-cards.md) ready | Select one card |
| **Archive card** | Archives the card | Same, for each card |
| **Delete card…** | Asks first, then deletes | Same, for each card |

- Items you cannot use stay in the menu, dimmed, with the reason underneath (for example *Viewers can't block cards*, *Select one card*, or the maintenance or shared-demo notice), so you know why. On the shared demo, **Block card…**, **Archive card** and **Delete card…** are dimmed, as they are in the card detail panel.
- Copy link and Delete confirm what they did in a short notice under the toolbar, because nothing else on the board shows it.
- Use <kbd>↑</kbd> / <kbd>↓</kbd> to move, <kbd>→</kbd> to open a submenu, <kbd>←</kbd> to close it, and a letter to jump to the item that starts with it. <kbd>Esc</kbd> closes a submenu, then the menu, and returns you to the card.
- The menu is not offered while a card detail panel is open; use the [command palette](keyboard-shortcuts.md#card-actions-in-the-command-palette) to act on the open card.
- When some cards in a multi-card action fail, a notice under the toolbar says how many failed and why, and the selection stays so you can retry, as in [bulk card operations](#bulk-card-operations).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `f` | Toggle the filter bar |
| `/` | Open the filter bar and focus the search input |
| `?` | Show / hide the keyboard shortcuts overlay |
| `.` | Open the overflow menu in the board toolbar |
| `b` / `s` / `h` / `a` | Switch to the Board / Summary / History / Analytics view |
| `l` | Switch to the Lens view (when Issue Board Lens is connected) |
| `e` | Collapse or expand every swimlane and column at once |
| `c` | Collapse the swimlane you last hovered |
| `y` | Toggle the Archived cards panel |
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

The board toolbar (Row 2) groups controls into three zones plus a pinned trailing cluster:

- **Zone 1** — view tabs (Board / Summary / History / Analytics)
- **Zone 2** — board controls (Collapse split button, Filters, Layout toggle, Archived)
- **Zone 3** (wide viewports only) — board tools (Activity drawer, Keyboard shortcuts, Export, Settings)
- **Trailing cluster** — overflow kebab (`⋮`) and connection status; always visible

**Collapse button:** a split control. Clicking the main segment collapses or expands everything at once (preserving one-click muscle memory); clicking the chevron opens a menu with granular options to hide or show only swimlanes, only columns, or everything.

**Overflow kebab (`⋮`):** contains Export, Keyboard shortcuts, and Replay onboarding tour. Below 1024 px, the Layout toggle, Archived, Activity drawer, and Settings fold into it too, so the toolbar degrades gracefully without hiding functionality. The first time you visit a board at that viewport size, the kebab auto-expands once so the folded controls are visible. After that, a small first-encounter dot marks the kebab until you click it.

The toolbar scrolls horizontally when it's wider than the viewport, with the trailing cluster (overflow kebab and connection status) pinned to the right edge so it's always reachable. This applies at any width, not just narrow phones.

## Card layout

The toolbar's **compact layout toggle** (icon button) switches between two card display modes:

| Mode | Description |
|---|---|
| **Expanded** (default) | Full card face with title, priority border, label pills, assignee avatar, checklist progress, and due date |
| **Compact** | Narrower cards showing title and priority indicator only — useful on dense boards with many cards per cell. An aging card's title starts with a small bar meter that shows its aging step, since compact cards have no `Stale · Nd` badge (see [Card aging tint](card-history.md#card-aging-tint)) |

The preference is stored per user in `localStorage` under the key `user:prefs:card-layout` and persists across boards and sessions. The toggle's `aria-pressed` attribute reflects the compact state for screen reader users.

## Filtering

Click **Filters** in the toolbar (or press `f`) to open the filter bar. Press `/` to open it and focus the search input at once. Filters apply client-side (no round-trip) and stack: all conditions must match.

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

When filters are active and no cards match, a **"No cards match"** banner appears across the board area, so it is clear the board has cards but none satisfy the current criteria.

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

Pick an **Overlay** from the dropdown in the board toolbar, next to **Filters**, to shade each cell of the grid from a single number per cell. An overlay is a reading layer drawn *on top of* the grid, not a different view of it. The grid keeps its exact layout when an overlay is on: nothing moves, nothing is hidden, and drag-and-drop, card creation, and filtering all behave the same.

| Overlay | What it shows |
|---|---|
| **None** (default) | No overlay — the board renders unchanged |
| **Card count** | How many visible cards sit in each cell, relative to the busiest cell on the board |

The choice is remembered per board in `localStorage` under `board:{boardId}:grid-overlay`, so it survives a reload but never follows you to another board. It is a personal reading preference available to every role, including viewers: turning an overlay on changes nothing for your teammates and writes nothing to the server.

### How a cell is shaded

Every overlay shares one scale with four steps, measured against the largest value currently visible on the board.

- A cell whose value is zero is left completely untouched.
- When every cell with a value has the *same* value, the whole board is drawn at the quietest step, because a board where nothing stands out should not look alarming.

Each step is encoded **three** ways, so the ordering never depends on telling colors apart:

1. **Tint** — a single-hue blue wash that deepens with the value. It is deliberately not a green→amber→red gradient: a busy cell is not a problem, and the board already uses amber and red for card aging and over-limit columns.
2. **A bar along the cell's bottom edge** — 1px, 2px, 3px, or 4px tall. Height, not hue.
3. **The value itself**, in the cell's top-right corner. While an overlay is on it replaces the usual card-count badge, so the corner never shows two different numbers.

Screen readers get the reading in words — for example "Card count: 4 cards, level 3 of 4" — and selecting an overlay is announced ("Overlay: Card count" / "Overlay off").

A legend floats in the bottom-right corner of the grid whenever an overlay is active. It names the overlay, describes it in one line, and lists the four steps with the range of values actually observed in each; a step no cell landed in shows `—`.

- When the active overlay has nothing to show, the legend says so instead of showing an empty ramp. If a filter is what left it with nothing to scale, it says that rather than claiming the board is empty.
- The legend is passive: it never intercepts a click, and it fades out while you drag.

Because the overlay reads the cards that are currently *visible*, narrowing the filter bar re-scales it and the labels switch to "matching cards", so the shading always agrees with what is on screen. Hidden columns and swimlanes are excluded from the scale, so a card parked out of sight cannot wash out every tint on the board.

### Notes

- Overlays are **stackable with views, not a replacement for them** — Analytics is a tab, an overlay is a layer, and both can be on at once
- The **Card count** overlay is computed from the cards the board already loaded. It issues no extra requests and no per-cell queries
- Collapsed columns and collapsed swimlanes render their compact count stubs rather than full cells, so they carry no shading — but they still count toward the scale, so folding a lane never silently re-shades the rest of the board
- The cell being dragged over is never shaded, so the drop-target highlight stays unambiguous

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

Archive and restore events **are included** in the board History view by default, alongside column-to-column moves. The API supports narrowing this with `exclude_type=archived,unarchived`, but the board toolbar's History view doesn't expose a control for it. Use the API directly, or check the individual card's **Activity** tab, if you want moves only.

## Export & import

### Export

Click **Export** in the board toolbar to download the board data:

- **JSON** (recommended) — full board structure including columns, swimlanes, labels, and cards with comments, checklists, assignee, movement history (Activity tab), and activity log. Use JSON for backups, migrations, and any situation where full card history must be preserved.
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
- Movement history — every column transition appears in the card's **Activity** tab
- Activity log — assignee changes, label changes, priority changes, due-date changes, checklist events, and comments all appear in the activity feed
- Imported history keeps its original times and is recorded under your name, the person who ran the import. The username the file gave for each movement and activity entry is kept as text, and the card's **Activity** tab and the board's **History** view show it next to your name, for example "by Kelly · imported, originally alice" — so imported entries can always be told apart from history recorded on this board. The name is not matched to an account on this instance. See [Imported history](card-history.md#imported-history).
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

The drawer has two filter rows:

- **Kind**: *All*, *Moves* (includes creations), *Members*
- **Window**: *1h*, *24h*, *7d*. It defaults to **24h** so the drawer stays focused on today's activity rather than all history. Widen to **7d** to scan back through the week, or narrow to **1h** for what's happened in the last hour.

The drawer is a live summary, not the canonical audit trail. For the full ordered history with no window filter, click **Open full history →** at the bottom of the drawer (also reachable from any card's **Activity** tab — see [Card History](card-history.md)).

## Board sharing

> **Added in 1.0**

Board admins can generate a public read-only link that lets anyone view the board without signing in.

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
