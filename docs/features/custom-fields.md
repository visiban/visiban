# Track your own fields on cards and swimlanes

<a id="custom-fields"></a>

<span class="vb-version" title="Added in 1.2">1.2+</span>

Board admins define typed fields in **Board Settings → Card fields** (or **Swimlane fields**). Everyone then fills them in on the card or row.

**Why it matters:** A label is an untyped tag; a custom field is a named key with a type. Use fields for what the built-in card fields don't cover: sprint, budget, region, array type, anything.

**The big picture:** two independent flavors, scoped to different objects.

- **Card fields:** described on the rest of this page.
- **Swimlane fields:** described in [Swimlane (row) custom fields](#swimlane-row-custom-fields). The two are separate per-board schemas. A board may define a card field and a swimlane field with the same name, and they are never merged or compared.

**By the numbers:** up to **30 card fields**, with up to **2 of them pinned** to the card face (a [track](#dimension-fields-13) shows as a chip instead and cannot be newly pinned). Swimlane fields have smaller caps; see [Swimlane (row) custom fields](#swimlane-row-custom-fields).

**Yes, but:** `is_required` isn't enforced ([#1433](https://gitlab.com/visiban/visiban/-/issues/1433)) and only number filters have operators such as a range; date and choice filters match exact values ([#1847](https://gitlab.com/visiban/visiban/-/issues/1847)). See [Limitations in this release](#limitations-in-this-release).

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

Open **Board Settings** and select **Card fields** in the sidebar's **Fields** group, next to **Swimlane fields** (since 1.2). Since 1.3 the sidebar groups the sections under Board, Fields, Access, Integrations and Data. Only board admins can create, edit, reorder, pin, or delete fields. A track (a [dimension field](#dimension-fields-13)) cannot be newly pinned to the card face: it shows as a chip, and its row says so. A track that was already pinned (for example through the API) still counts toward the 2-pin limit and shows an **Unpin** control.

The tab lists every field in display order with its type glyph, name, type label, and pin state. Hover a row for **✎ Edit** and **✕ Delete**. Drag the `⋮⋮` handle to reorder, or use the keyboard: Tab to the handle, press Space to pick the field up, press the arrow keys to move it past its neighbors, and press Space to drop it (Escape cancels). That order is the order in the card detail panel and, for pinned fields, on the card face.

### Adding or editing a field

Click **+ Add field**, or **✎** on a field, to open the inline editor:

- **Field name:** required, unique on the board
- **Type:** one of the seven types, chosen from a row of buttons
- **Help text:** optional hint shown next to the input wherever the field is edited
- **Format** (number only): optional **Prefix**, **Suffix**, and **Decimals**; see [Number formatting](#number-formatting)
- **Thresholds** (number and date only): **Off**, **Above** or **Below** (**On or after** or **On or before** for dates), with a **Warn at** and an **Alert at** value; see [Threshold marking](#threshold-marking)
- **Choices** (dropdown and multi-select): add rows with **+ Add choice**, reorder them by dragging the `⋮⋮` handle or with the keyboard (Tab to the handle, Space to pick the choice up, the arrow keys to move it, Space to drop it, Escape to cancel without closing Board Settings), or click **Paste a list** to bulk-add from a block of text in one step. Each line becomes a choice, and so does each cell of a row copied from a spreadsheet; choices already in the list are skipped, and **Add N choices** counts only the new ones. Text still in the paste box when you click **Save field** is added too, and closing the box with text still in it adds that text to the choices instead of holding it aside. The round swatch in front of each choice sets its color; see [Choice colors](#choice-colors)
- **Pin to card face:** toggle to show this field's value on the card face; see [Pinned fields on the card face](#pinned-fields-on-the-card-face)

Click **Save field** to commit, or **Cancel** to discard.

!!! warning "A field's type locks once it holds a value"
    Once any card on the board has a stored value for a field, archived cards included, the API blocks changing that field's type. *Since 1.3*, the field editor disables the other type buttons up front and explains why: add a new field of the type you want, then delete the old one. **Deleting a field permanently deletes all of its values.** They can't be recovered. A brand-new, unsaved field has no values yet, so its type can be changed freely.

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

**Unset pinned fields:** a pinned field with no value shows as a dashed "ghost" chip (the field name and a dash) instead of disappearing:

- **Checkbox and dropdown** fields show the ghost at every [card density](board.md#card-density) when you can edit the board. Click it, or focus it and press Enter, to set the value straight from the card, the same as a chip that has one. Clearing a pinned dropdown with **— No value —** leaves its ghost on the card, so you can pick a value again without opening the card.
- **Other types** (text, number, date, URL, multi-select) show the ghost only at **Dense** density, so power users always see the full set of pinned fields. At **Comfortable** and **Standard** they stay hidden until they have a value, because they are set from the card detail, not the card face.

*Changed in 1.3:* before 1.3, an unset checkbox or dropdown was hidden at Comfortable and Standard density too, so clearing one removed it from the card face.

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
- **Multi-select:** a multi-select list of choices; saves when you close it (see [Multi-select fields](#multi-select-fields))

Each field autosaves on change, like other card detail fields. The section opens automatically if any field already has a value on the card; otherwise it starts collapsed. If the board has no custom fields, the section doesn't appear.

### Number formatting

A number field can show a unit and fixed decimals (`$1,234.50`, `8 h`, `-$5.00`) while the value stays a plain number. Set it in the field editor's **Format** block, which appears only for the **Number** type:

| Option | What it does | Default |
|---|---|---|
| **Prefix** | Text shown before the number, e.g. `$`. Up to 10 characters; spaces are kept, so `$ ` shows `$ 5`. | none |
| **Suffix** | Text shown after the number, e.g. ` h` or ` USD`. Up to 10 characters; spaces are kept. | none |
| **Decimals** | Show exactly this many decimal places (0–10), rounding as needed, with thousands separators (`1,234.50`). Leave it empty to show the digits as typed, with thousands separators added (`33000` shows `$33,000`, `1234.5` shows `$1,234.5`; *changed in 1.3*, #2387: before, no separators). A value written another way stays as entered (`+5` shows `$+5`, `1e3` shows `$1e3`). | empty (as typed) |

A **Preview** line shows how `1234.5` will look. A decimals value outside 0–10 shows *Enter 0 to 10.* and blocks saving until fixed.

- **Display only:** formatting changes how a value **looks** on the card face, in the card detail panel, in the hover peek, on swimlane row chips, and in the filter bar's active-filter chip. The stored value never changes: editing still uses a plain number box, with the prefix and suffix beside it as non-editable labels.
- **Short form on the card face:** a pinned number of 1,000 or more shows in short form on the card, with at most one decimal (`$33k`, `$1.2M`), so it fits a narrow card without being cut off. Only the field name shortens to make room; the number stays whole unless it alone is wider than the chip (a long prefix or suffix with many decimals), and then it ends in an ellipsis. Hover the chip to see the full value (`Deal value: $33,000`); every other place shows the full value (*new in 1.3*, #2387). A number field with no format option set shows as typed everywhere.
- **Very large numbers:** with Decimals set, a number beyond about 9 quadrillion (2^53) can show rounded digits. Only the display is affected; the stored value keeps every digit.
- **Negative numbers:** the minus sign goes before the prefix (`-$5.00`, not `$-5.00`). A negative value that rounds to zero shows without a sign (`$0.00`).
- **Separators:** grouping and the decimal point use US conventions (`1,234.50`) for every viewer. The **Number format** preference in your profile settings does not apply to custom field values. There is no currency model or conversion: `$` is just text.
- **Exports stay raw:** CSV and JSON exports contain the stored number (`1234.5`), not the formatted text. The JSON export also lists each field's `number_prefix`, `number_suffix` and `number_decimals`, so a consumer can apply the format itself.
- **Filtering uses the raw number:** type `1234.5` in the filter bar, not the formatted text.
- **Changing the type:** switching a field away from Number clears its format options.

The same options are available on [swimlane fields](#swimlane-row-custom-fields).

### Threshold marking

> **Added in 1.3**

A number or date card field can mark values that cross a threshold, so a card whose spend is over budget or whose renewal is close stands out without opening it.

- **Set it up** in Board settings → Card fields → the field → **Thresholds**. Choose **Above** (mark large numbers) or **Below** (mark small numbers); for a date field the choices read **On or after** (mark dates far ahead) and **On or before** (mark dates that are close or past). Then enter a **Warn at** value, an **Alert at** value, or both. With both, the alert must lie beyond the warning in that direction. **Off** clears them. The editor refuses to save an invalid combination and says why.
- **Dates use days from today**, in your own timezone, the same "today" as due dates (your profile timezone, or UTC if you have not set one). `0` is today, `3` is three days from now and `-2` is two days ago. So **On or before** with **Warn at** `14` and **Alert at** `0` warns two weeks ahead and alerts on the day and after.
- **Boundaries count.** A value exactly at a threshold is marked: **Above** `5000` marks `5000`.
- **On the card face** a marked value gets a chevron and bold text: one chevron (`›`) at warning, two (`»`) at alert, pointing left for a **Below** threshold. There is no red or amber: those colors already mean priority and urgency on a card, so a threshold never borrows them. Screen readers hear the words, for example "Spend: $6,100, Alert: at or above $6,000". The settings block shows the same legend.
- **In words** in the [hover peek](#hover-peek) and the card detail panel, for example `Alert: at or above $6,000` or `Warning: 3 days from today or earlier`. On a touch screen, tap the card to see them.
- **Card fields only.** Swimlane (row) fields, filter chips and the Summary view do not show threshold marks in this release (swimlane fields: #2217; filter chips and Summary tables: #2221). A value that is not a valid number or date is never marked.
- **Changing the type clears them**, as it does the number format.

### URL fields

A URL field holds one web address (a runbook, a design file, a CRM record) as a clickable link. Unlike a card's single [pull / merge request link](card-links.md), a board can have several URL fields, and they work on swimlanes too.

- **Entering a value:** type or paste the address and leave the field (or press Enter). Without a scheme, `https://` is added, so `example.com` saves as `https://example.com`. Only `http://` and `https://` are accepted; anything else (for example `javascript:` or `ftp:`) shows an inline error under the input and is **not** saved. Your typed text stays in the box so you can fix it. Escape puts back the last saved value.
- **Length:** at most **500 characters**, the same cap as every other custom field value. Longer addresses are rejected rather than shortened.
- **Opening the link:** an editable URL field has an **Open link ↗** line that opens the saved address in a new tab. Read-only viewers see the full address as a link. Pinned chips on the card face and in the swimlane band show just the hostname (a leading `www.` dropped); hover for the full address.
- **Links always open in a new tab**, and only `http://`/`https://` values are ever rendered as links. A stored value that isn't a valid web address shows as plain text.

### Multi-select fields

A multi-select field holds **several** of a fixed list of choices at once (the platforms a change touches, the teams involved, the regions affected), where a dropdown holds exactly one.

- **Picking values:** click the field to open a multi-select list. Type to narrow it, then check or uncheck as many choices as you like; the footer shows how many are selected. Nothing saves while the list is open: closing it saves the whole selection once. Click **Done**, press Escape or Tab, or click outside to close.
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

In a multi-select list these leftover values are listed under **No longer a choice**, checked. Keep them while you change other picks, or uncheck them to drop them. Once dropped, a value that is no longer a choice can't be picked again.

### Choice colors

<span class="vb-version" title="Added in 1.2">1.2+</span>

Each choice on a dropdown or multi-select field can have its own color, so a value like **High** or **Blocked** stands out. A choice named **Blocked**, in any color, is only a chip: since 1.3 cards have a built-in [blocked state](blocked-cards.md#blocked-cards-and-a-blocked-custom-field) with its own glyph, elapsed time and Analytics, and that page explains when to switch. Colors work the same on card fields and [swimlane fields](#swimlane-row-custom-fields).

- **Setting a color:** in the field editor, click the round swatch in front of a choice and pick one of eight colors: **Slate**, **Blue**, **Green**, **Amber**, **Red**, **Violet**, **Pink**, or **Teal**. **Reset to automatic** removes it. The color saves with the rest of the field when you click **Save field**.
- **Custom color** <span class="vb-version" title="Added in 1.3">1.3+</span>**:** under the eight colors, **+ Custom** opens a color square and hue slider with **Hex** and **R/G/B** fields, so a choice can match a brand or team color exactly. **Apply** sets it; **Cancel** or Escape goes back to the eight colors without a change. A choice with a custom color shows it in its swatch, and **+ Custom** reads **Custom** with a small dot of that color. Whatever the color, Visiban picks a text and tint that stay readable in both light and dark themes.
- **Automatic:** a choice with no color keeps the small automatic color dot it always had, so boards created before 1.2 look exactly as they did. In the editor its swatch is an empty dashed circle labelled *Automatic*.
- **Where it shows:** a colored choice renders as a tinted badge on the card face and in the swimlane band (and in the card detail panel and the multi-select picker's selected chips), inside the field's usual bordered chip. The choice's text is always shown, so color is never the only way to read it, and every color, custom ones included, meets WCAG AA contrast in both light and dark themes. The list of options you pick from is unchanged.
- **Renaming or removing a choice resets its color:** the color belongs to the choice's text, so a renamed choice starts *Automatic* again and a removed choice's color is deleted. Values still stored under the old text (see [Renaming or removing a choice](#renaming-or-removing-a-choice)) render neutral.
- **Changing the type:** switching a field away from Dropdown or Multi-select clears its colors. Switching between Dropdown and Multi-select keeps them.
- **Keyboard:** in the color popover, the arrow keys move between swatches, Space or Enter picks one, and Escape closes just the popover (not Board Settings), as does tabbing out of it. **+ Custom** and **Reset to automatic** are the next Tab stops after the swatches. In the custom panel, Escape returns to the eight colors first; a second Escape closes the popover.
- **Moving boards between servers:** a board exported with a custom choice color cannot be imported into a Visiban server older than 1.3. That server refuses the whole import, so upgrade it first. Exports from older versions import normally.
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
| Number | **equals**, **between**, **at least**, **at most**, **is empty** or **has a value** (1.3+, in the Filter panel) |
| Date | Exact value match |
| Dropdown | Multi-select of choices |
| Checkbox | Multi-select of Yes / No; a card that was never checked counts as **No** |
| URL | Substring match on the full address |
| Multi-select | Multi-select list of choices; matches a card holding **any** of the checked choices |

### Number filter operators

<span class="vb-version" title="Added in 1.3">1.3+</span>

In the [Filter panel](board.md#filter-panel), a number field's row has an **is** menu above its input: **equals**, **between**, **at least**, **at most**, **is empty** and **has a value**. Use it for filters like "Estimate 3–8" or "Estimate ≥ 13".

- **between** takes a minimum and a maximum, both inclusive. Leave either one blank for an open range; **at least** and **at most** are the same filter with one bound.
- A card with no value for the field never matches **equals**, **between**, **at least** or **at most**; only **is empty** matches it.
- Values compare as numbers, unrounded: the field's decimal places only set the input's step. Type the raw number, not the formatted text.
- A minimum greater than the maximum shows a warning and matches no cards; the filter is kept so you can fix it.
- A **between** with both bounds blank is not a filter and shows no chip.
- Chips show the operator: `Estimate: 3–8`, `Estimate: ≥ 13`, `Estimate: ≤ 2`, `Estimate: empty`, `Estimate: has a value`.
- Switching operators keeps what you typed where it fits: an **equals** value becomes the **between** minimum, and back.
- The filter bar's own number box sets **equals** only. While another operator is in use it shows that filter read-only (for example `3–8`); change it in the Filter panel or remove its chip.
- Saved filters keep the operator. A Visiban release before 1.3 ignores a range, **is empty** or **has a value** filter (it shows no filter on that field), and it keeps the operator when it re-saves the preset, unless you edit that field's filter there, which replaces the operator filter with a plain **equals** one.

!!! note
    Date, text and choice filters have no operator menu yet: date and choice match an exact value, text a substring ([#1847](https://gitlab.com/visiban/visiban/-/issues/1847)).

- A multi-select filter matches whole values only: checking `web` matches a card holding `web`, never one holding only `webhooks`.
- Within one field the checked choices are **or**-ed; different fields, and every other filter, are **and**-ed.
- The extra controls you added via **+ Custom fields**, and their values, persist per board in your browser with the rest of the filter bar state.

---

## Swimlane (row) custom fields

Board admins can also define typed fields on **swimlanes** (rows) instead of cards, in a separate per-board schema. Use one for something that belongs to the row as a whole: an owner, a region, a renewal date. Swimlane fields use the same seven types as card fields — Text, Number, Date, Dropdown, Checkbox, URL, and Multi-select. A multi-select swimlane field shows up to three of its picks on the band, wrapping onto further lines.

**By the numbers:** up to **30 swimlane fields** (15 before 1.3). On a legacy board (every field's `band_visibility` is null; see [Band visibility](../api/boards.md#band-visibility-since-13)) the swimlane band shows the first two values by field order and puts every field in an **N fields** grid behind a button; see [Swimlane fields in the lane band](#swimlane-fields-in-the-lane-band).

Every swimlane field type (dropdown, number, date, text, URL, checkbox, and multi-select) can also hide lanes from the board, whichever Show setting it has: see [Lane filters](board.md#lane-filters) (1.3+). Text and URL fields offer **contains**, **does not contain**, and **matches wildcard** (`*` any text, `?` one character, matches any part of the value): see [Text operators and wildcards](board.md#text-operators-and-wildcards). Admin-only fields are offered there to board admins only.

### Managing swimlane fields (Board Settings → Swimlane fields)

Open **Board Settings** and select **Swimlane fields**, beside **Card fields**. Only board admins can create, edit, reorder, or delete swimlane fields. Reorder by dragging the `⋮⋮` handle, or with the keyboard: Tab to the handle, Space to pick up, arrow keys to move, Space to drop.

**Shortcut:** when a swimlane's details are open, admins can choose **Manage swimlane fields** in the footer. It opens Board Settings on the Swimlane fields tab. The order and the Show settings are shared by every swimlane on the board.

The tab lists fields in display order with the same glyph, name, and type label as the Card fields tab. The header shows a running count, for example `12 of 30`. At **28–29 fields**, a warning line shows how many are left before **+ Add field** locks out; at **30 fields**, **+ Add field** is disabled with an inline explanation.

The editor matches the card field editor (name, type, help text, choices for dropdowns and multi-selects, and the [number format](#number-formatting) options for number fields), plus one addition. Unlike card fields, swimlane fields have no pin toggle (since 1.3, #2303):

- **Admin only:** toggle, **on by default** for a new field. An admin-only field's values are withheld from every non-admin role entirely. Members and viewers never receive the value over the API or the WebSocket, so there is nothing hidden client-side for them to discover. A padlock glyph marks an admin-only field in the settings list, beside its value in the swimlane band, and next to its input in the Edit Swimlane modal.

!!! note "Field type is locked once a swimlane holds a value"
    As with a card field, a swimlane field's **type cannot be changed once any swimlane on the board holds a value for it**. The API enforces this, not just a client-side caution. The field editor disables the other type buttons and explains why: add a new field of the type you want, then delete this one. Deleting a field permanently deletes all of its values; they can't be recovered. **Delete field** at the bottom left of the editor opens the same type-the-name confirmation as the row's ✕.

### Choosing where each field shows (Band, Details, Hidden)

<span class="vb-version" title="Added in 1.3">1.3+</span>

Each row of the Swimlane fields tab has a **Show** control with three options:

- **Band:** always visible on the lane band. The band holds **2** fields. When it is full, **Band** is disabled on every other row ("The band holds 2 fields. Move one to Details first.").
- **Details:** behind the band's **Show N more** toggle. The **In lane details** summary sets the limit with the **up to** select (4, 6, 9, 12 or 16; default 6). When the details are full, **Details** is disabled the same way. A limit below the number of fields already in Details can't be chosen.
- **Hidden:** off the band and out of the details count. Hidden fields are listed last in the lane details, under **Hidden on band**, so everyone who can see the field can still read it. Every field can be searched and used in filters, and stays in exports, whatever its Show setting.

The two counters in the summary bar (for example `2 / 2` and `4 / 6`) show how full each tier is, **Find a field** narrows the list, and the **Preview** at the bottom shows a band built from the current settings. Dragging still sets the order within each tier; once a board has explicit tiers, it never moves a field between tiers (on a board set up before 1.3, tiers come from position, so dragging can move a field between Band and Details).

On a board set up before 1.3, the tab shows the first two fields as Band and the rest as Details, and the board looks exactly as before until an admin changes a Show setting or the details limit. That first change records a setting for every field: the first two stay on the band, the next ones fill the details up to the limit, and any beyond it become Hidden.

Admin-only fields stay visible to admins only: for members and viewers they are left out of the band, the details, the Hidden on band group and every count.

### Swimlane fields in the lane band

A swimlane's header is a full-width band (see [Swimlanes](board.md#swimlanes)). The band shows the swimlane's first **two** field values inline, as `Label value` pairs in the order set on the Swimlane fields tab, right after the name. An **N fields** button (N counts every field you can see, set or not) sits before them and opens an aligned grid on its own line inside the band: one row per field in Swimlane fields order, labels in a fixed column, values beside them, and **—** for a field with no value, so a field sits in the same place on every lane. The grid always shows field names, even when row chip field names are hidden, and the button stays put when it opens. Screen readers hear the button's expanded or collapsed state and "Not set" for an empty value. The band shows the same fields at every card density, under the Classic preset too, and keeps them when the lane is collapsed.

*Changed in 1.3 (#2439):* once a board's fields have a [Show setting](#choosing-where-each-field-shows-band-details-hidden), the band shows its **Band** fields, and the toggle reads **Show N more** (N counts the Details and Hidden fields you can see). Open, it reads **Hide details** and shows the details grid, a **Hidden on band** group, and a footer such as `4 in details · 2 hidden on band`. The phone layout shows the same tiers in one column.

*Changed in 1.3 (#2303):* swimlane fields are no longer pinned. The band has room for the first two by order and the rest are one click away, so the Swimlane fields tab no longer shows a **Pin** button, a pinned count or a **Pin to swimlane row** switch, and the card density descriptions no longer state a number of swimlane values. A field pinned before 1.3 keeps its `show_on_row` value in the API; it just has no effect on the board. On a board set up before 1.3, reorder the fields to choose which two values show; once a board has explicit tiers, use each field's **Show** control instead. Admins also get a **Change field order** link after the open grid; it opens Board Settings on the Swimlane fields tab.

#### Hiding field names on row chips

<span class="vb-version" title="Added in 1.2">1.2+</span>

By default each swimlane field in the band shows its name before the value, for example `AD Diane Foster`. With several fields that name repeats on every row and takes up width. A board admin can turn it off in **Board Settings → Swimlane fields** with the **Show field names on row chips** switch at the top of the tab. The setting applies to the whole board, for everyone viewing it, and other people with the board open see the change straight away.

With names hidden, a band field shows only its value (`Diane Foster`). The name is still available:

- **On hover:** the value's tooltip reads `Field name: value`, as before.
- **For screen readers:** the name is still announced before the value.
- **In Board Settings:** the Swimlane fields tab lists every field by name, in the order the band uses.

**Checkbox fields always show their name**, because a bare **Yes** or **No** means nothing without it. Colored choice badges, multi-select chips, the admin-only padlock, and the dropdown color dot are unchanged. Chips on the card face always show the field name; this setting affects only the swimlane band.

!!! tip
    Hidden names work best when each swimlane field's values are recognizable on their own, like a person's name or a region. If two swimlane fields can hold similar values (two dates, two numbers, or two fields with the same choices), consider leaving names on, since viewers on a touch screen or reading a screenshot can't hover to tell them apart.

### Editing values (Edit Swimlane modal)

Swimlane field values are set in the **Edit Swimlane modal**, which gains a **Fields** section listing every field on the board (absent if the board has none).

- **Who:** editing a swimlane is already admin-only, so **only board admins can set swimlane field values at all**, regardless of a field's Admin only toggle. The toggle controls who can *read* a value, not who can *write* it.
- **Saving:** edits are held in the modal and saved together with the rest of the swimlane when you click **Save**. They do not autosave field by field the way card fields do in the card detail panel.

---

## Field sets (1.3)

A **field set** groups some of a board's card fields into a named block on the card detail,
so a board with many fields (a qualification framework such as MEDDIC, say) shows which group
is complete at a glance. Sets only change how fields are displayed: they hold no values, do not
count toward the 30-field limit, and do not block a card from moving.

### Managing field sets (Board Settings → Field sets)

Board admins create, rename, reorder and delete sets; other roles see the list read-only. Each
set has a **name**, an optional **description** (up to 120 characters, shown under the name on
the card), a **default size** (Collapsed, Summary or All fields), **Shows on** (every card, or
only cards in chosen swimlanes), and its **fields**. A field is in at most one set; adding a
field that is in another set moves it. A board can have up to **10** sets.

**Deleting a set** moves its fields to **Other fields**. No field and no value is deleted.

**Copy from another board** copies a set from any board you can read. Each of its fields
either reuses this board's field of the same name and type (when that field is in no set) or is
created, named "{name} (copied)" if the name is taken. The copy has no link to the source:
later changes on either board do not carry over. Values are never copied.

### Field sets on the card

When a board has at least one set, the card detail's Custom fields section becomes **Field
sets**: one block per set in order, with fields in no set under **Other fields** last. A board
with no sets looks exactly as before. Each block shows its progress (filled of total; checkbox
and dimension fields are not counted, so "missing" never means "No") and a size control:

- **Collapsed** shows the header only.
- **Summary** shows one line of chips, missing fields first, then "+N" for the rest.
- **All fields** shows every field.
- **Maximize** fills the card sheet with one set. Previous / Next step through the sets;
  **Restore** or Escape returns you to where you were.

Your sizes are saved per card in this browser and are yours alone. **Collapse all** and
**Reset** (back to each set's default) act on the current card. A set limited to other
swimlanes is hidden, unless one of its fields holds a value on this card: then it shows
collapsed with "Not used in {swimlane}", so a stored value is never hidden.

Field sets travel with JSON export and import. See [Field sets](../api/boards.md#field-sets-since-13)
for the API.

## API and real-time events

This page covers the UI. For the wire format:

- Field definition CRUD and reordering — [`/api/v1/boards/{id}/custom-fields/`](../api/boards.md#custom-fields-since-12)
- Card values — the `custom_field_values` field on the card payload — [Cards API](../api/cards.md)
- Real-time updates — `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, and `custom_field.reordered` WebSocket events — [WebSockets](../api/websockets.md)
- Field sets — [`/api/v1/boards/{id}/field-sets/`](../api/boards.md#field-sets-since-13) and the `field_set.*` events — [WebSockets](../api/websockets.md#field-set-events-since-13)
- Swimlane field definition CRUD and reordering — [`/api/v1/boards/{id}/swimlane-custom-fields/`](../api/boards.md#swimlane-custom-fields-since-12)
- Swimlane values — the `custom_field_values` field on the swimlane payload — [Boards API](../api/boards.md#swimlanes)
- Swimlane real-time updates — schema changes arrive as `swimlane_custom_field.created`, `swimlane_custom_field.updated`, `swimlane_custom_field.deleted`, and `swimlane_custom_field.reordered`; value changes arrive on the existing `swimlane.updated` event — [WebSockets](../api/websockets.md#swimlane-field-events-since-12)
- Board export (CSV and JSON) includes swimlane field values alongside card field values, with admin-only fields omitted entirely for a non-admin exporter — [Export & Import](../api/boards.md#export-import). In the CSV, a multi-select value is written as its picks joined with `; ` (for example `web; ios`); the JSON export keeps the stored JSON array string — see [Multi-select fields](../api/boards.md#multi-select-fields)
- Number formatting options — `number_prefix`, `number_suffix`, `number_decimals` on both definition endpoints; values stay raw on the wire and in exports — see [Number formatting](../api/boards.md#number-formatting)
- Choice colors — `choice_colors` (`{choice: palette_key or #RRGGBB}`) on both definition endpoints; `choices` stays a plain list — see [Choice colors](../api/boards.md#choice-colors)

---

## Limitations in this release

| Limitation | Detail |
|---|---|
| No conditional coloring | Custom field values cannot be color-coded by threshold (e.g. red above N). Only dropdown and multi-select choices can carry a color, a fixed one per choice — see [Choice colors](#choice-colors) |
| No date range filtering | Date filters match an exact value only, not a range (number filters take ranges from 1.3, #2357). Tracked in [#1847](https://gitlab.com/visiban/visiban/-/issues/1847) |
| Number formatting ignores the Number format preference | Formatted custom field numbers always use US separators (`1,234.50`), not the per-user **Number format** setting |
| `is_required` not enforced | The field definition has a "required" concept in the data model, but it is not enforced in the UI or API in this release — a field marked required can still be left blank. Tracked in [#1433](https://gitlab.com/visiban/visiban/-/issues/1433) |
| Swimlane fields aren't filterable | The board's filter bar only offers controls for card fields; swimlane field values cannot be used as filter criteria in this release |
| `is_required` not enforced (swimlane fields) | Same gap as the card-level entry above — a swimlane field marked required can still be left blank in the Edit Swimlane modal. Tracked in [#1433](https://gitlab.com/visiban/visiban/-/issues/1433) |
| No aggregates | Custom field values cannot be summed or otherwise rolled up on swimlane headers or in board and report widgets. Tracked in [#1851](https://gitlab.com/visiban/visiban/-/issues/1851) |

The backend also exposes a `CUSTOM_FIELD_VALIDATORS` extension point that lets an extension register additional per-type validators for card values, and a separate `SWIMLANE_CUSTOM_FIELD_VALIDATORS` list for swimlane-row values. See the [open-core boundary](../architecture/open-core-boundary.md).


## Dimension fields (1.3)

A **dimension** is a dropdown field whose choices each carry a resolution: `open`, `satisfied` (shown as "done") or `not_applicable`. Set `is_dimension: true` and `choice_resolutions` (a map from choice to resolution) on a dropdown field; a choice without an entry, and a card with no value, count as open. Only dropdown fields can be dimensions. A value can move between any two choices in any order.

Dimensions are what a stage's **tracks** are: a board admin binds dimension fields to a column as its tracks, and can mark a dimension not applicable for a whole swimlane. A lane's not-applicable mark overrides each card's own value for display, and the card's value is kept. Tracks count toward the 30-fields-per-board limit.

**Renaming or removing a choice.** Renaming a choice keeps its done/open setting for the choice itself, but stored card values are not rewritten, so cards that already hold the old name read as open until their value is updated. Removing a choice drops its setting.

Every change to any custom field value, dimension or not, appears in the card's history with the old value, the new value and who made it.
