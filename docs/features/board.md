# Board & Cards

The kanban grid, its cards, and the settings that shape them — the core workspace for anyone who works a board day to day, from quick status checks to full admin control.

!!! note "Small screens"
    Visiban works on phones and tablets: below 1024 px the sidebar becomes a hamburger drawer and the board grid scrolls horizontally. On a touch screen, press and hold a card to drag it (see [Touch screens](#touch-screens)). Column/swimlane resizing is easiest with a pointer, so a desktop browser is still the best fit for heavy board editing. See [Navigation → Mobile behavior](navigation.md#mobile-behavior).

## Board creation

Pick a template in the **Create Board** modal — ten are available (Sales Pipeline, Customer Support, Product Roadmap, Project Delivery, Hiring & Recruiting, and more), each with a tailored column layout and a first swimlane so you can start working right away.

No template fit? Select **Blank Board** — it creates no columns at all, so you build the layout yourself.

Templates are applied once at creation time — after the board is created you can rename, reorder, add, or remove columns freely.

### Inline board rename

> **Added in 1.1**

Board admins can rename a board without opening the settings modal: click the board name in the top-left breadcrumb to enter an inline edit field. Press **Enter** to confirm, **Escape** to cancel. Non-admins see the board name as plain text and cannot click to edit it.

**API:** `PATCH /api/v1/boards/{id}/` with `{ "name": "New name" }`

## Board layout

The board is a CSS grid with columns on the x-axis and swimlane rows on the y-axis. Each cell is a droppable zone identified as `cell:{column_id}:{swimlane_id}`.

- Column headers are sticky on horizontal scroll
- Over-limit columns gain a 2 px top accent strip — red for over-WIP, amber for over-weight — visible across the room. The single stat line beneath the column name flips to the over-limit message (e.g. `⚠ Over WIP · 6/5`); when calm, only `N cards` is shown. *Changed in 1.1 (#963).*
- When enforcement is enabled, moves into a full column are blocked (`409` error); board admins can override with `?force=true` (soft) or are denied entirely under hard mode

### Adding a card to a cell

> **Changed in 1.1** — empty cells now read as a discoverable click target instead of hiding the **+ Add card** affordance in the bottom-left corner.

An empty cell shows a dashed inset border with **+ Add card** centered.

- Click anywhere in the cell, or press **Tab** to focus it then **Enter**/**Space**, to open the inline new-card input.
- The dashed border disappears the moment a card lives in the cell; populated cells keep the **+ Add card** button anchored at the bottom for additional cards.
- Double-click and right-click on a cell still work for power users.

Card creation requires the column's *Allow card creation* setting and at least the Member role.

## Swimlanes

Swimlanes represent entities moving through your pipeline (customers, projects, epics). Each swimlane's label panel has a 4 px color stripe on its left edge (matching the swimlane's assigned color), making it easy to identify swimlanes at a glance even when the board is dense.

The swimlane label sidebar is resizable: drag its right edge to set the width (minimum ~56 px, maximum 400 px). Width is persisted per-board in localStorage.

Each swimlane row height is resizable: drag the bottom edge of any swimlane row to set a minimum height. Height is persisted per-swimlane per-board in localStorage.

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
    Contact email can only be set in the **Add Swimlane** dialog. The **Edit Swimlane** modal covers name and color, not contact email — to change it, delete and recreate the swimlane, or wait for that gap to close.

Each swimlane can be collapsed to save vertical space. Click the chevron on the label panel to toggle. When collapsed:

- The row shrinks to its minimum height — the stored row min-height is ignored
- Each column cell keeps the column's full width and renders as a centered count pill (empty cells show nothing)
- The contact email and edit (✎) button are hidden; the drag handle and the focus-mode crosshair remain
- Click the chevron again to expand and restore full card visibility

Admins can double-click the swimlane label to open the Edit Swimlane modal.

### Swimlane focus mode

> **Added in 1.0**

Focus mode collapses all other swimlane rows so you can work with a single swimlane without distraction — useful on dense boards with many swimlanes.

**Entering focus mode:**

Hover over any swimlane label panel to reveal the crosshair icon (⊙) in the top-right corner of the label. Click it to enter focus mode for that swimlane. The icon is always visible (highlighted in blue) when that swimlane is currently focused.

**What changes when focus is active:**

- All other swimlane rows are collapsed and their cards are hidden
- A blue banner appears between the board toolbar and the scroll area: "Focused on: *[swimlane name]*"
- The URL updates to include `?focus=<swimlane_id>` — focus mode can be bookmarked and shared

**Exiting focus mode:**

- Click **Exit focus** in the blue banner
- Press **Escape**
- Reload the page without the `?focus=` param

On exit, the swimlane collapse state is restored to exactly what it was before focus was entered.

**Edge cases:**

- If the focused swimlane is deleted while focus mode is active (e.g. by another session), focus mode exits automatically and the collapse state is restored
- If the `?focus=` URL param contains an ID that no longer exists on the board, it is silently ignored

## Collapsed columns

Clicking a column header collapses it to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes
- Each swimlane cell shows the card count for that specific swimlane
- The column header continues to show the aggregate total across all swimlanes
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count — so hidden results are visible without expanding every column

## Columns

Columns represent pipeline stages. Each column has:

- **Name** and **color**
- **WIP limit** — maximum number of active cards allowed. The column header carries a single calm `N cards` stat line when within budget; when the limit is exceeded the line flips to `⚠ Over WIP · count/limit` and the header gains a 2 px red top accent strip so the over-limit state is visible at a distance (#963). If the board has **Enforce WIP limits** enabled (Board Settings → Rules), moving a card into a column at or over its limit, creating a card in it, or restoring an archived card into it returns a `409` error — board admins can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged. See [Hard WIP enforcement](#hard-wip-enforcement) for a stricter mode. Optionally, the **Show at-limit WIP indicator** board setting (off by default) surfaces the *at*-limit case too — see [At-limit WIP indicator](#at-limit-wip-indicator) below.
- **Weight limit** — maximum total card weight (story points / effort) allowed. When the limit is exceeded (and the column is not also over WIP — that state wins) the stat line shows `Weight weight/limit` and the header gains a 2 px amber top accent strip. If the board has **Enforce weight limits** enabled (Board Settings → Rules), moving, creating, or restoring a card that would push the column over its budget — or raising a card's weight so that it would — returns a `409` error; board admins can override with `?force=true`. Lowering a card's weight is never blocked. Enforcement is **on by default** for newly created boards; existing boards are unchanged.
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected
- **Done column** — mark a column as the completion target for cycle-time and throughput metrics; multiple done columns are supported (e.g. "Done" and "Released")

- Drag a column header left or right to reorder it.
- Manage a column through the **`⋮` kebab** on its header (hover or keyboard focus) — **Rename**, **Edit settings…**, **Delete column**. Double-click the column name to rename directly.
- The kebab is the keyboard-accessible path; mouse users can also drag a column onto the trash zone (see *Column trash zone* below) for the same delete confirmation.

### Adding columns and swimlanes

The 16 px separators between columns and between swimlane rows are interactive insertion handles:

- **Column separators** (vertical, between columns): hover to see a centered **+**; click to insert a new column to the right; drag left/right to resize the column to the left
- **Row separators** (horizontal, between swimlane rows): hover to see a **+** at each column's center; click to insert a new swimlane below; drag up/down to resize the swimlane above

Both handle types highlight in blue when hovered and the "+" affordance is visible across the full extent of the separator — column highlight extends through every row separator, and row highlight extends across the full board width.

The far-left separator (between the swimlane label column and the first board column) follows the same design and resizes the swimlane label sidebar on drag.

### Column trash zone

> **Changed in 1.1** — the trash zone is now opt-in, gated behind ⌥ (Alt). Reorder is the default; deletion is a deliberate gesture. The new column kebab menu (`⋮`) is the discoverable, keyboard-accessible alternative.

Dragging a column shows a **Hold ⌥ to delete** hint on the drag overlay.

- Hold ⌥ (Alt) to reveal a red **Delete** drop target at the right edge of the board — the hint flips to **Drop on trash to delete**. Release ⌥ to hide it again.
- Dropping a column there opens the same confirmation as the kebab's `Delete column` action: type the column name to confirm if it holds cards, or delete an empty column with a single click.

### Hard WIP enforcement

> **Added in 1.0**

By default, WIP limit enforcement is "soft" — board admins can bypass a full column by appending `?force=true` to the request. The **Enforce WIP hard** board setting removes this override entirely. When enabled:

- Moving a card into a column at or over its WIP limit, creating a card in it, and restoring an archived card into it are blocked for **all roles**, including board admins and site admins.
- The `?force=true` query parameter is ignored — there is no bypass.
- The API returns a `409` error with `code: "wip_hard_blocked"`.
- The toast indicator uses a `⛔` icon instead of `⚠` to distinguish hard blocks from soft blocks.

WIP and weight limits, soft or hard, are checked whenever a card is moved into a column, created in it, or restored into it from the archive, and weight limits also when a card's weight is raised. *Changed in 1.2 (#1428): before 1.2 only moves were checked.* [Board import](#import) is the one exception: it restores a board as it was exported, so an imported column can start out over its limit. When a new card or a restore is refused, the add-card field or the **Archived cards** panel says which limit was reached, and the card stays where it was. When a weight increase is refused, the card detail shows the reason under the weight control and the weight reverts. See [Field Enforcement](../architecture/field-enforcement.md).

Hard enforcement is **off by default**. Enable it in **Board Settings → Rules → Enforce WIP hard**. Toggling it on requires an inline confirmation step because the change takes effect immediately and applies board-wide.

!!! tip
    Hard WIP enforcement is useful for teams that treat WIP limits as a strict policy rather than a guideline. To unblock a column, move a card out of it or ask an admin to raise the WIP limit.

### At-limit WIP indicator

> **Added in 1.2**

The column header's stat line only ever flips out of its calm state to warn about the *over*-limit case (`⚠ Over WIP · count/limit`) — a column sitting exactly *at* its WIP limit still reads as an ordinary `N cards` line. The **Show at-limit WIP indicator** board setting (off by default, admin-only, in **Board Settings → Rules → Limit enforcement**) adds ambient visibility for that at-limit state:

- **Off (default):** a column at its WIP limit shows `N cards` — unchanged from the calm state
- **On:** a column at its WIP limit shows `WIP N/N` in place of the card count, styled the same as the calm state (`text-fg-muted`, no accent strip, no glyph) — deliberately quieter than the over-limit warning so the two states stay visually distinct. Hovering shows the tooltip "Column is at its WIP limit (N/N)"
- Columns **over** their limit are unaffected — the existing `⚠ Over WIP` treatment always takes precedence
- Columns under the limit are unaffected — always `N cards`

This setting is purely ambient: it does not change limit enforcement, which is controlled independently by **Enforce WIP limits** / **Enforce WIP hard** above (#973).

## Cards

Cards are displayed as compact tiles with a full colored border indicating priority. **How much metadata appears on each card depends on the board's *Card density* setting** (Comfortable / Standard / Dense — see [Card density](#card-density) below). At every density the colored border carries priority, the assignee avatar sits at the bottom-right, and the card count badge appears in the top-right corner of cells with 2 or more cards.

### Card density

> **Added in 1.1** — replaces the previous per-user *hide field* toggles (Labels / Due date / Assignee / Priority badge / Last moved).

A board admin chooses one of three layouts in **Board Settings → Display → Card density**:

| Tier | Best for | What appears on the card face |
|---|---|---|
| **Comfortable** *(default for new boards)* | Sam-style occasional users; teams who want a clean glanceable board | One worst-offender urgency badge (Overdue · Due soon · Stale · Just moved), one primary label + `+N` overflow pill, checklist progress, assignee avatar |
| **Standard** | Mid-density boards — extra signal without the full wall | Adds a second label, due date (when not folded into the urgency badge), weight pill (when `>1`), attachment count |
| **Dense** *(default for boards upgraded from 1.0)* | Power users who use every field every day | Today's pre-1.1 layout — all labels (up to 3 + overflow), description indicator, checklist, attachments, due date, weight, last-moved text, recently-moved dot, priority badge |

The **urgency badge** at Comfortable / Standard picks the most urgent of: Overdue → Due soon (within 72 h) → Stale (server-flagged based on the board's staleness threshold) → Just moved (within 24 h). Only one is shown; if none apply, no badge appears. For date-based urgencies the badge carries the actual date — `⚑ 2d late` for overdue, `⏱ Tomorrow` for due-soon — so the date is never lost when the standalone date pill is suppressed. Dense intentionally keeps the per-field cues — the badge is a *replacement* at lower densities, not an addition.

Fields hidden from the card face at Comfortable / Standard (weight, attachment count) still appear on the **card peek** (hover for 600 ms) as a single muted line — `Weight 5 · 3 attachments`. The full detail panel always shows everything.

Existing boards upgraded from 1.0 are migrated to **Dense** so they keep their pre-1.1 visual until an admin chooses otherwise. Per-user per-field hide preferences from 1.0 (browser-stored) are silently dropped — the board admin's setting is now the default density for everyone, unless a member sets their own personal override (see below).

#### Personal density override

> **Added in 1.2**

Any board member — not just admins — can flip **Use my own density** in **Board Settings → Display** and choose Comfortable, Standard, or Dense for their own view. This overrides the board's admin-set default without changing it for anyone else, including other admins. The override is stored in the browser (not synced across devices) and is board-scoped: turning it off, or clearing it, reverts that device to the board's admin-set default (#974).

Empty cells show a dashed border to indicate they are valid drop targets even when no cards are present.

Click a card to open its **detail panel** on the right side. The panel contains all editable fields plus two tabs:

- **Details** — description, priority, assignee, labels, due date, weight, checklist, attachments, and comments. The Checklist and Attachments sections are collapsible via a chevron toggle; each auto-collapses when empty on load. A scroll gradient at the bottom of the panel indicates there is more content below the visible area.
- **Activity** — the full movement and activity timeline. See [Card History](card-history.md).

The Details tab also includes a **Move to** section at the bottom (visible to members and above). It lets you move the card to a different column and/or swimlane without closing the panel — select the destination swimlane and column from the dropdowns, then click **Move**. WIP and weight limits are enforced the same way as drag-and-drop moves.

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

> **Added in 1.1**

Hovering over a card for 600 ms opens a read-only **peek popover** showing the card's description (rendered as markdown), checklist progress (`done / total`), and the last-activity timestamp. The popover closes as soon as the pointer leaves the card or any movement begins. No interaction is possible inside the popover — click the card to open the full detail panel.

The 600 ms delay means casual scrolling and rapid drag-and-drop do not trigger the popover unintentionally.

## Drag and drop

Cards are dragged between cells using @dnd-kit. Updates are **optimistic** — the UI moves the card immediately and rolls back if the API call fails.

Every drag that changes column or swimlane creates a `CardMovement` audit record automatically.

### Touch screens

> **Changed in 1.2**

On a tablet or phone, **press and hold** a card for about a quarter of a second, then drag it. A quick swipe scrolls the board instead, so you can still pan a wide board with one finger. The same press-and-hold picks up a column header or swimlane handle (board admins) and reorders custom fields in Board Settings.

To move a card without dragging, open it and tap **Move** next to the column name at the top of the panel. On touch screens this button is larger and shows its label.

A Bluetooth mouse paired with a tablet drags exactly as on a desktop.

### Board panning

Hold **Space** and drag to pan the board in any direction. This is useful on dense boards where the visible area is smaller than the full grid. Release Space to return to normal drag-to-move mode.

## Bulk card operations

Select multiple cards by clicking the checkbox that appears in the top-right corner of each card on hover. Selected cards are highlighted with a blue ring. A **bulk action toolbar** appears fixed at the bottom of the board when one or more cards are selected.

| Action | Description |
|---|---|
| **Move to...** | Move all selected cards to a target column (each card stays in its current swimlane) |
| **Assign to...** | Set or clear the assignee on all selected cards |
| **Priority...** | Set priority on all selected cards |
| **Archive** | Archive all selected cards — they are removed from the board view and can be restored from the **Archived** panel in the toolbar |
| **Delete** | Delete all selected cards (with confirmation) |

Press **Escape** or click the **×** button to clear the selection. Selection is also cleared when starting a drag or opening a card detail panel. Bulk operations are only available to users with the **member** role or above.

Each bulk action calls the existing individual card API endpoints, so partial failures are handled gracefully. Assign, Priority, Archive, and Delete fire their requests concurrently via `Promise.allSettled`; **Move to...** runs sequentially instead, to avoid database deadlocks from concurrent position-reorder transactions.

## Right-click to add

Right-click any board cell to open an inline card creation input directly in that column + swimlane.

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

The **Collapse** button is a split control: clicking the main segment collapses or expands everything at once (preserving one-click muscle memory), while clicking the chevron opens a menu with granular options to hide or show only swimlanes, only columns, or everything.

The overflow kebab (`⋮`) contains Export, Keyboard shortcuts, and Replay onboarding tour. Below 1024 px, the Layout toggle, Archived, Activity drawer, and Settings fold into it too — the toolbar degrades gracefully without hiding functionality.

The first time you visit a board at that viewport size, the kebab auto-expands once so the folded controls are visible. After that, a small first-encounter dot marks the kebab until you click it.

The toolbar scrolls horizontally when it's wider than the viewport, with the trailing cluster (overflow kebab and connection status) pinned to the right edge so it's always reachable — this applies at any width, not just narrow phones.

## Card layout

The toolbar contains a **compact layout toggle** (icon button) that switches between two card display modes:

| Mode | Description |
|---|---|
| **Expanded** (default) | Full card face with title, priority border, label pills, assignee avatar, checklist progress, and due date |
| **Compact** | Narrower cards showing title and priority indicator only — useful on dense boards with many cards per cell |

The preference is stored per-user in `localStorage` under the key `user:prefs:card-layout` and persists across boards and sessions. The toggle's `aria-pressed` attribute reflects the compact state for screen reader users.

## Filtering

Click **Filters** in the toolbar (or press `f`) to open the filter bar below the toolbar. Press `/` to open the filter bar and immediately focus the search input. Filters are applied client-side (no round-trip) and stack — all conditions must match.

| Filter | Options |
|---|---|
| Search | Matches card title, description, assignee name, and label names |
| **My cards** | Quick filter — shows only cards assigned to the current user. Click the **My cards** button in the filter bar to toggle. Active state is indicated by a blue highlight on the button. |
| Assignee | Any board member, or "Unassigned" |
| Labels | One or more labels (card must have all selected) |
| Priority | One or more of low / medium / high / urgent |
| Due date | None set · Overdue · Due today · Due this week |

> **Changed in 1.2** — Assignee, Labels, Priority, and Due date no longer sit in the filter bar as always-visible dropdowns. Click **+ Filter** to pick which one(s) you want to set; picking a filter reveals its own dropdown in the bar, which collapses again once you close it. Once a filter has a value, it shows as a removable chip (e.g. `backend ×`) below the filter bar — click the **×** on a chip to clear just that value. The **+ Filter** button shows a count badge for how many filters currently have a value.

An active filter count badge appears on the Filters button when filters are in use. Click **Clear** to reset all filters at once.

When all filters are active and no cards match, a **"No cards match"** banner appears across the board area so it is clear the board has cards but none satisfy the current criteria.

#### URL-serialized filter state

> **Added in 1.1**

Active filters are serialized into the page URL as query parameters so filter combinations can be bookmarked and shared:

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

You can save the current filter combination under a name and restore it later in one click. Saved filters are stored server-side, so they persist across devices and browsers.

**Saving a filter:**

1. Set your desired filters in the filter bar.
2. Click the **Saved** dropdown (to the right of the filter controls).
3. Click **Save current filters**, enter a name, and confirm.

**Loading a saved filter:**

Saved filters appear as one-click **tab pills** above the filter bar (added in 1.1). Click any pill to apply that filter preset immediately — no dropdown required. The active pill is highlighted. Open the **Saved** dropdown to manage presets (save, rename, delete).

**Deleting a saved filter:**

Hover over a saved filter in the dropdown to reveal the delete icon. Click it to remove the filter permanently.

Saved filters are private to each user — other board members cannot see or modify your saved filters. Any board member, including viewers, can create, load, and delete their own saved filters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/boards/{id}/saved-filters/` | List saved filters for the current user |
| `POST` | `/api/v1/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/v1/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |

## Grid overlays

> **Added in 1.2**

An **overlay** shades each cell of the board grid from a single number per cell — a
reading layer drawn *on top of* the grid, not a different view of it. The grid keeps its
exact layout when an overlay is on: nothing moves, nothing is hidden, and drag-and-drop,
card creation, and filtering all behave the same.

Pick one from the **Overlay** dropdown in the board toolbar, next to **Filters**:

| Overlay | What it shows |
|---|---|
| **None** (default) | No overlay — the board renders unchanged |
| **Card count** | How many visible cards sit in each cell, relative to the busiest cell on the board |

The choice is remembered per board in `localStorage` under `board:{boardId}:grid-overlay`,
so it survives a reload but never follows you to another board. It is a personal reading
preference available to every role, including viewers: turning an overlay on changes
nothing for your teammates and writes nothing to the server.

### How a cell is shaded

Every overlay shares one scale with four steps, measured against the largest value
currently visible on the board. A cell whose value is zero is left completely untouched,
and when every cell with a value has the *same* value the whole board is drawn at the
quietest step — a board where nothing stands out should not look alarming.

Each step is encoded **three** ways, so the ordering never depends on telling colors
apart:

1. **Tint** — a single-hue blue wash that deepens with the value. It is deliberately not
   a green→amber→red gradient: a busy cell is not a problem, and the board already uses
   amber and red for card aging and over-limit columns.
2. **A bar along the cell's bottom edge** — 1px, 2px, 3px, or 4px tall. Height, not hue.
3. **The value itself**, in the cell's top-right corner. While an overlay is on it
   replaces the usual card-count badge, so the corner never shows two different numbers.

Screen readers get the reading in words — for example "Card count: 4 cards, level 3 of
4" — and selecting an overlay is announced ("Overlay: Card count" / "Overlay off").

A legend floats in the bottom-right corner of the grid whenever an overlay is active. It names the overlay, describes it in one line, and lists the four steps with the range of values actually observed in each — a step no cell landed in shows `—`.

- When the active overlay has nothing to show, the legend says so instead of showing an empty ramp — and if a filter is what left it with nothing to scale, it says that rather than claiming the board is empty.
- The legend is passive: it never intercepts a click, and it fades out while you drag.

Because the overlay reads the cards that are currently *visible*, narrowing the filter bar
re-scales it and the labels switch to "matching cards", so the shading always agrees with
what is on screen. Hidden columns and swimlanes are excluded from the scale, so a card
parked out of sight cannot wash out every tint on the board.

### Notes

- Overlays are **stackable with views, not a replacement for them** — Analytics is a tab,
  an overlay is a layer, and both can be on at once
- The **Card count** overlay is computed from the cards the board already loaded. It
  issues no extra requests and no per-cell queries
- Collapsed columns and collapsed swimlanes render their compact count stubs rather than
  full cells, so they carry no shading — but they still count toward the scale, so folding
  a lane never silently re-shades the rest of the board
- The cell being dragged over is never shaded, so the drop-target highlight stays
  unambiguous

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

When no date range is specified, the full movement history is shown. There's no separate assignee filter — filter by swimlane or column to narrow the list instead.

#### Detail panel

Click any row to open a slide-in detail panel showing the full movement record: card title, from/to column, from/to swimlane, moved by, and any notes recorded at the time of the move.

#### Archive and restore events

Archive and restore events **are included** in the board History view by default, alongside column-to-column moves. The API supports narrowing this with `exclude_type=archived,unarchived`, but the board toolbar's History view doesn't expose a control for it — use the API directly, or check the individual card's **Activity** tab, if you want moves only.

## Export & import

### Export

Click **Export** in the board toolbar to download the board data:

- **JSON** (recommended) — full board structure including columns, swimlanes, labels, and cards with comments, checklists, assignee, movement history (Activity tab), and activity log. Use JSON for backups, migrations, and any situation where full card history must be preserved.
- **CSV** — one row per card with columns for ID, title, description, column, swimlane, priority, assignee, labels, due date, weight, dates, and movement history. Cards are imported without movement history or activity log. Use CSV when you need the data in a spreadsheet.

> **Added in 1.1** — export permission threshold and audit history (#842, #843)

By default, any board member can export. Admins can raise the threshold per board under **Board Settings → Data → Export permission** to restrict exports to collaborators, members, or admins only — owners and site admins always bypass it.

Below the threshold, the **Export** button is hidden and direct API calls return `403 export_restricted`. The export endpoints are:

- `GET /api/v1/boards/{id}/export/` — CSV
- `GET /api/v1/boards/{id}/export/?format=json` — JSON

#### Export audit history

Every successful export is recorded in an audit log capturing the actor, the role they held at export time, the format (`csv` / `json`), and the number of rows exported. Admins can review the log under **Board Settings → Data → Export history**, or via `GET /api/v1/boards/{id}/export-history/` (admin-only). Failed exports (permission denied, rate limited) are not logged.

This per-board export log is a data-exfiltration safeguard scoped to individual board admins — it is part of the open-source core. It is intentionally distinct from the site-wide, compliance-oriented **audit log** in Visiban Enterprise, which records administrative activity across the whole instance.

### Import

Click **Import** on the dashboard to create a new board from a previously exported Visiban JSON or CSV file. The import atomically creates a new board with all structure (columns, swimlanes, labels) and cards.

**JSON import** restores full card history:

- Assignee (matched by username; cards whose assignee username is not found in this instance are imported unassigned)
- Movement history — every column transition appears in the card's **Activity** tab
- Activity log — assignee changes, label changes, priority changes, due-date changes, checklist events, and comments all appear in the activity feed
- Custom fields (since 1.2) — the board's card and swimlane custom field definitions, with their number formatting and choice colors, and every card's and swimlane's values. A value the field's type would refuse is skipped; the rest of the import goes ahead

**CSV import** creates cards with their current field values only. Movement history and activity log are not restored.

The new board is named **Imported: <name>** — the board name stored in a JSON file, or the filename without its extension for a CSV file (for example, `Q3 plan.csv` becomes **Imported: Q3 plan**). If a board with that name already exists in the same place (the group you import into, or — without a group — any board you can access that is not in a group, as listed under **My Boards**), a number is added: **Imported: Q3 plan - 1**, then **- 2**, and so on. To choose the name yourself, type it in **Board name** when importing; it is used exactly as typed.

!!! note "Changed in 1.2"
    Earlier releases named a JSON import after the file's board name unchanged, and every CSV import **Imported Board**.

#### Choosing what to import

> **Added in 1.2**

Once you pick a file, an **Include** list lets you leave parts of the export out. Board structure — the name, columns, swimlanes, and (from JSON) custom field definitions — is always imported. Swimlane custom field values come with the structure; card custom field values come with **Cards**.

| Option | What it covers | Formats |
|---|---|---|
| **Cards** | Cards. From JSON: with their assignees and due dates. From CSV: title, description, priority, weight, due date, and assignee. | JSON, CSV |
| **Comments** | Card comments | JSON |
| **Checklist items** | Card checklist items | JSON |
| **Card history** | Movements, imported activity entries, and the "weight changed" entry recorded for a card with a non-default weight | JSON |
| **Labels** | Label definitions and the labels on cards | JSON, CSV |

Comments, checklist items, and card history belong to cards: unchecking **Cards** turns them off too, and checking it again restores your earlier choices. Leaving **Labels** out also leaves out the "label added" activity entries the import would otherwise record; the same applies to checklist items ("checklist item added"), and leaving **Card history** out also leaves out the "weight changed" entry recorded for a card with a non-default weight. The import records those three entries itself only when the file has no history of its own for them: a card whose imported history already includes a label, checklist or weight change keeps the original entries, with their original people and times, and gets no second copy. A line under the list shows what will be imported, for example "Importing: structure, cards, labels".

Everything is included by default ("Importing: everything"), so an import where you change nothing behaves exactly as before. When an import leaves out cards or anything on them, the new board opens with a short notice counting what was skipped, for example "Board imported. Skipped: 12 cards, 30 comments, 4 card labels." It counts cards, comments, checklist items, labels on cards, and history entries (movements and activity entries together); label definitions that no card uses are not counted, so leaving **Labels** out of a file whose labels are unused shows no notice. The notice closes by itself after a few seconds, and stays open while you hover over it or focus it.

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

    Boards exported from Visiban stay well within these limits in normal use. If you are migrating from an external tool and your board exceeds a limit, split it into smaller boards before importing.

!!! note "JSON vs CSV import fidelity"
    JSON imports restore movement history, activity log, and assignees (matched by username). CSV imports create cards with their current field values only, including the **Assignee** column (matched by username, case-insensitively) — no history or activity log is restored. A blank Assignee, or a username that does not exist on this instance, imports the card unassigned. The user does not need to be a member of the source board; any user on the instance matches, including deactivated accounts, as with JSON.

- `POST /api/v1/boards/import/` — multipart file upload

## Board member management

Admins can manage board members directly from the board toolbar via the **Members** button. This allows assigning all four roles (admin, member, collaborator, viewer) independently of group membership. Press **Escape** or click **×** to close the dialog. See [Roles & Permissions](rbac/roles.md) for what each role can do.

## Real-time indicator

The board toolbar shows a **ConnectionStatus** indicator in the top-right corner:

- **Healthy** — quiet: a small dot with the word "Live" (visible at wider viewports)
- **Degraded or lost** — prominent: an amber pill for reconnecting/stale, a red pill for failed

Board state updates automatically when other users move cards or make changes. See [Real-time Updates](realtime.md).

## Activity drawer

> **Added in 1.1**

A right-hand panel that streams the most recent board events — card moves, creations, and membership changes — as they happen. Open and close it with **⌘\\** (Ctrl+\\ on Linux/Windows) or the activity button in the board toolbar.

The drawer has two filter rows:

- **Kind**: *All*, *Moves* (includes creations), *Members*
- **Window**: *1h*, *24h*, *7d* — defaults to **24h** so the drawer stays focused on today's activity rather than all history. Widen to **7d** to scan back through the week, or narrow to **1h** for what's happened in the last hour.

The drawer is a live summary, not the canonical audit trail. For the full ordered history with no window filter, click **Open full history →** at the bottom of the drawer (also reachable from any card's **Activity** tab — see [Card History](card-history.md)).

## Board sharing

> **Added in 1.0**

Board admins can generate a public read-only link that lets anyone view the board without signing in.

### Enabling a share link

1. Open **Board Settings** and go to the **Sharing** tab.
2. Toggle **Enable public share link** to the on position.
3. Optionally set an **expiry** — choose 7 days, 30 days, 90 days, or no expiry. The default is no expiry.
4. A URL in the format `https://<host>/share/<token>` is displayed with a **Copy** button.

Share that URL with anyone — recipients do not need a Visiban account.

> **Added in 1.1** — share link expiry options (#804)

When a share link expires, visitors who follow the URL receive a `410 Gone` response and a "This link has expired" page. Toggling sharing back on after expiry generates a new token — the expired token cannot be restored.

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

Toggle **Enable public share link** off to revoke the current token immediately. Any visitor who follows the old URL will see a "This board is no longer shared" page with a link to sign in. Toggling sharing back on generates a new token — the previous link cannot be restored.

### Rate limiting

The public board endpoint is rate-limited to **120 requests per hour per IP address** to prevent token enumeration, with a separate, higher per-token limit (240/hour) layered on top for a legitimately busy shared link.

### API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/boards/{id}/share/` | Board admin | Generate or regenerate the share token |
| `DELETE` | `/api/v1/boards/{id}/share/` | Board admin | Revoke the share token |
| `GET` | `/api/share/{token}/` | None (public) | Read-only board payload; rate-limited |
