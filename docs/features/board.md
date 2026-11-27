# Work the board: grid, cards, and settings

<a id="board-cards"></a>

Pick a template in the **Create Board** modal, then drag cards between cells. Everything else on this page shapes that grid.

**Why it matters:** This is the core workspace for anyone who works a board day to day, from quick status checks to full admin control.

**The big picture:** the board is a grid. Columns are pipeline stages, swimlanes are the entities moving through them (customers, projects, epics), and each card sits in exactly one cell. Every move is logged to the audit trail.

**Vocabulary:** a **stage** is a column. A column's **Stage** tab holds its [sub-columns and tracks](#sub-columns-and-tracks-13), and a stage split into sub-columns is a **gated stage**.

!!! note "Small screens"
    Visiban works on phones and tablets: navigation opens in a drawer from the header's menu button at every width, and below 640 px the board shows one column at a time (see [Phone layout](#phone-layout)). On a tablet, press and hold a card to drag it (see [Touch screens](#touch-screens)). Column/swimlane resizing is easiest with a pointer, so a desktop browser is still the best fit for heavy board editing. See [Navigation → Mobile behavior](navigation.md#mobile-behavior).

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
- Each column header is a panel tinted with the column color: color dot, name (one line, truncated with an ellipsis when long; the full name is its tooltip), an add-card button, a thin WIP meter and a count line. With no limit the line reads `2 cards` and there is no meter; under a limit it reads `2 / 4` with the meter in the column color; at the limit `4 / 4` with a full meter; over the limit `8 / 6 over` in warning text with a full warning-colored meter. A weight budget that is exceeded adds `Weight 14/10` to the same line. *Changed in 1.3 (#2270).*
- When enforcement is enabled, moves into a full column are blocked (`409` error); board admins (or the card's assignee, when enabled) can override with `?force=true` (soft) or are denied entirely under hard mode.

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
- an **N fields** button on a board set up before 1.3 (shown when the lane has more than two fields; once a board has explicit tiers, the band shows its Band fields and a **Show N more** button instead; it opens an aligned grid of every field, with labels in a fixed column and **—** for an unset value, inside the band; see [Swimlane fields in the lane band](custom-fields.md#swimlane-fields-in-the-lane-band)); then the swimlane's first two field values as `Label value` pairs;
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
- **When the row is full.** **Follow board settings** (the default) applies the board's **Enforce WIP limits** (including **Hard mode (no admin override)**) and **Enforce weight limits** rules, exactly as for columns. **Block, admins can override** refuses the move and lets a board admin move anyway (and the card's assignee, [when enabled](#letting-a-cards-assignee-move-it-anyway-since-13) and unless they assigned the card to themselves). **Block for everyone** is the hard mode: nobody, board admins included, can add a card past the row's WIP limit. A weight limit can always be overridden by a board admin, as on columns, and by the assignee on the same terms.

**What the row shows.** Once a row has a limit, its band shows one state line in the right-hand stats, worst state first:

| State | Line |
|---|---|
| Under the limit | `WIP 4 / 6` |
| At the limit | `WIP 5 / 5 · at limit`, only when the board's **Show at-limit WIP indicator** setting is on; otherwise the line reads `WIP 5 / 5` |
| Over the WIP limit | `WIP 5 / 4 over` in warning (orange) text, like an over-limit column header (`⛔ WIP 5 / 4 over` when the row is in hard mode) |
| Over the weight limit | `Weight 18 / 12 over` in warning text |

The words carry the state. A collapsed row hides the calm states but keeps the two over-limit ones. *Changed in 1.3 (#2275): the line matches the column header's `n / limit over` format and warning color; before, an over-limit row read `⚠ Over WIP · 5/4` in red with a red line across the top of the band.*

### Swimlane default team

> **Added in 1.3** (#2211)

A swimlane can carry a **default team**: the board members who work that row, for example the people on one customer account. New cards created in the lane, and children created with **Add child** from its cards, are pre-assigned to the team. A card has one assignee, so only the **first** person on the team (in team order) who can be assigned is pre-assigned; the others are named in the caption ("Also on the team, not assigned: ..."). Existing cards never change when the team does.

Set it in the **Edit Swimlane** modal (board admins), under **Default team**. Each person is a row with a **Remove** button; **Add a member** lists the board's active, listed members who are not viewers. On a phone, Edit Swimlane is a full-screen sheet.

- **Pre-assignment is never silent.** The Add card input in a cell (and the phone composer) and the Add child dialog show the pre-assigned person as a chip under **Assignees**, with a caption saying where it came from: "From the Acme Corp default team. Remove anyone this card shouldn't have." for Add card, and "From the Acme Corp default team on Pipeline, the lane the parent is in. Delivery's own lanes are not consulted." for Add child. **Unassign NAME** removes them for that card only, and **+ Add** puts them back; assign someone else in card detail afterward. The Add child dialog's header names the parent card and its column ("Parent: Acme: platform renewal · Qualify"), and on a phone both sheets have **‹ Board** to go back.
- **The pre-assigned person is notified.** Being pre-assigned is an assignment like any other: the person gets the usual "You were assigned to ..." notification under their **Card assigned to me** preference (in-app, and email when they turned it on), once per card, from Add card and Add child alike. Nobody is notified when you assign yourself, when you removed the chip (Unassign), or when nobody on the team can be assigned there. Only this pre-assignment notifies: a card created with an assignee any other way (the API without `notify_assignee`, MCP, import) does not.
- **Add child uses the parent's lane.** A child gets the team of the lane its parent is in; the child board's own lanes are not consulted. A team member who can't be assigned on the child board is skipped (the next person is used) and never shown as a chip. If the person on the chip can no longer be assigned there by the time you select **Add to <board>**, the child is created unassigned, never given to someone the dialog did not show.
- **Add card checks only this board.** Add card (the cell input and the phone composer) pre-assigns the first team member who can be assigned on the lane's own board. It does not skip someone who can't open a child board this lane's parents use: the card being added lives on this board, and a child board only matters later, for Add child. Add child does skip them (above), and Edit Swimlane flags them (below), so the gap is visible before it matters.
- **Warning in Edit Swimlane.** A team member who can't be assigned on a child board this lane's parents use (the boards its parent cards already have children on, and the board's default child board) is flagged with a dashed warning border and "No access to Delivery: skipped on new children". A board you can't open yourself is counted, not named. Remove them, or give them access to that board, to clear it.
- **Deactivated people.** A deactivated person who is still on a lane team is marked "Deactivated: remove to save the team". They are never pre-assigned, and a change to the team can't be saved until they are removed (one click on **Remove**).
- **On the lane band.** The team is not on the band itself. It is the first row behind the band's **Show N more** toggle: "Default team: Mia Reyes, Dan Kovacs".

- **Leaving the board.** Removing someone from the board, in the app or in the Django admin, removes them from every lane team on it. Someone who loses access another way (a group change, or becoming a viewer) keeps their id in the lane's team in the API until someone edits that team; the Edit Swimlane modal hides them in the meantime, and neither Add card nor Add child pre-assigns or notifies them.

### Swimlane rollup

*Added in 1.3 (#2275).* A board can show, in every swimlane band, the total of one card [number field](custom-fields.md) over the lane's open cards, for example `$413k open` on a sales board whose cards carry a deal amount. "Open" means every card in the lane that is not in a column marked done; archived cards never count. Cards without a value add nothing. The total uses the field's prefix, suffix and decimal places, so a field with prefix `$` and suffix `k` reads `$413k open`. It sits after the WIP line in the band and updates live as cards are created, moved, edited and archived.

To choose the field, a board admin opens **Board settings → Rules & limits → Limit enforcement → Swimlane rollup** and picks one of the board's number fields, or **None** (the default, which shows no total). Other members see the choice as a read-only line. Deleting the field turns the rollup off. Changing the field to another type hides the totals until it is a number field again; the settings then say why.

The lane's own WIP limit is set in **Edit Swimlane** (see [Swimlane limits](#swimlane-limits) above); the rollup does not affect limits or moves.

**What a move does.** A move is checked against a row only when it adds to the row's count: the card enters one of the row's counted columns from another row, from a column of this row that does not count, or by being created or restored there. Moving a card between two counted columns of the same row never trips the row's limit. While you drag a card over a cell whose column or row is full, the cell turns amber with a dashed edge and names the limit (for example `⚠ WIP limit 5/5 · Payouts`). With the keyboard, the screen reader announcement for each cell includes the same verdict. If you drop anyway, the move is refused with the same toast as a column limit, naming the row; when a column limit and a row limit both trip, the toast names both. Board admins get **Move anyway (admin override)** for a soft limit (the card's assignee gets **Move anyway (assignee override)**, [when enabled](#letting-a-cards-assignee-move-it-anyway-since-13) and unless they assigned the card to themselves), never for a hard one.

Board import restores row limits as exported and does not check them, as with column limits.

### Swimlane focus mode

> **Added in 1.0**

Focus mode collapses all other swimlane rows so you can work with a single swimlane without distraction, which helps on dense boards with many swimlanes.

**Entering focus mode:** hover over any swimlane band to reveal the crosshair icon (⊙) beside the lane name, and click it. The icon is always visible (highlighted in blue) when that swimlane is currently focused.

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

<a id="child-cards"></a>

*Added in 1.3 (#2208).* Cards can be linked parent to child across boards, and the hierarchy is two-tier by design: a board whose cards can have children is a parent board, and the child cards live on another board. A board with that setting off is an ordinary board that can *hold* children; it is a child board only once it holds children, or when another board names it as its default child board. A card is never both a parent and a child, so each card stays within two tiers. To decide between a child card and a checklist item, see [Breaking work down: which tool?](breaking-work-down.md).

A board admin chooses which one in **Board settings → Rules & limits → Child cards** with the **Cards on this board can have children** switch. It is off by default, so every existing board stays an ordinary board and nothing changes until an admin turns it on. Boards that never use hierarchy are never asked to pick a role. Other members see the choice as a read-only line.

The switch can be refused, and then it stays focusable but dimmed (`aria-disabled`). Activating it moves focus to a **"A child can't also have children"** list that says why: cards on this board are children of cards on another board, or another board names this one as its default child board (with a **Change on <board>** link when you administer that board, or "Ask an admin of that board" when you do not, or cannot open it). When cards here are children, **Show the N cards** (or **Show the card** for one) closes settings and filters the board to them (Parent: Any parent). Only turning it **on** can be refused. Fix the cause and the line clears. If the server still refuses the change (for example a card was linked a moment ago), the reason is shown under the switch. If the check itself cannot be made, a line under the switch says "Couldn't check whether this can change" with a **Retry** button; the server still refuses a change that isn't allowed.

**Turning it off when cards already have children** (*1.3, #2446*). Before 1.3's #2446 this was refused; now it asks first. An inline confirm under the switch reads **Turn off children on <board>?** and says, for example, "9 cards here have children. They keep them and stay linked, and the tab and rollup stay on those 9 cards. The 9 can still Add child; no other card can get children." **Keep it on** cancels; **Turn off** saves. Focus starts on **Turn off**, and Escape cancels and returns focus to the switch (Escape does nothing while the change is saving). With no cards that have children, the switch turns off at once with no confirm. After it is off, the board's other cards can't get children, but each card that still has children keeps its Children tab, rollup, **Add child** and **Link existing** until its last child is unlinked, moved away or deleted; after that it is an ordinary card. The board can be chosen as another board's child board, and a card on it can be linked as a child as long as it has no children of its own. A card is never both a parent and a child, so the hierarchy stays two tiers per card.

On a card that has children, the card-detail header shows a **Parent chip** (named by the board's parent name, with the child count) that opens the Children tab. On the board, a parent card's footer shows child progress: a loading skeleton appears while it is first read, and the "Work moved N ago" and "Work idle" text keeps itself current without a reload.

### What a parent card is called

*New in 1.3.* While **Cards on this board can have children** is on, a board admin can name the parent cards under **What do you call a parent card on this board?**: a **Singular** and a **Plural** field, for example "Initiative" and "Initiatives". Both start empty, so the board says "Parent". The **Opportunity**, **Initiative** and **Release** suggestions fill both fields; choosing the active one again clears them. Any text works, up to 24 characters.

The name appears in two places: on a child card, the parent row is labeled with the parent board's singular name once a parent is linked; and in **Link a parent card**, the line under the Board picker reads, for example, "Pipeline calls these Initiatives". The word "Children", the Children tab, the rollup, the Parent filter and the public share link never change.

## Parent card (child side)

*Added in 1.3 (#1104).* A card on a board whose cards cannot have children can be linked to one **parent** card on another board. The parent's own columns and this card's columns stay independent: moving one never moves the other.

- **Link a parent.** Open the card. The **Parent** row at the top of the details reads "Not linked" with a **Link a parent** button. It appears only for members and admins, and only when there is at least one parent board you are a member or admin of. The picker lists those boards in a **Board** select; search the chosen board by title or card number, then choose **Link to** *card*. Up and Down move through the matches and Enter links the highlighted one. Cards that can't be chosen stay listed with the reason, such as "Its children are on Onboarding" (a parent's children all live on one board) or "Has 100 children (the limit)". A card you can't open is never listed, and a search that finds nothing reads "No matching cards", whatever the reason.
- **Siblings.** When the parent has two or more live children on this board, the Parent row also reads, for example, "2 of 5 siblings done": this card and its siblings on this board, and how many of them are done. A child counts as done in a done column unless it is blocked, the same rule the parent's Children tab summary uses, so the two never disagree. Archived children, and children on any other board, are not counted. The line is not shown for a parent you can't open.
- **On the card face.** A linked card shows one line above its title with the parent's title. The compact card layout shows no parent line, and no lock for a hidden parent.
- **A parent you can't open.** When the parent is on a board you don't have access to, the card face and the Parent row show only "Linked card you can't open", with a lock. No title, board or column is shown.
- **Unlink.** The **Unlink** button on the Parent row removes the link at once, without asking. It changes nothing else about the card, and you can link it again from the picker. Both cards record the link and the unlink in their history.
- **Live.** When someone links, unlinks, renames or moves a parent, the parent line updates for everyone viewing the child board. The sibling line updates the same way when a sibling is moved to another column, archived, restored, blocked, unblocked, deleted, linked or unlinked.

Public share links show no parent line. On a phone the picker opens as a full-screen sheet with **‹ Card** and **Close**, and the sheet shrinks to the space above the on-screen keyboard, so the keyboard never covers the list, and Cancel and Link stay pinned at the bottom. A parent's children are shown on its [Children tab](#children-tab-parent-side).

### Default child board and Add child

*Added in 1.3 (#2208).* A parent board can name a **default child board**: the board where **Add child** on one of its cards creates the new child card, in that board's first column and first lane. It is a preference, not a link, so setting, changing or clearing it never moves or unlinks an existing child. A parent's children always stay on one board: once a card has children, Add child uses their board, and a default change only applies to parents with no children yet. Different parents on one board may still use different child boards.

- **Who can set it:** an admin of both boards. In **Board settings → Rules & limits → Child cards**, the **Default child board** select appears while the switch is on and lists only boards you administer that qualify; choose **None (ask each time)** to clear it. The select and the Add child chooser list at most 100 boards, by name, always including the current default; above that they say, for example, "Showing 100 of 240 boards, by name." Clearing needs admin on the parent board only. The same value is writable through the board PATCH API.
- **Which boards qualify:** a board whose cards cannot have children and whose first column allows card creation. A board named as another board's default cannot turn on "cards can have children" until that default is cleared.
- **Turning children off** on the parent board clears its default.
- **Deleting the child board** clears the default; Add child then asks which board to use. Each parent that lost children records "N children removed: their board was deleted", and each child of a deleted parent board records "Parent removed: its board was deleted". The deleted board is never named in that history.
- **Add child chooser:** a card on a parent board with member access or above shows an **Add child** button on its Children tab (#2209; before, in its detail panel). It opens a dialog (a full-screen sheet on a phone) titled **Add child to <board>** once the board is known (**Add child** until then), with a header line "Parent: <card title> · <column>". Under **Title**, a line reads "A child card has its own workflow on another board. For a simple to-do, use the checklist." (*since 1.3*, #2542; see [Breaking work down: which tool?](breaking-work-down.md)). With a default, the board is preselected and the button reads **Add to <board>**; without one, members see **Choose a board** and the button stays disabled until a board and a title are given. Admins of both boards also get **Use <board> as the default for <this board>**, which sets the default in a second request after the child is added. Once a card has children, the select is replaced by the board they are on; if you cannot open that board, Add child is unavailable. A board that is no longer available is reported and the list is re-read. If the boards cannot be loaded, the dialog says so and offers **Retry**. An archived card cannot get new children (*1.3, #2447*): the dialog says "This card is archived. Restore it before adding children." and Add stays disabled, and the server refuses the add with `parent_archived` if it is tried anyway. Restoring the card lifts it; archiving a parent never removes the children it already has. One exception: a card that was a child of the archived card and was then unlinked from it may be linked back, so an unlink can be undone; the server refuses only cards that were never its children.
- **Delete confirm:** the confirm for deleting a board that holds children of cards on other boards says how many parents lose them, naming the parent boards you can open and "another board you can't open" for the rest.

### Planned children

<a id="planned-child"></a>

*Added in 1.3 (#2371).* A child can be work you already know the parent will need at a **later stage**, for example a workshop needed once the parent reaches Proposal. Such a child is a real card in the child board's first column (To do), but it is **planned**: it waits quietly until it is needed.

- **Needed.** Add child accepts an optional **Needed** value: **Now** (the default, and every child before 1.3) or a column on the parent's board after the one the parent is in. Through the API this is `needed_at_column` on `POST .../children/`. *Since 1.3 (#2549).* Add child also takes an optional **Due date**; while Needed is a later column it reads "Inactive while planned", because the date counts only once the work is pulled or the parent reaches that column. With a later column chosen, a hint suggests splitting work with a lead time into its own task needed one column earlier (for example "Book Proposal workshop" at Qualify, "Proposal workshop" at Proposal). On a phone the Needed choices open as a bottom sheet.
- **Inactive date.** A planned child's due date is saved but does not count: the card is left out of Overdue, Due soon and Stale until it is released. That holds wherever the server works these out (the board and card reads, the card query, a public share link's Stale flag, the stale digest, the due-soon notification, the lane health counts and Analytics' **Needs attention** list) and in the board view itself: its filters, chips, lane squares, the card face, the peek sheet and card detail. Export and MCP carry the date but no Stale or Overdue value of their own. Every other card, To do included, keeps its date exactly as before.
- **Public share link.** The share page shows a card's plain due date and never works out Overdue, so a planned child cannot look overdue there. The share link carries no planned field.
- **On the parent's Children tab.** *Since 1.3 (#2553).* A planned child's row reads "Planned for a later stage" (with "Dec 4, counts once needed" when it has a date), or "Dec 4 passed while planned" in warning text once the date has passed, never Overdue.
- **Planned filter.** *Since 1.3 (#2550).* On a board with planned children, the filter panel has a **Planned** row after Due date: Any, **Hide planned** or **Only planned**. An active row adds a removable chip ("Planned: hidden" or "Planned: only"), and the value is kept in saved filters like any other filter. Nothing is hidden by default, and column counts and WIP meters still count the whole column. The row stays while its value is not Any, even when no planned card is left.
- **Moving a planned child.** *Since 1.3 (#2550).* Moving a planned child out of To do (from card detail or the parent's Children tab) pulls it, so its date counts at once. When that date has already passed, the Move popover says "Its date, Dec 4, has passed. It will be overdue once moved." before you move it. It is a note, not a confirmation: Move still moves. A move within To do, or to a done column, shows no note. After the move, focus returns to the moved card (its Move button in card detail, the card itself on the Children tab).
- **Release.** The child stops being planned when the parent reaches that column **or skips past it**, or when someone pulls the child out of To do. The release is stored, so a parent moving back never makes the child planned again. After release, Stale is measured from the release, not from the child's last move. A released child (by its parent, a column delete, or setting Needed to Now) reads "needed now" until it leaves To do.
- **Reordering columns.** *Since 1.3 (#2553).* If an admin reorders the parent's board so that a child's column now sits at or before the parent's current column, the child is released at once, as if the parent had reached it (a "parent reached" history row, no names). Any other reorder leaves it planned.
- **Renaming** the column changes nothing (the child follows the column). **Deleting** it makes the child "Needed: Now", with a history note, and releases it: its Stale clock restarts then, so a child planned for weeks does not turn Stale the moment its column goes. Setting a planned child to Now by hand does the same; a child that was already released keeps its original release time. **Unlinking** the child, or deleting the parent's board, removes the link and with it the plan, so any stored date counts at once.
- **Changing Needed by hand.** *Since 1.3 (#2549).* Card detail shows a **Needed** field on a child that is planned or waits in To do, next to its due date, which reads "Inactive while planned" while the child is planned. If you can't open the parent's board, it shows "Planned for a later stage" and offers only Now. Through the API (`POST .../cards/<id>/needed/`), this needs member access on the child's board. Choosing a column also needs member access to the parent's board, and the child must still be in its board's first column; anyone may set it back to Now. The stored date is kept either way.
- **On the parent card.** *Since 1.3 (#2551).* The parent's child footer draws planned children as dashed segments and counts them on their own ("2 planned · work moved 1d ago"); "No work started" and "Work idle" describe only the work needed now. In warning text it says "Qualify: 1 child not started" when the parent reached a child's column and the child has not started, and "1 planned date has passed: Dec 4" when a planned child's date went by.
- **History.** The child's history records each change into or out of planned: created planned, released (by the parent or by a pull, with the date that now counts), Needed changed by hand, and Needed reset because its column was deleted. These entries never name the parent, its board, its column or the person who moved it, because the reader may be unable to open the parent's board.
- **Who sees what.** Every reader of the child sees whether it is planned or needed now. The column name (`needed_at_column_name`) is shown only to someone who can open the parent's board; anyone else sees "planned for a later stage".
- **Needed now, on the card.** A child released by its parent reads "Needed now: parent is in Proposal" to someone who can open the parent, and "Needed now: the parent moved on" to anyone else. A child whose plan was cancelled, or whose parent's release was overridden (the Needed column was deleted, or Needed was set to Now), reads a plain "Needed now". Through the API, `needed_now_reason` is `parent` or `cancelled`.

## Children tab (parent side)

*Added in 1.3 (#2209).* A card on a parent board has a **Children** tab between Details and Comments, with the number of its children in the tab name. The tab is a filtered view of the child board, scoped to this card: the children stay ordinary cards on their own board, with that board's columns, colors, WIP limits and history.

- **Summary:** "2 of 5 done", the number blocked, "Work moved 1d ago" (the newest move among the children), and a bar split into done, doing, blocked, to do and planned (a dashed segment, counted "N planned" beside the summary and read "N planned for later columns" by screen readers). A child planned for a later parent column counts as planned, not to do, exactly as in the card footer; blocked and done beat planned, which beats to do. A child in a done column counts as done unless it is blocked; a blocked child is one with a manual block or an open blocking relation.
- **Add child** and **Link existing** (member on both boards). Add child opens the Add child dialog above. Link existing opens a search of the child board's cards; a card that is already a child of another parent is listed but disabled, naming that parent only when you can open its board ("already a child of a card you can't open" otherwise). With no children and no default child board, Link existing offers the boards Add child would. On an archived card both buttons stay focusable but disabled, with "This card is archived. Restore it before adding or linking children." beside them; the server refuses a link to an archived parent the same way (*#2447*), except for a card that was its child and was unlinked from it, which may be linked back.
- **The scoped board:** each column shows this card's children and how many cards the whole column holds ("1 of 9 on Delivery · limit 5"). Each child shows the child board's card face: its title, up to two labels (then "+N"), its priority in words when it is not Low, its due date (in danger text when overdue), how long it has been blocked, and its owner. Below the board, a line says how many other cards on the child board this view hides, and **Movement history of these children** opens the child board's History filtered to this card's children. **Open on Delivery** opens the child board with its Parent filter set to this card. Side by side needs a Children tab at least 800px wide; the current 540px card sheet never gives that, so it (like a phone) shows one column at a time, chosen with column buttons, with the limit line under them ("1 of 3 on Delivery are this card's · limit 4"). A column with a WIP limit also shows the child board's meter for the whole column, warning-colored when over.
- **Move:** each child has a **Move** button that opens a list of the child board's columns, with their counts. A column at its WIP limit follows the child board's WIP mode, exactly as a move on that board would: with limits not enforced it stays available and says "not enforced"; with limits enforced it is disabled with its reason, except for an admin of the child board, who can move past it ("admin override"), and the card's assignee, [when enabled](#letting-a-cards-assignee-move-it-anyway-since-13) on the child board and unless they assigned the card to themselves, who can move past it with a reason ("assignee override"); with hard limits it is disabled for everyone. The list models column WIP limits only; the child board's column weight limits and swimlane limits are checked by the server when you move, and if it refuses, the reason shows under the list. The move goes through the child board, so its limits, its movement history and its live updates apply as for any move there. Move needs member access on the child board; the parent board's role never grants it.
- **Unlink:** each child has **Unlink**, which removes the link at once and changes nothing else. A toast offers **Undo**, which links the child again (it works even if this card was archived meanwhile). Undo is offered only if you can edit cards on the child's board (Member or higher there); with Viewer access on the child's board, you can unlink but the toast has no Undo, so use the child's board to link it again.
- **Back to the parent:** a child opened from the tab shows "‹ <parent title>" in its sheet header in place of "‹ Board". It reopens this card's Children tab with focus on the same child.
- **Keyboard:** the board is one Tab stop. Arrow keys move between cards (Left and Right skip columns with none of this card's children), Home and End go to the first or last card in the column, Enter opens the card on its own board, and Escape returns to the tab list.
- **A child board you can't open:** the tab shows only "N children on a board you can't open". No title, board or column is shown.
- **Archived children** leave the tab and its counts, and return when restored.
- **Parent filter on History:** the child board's History view accepts `parent=<card id>` in its URL and shows a removable **Parent** chip. It lists only movements of that card's children; a parent you can't open lists nothing and is never named.
- **Parent filter on the child board:** on a board whose cards have parents, the Filter panel has a **Parent** row: Any, Any parent, No parent, or one parent card. It offers only parents on boards you can open; a card whose parent you can't open counts for Any parent and never for a named one. An active Parent filter adds a removable chip, travels in the board URL as `f_parent` (a card id, `any` or `none`), and is kept in saved filters. A **Parent lane** row (1.3+, #2370) narrows the board to children of parents in one lane ("Parent lane: Acme Corp"); it offers only lanes of parents you can open, adds its own removable chip, travels as `f_parent_lane` (a lane id), and is kept in saved filters.
- **Live updates:** when a child moves, is blocked or unblocked, archived, restored, linked or unlinked by someone else, the open tab re-reads its children. A screen reader hears the change once: "Pen-test scoping call moved to Doing. 3 of 5 done." for one move, "Children updated. 3 of 5 done." for anything else. The update itself names no card; the tab re-reads what you may see, so losing access to the child board turns the tab into the count-only line with nothing announced.

## Children mode

*Since 1.3 (#2370, #2550).* On a board where cards can have children, the Board tab has a **Show: Cards | Children** control beside the tabs, with the board's total ("25 in progress") next to it (on phones, the control is its own toolbar row above the tabs, and the total sits above the lanes). **Children** shows all work in progress for the whole board, child tasks included: one row per parent, grouped under its lane, with that parent's children in their real columns on the child board. Your choice is remembered per board. A shared board link has no Show control.

- **Ways in.** In Cards mode, every lane band has a **Children** action beside Focus ("Children 12 in progress", for everyone; it shows on hover and focus, and always on touch; on phones it is a button at the bottom of the lane band) that opens Children mode at that lane: the lane is open and scrolled into view, with focus on its name, and every other lane is shown collapsed. A parent card's **Children** tab ends with "All children in Acme Corp (12 in progress)", which does the same for the parent's lane.
- **Linking a lane.** `?show=children&lane=<lane id>` opens Children mode with that lane expanded and every other lane collapsed; all lanes stay on the page, and a collapsed lane loads its parents when you open it. Each lane band has **Focus** (show only this lane, press again for every lane; the same as the View menu's Lanes, and separate from the link), **Copy link** (if the browser refuses, "Couldn't copy the link" shows beside it), and for admins the `⋮` menu (Edit swimlane…, Change field order…). A lane you can't see, or one that no longer exists, is simply absent: the link opens Children mode for every lane.
- **Lane band.** The lane name, "5 parents · 2 child boards", the total ("12 in progress of 16"), a bar of done, doing, blocked and to do, "⊘ 3 blocked" (or "none blocked"), and "+4 on a board you can't open". A collapsed band shows the lane name, "5 parents" and the totals; it also says "Work idle 9d" in the warning color when nothing in the lane has moved for the board's stale threshold. Focus, Copy link and the `⋮` menu show while the lane is open. In progress means not done and not planned: a lane with planned children reads "2 in progress · 2 planned". Totals count only children you can open; children on a board you can't open, and archived children, never enter the done, doing or blocked counts.
- **Rows.** Each child board gets its own heading ("Parent · column on Pipeline", then "Children on Delivery") and its own columns, with counts against the whole column ("3 of 4 on Delivery · limit 5") and, where the column has a limit, a meter of the whole column against it. A parent row shows the parent (opens its card), its column, its owner, a bar with one segment per child and "1/6 done" (or "No work started"), plus "3 blocked" when some are; its children sit in their columns, blocked ones with "⊘ 4d". The Done column is a count ("3 done · Show"); Show turns on Show done cards and keeps focus in that cell. Rows with blocked children come first, with a red left edge, then the most recent move. A child board with fewer columns leaves the space before its Done column empty, so Done lines up across boards; its Done heading reads "Done column".
- **Planned children.** In a row, planned children fold into the To do column as "2 planned · Show"; press it again ("2 planned · Hide") to fold them back. Parents with nothing in progress, and parents whose only children are planned, fold into one button at the end of the lane: "2 parents with nothing in progress · 1 with only planned work".
- **Locked rows.** A parent whose child board you can't open shows "4 children on a board you can't open. Their columns and titles are not shown." On a desktop it is a row inside the lane's first child-board section, with the parent, its column and its owner.
- **Large lanes.** Past 8 parents, rows shrink to one line (parent, bar, count) and open on Enter or click; rows with blocked work open by default. Each row's **Open** (the parent's card) shows when you point at the row, is reached with Down from its title, and on touch shows once the row is open. Each lane loads 20 rows at a time with its own "+9 more parents · loads 20 rows at a time" button, also for a lane further down than the first rows reached.
- **Empty board.** When no card on the board has children yet, Children mode says so once: "No cards on this board have children yet."
- **Options.** While Children is shown, the **View** menu has Lanes (all or one), Show done cards, Blocked only, and Planned (Any, Hide planned, Only planned); the Cards-only View items (preset, density, layout, overlay, collapse and column controls) are absent. On phones the View options open from Filters, where Show done cards and Blocked only are switches. Children mode honors none of the Filter panel's rows, so on a desktop the Filters button, the filter bar and its chips are hidden while Children is shown (on a phone, Filters opens the View options directly), and the grid shortcuts `e`, `c`, `f` and `/` do nothing.
- **Keyboard.** Each lane's grid is one Tab stop: arrow keys move between cards and parents, Home and End go to the first and last cell of the row (Ctrl+Home and Ctrl+End to the first and last of the grid), Enter opens a card on its board or a parent's card, and Escape leaves the grid.
- **Moving a child.** If you are a member (or higher) on the child board, each child card has a **Move** action (an icon inside the card, shown on hover and focus, and always on touch; screen readers hear "Move {title}") that opens the same column picker as the Children tab, with the child board's limits and reasons. It changes the child's column only, and the child stays in whatever lane it is in now on its board, even if someone changed that lane since this view loaded; a child never changes parent here, and cards can't be dragged in Children mode. With the keyboard, press Right on a card to reach its Move action. After the move, focus stays on the card. A manually blocked card's name includes how long it has been blocked and why ("4d, blocked: IdP access").
- **Live updates.** Counts update as people work: a burst of changes is one re-read, a re-read already under way finishes before the next starts, and a card without children moving reads nothing. Rows never re-sort while you are working inside a lane's grid: a "3 changes in Acme Corp · Show" button appears instead (on phones, "3 changes · Show"), and the new order applies when you press it or move focus out of the grid. A card you have focused keeps focus when it moves; if it leaves the view, focus goes to its parent and that is announced. A child's title, assignee or column name edited on its own board appears here on the next refresh or reload.
- **Over a limit.** A child-board column past its WIP limit reads "… · limit 5 over" in the warning color.
- **On a phone.** Each lane band is tinted with the lane color and has two lines: the lane name and its total ("12 in progress of 16"), then "3 blocked" and "+4 you can't open", with the lane's actions row (Focus, Copy link and the admin `⋮`) as the band's last line, as on the phone board, while the lane is open. Children mode shows one child board and one of its columns at a time: tap a column button ("To do 5", "Blocked 2", "Done 4") or use the Left and Right arrow keys on them, and each parent appears as a heading inside that column with its children under it. A parent with nothing in the shown column says so ("Nothing blocked", "Nothing in Doing"). When a lane's parents use more than one child board, the other boards are buttons at the end of the lane, for example "Onboarding · 2 children · Columns ›", that switch the column buttons to that board. Up and Down move through the column in reading order. Nothing scrolls sideways.

## Extension sections in card details

*New in 1.3, experimental.* An installed extension (for example an Enterprise module) can add a read-only section to a card's **Details** tab, after Weight. Each section has its own heading and shows plain label and value rows. Without an extension nothing is shown, and the tab looks as it always has.

## Collapsed columns

Click the chevron at the left of a column header (it appears on hover and on keyboard focus) to collapse the column to a narrow vertical strip. When collapsed:

- The column spans the full board height across all swimlanes.
- Each swimlane cell shows the card count for that specific swimlane.
- The column header continues to show the aggregate total across all swimlanes.
- When a filter is active, any cell that contains matching cards pulses with a blue highlight and shows the match count, so hidden results are visible without expanding every column. With your operating system's "reduce motion" setting on, matching cells show a static highlight instead of pulsing.

## Columns

<a id="board-columns"></a>

Columns represent pipeline stages. Each column has:

- **Name** and **color** — a preset or a [custom color](#custom-colors)
- <a id="wip-limit"></a>**WIP limit** — maximum number of active cards allowed. The column header shows `count / limit` with a meter; when the limit is exceeded the line reads `count / limit over` in warning text and the meter turns warning-colored, so the over-limit state is visible at a distance (#963, #2270). If the board has **Enforce WIP limits** enabled (Board settings → Rules & limits), moving a card into a column at or over its limit, creating a card in it, or restoring an archived card into it returns a `409` error — board admins (or the card's assignee, when enabled) can override with `?force=true`. Enforcement is **on by default** for newly created boards; existing boards are unchanged. See [Hard WIP enforcement](#hard-wip-enforcement) for a stricter mode. Optionally, the **Show at-limit WIP indicator** board setting (off by default) surfaces the *at*-limit case too — see [At-limit WIP indicator](#at-limit-wip-indicator) below.
- **Weight limit** — maximum total card weight (story points / effort) allowed. When the limit is exceeded (and the column is not also over WIP — that state wins) the count line adds `Weight weight/limit` in warning text. If the board has **Enforce weight limits** enabled (Board settings → Rules & limits), moving, creating, or restoring a card that would push the column over its budget — or raising a card's weight so that it would — returns a `409` error; board admins (or the card's assignee, when enabled) can override with `?force=true`. Lowering a card's weight is never blocked. Enforcement is **on by default** for newly created boards; existing boards are unchanged.
- **Allow card creation** — only columns with this enabled show the add-card input; useful for marking "done" columns as write-protected
- **Done column** — mark a column as the completion target for cycle-time and throughput metrics; multiple done columns are supported (e.g. "Done" and "Released")
- **Intake column note** (since 1.3) — the board's first column that is not done is its intake column, where new work arrives. Its **Edit settings** shows a short note under the **Done column** setting: Analytics never names that column as the bottleneck, because a growing queue there is demand, not a hold-up. It still appears in cumulative flow, WIP, WIP age, dwell, and cycle-time. **More** explains why and links to [how the bottleneck is chosen](analytics.md#bottleneck). The role follows position: reordering columns, or adding a not-done column to the left of the intake column, moves it to the new first not-done column. **Add Column** tells you when the new column will take over the role.
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

By default, WIP limit enforcement is "soft": board admins can bypass a full column by appending `?force=true` to the request. The **Hard mode (no admin override)** board setting removes this override entirely. When enabled:

- Moving a card into a column at or over its WIP limit, creating a card in it, and restoring an archived card into it are blocked for **all roles**, including board admins and site admins.
- The `?force=true` query parameter is ignored. There is no bypass.
- The API returns a `409` error with `code: "wip_hard_blocked"`.
- The toast indicator uses a `⛔` icon instead of `⚠` to distinguish hard blocks from soft blocks.

Hard enforcement is **off by default**. Enable it in **Board settings → Rules & limits → Enforce WIP limits → Hard mode (no admin override)**. Toggling it on requires an inline confirmation step because the change takes effect immediately and applies board-wide.

!!! tip
    Hard WIP enforcement is useful for teams that treat WIP limits as a strict policy rather than a guideline. To unblock a column, move a card out of it or ask an admin to raise the WIP limit.

**Where limits are checked:** WIP and weight limits, soft or hard, are checked whenever a card is moved into a column, created in it, or restored into it from the archive, and weight limits also when a card's weight is raised. *Changed in 1.2 (#1428): before 1.2 only moves were checked.* Since 1.3 the same paths also check a swimlane's own limits; see [Swimlane limits](#swimlane-limits).

- [Board import](#import) is the one exception: it restores a board as it was exported, so an imported column can start out over its limit.
- When a new card or a restore is refused, the add-card field or the **Archived** tab of the Activity drawer says which limit was reached, and the card stays where it was.
- When a weight increase is refused, the card detail shows the reason under the weight control and the weight reverts.

See [Field Enforcement](../architecture/field-enforcement.md).

### At-limit WIP indicator

<span class="vb-version" title="Added in 1.2">1.2+</span>

**As of 1.3 (#2270) the column header always shows `count / limit` and a full meter at the limit, so this setting no longer changes the expanded header (it still adds the cue to collapsed columns, below).** It is kept so existing boards and the API are unchanged. Before 1.3 the column header only flipped out of its calm `N cards` state for the *over*-limit case, and the **Show at-limit WIP indicator** board setting (off by default, admin-only, in **Board settings → Rules & limits → Limit enforcement**) added the at-limit state:

- **Off (default):** a column at its WIP limit shows `N cards`, unchanged from the calm state.
- **On:** a column at its WIP limit shows `WIP N/N` in place of the card count, styled the same as the calm state (`text-fg-muted`, no accent strip, no glyph) — deliberately quieter than the over-limit warning so the two states stay visually distinct. Hovering shows the tooltip "Column is at its WIP limit (N/N)".
- **Collapsed columns (since 1.3):** with the setting on, a collapsed column exactly at its limit shows its card count in stronger text with a small `=` after it, and its tooltip reads "Expand \"Name\" · At WIP limit (N/N)", and the collapsed button's accessible name also carries the limit state (at WIP limit, over WIP limit, or over weight limit). With the setting off, a collapsed column at its limit looks like any other.
- Columns **over** their limit are unaffected: the existing `⚠ Over WIP` treatment always takes precedence.
- Columns under the limit are unaffected: always `N cards`.

This setting is purely ambient: it does not change limit enforcement, which is controlled independently by **Enforce WIP limits** / **Hard mode (no admin override)** above (#973).

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

Cards are calm so the urgent ones stand out. The bold title is the text before ` -- ` (a company name, for example) and the text after it is a subtitle at Comfortable density. Only an **overdue** card has a colored (red) border; every other card keeps a neutral border, and priority is read from the card's accessible name and the peek. The status line is the one place a card's status shows: **Overdue Nov 12** (red text, flag icon), **Stale 39d** (amber text, clock icon) or **Due in 3 days** (secondary text, flag icon). Every status carries words and an icon as well as color. **How much metadata appears on each card depends on the board's *Card density* setting** (Comfortable / Standard / Dense; see [Card density](#card-density) below). The assignee avatar sits at the end of the label row. Every [preset](#board-presets), including **Classic**, shows this same card face; a preset changes only the density.

### Card density

> **Added in 1.1** — replaces the previous per-user *hide field* toggles (Labels / Due date / Assignee / Priority badge / Last moved).

A board admin chooses one of three layouts in **Board Settings → Display → Card density**. Density does not change the swimlane band, which shows the first two lane fields at every tier (since 1.3, #2303; once a board has explicit [Show settings](custom-fields.md#choosing-where-each-field-shows-band-details-hidden), it shows its Band fields instead):

| Tier | Best for | What appears on the card face |
|---|---|---|
| **Comfortable** *(default for new boards)* | Sam-style occasional users; teams who want a clean glanceable board | One status line (Overdue · Due soon · Stale) under the details, one primary label + `+N` overflow pill, checklist progress, assignee avatar. A due date that is not overdue or due soon is not drawn: a screen reader hears it in the card's name, and the hover peek shows it |
| **Standard** | Mid-density boards — extra signal without the full wall | Adds a second label, due date (when not folded into the status line), weight pill (when `>1`), attachment count |
| **Dense** *(default for boards upgraded from 1.0)* | Power users who use every field every day | A single row: the title, a short status (*Overdue*, *Due soon* or *39d*) and the first pinned field with a value, with the assignee avatar at the end. Labels, checklist, attachments, weight, the reference link and the full due date are not drawn. A screen reader hears each of them in the card's name; the hover peek shows the due date, the labels, checklist progress, weight, attachments and the reference link, and the peek sheet and the detail panel show the labels and the due date. Priority, the description icon, the moved-N-days text and the recently-moved dot are not drawn at Dense either |

<a id="overdue"></a>**Overdue:** a card is overdue when it has a due date, that date is before today, and the card is still open: a card in a done column or an archived card is never overdue, and has no *Due soon* status either. "Today" is the date in the instance time zone (`INSTANCE_TIMEZONE`, UTC unless your administrator sets it; see [Instance time zone](../administration/configuration.md#instance-time-zone)), so a card due today is *Due soon* until midnight in that zone, then *Overdue*. The card's Overdue status line and border, the Show chips, the lane counts, the **Overdue** filter and [auto health status](health-status.md) use this rule (*changed in 1.3*, #2313: before, the card face called a card overdue from midnight UTC at the start of its due day, and kept the cue on cards in a done column). Two things still follow your personal time zone, pending #871: the due date's own label (*Due today*, *Due tomorrow*) and the **Due today** and **Due this week** filters, so around midnight a card can match neither **Overdue** nor **Due today**. The card list's `?overdue=` API filter applies only the date part, as it always has, so combine it with the column and archive filters for the full rule. The due-soon notification skips cards in a done column too (*changed in 1.3*).

!!! note "Proposed, pending owner confirmation"
    These #2313 choices are implementer proposals, not settled decisions: a done or archived card is never overdue; a card due today reads *Due soon* until midnight in the instance zone; the instance zone is served to anonymous clients on site-config.

**Status line:** it picks the most urgent of Overdue, then Due soon (within 72 h), then Stale (server-flagged from the board's staleness threshold). At Comfortable it sits on its own row under the card's details; at Standard it shares the row with labels and fields; at Dense it shortens to *Overdue*, *Due soon* or the idle days (*39d*). A card that is on track has no status line. A "Just moved" (within 24 h) cue still appears as a small badge.

### Show chips

A **Show** row above the column headers has four chips: **All cards**, **Overdue**, **Stale** and **Due soon**, each with the number of cards on the whole board. Click one to hide every card that does not match, in every swimlane and sub-column. The colored squares on a collapsed swimlane use the same colors as the chip swatches. The active chip is shown by bolder text and a blue border, not by color alone. A chip is a quick view rather than a saved filter: it is kept in the page address (`?show=overdue`, `?show=stale` or `?show=due_soon`) so you can share it, it is not remembered between visits, and it combines with the Filter panel. Column counts, WIP meters and lane counts keep counting the whole column or lane. The board totals (swimlanes, columns and cards) are shown at the right of the row. A **Collapse all lanes** button in the same row mirrors the **View** menu's **Collapse all** and **Expand all** items for swimlanes; its label changes to **Expand all lanes** when every lane is collapsed. Screen readers announce "Collapsed all N lanes" or "Expanded all N lanes" when you use it; the **View** menu's swimlane **Collapse all** and **Expand all** items, and the **Expand all swimlanes** button on the strip that appears when lanes are collapsed, announce the same "Collapsed all N lanes" or "Expanded all N lanes" message ("Collapsed all lanes" when the count is not known). <span class="vb-version" title="Added in 1.3">1.3+</span>

Fields hidden from the card face at Comfortable / Standard (weight, attachment count) still appear on the **card peek** (hover for 600 ms) as a single muted line — `Weight 5 · 3 attachments`. The full detail panel always shows everything.

**Upgrading from 1.0:** existing boards are migrated to **Dense** so they keep their compact density until an admin chooses otherwise. Per-user per-field hide preferences from 1.0 (browser-stored) are silently dropped. The board admin's setting is now the default density for everyone, unless a member sets their own personal override (see below).

#### Personal density override

<span class="vb-version" title="Added in 1.2">1.2+</span>

Any board member, not just admins, can flip **Use my own density** in **Board Settings → Display** and choose Comfortable, Standard, or Dense for their own view. This overrides the board's admin-set default without changing it for anyone else, including other admins. The override is stored in the browser (not synced across devices) and is board-scoped: turning it off, or clearing it, reverts that device to the board's admin-set default (#974). Since 1.3 a [board preset](#board-presets) you apply can set this override too, and the Display tab then says which preset set it. An override you set yourself, including one from before 1.3, is never attributed to a preset, even when its value matches one. When the board has a default preset that sets a density, turning the override off returns you to that preset's density.

Empty cells show a dashed border to indicate they are valid drop targets even when no cards are present.

### Card peek sheet

*New in 1.3 (#2273, #2358).* Hold **Shift** and click a card, or focus it and press **Shift+Enter**, to open its **peek sheet**. A plain click, **Enter** or **Space** opens the [detail panel](#card-detail-panel) as in 1.2. You can also choose **Show summary** in the card's [actions menu](#card-actions-menu), or press the **Show summary** (eye) button on the card face, which appears on hover or focus and, on touch screens, next to **⋯ More actions**. The peek sheet is a 400 px read-only sheet. It opens next to the card's column (on a stage with sub-columns, next to the card's sub-column), the same way the detail panel does (*changed in 1.3, #2507*: it used to open at the far right of the board), so the card you are reading stays in view, and it floats over the grid without resizing it. Below 1280 px, or when the card is not on screen, it sits at the right edge. At 640 px and narrower it fills the screen. Above 640 px its header has the same **Dock to edge** button as the detail panel (just left of **Close**), and the choice is shared: docking one docks the other, and it is remembered in this browser. Top to bottom it shows:

- the swimlane name and a **Close** button, then the title and a short description;
- a banner when the card is overdue (**Was due Nov 12**) or stale (**No movement for 39 days**);
- **Status**: the previous stage, the current stage (marked, with a border and bold text, not color alone) and the next stage;
- **Fields**: every custom field on the board, with **Not set** for an empty one, plus the assignee, due date, labels (**None** when the card has none; *new in 1.3*, #2391) and when the card last moved (**Never moved** for a card that has not), and, when the board has custom fields, a note such as **2 of 8 pinned to the card**;
- **Time in each column**: one segmented bar and a list of days per column, with the current column in bold. A column the card visited twice is added up;
- **History**: the card's moves, including moves between the sub-columns of a stage (*since 1.3*, #2365), newest first, each with a relative time (**39 d ago**) and the exact date and time on hover;
- **Open card** (opens the full [detail panel](#card-detail-panel)) and **Move** (a column and swimlane picker; shown to people who can edit the card).

The open card is marked on the board with the same ring as the detail panel. Click another card (or Shift+click it) to swap the peek to it; click an empty part of the board, press **Escape** or select **Close** to close it, and focus returns to the card. Only one of the peek sheet, the detail panel and the [Activity drawer](#activity-drawer) is open at a time: opening one closes the others. While the detail panel is open, clicking another card switches the panel, and Shift+click does too (it does not open the peek). Opening a card from a link, the command palette or a relation opens the detail panel directly.

### Card detail panel

<a id="checklist"></a>

Click a card to open its **detail panel** (from the peek sheet, click **Open card**; focus lands on that button when the peek opens). Where it opens depends on the window width. *Changed in 1.2 (#1914): before 1.2 the panel always opened at the right edge of the window, over a dimmed board.*

- **1280 px and wider:** the panel opens next to the card's column (on a stage with sub-columns, next to the card's sub-column), to its right if there is room, otherwise to its left. A small tail on the panel's outer edge points at the card (the panel gets a thin blue outline), and the card gets a thick blue border and ring while it is open. The board is not dimmed. If neither side has room (the panel never covers the swimlane names), the card's column is scrolled off to the side, or the card isn't on the board (for example, it is filtered out or its swimlane is collapsed), the panel opens at the right edge instead. A card scrolled out of view up or down keeps the panel next to its column; the tail then becomes a wedge near the panel's top or bottom corner, pointing up or down toward the card.
- **641 to 1279 px:** the panel opens at the right edge of the window, over a lightly dimmed board.
- **640 px and narrower:** the panel fills the screen, with a **‹ Board** button to go back.

**Dock to edge** *(new in 1.3, #1915)*: above 640 px, the panel header has a **Dock to edge** button just left of **×**. Click it to keep the panel at the right edge of the window at any width instead of next to the card's column; the button then reads **Open next to card** and shows a short underline bar, a border, and a different icon. Your choice is remembered in this browser and applies to every card you open afterward, including when you switch cards, and to the [peek sheet](#card-peek-sheet) too. The button is not shown at 640 px and narrower, where the panel fills the screen.

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
- For a soft WIP or weight limit, board admins also get a **Move anyway (admin override)** link right there, which forces the move to the selected destination (the card's assignee gets **Move anyway (assignee override)**, [when enabled](#letting-a-cards-assignee-move-it-anyway-since-13) and unless they assigned the card to themselves). Hard WIP limits have no override.

Each card belongs to exactly one column and one swimlane. Cards have:

| Field | Description |
|---|---|
| Title | Required |
| Description | Rich text with a toolbar (bold, italic, code, lists, heading, blockquote); stored as markdown. See [Card Descriptions](card-descriptions.md). |
| Priority | `low` / `medium` / `high` / `urgent`; read from the card's accessible name and the peek (only overdue cards have a colored border; no density draws a priority badge on the card) |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select; displayed on the card as truncated pills (up to 7 characters) |
| Due date | Optional date; past dates are disabled in the picker; shown on the card in the status line (for example *Overdue Nov 12* or *Due in 3 days*) with a flag icon; only an overdue card has a colored (red) border |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state, an optional assignee and due date per item, and a progress bar with a session-only **Hide completed** toggle. A line under the add-item field reads "Steps for this card only."; on a card that can have children it adds "For work with its own workflow on another board, use the Children tab." For work that needs its own workflow, or a check every card in the column needs, see [Breaking work down: which tool?](breaking-work-down.md) |
| Attachments | Files up to 10 MB (configurable via `MAX_UPLOAD_SIZE_BYTES`) |
| Comments | Threaded, visible to all board members; type `@` to mention a member; timestamps show relative time ("5m ago", "3h ago") for recent comments and full date + time for older ones |

### Card peek

<span class="vb-version" title="Added in 1.1">1.1+</span>

Hover over a card for 600 ms to open a read-only **peek popover** showing the card's description (rendered as markdown), its due date and labels (*new in 1.3*, #2391, #2399), checklist progress (`done / total`), and the last-activity timestamp. The popover closes as soon as the pointer leaves the card or any movement begins. Pressing any non-modifier key, scrolling, switching windows, or pressing elsewhere also closes it, and it never covers the toolbar or filter row. No interaction is possible inside it; click the card to open its detail panel, or Shift+click it for the [peek sheet](#card-peek-sheet). The popover footer carries the hint "Shift+click for summary".

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

Swimlanes stack. Each lane has a band showing its name and how many cards it has in this column ("2 here"); tap that line to collapse or expand the lane. A second line shows an **N fields** button when the lane has more than two fields, or **Show N more** once the board has explicit tiers (it opens the same aligned grid, one column wide), the lane's first two field values, the overdue and stale counts, the lane's [row limit](#swimlane-limits) line and the rollup total, the same as on a larger screen. Under each band are the lane's actions. **Add card** (people who can edit, in columns that allow new cards) and the health control (board admins set it; everyone else sees a set status read-only) stay in view. **Edit**, **Focus** and the lane's **Move earlier** / **Move later** rest behind a **Lane actions** button that opens closed. Board admins also get a **Column actions** button beside the column's limit line, closed the same way, which holds **Edit column** and the column's **Move earlier** / **Move later**, and **Add swimlane** and **Add column** at the end of the board. These open the same dialogs as on a larger screen. The Show chips sit in one row that scrolls sideways, and every button and card on the board is at least 44px tall.

Cards cannot be dragged at this width. Tap a card to open it, then tap **Move**, or use the **⋯ More actions** button on a selected card (see [Touch screens](#touch-screens)). Reordering, a drag on a larger screen, uses buttons instead:

- **Move earlier** / **Move later** in **Column actions** move the selected column one place (board admins).
- **Move earlier** / **Move later** in **Lane actions** move the lane one place (board admins).
- **Move earlier** / **Move later** in the card's peek sheet, and on a phone in the card detail panel a tap opens (1.3+), move the card one place within its lane and column (people who can edit). With a filter on, the step counts only the cards the filter shows, so the card always moves past a card you can see.

Each is disabled at the first or last place and saves the same way a drag does, so everyone on the board sees the new order.

At this width the header and toolbar use icon buttons. The menu button sits at the start of the app header, in the same row as the board name, **Search**, **Notifications** and your account menu, so there is no separate navigation bar above it. **Filters**, **Activity**, **Export** and **Settings** show only their icon (screen readers still announce their names). The **Filters** button also opens the View options: tap it, then **View options** in the Filter panel's heading row. Screen readers announce the button as "Filters and view options"; with a keyboard, Shift+Tab from the search box reaches **View options**, and Escape in the View options returns focus to the **Filters** button. The board toolbar is one row (1.3+): the tabs (Board, Summary, History, Analytics) scroll sideways in their own box, with **Filters**, **Activity**, **Export**, **Settings** and **More board actions** after them (**Export** shows when you can export, **Settings** for board admins). With all five buttons there, the tab box is narrow at 390px, so about one and a half tabs show at a time; swipe it or pick a tab to scroll it into view. The connection status shows on a phone only when it is not healthy (offline, reconnecting, stale), and tapping it still opens the details. The header and the toolbar together take about 92px at 390px. On phones the header no longer links from a board to its group; the group stays reachable from the navigation drawer and the group page shows its own breadcrumb. Every header and toolbar control, including **Search**, **Notifications**, the navigation menu, the filter bar, **More board actions** and the **Show all cards** and **Exit focus** banner buttons, is at least 44px tall and wide when closed. So is every control inside the panels they open: the Filter panel, the View options, the **More board actions** menu, the account menu, the navigation drawer and the notification rows. So are the filter bar's facet menus, the Activity drawer, the Board Health popover and the command palette (1.3+). The pencil beside the board name is hidden; tap the name to rename the board.

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
- **Filters** button, which opens the [Filter panel](#filter-panel) (press `f` to toggle the filter bar instead)
- **View** button, which opens the View menu
- **Activity** button, which opens the activity drawer
- The overflow menu (`...`) and the connection status, always visible

**View menu:** a panel with the display controls, in order: **Preset**, card density, card layout (Expanded or Compact), **Overlay** (the select reads its current value, "None" by default), **Collapse all** / **Expand all** for swimlanes, **Hide all** / **Show all** for columns, a **Show sub-columns** checkbox (only on a board with a gated stage), an **On the card** line naming the fields pinned to the card face with a **Change** link that opens Board settings on Card fields (board admins only), and **Show archived cards**. Press Escape to close an open picker first, then the panel. Screen readers announce the bulk lane and column items: "Collapsed all N lanes" / "Expanded all N lanes" and "Hid all N columns" / "Showed all N columns" ("1 lane", "1 column" in the singular, and no number when the count is not known).

**Export and Settings buttons:** to the right of Activity, **Export** (shown when you are allowed to export) and **Settings** (board admins) open the export dialog and Board settings. On a phone they show only their icons. The shortcuts are `⌘⇧E` and `⌘,`.

**Overflow menu (`...`):** lists Export board, Board settings and Keyboard shortcuts. To replay the onboarding tour, use **Restart tour** in the keyboard shortcuts overlay or **Restart onboarding tour** in Settings. A small first-run dot marks the menu until you open it.

## Card layout

The **Card layout** control in the toolbar's **View** menu switches between two card display modes:

| Mode | Description |
|---|---|
| **Expanded** (default) | Full card face with title, label pills, assignee avatar, checklist progress, and a status line (only an overdue card has a colored border) |
| **Compact** | Narrower cards showing the title, the assignee avatar and a blocked marker only; an overdue card adds a flag. On a board set to Dense density a priority badge and the recently-moved dot also appear. Useful on boards with many cards per cell. An aging card's title starts with a small bar meter that shows its aging step, since compact cards have no status line (see [Card aging tint](card-history.md#card-aging-tint)) |

The preference is stored per user in `localStorage` under the key `user:prefs:card-layout` and persists across boards and sessions. The control's `aria-pressed` state reflects the compact layout for screen reader users.

## Filter panel

The toolbar's **Filters** button opens a panel with:

- A **Search fields and values to filter** box (focused on open; **Esc** clears it, then closes the panel) and three scope chips, **All fields**, **Card fields** and **Swimlane fields**. Type a field name to see **Fields matching** it, or the start of a value to see **Values matching** it: each value row reads, for example, "Region is EMEA" with how many cards or lanes hold it (select it to add that filter). A swimlane field that is set to **Hidden** on the band still appears, marked "(hidden on band)", and every field is searchable whatever its band setting. Admin-only swimlane fields appear only for board admins. Type `field:value` (for example `tier:gold`) and press **Enter** to jump straight to that value. The last value row, **Title contains**, searches card titles and descriptions. Use the up and down arrow keys to move through the results and **Enter** to add one; the footer reads "↑↓ to move · Enter to add · field:value to jump". Selecting a swimlane field row opens the Lanes popover on that field's rule, adding one if the field has none. Field types are named as in board settings (Dropdown, Multi-select, and so on), a checkbox lane field shows its rule as Yes or No, and the **Title contains** row shows how many cards have the text in their title or description. With the box empty the panel shows one row per field, as below.
- One row per filterable field: **Assignee**, **Label**, **Priority**, **Due date**, **Blocked**, **Parent** (on a child board with linked cards; 1.3+), **Lanes** (when the board has a swimlane field you can filter on, two or more lanes, or a lane filter set) and each custom field. A row shows its current value, or **Any** when it is not filtering. Click a row to expand its choices in place; only one row is open at a time. A number field's row also has an operator menu (**equals**, **between**, **at least**, **at most**, **is empty**, **has a value**; 1.3+): see [Number filter operators](custom-fields.md#number-filter-operators).
- A **Filtered by** row at the top while any filter is active: one chip per active filter (click the **x**, or focus a chip and press Enter, Space or Delete, to remove it), **Clear all**, and **Save filter**, which asks for a name and saves like the filter bar does. Lane rules appear as **Lanes** chips.
- Your **saved filters**. Click one to load it and close the panel. Deleting stays in the filter bar.
- A footer button, **Show filter bar** (or **Hide filter bar (F)**), for search, scope, **My cards** and saving a filter.

The **Lanes** row closes the panel and opens the lane filter rules. Escape closes the panel and returns focus to the Filters button. The panel edits the same filters as the filter bar, so a change in one shows in the other and in saved filters. Most filters also show in the page address; **Sub-column** and **Track state** do not (see [Sub-columns and tracks](#sub-columns-and-tracks-13)). Pressing `f` still toggles the filter bar, not the panel. While the filter bar is shown, a chevron at its right end (**Hide filter bar**) closes it in one click and returns focus to the Filters button. Hiding the bar does not clear filters: they keep applying, and the Filters button keeps its count.

## Filtering

Click **Filters** in the toolbar to open the [Filter panel](#filter-panel), then choose **Show filter bar** in its footer to open the full filter bar. Press `f` to toggle the filter bar directly. Press `/` to open it and focus the search input at once. Filters apply client-side (no round-trip) and stack: all conditions must match.

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

On a board with many swimlanes (one per account, say), **Lanes** in the filter bar hides the lanes whose name, contact email, health status, or own [swimlane field](custom-fields.md#swimlane-row-custom-fields) values don't match your rules. Card filters still apply inside the lanes that remain; the two are combined with And.

1. Click **Lanes** to open the rule builder, then **+ Add filter**.
2. Pick a field, then a value or range. The field list starts with three **built-in** fields ([#2336](https://gitlab.com/visiban/visiban/-/issues/2336), [#2247](https://gitlab.com/visiban/visiban/-/issues/2247)), **Lane name**, **Contact email** and **Health**, then the board's swimlane fields in board order; when both kinds are listed they sit under **Built-in** and **Custom fields** headings. If a swimlane field has the same name as a built-in, the built-in reads, for example, **Lane name (built-in)**.
    - **Lane name** and **Contact email**: the same five text operators as a text field, for example *Lane name is Acme Corp* or *Contact email contains @acme.com*. **Contact email** is offered to board admins only (see below). A lane with no contact email never matches **is**, **contains** or **matches wildcard**, and always matches **is not** and **does not contain**.
    - **Health** ([#2247](https://gitlab.com/visiban/visiban/-/issues/2247)): **is** or **is not** one of **On track**, **At risk** and **Off track**, or **is set** / **is empty** (no value to pick). The filter reads the [health status](health-status.md#lane-status) its header shows: the lane's own status if set, else the status computed by [auto health](health-status.md) on a board that uses it. A lane with no status matches **is empty** and **is not**, and fails **is** and **is set**. Every board role can use it.
    - **Dropdown** fields: **is** or **is not** a choice.
    - **Checkbox** fields ([#2438](https://gitlab.com/visiban/visiban/-/issues/2438)): **is Yes** or **is No**. A lane with no value counts as **No**, as it does for card filters.
    - **Multi-select** fields ([#2438](https://gitlab.com/visiban/visiban/-/issues/2438)): **is** or **is not** one choice, matched against whole entries (*Pricing regions is EMEA* does not match a lane whose only entry is "EMEAx"). To match any of several choices, add one rule per choice and join them with **Or**. A lane with no value fails **is** and passes **is not**.
    - **Number** and **Date** fields: **between** two values. Leave either end as **Any** for "or more" / "up to" (numbers) or "on or after" / "on or before" (dates). Both ends are inclusive.
    - **Text** and **URL** fields ([#2226](https://gitlab.com/visiban/visiban/-/issues/2226)): **is** or **is not** one of the values your lanes already carry for that field (listed alphabetically), or one of three operators that take text you type (up to 500 characters): **contains**, **does not contain**, and **matches wildcard**, for example *AE is Ethan Ross*, *AE contains ross*, or *AE matches wildcard Ethan\**. Matching ignores case and leading or trailing spaces. See [Text operators and wildcards](#text-operators-and-wildcards). A value no lane carries any more (from a saved filter or a shared link) stays in the list, marked "(no lane has this)", until you change it. An empty text box is an incomplete filter.
3. Add more filters, or **+ Add group** to bracket several together. Between every two filters or groups, an **And / Or** toggle sets how they combine. **And** binds tighter than **Or**, the way it does in arithmetic, and groups go one level deep.
4. The **Reads as** line spells out the result in words, for example: *Reads as: (AE is Priya and Deal value 50,000 or more) or Client Director is Jo*.

Rules apply as soon as they are complete; **Done** just closes the builder. A filter with no value yet is ignored (the Reads as line counts it as an incomplete filter), so a half-built rule never hides anything.

- **Lanes with no value:** a lane with no value for the field, or a value that isn't a valid number or date, fails **is**, **contains**, **matches wildcard**, and **between**, and passes **is not** and **does not contain**.
- **Admin-only fields**, and the built-in **Contact email**, are offered only to board admins. Their values are never sent to other roles, so members and viewers can't filter on them. For them, a rule on one (from a saved filter or a shared link) is dropped as if it were not there: the remaining rules still apply, so the result can show more lanes or, when the dropped rule was one side of an **Or**, fewer.
- **Every swimlane field type** can be filtered on, whatever its [Show setting](custom-fields.md#choosing-where-each-field-shows-band-details-hidden): Band, Details or Hidden. **Lanes** is shown when you can see a swimlane field it can filter on, when the board has two or more lanes, or when a lane filter is already set (so you can clear it).
- **Chips:** each complete filter or group shows as a chip tagged **Lanes**, joined by "and" / "or". A checkbox rule reads *PCI in scope: Yes*, and a multi-select rule *Pricing regions: EMEA* (or *Pricing regions: not EMEA*). Dismissing a chip removes that filter or group. The **Lanes** button shows how many rules are active; the Filters badge and **Clear all** count all lane rules together as one filter.
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
| `?f_parent=` | [Parent card](#children-tab-parent-side) (1.3+): a parent card id, `any` or `none`. A malformed value is ignored |
| `?f_parent_lane=` | Parent lane (1.3+, #2370): a lane id on a parent board. A malformed value is ignored |
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
| **Classic** | The board's own [card density](#card-density) and no overlay. There is no separate Classic look: the redesigned board is the board in 1.3, so the only visible difference between the two presets is density (Classic keeps the board's own, Default uses Standard). A board with no preset looks the same as Classic. |
| **Default** | Standard density and no overlay. |

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

With no board default (the setting for every board created or upgraded before 1.3) and no link, the board uses its own card density with no overlay, the same as choosing **Classic**. Choosing the board default yourself clears your personal density and overlay choices for that board, so you follow the board default again if an admin changes it later, in an open tab as after a reload. A preset you chose that is not the board default stays yours when the board default changes. Each board keeps its own preset: moving to another board never carries one over.

## Board states

- **Loading:** a skeleton of column headers, a lane band and cards, announced to screen readers as "Loading board".
- **No cards yet:** the column headers stay, and below them a panel says "No cards yet" with **Add a card** for people who can add cards and **Import cards** for people who can create boards in the board's group. **Import cards** opens the group's import dialog, which imports a file as a new board in that group. The sentence leaves out what you can't do: "Add the first card to Prospect, or import cards from a file." when you can do both.
- **Filters or a Show chip match nothing:** on a desktop each swimlane shrinks to its band, reading **No matching cards** (on a phone each lane's empty note reads **No matching cards in** the column name while a filter is active, and the line below sits above the lanes), and below the lanes a line names the cause: the chip ("No cards are due soon", "No cards are overdue", "No cards are stale") when the chip alone empties the board, or "No cards match the active filters" otherwise. **Show all cards** clears the card filters, the selected saved filter and the Show chip; it keeps your lane filters, including **Hide lanes with no matching cards**. With **Hide lanes with no matching cards** on, the bands are hidden and only the line shows. This never shows on an empty board, which shows only "No cards yet" (unless lane filters hide every lane; then "No lanes match your lane filters" takes precedence), or when lane filters, together with **Hide lanes with no matching cards**, hide every lane while some card matches, which shows "No lanes match your lane filters" with **Clear lane filters**. When no card matches, the line and **Show all cards** show instead.
- **Offline:** while the live connection is down, the banner reads "Offline. Reconnecting. Moves are paused until the board is live again." and the connection status in the toolbar reads **Offline**. Moves are paused so a move never lands on a board that other people changed meanwhile: you cannot drag cards, columns or lanes, and **Move to…** (card menu, ⌘K and bulk toolbar) and **Move** (card details and the card peek) are disabled with "Moves are paused while the board is offline" written beside them. Everything else still works. If reconnecting gives up, the banner reads "Offline. Live updates are off and moves are paused. Reload the page to reconnect."
- **Dragging:** the card you drag tilts and casts a deep shadow (no tilt or lift with reduced motion), and its place in the cell stays dimmed. The cell under it gets a blue dashed edge, and a dashed placeholder after the last card shows where it will land; a cell that would put a column or lane over its limit turns amber instead and names the limit.
- **Load error:** "The board didn't load." with **Try again**, which fetches the board again without reloading the page.
- **Keyboard:** every way of moving a card by dragging has a keyboard equivalent, with no new shortcut keys. Focus a card and press <kbd>Menu</kbd> or <kbd>Shift+F10</kbd>, then choose **Move to…**: **Move earlier in this cell** and **Move later in this cell** reorder the card one place among the cards shown in its cell (each appears only when there is a card that way), and the columns below them move it to another column. To change swimlane, open the card and use **Move** in its details. Select several cards with the checkbox on each card and use **Move to…** in the bulk toolbar, which moves them to a column. In a column split into sub-columns, **Move to…** lists each sub-column ("Discovery: Ready") and adds **Move on to** and **Move back to** steps; see [Sub-columns and tracks](#sub-columns-and-tracks-13).
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

When a move left a stage with sub-columns open, or entered a stage past its first sub-column, the row adds a note after the destination, for example "· left 2 sub-columns early, entered at sub-column 2". The card's **History** tab shows the same note.

#### Filters

All filters are URL-synced and persist across page reloads.

| Filter | Description |
|---|---|
| **Swimlane** | Limit results to cards currently in a specific swimlane |
| **Column** | Limit results to movements whose destination was a specific column |
| **User** | Limit results to movements performed by a specific member ("moved by") |
| **Parent** | *(new in 1.3, #2209)* Limit results to movements of the children of one parent card. Set from a parent card's Children tab (**Work moved**); it is carried in the History URL as `?parent=<card id>` |
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

## Board settings

Open **Settings** in the board toolbar (or press `⌘,` / `Ctrl+,`). Board settings has a left sidebar of sections, grouped:

| Group | Sections |
|---|---|
| Board | Display, Rules & limits |
| Fields | Card fields, Field sets, Swimlane fields |
| Access | Members, Sharing (admins) |
| Integrations | Webhooks (admins), Issue lens (admins, when enabled) |
| Data | Export, Danger zone (admins) |

Use the Up and Down arrow keys to move through the sidebar and Enter to open a section; Tab then moves into the section's panel. On a phone the sidebar is a **Section** menu above the panel.

**Find a setting.** Type in the box at the top (for example `export`, `WIP` or `stale`). Matching settings are listed under it; press Enter or click one to open its section and highlight the control. If nothing matches, the box says so. Escape clears the search.

**Export** holds the export format and button, the export permission (who can export) and the export history. **Issue lens** and **Danger zone**, which used to share the Data tab, are now their own sections.

## Export & import

### Export

Click **Export** in the board toolbar (or press `⌘⇧E` / `Ctrl+Shift+E`) to download the board data. The same export is in **Board settings → Export**:

- **JSON** (recommended) — full board structure including columns, swimlanes, labels, and cards with comments, checklists, assignee, movement history (History tab), and activity log. Use JSON for backups, migrations, and any situation where full card history must be preserved.
- **CSV** — one row per card with columns for ID, title, description, column, swimlane, priority, assignee, labels, due date, weight, dates, and movement history. Cards are imported without movement history or activity log. Use CSV when you need the data in a spreadsheet.

> **Added in 1.1** — export permission threshold and audit history (#842, #843)

By default, any board member can export. Admins can raise the threshold per board under **Board settings → Export → Export permission** to restrict exports to collaborators, members, or admins only; owners and site admins always bypass it. The threshold limits only the export action and file formats; it does not change what members can read on the board.

Below the threshold, the **Export** button is hidden and direct API calls return `403 export_restricted`. The export endpoints are:

- `GET /api/v1/boards/{id}/export/` — CSV
- `GET /api/v1/boards/{id}/export/?format=json` — JSON

#### Export audit history

Every successful export is recorded in an audit log capturing the actor, the role they held at export time, the format (`csv` / `json`, or `movements_<format>` for movement-history exports, shown as "Movements (CSV)"), and the number of rows exported (cards for a board export, movements for a movement export). Admins can review the log under **Board Settings → Export → Export history**, or via `GET /api/v1/boards/{id}/export-history/` (admin-only). Failed exports (permission denied, rate limited) are not logged. A CSV download that is interrupted partway is still listed, because part of the board was delivered; its row count is then the board's card count.

This per-board export log is a data-exfiltration safeguard scoped to individual board admins, and it is part of the open-source core. It is intentionally distinct from the site-wide, compliance-oriented **audit log** in Visiban Enterprise, which records administrative activity across the whole instance.

### Import

Click **Import** on Home to create a new board from a previously exported Visiban JSON or CSV file. The import atomically creates a new board with all structure (columns, swimlanes, labels) and cards.

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

- If a board with that name already exists in the same place (the group you import into, or — without a group — any board you can access that is not in a group, as listed under **All boards** with the **Personal** filter), a number is added: **Imported: Q3 plan - 1**, then **- 2**, and so on.
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

- It counts cards, comments, checklist items, labels on cards, and history entries (movements, activity entries and, since 1.3, block and gate history together), and, since 1.3, card relations. Label definitions that no card uses are not counted, so leaving **Labels** out of a file whose labels are unused shows no notice.
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

<span class="vb-version" title="Added in 1.3">1.3+</span> The first time you open the drawer on a board, the **Recent** tab loads the board's saved card moves and creations from the last 7 days, newest first, and then adds new board events as they happen. Until then the tab shows "Loading activity…". If the load fails, a "Couldn't load earlier activity" line with a **Retry** button appears above any live events, and **Retry** loads it again. "No activity yet" means the board has no moves or creations in the last 7 days and nothing has happened since you opened it. Membership changes appear only as they happen, and archiving and unarchiving are not listed (the **Archived** tab and the **History** view show them). The drawer holds the 100 most recent rows. When a busy board has more than that and the window you're viewing reaches back past the oldest one, a note under the list says so; the **History** view has the full record.

<span class="vb-version" title="Added in 1.3">1.3+</span> The drawer has two tabs: **Recent** (the recent board events described here) and **Archived** (the board's archived cards, with **Unarchive**; see [Card archiving](card-archiving.md#viewing-archived-cards)). Press <kbd>Y</kbd> or choose **Show archived cards** in the **View** menu to open the drawer straight on the Archived tab. The drawer and the card detail sheet are never open together: opening one closes the other.

<span class="vb-version" title="Added in 1.3">1.3+</span> Each Recent row shows the actor's avatar, the card title, what happened beneath it (for a move, "Qualified to Discovery"; "Created" for a new card) and the time on the right. Membership events show the person's name with "joined the board" or "was removed from the board". The sentence "Live · board events" no longer appears under the title.

The **Filter** button beside the tabs opens a small panel with two choices. Select a choice with the mouse or with <kbd>Tab</kbd> and <kbd>Enter</kbd>; <kbd>Escape</kbd> closes the panel and returns focus to the button (a second <kbd>Escape</kbd> closes the drawer):

- **Kind**: *All*, *Moves* (includes creations), *Members*
- **Window**: *1h*, *24h*, *7d*. It defaults to **24h** so the drawer stays focused on today's activity rather than all history. Widen to **7d** to scan back through the week, or narrow to **1h** for what's happened in the last hour. <span class="vb-version" title="Added in 1.3">1.3+</span> If nothing happened in the last 24 hours but something did in the last 7 days, the drawer opens on **7d** instead and says "Nothing in the last 24 hours. Showing the last 7 days." It does this once, when the saved activity loads, and never after you pick a window yourself (picking *24h* keeps *24h*). When the window you picked is what empties the list, the drawer says so ("No activity in the last 24 hours") and offers **Show the last 7 days**.

While either choice differs from its default (*All* and *24h*), the button is highlighted and shows how many are active, so a filtered feed is never mistaken for a quiet board.

The drawer is a live summary, not the canonical audit trail. For the full ordered history with no window filter, click **Open the full History view** at the bottom of the drawer (also reachable from any card's **History** tab — see [Card History](card-history.md)).

## Board sharing

> **Added in 1.0**

Board admins can generate a public read-only link that lets anyone view the board without signing in.

### How fresh the public view is

> **Added in 1.3** (#1965)

The board an anonymous visitor sees is cached for up to 15 seconds, which keeps a widely shared link from loading the database on every visit. A change to a card, column, swimlane or label shows on the next visit after it is saved. A change that does not announce itself to the board's live feed, and time-based fields such as a card turning stale, can lag by up to the cache window.

The cache never keeps a link alive: turning sharing off, rotating the link, its expiry, and the enabling admin losing admin standing or being deactivated all take effect on the very next visit. Operators can change the window with the `SHARE_BOARD_CACHE_TTL_SECONDS` environment variable (a whole number of seconds; `0` or a negative value turns the cache off; on Helm set `backend.settings.shareBoardCacheTtlSeconds`; see [Configuration](../administration/configuration.md#variables-documented-on-other-pages)). For a board that is shared widely and read far more often than it changes, leave it on.

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

A column split into sub-columns (1.3+, #2366) shows each sub-column's name and card count under the column name, and its cards sit in their own sub-column of the cell, side by side with a dashed divider. The stage's tracks are listed by name under the header. The public view shows track names only, never a card's track state, so a visitor sees which tracks the stage has but not which are done.

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

## Sub-columns and tracks (1.3)

<a id="sub-columns-and-tracks"></a>

A column can be split into ordered **sub-columns** (#1102), and it can show **tracks**: checks that can finish in any order (#1920). If the order of the checks matters, use sub-columns. If it doesn't, use tracks. Both apply to every card in the column; for one card's own to-dos, use its checklist. [Breaking work down: which tool?](breaking-work-down.md) compares all five options.

**Sub-columns.** A stage has no sub-columns or 2 to 4 of them. On the board it takes one column's width per sub-column, with one drop area per sub-column and a dashed line between them. An empty sub-column in a populated stage shows its own name, and the sub-column under a dragged card shows its name too. The column header adds one row with a cell per sub-column, lined up with those dashed lines: the name in bold (up to two lines) above its count (screen readers hear "Doing: 5 working"). Working sub-columns show the bare count, and the last shows "N waiting". One WIP limit covers the whole stage. To move a card between sub-columns, drag it, or open the card menu (Menu key or Shift+F10), choose **Move to…** and pick "Move on to <next>" or "Move back to <previous>".

- A card that enters a stage starts in its first sub-column, unless you drop it on a later one.
- A card can leave a stage before its last sub-column. The move is never refused: whichever way you move it (drag, the card menu, the bulk toolbar, the card peek or **Move** in the card's details), you get a warning that screen readers announce ("Left Discovery in Doing, before Ready"), and the card's history notes it ("left 1 sub-column early").
- **Move to…** in the card menu and the bulk toolbar, and **Move** in the card's details, list every sub-column of a gated stage. Picking a plain column, or moving a card some other way without picking a sub-column, places it in the stage's first sub-column.
- **View → Show sub-columns** turns the split view off on your browser. Each gated stage then shows at normal width, and each card shows a progress bar for its sub-column. The checkbox only appears on a board that has a gated stage.
- At phone width, a gated stage adds a row of sub-column buttons under the column picker, each with its card count. An empty sub-column says "Empty". With **Show sub-columns** off, the buttons are gone and the stage lists all its cards.
- The card peek's **Move** lists every sub-column of a gated stage ("Discovery: Ready"), so you can move a card to another sub-column from there too. On a phone, **Move earlier** and **Move later** step within the card's own sub-column.

**Tracks.** Each track on a card is shown as a chip: a check mark for done, an empty circle for open, or a dash for not applicable. The chip's icon and fill both change, so the state does not rely on color. At phone width, the chip also says the state in words ("Technical: done"). A track's value is set like any other custom field, in the **Custom fields** section of the card detail panel. A chip is not a control you can tick: its tooltip and a line that screen readers read before the chips say "set in the card's Custom fields". Two visible lines say the same: "Set in the card's Custom fields." under the tracks in the card peek, and "Tracks show as chips on the card." at the top of **Custom fields** in the card detail (*since 1.3*, #2542). Tracks don't appear in the peek's field list. Since 1.3 (#1922) a board admin can pin up to 3 dimensions as chips under the title; a dimension that is a track of the card's column shows once, as its track chip. See [Dimension fields](custom-fields.md#dimension-fields-13).

<a id="stage-settings"></a>**Stage settings.** Board admins open them from the column menu: **Stage settings…** (or the **Stage** tab of the column settings). On a phone, the **Column actions** menu has a **Stage settings** button. The tab opens with one line defining the term: "A stage is a column. This tab holds its sub-columns and tracks." Each section's helper line says it applies to every card in the column; the tracks line adds "For one card's to-dos, use its checklist."

- **Sub-columns, in order:** rename, add (up to 4), remove or reorder them. Use the ↑ and ↓ buttons beside a sub-column to move it. Its cards move with it and stay in that sub-column, and the move is not recorded as a card passing or reopening a step. Removing a sub-column moves its cards back to the sub-column before it. Reorder and remove in separate saves: a save that does both is refused, and the arrow buttons are unavailable while a removal is waiting to be saved.
- **Tracks, any order:** **Add track** creates a dropdown field with the choices "Done" and "Not applicable". You can also add a track field that already exists. Edit a track's name in place to rename it: this renames its field everywhere it is used, and every card's value and swimlane exception for it stay. A track name can't be empty or match another track or field on the board. Removing a track only takes it off this stage; the field and its values stay.
- **Swimlane exceptions:** mark a track not applicable for every card in a swimlane, for example "APAC: Business is not applicable". The card's own value is kept. On the card, such a track reads "not applicable for this swimlane".
- Before you save, the tab lists what happens to cards in a sub-column you removed, for example "3 cards will move from Review back to Doing." The count comes from the server and includes archived cards, which move too ("3 cards (1 archived) will move…").
- **Save stage** saves all three groups at once. It saves only the Stage tab. With no unsaved Settings or Policy changes it closes the dialog. With some, the dialog stays open and says "Stage saved", so you can save those changes from their tab or cancel them. If the board's swimlanes can't be loaded, the Stage tab says so and can't be saved.

Not in this release: a rule that every track must be done before a card reaches the last sub-column, and blocking a card from leaving a stage before its last sub-column (#1102, #1920).

### Filtering by sub-column and track state

<span class="vb-version" title="Added in 1.3">1.3+</span>

When the board has a gated stage, the **Filter** panel gains a **Sub-column** row listing every sub-column as "Stage: Sub-column". When any stage has tracks, it also gains a **Track state** row with **Done**, **Open** and **Not applicable**. Pick one or more in either row; each pick adds a chip you can dismiss, like any other filter.

- **Sub-column** shows only cards currently in a picked sub-column. Cards on a plain stage are hidden while it is active.
- **Track state** shows a card when at least one of its tracks on its own stage is in a picked state. A lane's not-applicable exception counts as **Not applicable**.
- Both combine with every other filter, are remembered per board, and are saved with [saved filters](saved-filters.md). Not kept in the page address; a shared filter link does not carry them.



### Letting a card's assignee move it anyway (since 1.3)

By default only board admins can use **Move anyway** past a WIP or weight limit in Block mode. A board admin can turn on **Let a card's assignee move it anyway** (Board settings › Rules & limits › WIP & weight limits). The card's assignee can then move it past a Block limit too, with a reason, unless they assigned the card to themselves. Hard limits still stop everyone.

Every override is recorded in the card's history with who did it, on what basis (admin or assignee) and the reason. The reason is visible to everyone on the board. Turning the switch on or off, and changing any WIP or weight enforcement setting, is recorded too.
