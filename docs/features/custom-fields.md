# Track your own fields on cards and swimlanes

<a id="custom-fields"></a>

<span class="vb-version" title="Added in 1.2">1.2+</span>

Board admins define typed fields in **Board Settings → Card fields** (or **Swimlane fields**). Everyone then fills them in on the card or row.

**Why it matters:** A label is an untyped tag; a custom field is a named key with a type. Use fields for what the built-in card fields don't cover: sprint, budget, region, array type, anything.

**The big picture:** two independent flavors, scoped to different objects.

- **Card fields:** described on the rest of this page.
- **Swimlane fields:** described in [Swimlane (row) custom fields](#swimlane-row-custom-fields). The two are separate per-board schemas. A board may define a card field and a swimlane field with the same name, and they are never merged or compared.

**By the numbers:** up to **30 card fields**, with up to **2 of them pinned** to the card face. Swimlane fields have smaller caps; see [Swimlane (row) custom fields](#swimlane-row-custom-fields).

**Yes, but:** `is_required` isn't enforced ([#1433](https://gitlab.com/visiban/visiban/-/issues/1433)) and filters match exact values only ([#1847](https://gitlab.com/visiban/visiban/-/issues/1847)). See [Limitations in this release](#limitations-in-this-release).

## Field types

Seven types are available:

| Type | Glyph | Stored as | Notes |
|---|---|---|---|
| Text | `Aa` | Free text | No length limit enforced client-side |
| Number | `#` | Numeric string | No range validation |
| Date | `📅` | ISO date | Rendered with a calendar picker; shown in your **Date format** preference (Settings → Profile) on cards, in the editor, in filter chips, and in swimlane row fields; the browser's native date picker keeps its own locale. The stored value and exports stay `YYYY-MM-DD` |
| Dropdown | `▾` | One of a fixed list of choices | Requires at least one choice |
| Checkbox | `☑` | `true` / `false` | Displayed as **Yes** / **No** |
| URL | `↗` | A web address | Must start with `http://` or `https://` (a bare `example.com` gets `https://` added for you); at most 500 characters. See [URL fields](#url-fields) |
| Multi-select | `☰` | Any number of a fixed list of choices | Requires at least one choice. See [Multi-select fields](#multi-select-fields) |

---

## Managing card fields (Board Settings → Card fields)

!!! note "Tab renamed in 1.2"
    This tab was named **Fields** before 1.2. It was renamed to **Card fields** when [swimlane fields](#swimlane-row-custom-fields) shipped, so the two tabs read unambiguously side by side.

Open **Board Settings** and select **Card fields** (alongside Members, Display, Rules, Sharing, and, since 1.2, Swimlane fields). Only board admins can create, edit, reorder, pin, or delete fields.

The tab lists every field in display order with its type glyph, name, type label, and pin state. Hover a row for **✎ Edit** and **✕ Delete**. Drag the `⋮⋮` handle to reorder, or use the keyboard: Tab to the handle, press Space to pick the field up, press the arrow keys to move it past its neighbors, and press Space to drop it (Escape cancels). That order is the order in the card detail panel and, for pinned fields, on the card face.

### Adding or editing a field

Click **+ Add field**, or **✎** on a field, to open the inline editor:

- **Field name:** required, unique on the board
- **Type:** one of the seven types, chosen from a row of buttons
- **Help text:** optional hint shown next to the input wherever the field is edited
- **Format** (number only): optional **Prefix**, **Suffix**, and **Decimals**; see [Number formatting](#number-formatting)
- **Choices** (dropdown and multi-select): add rows with **+ Add choice**, drag to reorder, or click **Paste a list** to bulk-add from a block of text in one step. Each line becomes a choice, and so does each cell of a row copied from a spreadsheet; choices already in the list are skipped, and **Add N choices** counts only the new ones. Text still in the paste box when you click **Save field** is added too, and closing the box with text still in it adds that text to the choices instead of holding it aside. The round swatch in front of each choice sets its color; see [Choice colors](#choice-colors)
- **Pin to card face:** toggle to show this field's value on the card face; see [Pinned fields on the card face](#pinned-fields-on-the-card-face)

Click **Save field** to commit, or **Cancel** to discard.

!!! warning "A field's type locks once it holds a value"
    Once any card on the board has a stored value for a field, the API blocks changing that field's type. If you try, the editor tells you why and what to do instead: add a new field of the type you want, then delete the old one. **Deleting a field permanently deletes all of its values.** They can't be recovered. A brand-new, unsaved field has no values yet, so its type can be changed freely.

    To delete a field from its editor, click **Delete field** at the bottom left. It opens the same type-the-name confirmation as the ✕ on the field's row. Only admins can edit or delete fields.

### Field limits

The tab header shows a running count, for example `12 of 30 · 1 of 2 pinned`.

- At **28–29 fields**, a warning line shows how many fields are left before **+ Add field** locks out.
- At **30 fields**, **+ Add field** is disabled with an inline explanation. Delete a field to make room.

### Pinned fields on the card face

Up to **2 fields per board** can be pinned so their values show on the card face without opening the card. Toggle **Pin to card face** in the field editor, or click **Pin** on a field's row.

Pinning a third field opens a swap prompt naming the 2 pinned fields; pick which to replace. Unpinning doesn't delete data: unpinned values stay visible in the card detail panel and in the [hover peek](#hover-peek).

### Deleting a field

Click **✕** on a field's row, or open the field's editor and click **Delete field**. Deleting is permanent: it removes the field definition **and every card's stored value for it**. To confirm, type the field's exact name into the dialog.

!!! danger "This cannot be undone"
    There is no way to recover a deleted field's values. If you only want to stop showing a field on the card face, unpin it instead of deleting it.

### Viewing fields as a non-admin

Members, collaborators, and viewers see a read-only list of the board's fields (name, type, and pin status) with a banner explaining that only board admins can add or edit fields.

---

## Custom fields on the card face

Pinned values render as small bordered chips in the card's metadata row, alongside labels and checklist progress, as `Field name: value`.

- **Dropdown:** a small color dot before the value, or, if an admin gave the choice a color, a tinted badge (see [Choice colors](#choice-colors)).
- **Checkbox:** **Yes** or **No**.
- **URL:** just the site's hostname (for example `wiki.example.com`) as a link.
- **Multi-select:** up to two picks as small chips, with a `+N` marker for the rest (hover it to see them all).
- **Long values:** truncated with an ellipsis; hover the chip for the full value.

**Unset pinned fields:** hidden at **Comfortable** and **Standard** card density (see [Card density](board.md#card-density)) to keep the face uncluttered. At **Dense** density they show as a dashed "ghost" chip, so power users always see the full set of pinned fields.

### Quick edit from the card face

Checkbox and dropdown chips are editable without opening the card. Click a checkbox chip to toggle it; click a dropdown chip to open a popover and pick a value. A dotted underline under the value marks it editable, always visible rather than only on hover.

Text, number, date, URL, and multi-select fields are not quick-editable; edit them in the card detail panel. Clicking a URL chip's hostname opens the link in a new tab without opening the card.

---

## Custom fields in the card detail panel

A collapsible **Custom fields** section (below Labels, above Weight) lists every field on the board, not just pinned ones, each with its own typed input:

- **Text:** plain text input
- **Number:** numeric input
- **Date:** calendar picker
- **Dropdown:** select from the field's choices
- **Checkbox:** toggle
- **URL:** web address input; saves when you leave the field or press Enter (see [URL fields](#url-fields))
- **Multi-select:** a checklist of choices; saves when you close it (see [Multi-select fields](#multi-select-fields))

Each field autosaves on change, like other card detail fields. The section opens automatically if any field already has a value on the card; otherwise it starts collapsed. If the board has no custom fields, the section doesn't appear.

### Number formatting

A number field can show a unit and fixed decimals (`$1,234.50`, `8 h`, `-$5.00`) while the value stays a plain number. Set it in the field editor's **Format** block, which appears only for the **Number** type:

| Option | What it does | Default |
|---|---|---|
| **Prefix** | Text shown before the number, e.g. `$`. Up to 10 characters; spaces are kept, so `$ ` shows `$ 5`. | none |
| **Suffix** | Text shown after the number, e.g. ` h` or ` USD`. Up to 10 characters; spaces are kept. | none |
| **Decimals** | Show exactly this many decimal places (0–10), rounding as needed, with thousands separators (`1,234.50`). Leave it empty to show the number exactly as typed — no separators, and written the way it was entered (`+5` shows `$+5`, `1e3` shows `$1e3`). | empty (as typed) |

A **Preview** line shows how `1234.5` will look. A decimals value outside 0–10 shows *Enter 0 to 10.* and blocks saving until fixed.

- **Display only:** formatting changes how a value **looks** on the card face, in the card detail panel, in the hover peek, on swimlane row chips, and in the filter bar's active-filter chip. The stored value never changes: editing still uses a plain number box, with the prefix and suffix beside it as non-editable labels.
- **Very large numbers:** with Decimals set, a number beyond about 9 quadrillion (2^53) can show rounded digits. Only the display is affected; the stored value keeps every digit.
- **Negative numbers:** the minus sign goes before the prefix (`-$5.00`, not `$-5.00`). A negative value that rounds to zero shows without a sign (`$0.00`).
- **Separators:** grouping and the decimal point use US conventions (`1,234.50`) for every viewer. The **Number format** preference in your profile settings does not apply to custom field values. There is no currency model or conversion: `$` is just text.
- **Exports stay raw:** CSV and JSON exports contain the stored number (`1234.5`), not the formatted text. The JSON export also lists each field's `number_prefix`, `number_suffix` and `number_decimals`, so a consumer can apply the format itself.
- **Filtering uses the raw number:** type `1234.5` in the filter bar, not the formatted text.
- **Changing the type:** switching a field away from Number clears its format options.

The same options are available on [swimlane fields](#swimlane-row-custom-fields).

### URL fields

A URL field holds one web address (a runbook, a design file, a CRM record) as a clickable link. Unlike a card's single [pull / merge request link](card-links.md), a board can have several URL fields, and they work on swimlanes too.

- **Entering a value:** type or paste the address and leave the field (or press Enter). Without a scheme, `https://` is added, so `example.com` saves as `https://example.com`. Only `http://` and `https://` are accepted; anything else (for example `javascript:` or `ftp:`) shows an inline error under the input and is **not** saved. Your typed text stays in the box so you can fix it. Escape puts back the last saved value.
- **Length:** at most **500 characters**, the same cap as every other custom field value. Longer addresses are rejected rather than shortened.
- **Opening the link:** an editable URL field has an **Open link ↗** line that opens the saved address in a new tab. Read-only viewers see the full address as a link. Pinned chips on the card face and in the swimlane label panel show just the hostname (a leading `www.` dropped); hover for the full address.
- **Links always open in a new tab**, and only `http://`/`https://` values are ever rendered as links. A stored value that isn't a valid web address shows as plain text.

### Multi-select fields

A multi-select field holds **several** of a fixed list of choices at once (the platforms a change touches, the teams involved, the regions affected), where a dropdown holds exactly one.

- **Picking values:** click the field to open a checklist. Type to narrow it, then check or uncheck as many choices as you like; the footer shows how many are selected. Nothing saves while the list is open: closing it saves the whole selection once. Click **Done**, press Escape or Tab, or click outside to close.
- **Keyboard:** ↑ and ↓ move through the list, Enter (or Space, while the search box is empty) checks or unchecks the highlighted choice, and typing filters. With a search typed, the first Escape clears the search and the second closes the list.
- **Order:** selected values are always stored and shown in the order of the field's choices, whatever order you picked them in.
- **Clearing:** uncheck everything and close the list; the field becomes unset.
- **If the save fails**, the field returns to its previous value and a message names the field: *Couldn't save Platforms. Try again.*
- **Length:** all of a card's picks together can be at most **500 characters** (the same cap as every other custom field value, measured on the stored form). A selection over the cap is refused, not shortened.

#### Renaming or removing a choice

Renaming or removing a choice on a dropdown or multi-select field **never changes values already on cards or swimlanes**. A card that held the old choice keeps it as text:

- it still shows on the card, in the same neutral style as every other value, with no [choice color](#choice-colors);
- it still appears in exports;
- it matches nothing in the filter bar's choice list, which offers only current choices.

In a multi-select's checklist these leftover values are listed under **No longer a choice**, checked. Keep them while you change other picks, or uncheck them to drop them. Once dropped, a value that is no longer a choice can't be picked again.

### Choice colors

<span class="vb-version" title="Added in 1.2">1.2+</span>

Each choice on a dropdown or multi-select field can have its own color, so a value like **High** or **Blocked** stands out. A choice named **Blocked**, in any color, is only a chip: since 1.3 cards have a built-in [blocked state](blocked-cards.md#blocked-cards-and-a-blocked-custom-field) with its own glyph, elapsed time and Analytics, and that page explains when to switch. Colors work the same on card fields and [swimlane fields](#swimlane-row-custom-fields).

- **Setting a color:** in the field editor, click the round swatch in front of a choice and pick one of eight colors: **Slate**, **Blue**, **Green**, **Amber**, **Red**, **Violet**, **Pink**, or **Teal**. **Reset to automatic** removes it. The color saves with the rest of the field when you click **Save field**.
- **Automatic:** a choice with no color keeps the small automatic color dot it always had, so boards created before 1.2 look exactly as they did. In the editor its swatch is an empty dashed circle labelled *Automatic*.
- **Where it shows:** a colored choice renders as a tinted badge on the card face and in the swimlane label panel (and in the card detail panel and the multi-select picker's selected chips), inside the field's usual bordered chip. The choice's text is always shown, so color is never the only way to read it, and every color meets WCAG AA contrast in both light and dark themes. The list of options you pick from is unchanged.
- **Renaming or removing a choice resets its color:** the color belongs to the choice's text, so a renamed choice starts *Automatic* again and a removed choice's color is deleted. Values still stored under the old text (see [Renaming or removing a choice](#renaming-or-removing-a-choice)) render neutral.
- **Changing the type:** switching a field away from Dropdown or Multi-select clears its colors. Switching between Dropdown and Multi-select keeps them.
- **Keyboard:** in the color popover, the arrow keys move between swatches, Space or Enter picks one, and Escape closes just the popover (not Board Settings), as does tabbing out of it.
- Colors are display-only: exports, filters and the API's `choices` list are unchanged.

---

## Hover peek

Hovering a card for 600 ms opens the existing [card peek popover](board.md#card-peek). Beside weight, attachment count, and last-moved information, the peek lists any **non-pinned** custom field values that have data, so a value is never hidden just because it isn't one of the 2 pinned slots.

- **Own line:** custom fields get a separate line from weight and attachments. Pinned fields aren't repeated, since they show on the card face.
- **"Other fields —" prefix:** when the board pins at least one field, the line starts with **Other fields —** so it's clear these differ from the chips on the card. A card showing `SA: Glenda` on its face peeks as `Other fields — AE: Bob`.
- **Hover an entry** to see the full value plus the field's help text, if set. Help text on a short-named field (for example `SA` → "Solutions Architect") tells everyone what the abbreviation means.
- **Cap:** 6 entries; a `+N more` marker summarizes the rest, and hovering it lists the hidden fields' names.

---

## Filtering by custom fields

The filter bar shows one control per **pinned** custom field by default, matching the card face. Click **+ Custom fields** to add or remove controls for any other field on the board.

| Field type | Filter behavior |
|---|---|
| Text | Substring match |
| Number | Exact value match |
| Date | Exact value match |
| Dropdown | Multi-select of choices |
| Checkbox | Multi-select of Yes / No; a card that was never checked counts as **No** |
| URL | Substring match on the full address |
| Multi-select | Checklist of choices; matches a card holding **any** of the checked choices |

!!! note
    Number and date filters match an exact value only — there is no range filter (e.g. "between" or "greater than") in this release ([#1847](https://gitlab.com/visiban/visiban/-/issues/1847)).

- A multi-select filter matches whole values only: checking `web` matches a card holding `web`, never one holding only `webhooks`.
- Within one field the checked choices are **or**-ed; different fields, and every other filter, are **and**-ed.
- The extra controls you added via **+ Custom fields**, and their values, persist per board in your browser with the rest of the filter bar state.

---

## Swimlane (row) custom fields

Board admins can also define typed fields on **swimlanes** (rows) instead of cards, in a separate per-board schema. Use one for something that belongs to the row as a whole: an owner, a region, a renewal date. Swimlane fields use the same seven types as card fields — Text, Number, Date, Dropdown, Checkbox, URL, and Multi-select. A pinned multi-select swimlane field shows up to three of its picks on the row, wrapping onto further lines.

**By the numbers:** up to **15 swimlane fields**, with up to **8 of them pinned** to the swimlane label panel.

Dropdown, number, and date swimlane fields can also hide lanes from the board: see [Lane filters](board.md#lane-filters) (1.3+). Admin-only fields are offered there to board admins only.

### Managing swimlane fields (Board Settings → Swimlane fields)

Open **Board Settings** and select **Swimlane fields**, beside **Card fields**. Only board admins can create, edit, reorder, pin, or delete swimlane fields. Reorder by dragging the `⋮⋮` handle, or with the keyboard: Tab to the handle, Space to pick up, arrow keys to move, Space to drop.

**Shortcut:** when a swimlane's `+N` popover is open and the board has two or more swimlane fields, admins can choose **Edit field order…** in its footer. It closes the popover and opens Board Settings on the Swimlane fields tab. The order is shared by every swimlane on the board.

The tab lists fields in display order with the same glyph, name, type label, and pin state as the Card fields tab. The header shows a running count, for example `12 of 15 · 2 of 8 pinned`. At **13–14 fields**, a warning line shows how many are left before **+ Add field** locks out; at **15 fields**, **+ Add field** is disabled with an inline explanation.

The editor matches the card field editor (name, type, help text, choices for dropdowns and multi-selects, the [number format](#number-formatting) options for number fields, and a pin toggle), plus one addition:

- **Admin only:** toggle, **on by default** for a new field. An admin-only field's values are withheld from every non-admin role entirely. Members and viewers never receive the value over the API or the WebSocket, so there is nothing hidden client-side for them to discover. A padlock glyph marks an admin-only field in the settings list, on its chip in the swimlane label panel, and next to its input in the Edit Swimlane modal.

!!! note "Field type is locked once a swimlane holds a value"
    Unlike a card field, a swimlane field's **type cannot be changed once any swimlane on the board holds a value for it**. The API enforces this, not just a client-side caution. The field editor disables the other type buttons and explains why: add a new field of the type you want, then delete this one. Deleting a field permanently deletes all of its values; they can't be recovered. **Delete field** at the bottom left of the editor opens the same type-the-name confirmation as the row's ✕.

### Pinned fields in the swimlane label panel

Up to 8 fields can be pinned, and how many show as chips in the swimlane's label panel (the sticky left column, alongside the swimlane's name) follows the board's [card density](board.md#card-density): **3** at Comfortable, **5** at Standard, **8** at Dense. Chips are stacked below the row name, and they're hidden while the swimlane is collapsed, like the rest of the panel's detail. The same limits apply under the Classic preset.

Pinned values past the visible count fold into a trailing `+N` chip, together with any unpinned values. It opens a read-only popover listing every value the current viewer may see, so nothing is lost.

- **Order:** the N values counted by `+N` come first (folded pinned values in pin order, then unpinned ones), then the chips actually on the row under an **On row** heading.
- **Size:** the popover grows to fit its values up to the window height. When it must scroll, a fade at the bottom edge shows there is more, and keyboard focus lands in it on open, so the arrow keys, Page Down and Space scroll it straight away.

#### Hiding field names on row chips

<span class="vb-version" title="Added in 1.2">1.2+</span>

By default each row chip shows its field's name before the value, for example `AD: Diane Foster`. With several pinned fields that name repeats on every row and takes up width. A board admin can turn it off in **Board Settings → Swimlane fields** with the **Show field names on row chips** switch at the top of the tab. The setting applies to the whole board, for everyone viewing it, and other people with the board open see the change straight away.

With names hidden, a chip shows only its value (`Diane Foster`) and, unless you resized it yourself, the swimlane label column starts narrower. The name is still available:

- **On hover:** the chip's tooltip reads `Field name: value`, as before.
- **For screen readers:** the chip is still announced as `Field name: value`.
- **In the row's field list:** the row's field popover lists every field with its name. It opens from the `+N` button when some values are folded or unpinned, or from an **All fields** button when every value is already on the row, so touch and keyboard users can always reach the names.

**Checkbox fields always show their name**, because a bare **Yes** or **No** means nothing without it. Colored choice badges, multi-select chips, the admin-only padlock, and the dropdown color dot are unchanged. Chips on the card face always show the field name; this setting affects only swimlane rows.

!!! tip
    Hidden names work best when each pinned field's values are recognizable on their own, like a person's name or a region. If two pinned fields can hold similar values (two dates, two numbers, or two fields with the same choices), consider leaving names on, since viewers on a touch screen or reading a screenshot can't hover to tell them apart.

### Editing values (Edit Swimlane modal)

Swimlane field values are set in the **Edit Swimlane modal**, which gains a **Fields** section listing every field on the board (absent if the board has none).

- **Who:** editing a swimlane is already admin-only, so **only board admins can set swimlane field values at all**, regardless of a field's Admin only toggle. The toggle controls who can *read* a value, not who can *write* it.
- **Saving:** edits are held in the modal and saved together with the rest of the swimlane when you click **Save**. They do not autosave field by field the way card fields do in the card detail panel.

---

## API and real-time events

This page covers the UI. For the wire format:

- Field definition CRUD and reordering — [`/api/v1/boards/{id}/custom-fields/`](../api/boards.md#custom-fields-since-12)
- Card values — the `custom_field_values` field on the card payload — [Cards API](../api/cards.md)
- Real-time updates — `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, and `custom_field.reordered` WebSocket events — [WebSockets](../api/websockets.md)
- Swimlane field definition CRUD and reordering — [`/api/v1/boards/{id}/swimlane-custom-fields/`](../api/boards.md#swimlane-custom-fields-since-12)
- Swimlane values — the `custom_field_values` field on the swimlane payload — [Boards API](../api/boards.md#swimlanes)
- Swimlane real-time updates — schema changes arrive as `swimlane_custom_field.created`, `swimlane_custom_field.updated`, `swimlane_custom_field.deleted`, and `swimlane_custom_field.reordered`; value changes arrive on the existing `swimlane.updated` event — [WebSockets](../api/websockets.md#swimlane-field-events-since-12)
- Board export (CSV and JSON) includes swimlane field values alongside card field values, with admin-only fields omitted entirely for a non-admin exporter — [Export & Import](../api/boards.md#export-import). In the CSV, a multi-select value is written as its picks joined with `; ` (for example `web; ios`); the JSON export keeps the stored JSON array string — see [Multi-select fields](../api/boards.md#multi-select-fields)
- Number formatting options — `number_prefix`, `number_suffix`, `number_decimals` on both definition endpoints; values stay raw on the wire and in exports — see [Number formatting](../api/boards.md#number-formatting)
- Choice colors — `choice_colors` (`{choice: palette_key}`) on both definition endpoints; `choices` stays a plain list — see [Choice colors](../api/boards.md#choice-colors)

---

## Limitations in this release

| Limitation | Detail |
|---|---|
| No conditional coloring | Custom field values cannot be color-coded by threshold (e.g. red above N). Only dropdown and multi-select choices can carry a color, a fixed one per choice — see [Choice colors](#choice-colors) |
| No range filtering | Number and date filters match an exact value only, not a range. Tracked in [#1847](https://gitlab.com/visiban/visiban/-/issues/1847) |
| Number formatting ignores the Number format preference | Formatted custom field numbers always use US separators (`1,234.50`), not the per-user **Number format** setting |
| `is_required` not enforced | The field definition has a "required" concept in the data model, but it is not enforced in the UI or API in this release — a field marked required can still be left blank. Tracked in [#1433](https://gitlab.com/visiban/visiban/-/issues/1433) |
| Swimlane fields aren't filterable | The board's filter bar only offers controls for card fields; swimlane field values cannot be used as filter criteria in this release |
| `is_required` not enforced (swimlane fields) | Same gap as the card-level entry above — a swimlane field marked required can still be left blank in the Edit Swimlane modal. Tracked in [#1433](https://gitlab.com/visiban/visiban/-/issues/1433) |
| No aggregates | Custom field values cannot be summed or otherwise rolled up on swimlane headers or in board and report widgets. Tracked in [#1851](https://gitlab.com/visiban/visiban/-/issues/1851) |

The backend also exposes a `CUSTOM_FIELD_VALIDATORS` extension point that lets an extension register additional per-type validators for card values, and a separate `SWIMLANE_CUSTOM_FIELD_VALIDATORS` list for swimlane-row values. See the [open-core boundary](../architecture/open-core-boundary.md).
