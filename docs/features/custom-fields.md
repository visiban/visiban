# Custom Fields

> **Added in 1.2**

Board admins can define typed metadata fields scoped to a single board — where a label is an untyped tag, a custom field is a named key with a type. Use custom fields to track information specific to your workflow that doesn't fit the built-in card fields: sprint, budget, region, array type, anything.

Custom fields come in two independent flavors, scoped to different objects on the board: **card fields**, described on the rest of this page, and **swimlane fields**, described in [Swimlane (row) custom fields](#swimlane-row-custom-fields) below. The two are separate per-board schemas — a board may define a card field and a swimlane field with the same name, and they are never merged or compared.

Five field types are available:

| Type | Glyph | Stored as | Notes |
|---|---|---|---|
| Text | `Aa` | Free text | No length limit enforced client-side |
| Number | `#` | Numeric string | No range validation |
| Date | `📅` | ISO date | Rendered with a calendar picker in the card detail panel |
| Dropdown | `▾` | One of a fixed list of choices | Requires at least one choice |
| Checkbox | `☑` | `true` / `false` | Displayed as **Yes** / **No** |

A board can have up to **30 card fields**, and up to **2 of them pinned** to the card face at once. (Swimlane fields have their own, smaller caps — see [Swimlane (row) custom fields](#swimlane-row-custom-fields).)

---

## Managing card fields (Board Settings → Card fields)

!!! note "Tab renamed in 1.2"
    This tab was named **Fields** before 1.2. It was renamed to **Card fields** when [swimlane fields](#swimlane-row-custom-fields) shipped, so the two tabs read unambiguously side by side.

Open **Board Settings** and select the **Card fields** tab (alongside Members, Display, Rules, Sharing, and, since 1.2, Swimlane fields). Only board admins can create, edit, reorder, pin, or delete fields.

The tab lists every field defined on the board in display order, showing the type glyph, name, type label, and pin state. Hover a row to reveal **✎ Edit** and **✕ Delete**. Drag the `⋮⋮` handle to reorder fields — the order here is the order fields appear in the card detail panel and, for pinned fields, on the card face.

### Adding or editing a field

Click **+ Add field**, or **✎** on an existing field, to open the inline editor:

- **Field name** — required, unique on the board
- **Type** — one of the five types above, chosen from a row of buttons
- **Help text** — optional hint shown next to the input wherever the field is edited
- **Choices** (dropdown only) — add rows one at a time with **+ Add choice**, drag to reorder, or click **Paste a list** to bulk-add choices from a newline-separated block of text in one step
- **Pin to card face** — toggle to add this field's value to the card face (see [Pinned fields on the card face](#pinned-fields-on-the-card-face) below)

Click **Save field** to commit, or **Cancel** to discard.

!!! warning "Changing an existing field's type"
    If you change the type of a field that may already have values stored on cards, the editor shows an inline warning — **"Changing this field's type may make existing values unreadable"** — before you confirm. Visiban does not retroactively re-validate or convert existing card values against the new type, so a value stored under the old type can become unreadable or unwritable after the change. A brand-new, unsaved field has no existing values to protect and skips this warning.

### Field limits

The tab header shows a running count, e.g. `12 of 30 · 1 of 2 pinned`. As the board approaches the cap:

- At **28–29 fields**, a warning line shows how many fields are left before **+ Add field** locks out
- At **30 fields**, **+ Add field** is disabled with an inline explanation — delete an existing field to make room

### Pinned fields on the card face

Up to **2 fields per board** can be pinned so their values show directly on the card face without opening the card. Toggle **Pin to card face** in the field editor, or click the **Pin** button on a field's row.

If 2 fields are already pinned and you try to pin a third, a swap prompt appears naming the 2 currently-pinned fields — pick which one to replace. Unpinning a field doesn't delete its data: unpinned values remain visible in the card detail panel and in the [hover peek](#hover-peek).

### Deleting a field

Click **✕** on a field's row. Deleting a field is permanent — it removes the field definition **and every card's stored value for it**. To confirm, type the field's exact name into the confirmation dialog.

!!! danger "This cannot be undone"
    There is no way to recover a deleted field's values. If you only want to stop showing a field on the card face, unpin it instead of deleting it.

### Viewing fields as a non-admin

Members, collaborators, and viewers see a read-only list of the board's fields — name, type, and pin status — with a banner explaining that only board admins can add or edit fields.

---

## Custom fields on the card face

Pinned field values render as small bordered chips in the card's metadata row, alongside labels and checklist progress, in the format `Field name: value`. A dropdown value shows a small color dot before the value; a checkbox value shows **Yes** or **No**. Long values are truncated with an ellipsis; hover the chip to see the full value.

An unset pinned field is hidden at **Comfortable** and **Standard** card density (see [Card density](board.md#card-density)) to keep the card face uncluttered. At **Dense** density, an unset pinned field shows as a dashed "ghost" chip instead, so power users always see the full set of pinned fields whether or not they're populated.

### Quick edit from the card face

Checkbox and dropdown chips are directly editable from the card face, without opening the card: click a checkbox chip to toggle it, or click a dropdown chip to open a small popover and pick a new value. The editable affordance is a dotted underline under the value — shown at all times, not just on hover, so it's discoverable without training. Text, number, and date fields are not quick-editable from the card face; edit them in the card detail panel.

---

## Custom fields in the card detail panel

The card detail panel shows a collapsible **Custom fields** section (below Labels, above Weight) listing every field defined on the board — not just the pinned ones — each with its own typed input:

- **Text** — plain text input
- **Number** — numeric input
- **Date** — calendar picker
- **Dropdown** — select from the field's defined choices
- **Checkbox** — toggle

Each field autosaves on change, the same way other card detail fields behave. The section opens automatically if any field already has a stored value on the card; otherwise it starts collapsed and expands on click.

If the board has no custom fields defined, this section doesn't appear at all.

---

## Hover peek

Hovering a card for 600 ms opens the existing [card peek popover](board.md#card-peek). In addition to weight, attachment count, and last-moved information, the peek now lists any **non-pinned** custom field values that have data — so a field's value is never hidden just because it isn't one of the board's 2 pinned slots. The list is capped at 6 entries; beyond that, a `+N more` marker summarizes the rest. Pinned fields are not repeated here since they already show on the card face.

---

## Filtering by custom fields

The board's filter bar shows one filter control per **pinned** custom field by default — matching what's visible on the card face. Click **+ Custom fields** in the filter bar to add or remove filter controls for any other field on the board.

| Field type | Filter behavior |
|---|---|
| Text | Substring match |
| Number | Exact value match |
| Date | Exact value match |
| Dropdown | Multi-select of choices |
| Checkbox | Multi-select of Yes / No |

!!! note
    Number and date filters match an exact value only — there is no range filter (e.g. "between" or "greater than") in this release.

Which extra field controls you've added via **+ Custom fields**, and the values you've set in them, persist per-board in your browser alongside the rest of the filter bar state.

---

## Swimlane (row) custom fields

Board admins can also define typed fields on **swimlanes** (rows) instead of cards — a separate per-board schema from the card fields above. Use a swimlane field to capture something that belongs to the row as a whole rather than to any one card on it: an owner, a region, a renewal date. Swimlane fields use the same five types as card fields — Text, Number, Date, Dropdown, and Checkbox.

A board can have up to **15 swimlane fields**, and up to **3 of them pinned** to the swimlane label panel at once.

### Managing swimlane fields (Board Settings → Swimlane fields)

Open **Board Settings** and select the **Swimlane fields** tab, beside **Card fields**. Only board admins can create, edit, reorder, pin, or delete swimlane fields.

The tab lists every swimlane field in display order, with the same type glyph, name, type label, and pin state that the Card fields tab uses. The tab header shows a running count, e.g. `12 of 15 · 2 of 3 pinned`. At **13–14 fields**, a warning line shows how many fields are left before **+ Add field** locks out; at **15 fields**, **+ Add field** is disabled with an inline explanation.

The field editor is the same shape as the card field editor — name, type, help text, choices for dropdowns, and a pin toggle — plus one addition:

- **Admin only** — toggle, **on by default** for a new field. An admin-only field's values are withheld from every non-admin role entirely: members and viewers never receive the value over the API or the WebSocket, so there is nothing hidden client-side for them to discover. A padlock glyph marks an admin-only field in the settings list, on its chip in the swimlane label panel, and next to its input in the Edit Swimlane modal.

!!! note "Field type is locked once a swimlane holds a value"
    Unlike a card field, a swimlane field's **type cannot be changed once any swimlane on the board holds a value for it** — this is enforced by the API, not just a client-side caution. The field editor disables the other type buttons and explains why. Delete the field and add it again under a new type if you need to change it.

### Pinned fields in the swimlane label panel

Up to 3 pinned swimlane fields render as chips in the swimlane's label panel — the sticky left column, alongside the swimlane's name — stacked below the row name. They're hidden while the swimlane is collapsed, the same way the rest of the label panel's detail is. If the swimlane has further, unpinned field values set, a trailing `+N` chip opens a read-only popover listing every value the current viewer may see.

### Editing values (Edit Swimlane modal)

Swimlane field values are set in the **Edit Swimlane modal**, which gains a **Fields** section listing every field defined on the board (the section doesn't appear if the board has none). Editing a swimlane is already admin-only, so **only board admins can set swimlane field values at all**, regardless of a field's Admin only toggle — the toggle controls who can *read* a value, not who can *write* it. Edits are held in the modal and saved together with the rest of the swimlane when you click **Save**; they do not autosave field-by-field the way card fields do in the card detail panel.

---

## API and real-time events

This page covers the UI. For the wire format:

- Field definition CRUD and reordering — [`/api/v1/boards/{id}/custom-fields/`](../api/boards.md#custom-fields-since-12)
- Card values — the `custom_field_values` field on the card payload — [Cards API](../api/cards.md)
- Real-time updates — `custom_field.created`, `custom_field.updated`, `custom_field.deleted`, and `custom_field.reordered` WebSocket events — [WebSockets](../api/websockets.md)
- Swimlane field definition CRUD and reordering — [`/api/v1/boards/{id}/swimlane-custom-fields/`](../api/boards.md#swimlane-custom-fields-since-12)
- Swimlane values — the `custom_field_values` field on the swimlane payload — [Boards API](../api/boards.md#swimlanes)
- Swimlane real-time updates — schema changes arrive as `swimlane_custom_field.created`, `swimlane_custom_field.updated`, `swimlane_custom_field.deleted`, and `swimlane_custom_field.reordered`; value changes arrive on the existing `swimlane.updated` event — [WebSockets](../api/websockets.md#swimlane-field-events-since-12)
- Board export (CSV and JSON) includes swimlane field values alongside card field values, with admin-only fields omitted entirely for a non-admin exporter — [Export & Import](../api/boards.md#export-import)

---

## Limitations in this release

| Limitation | Detail |
|---|---|
| No conditional coloring | Custom field values cannot be color-coded by threshold (e.g. red above N) |
| No range filtering | Number and date filters match an exact value only, not a range |
| `is_required` not enforced | The field definition has a "required" concept in the data model, but it is not enforced in the UI or API in this release — a field marked required can still be left blank |
| Type changes aren't guarded server-side | The inline warning in the field editor is a client-side caution, not a backend safeguard; the API does not validate a retyped field's existing values |
| Swimlane fields aren't filterable | The board's filter bar only offers controls for card fields; swimlane field values cannot be used as filter criteria in this release |
| `is_required` not enforced (swimlane fields) | Same gap as the card-level entry above — a swimlane field marked required can still be left blank in the Edit Swimlane modal |

Teams with more advanced custom field needs — beyond what a single board's admin can configure here — should look at [Visiban Enterprise](https://visiban.com/enterprise).
