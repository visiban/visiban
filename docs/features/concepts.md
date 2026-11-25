# Concepts at a glance: one definition per term

<a id="concepts"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

Each term the app uses for organizing work has one plain definition here, with what it belongs to, where to find it, and a link to its full section. The app links to these definitions, so a term in a tooltip or a settings panel lands on the entry below.

**Why it matters:** several terms sound alike. A checklist item and a child card both break a card down, and a sub-column and a track both sit inside a column, but each does a different job. To choose between them, see [Breaking work down: which tool?](breaking-work-down.md).

**How it works:** every entry has the same four lines: what it is, what it belongs to, where to find it, and the section that explains it in full. The anchor of each entry is stable: a heading elsewhere can be renamed without breaking a link to the entry here (see [Anchors](#concept-anchors)).

**Yes, but:** this page defines terms; it does not repeat the rules. Limits, permissions and edge cases are in the linked sections.

---

## Terms by owner

| Belongs to | Terms |
|---|---|
| A card | [checklist item](#concept-checklist-item), [child card](#concept-child-card), [planned child](#concept-planned-child) |
| A column | [stage](#concept-stage), [stage settings](#concept-stage-settings), [sub-column](#concept-sub-column), [track](#concept-track), [entry criteria](#concept-entry-criteria), [column policy](#concept-column-policy), [WIP limit](#concept-wip-limit) |
| A board | [custom field](#concept-custom-field), [field set](#concept-field-set), [Band, Details and Hidden](#concept-field-visibility) |
| A board or group | [health status](#concept-health-status) |

## Work inside a column

### Stage

<a id="concept-stage"></a>

A **stage** is a column. A stage split into sub-columns is a **gated stage**.

- **Belongs to:** the board.
- **Where do I find it?** The board grid. The column's header menu opens its settings.
- **Full section:** [Board & Cards: Columns](board.md#board-columns).

### Stage settings

<a id="concept-stage-settings"></a>

**Stage settings** is the tab where a board admin sets up a column's sub-columns, tracks and swimlane exceptions, for every card in that column.

- **Belongs to:** the column.
- **Where do I find it?** The column's **⋮** menu, then **Stage settings…** (the **Stage** tab of the column settings). On a phone, **Column actions**, then **Stage settings**.
- **Full section:** [Sub-columns and tracks](board.md#stage-settings).

### Sub-column

<a id="concept-sub-column"></a>

A **sub-column** is one ordered step inside a stage. Every card in the stage passes through the steps from left to right. A stage has no sub-columns or 2 to 4 of them.

- **Belongs to:** the column.
- **Where do I find it?** On the board, as the dashed divisions under the column header. To change them, **Stage settings…**, then **Sub-columns, in order**.
- **Full section:** [Sub-columns and tracks](board.md#sub-columns-and-tracks).

### Track

<a id="concept-track"></a>

A **track** is a check every card in a stage needs, which can be finished in any order. Each card shows a chip per track: done, open or not applicable. A track is a dropdown field, and its value is set in the card's **Custom fields**.

- **Belongs to:** the column (its value belongs to each card).
- **Where do I find it?** The chips on the card. To add one, **Stage settings…**, then **Tracks, any order**, then **Add track**.
- **Full section:** [Sub-columns and tracks](board.md#sub-columns-and-tracks) and [Dimension fields](custom-fields.md#dimension-fields-13).

### Entry criteria

<a id="concept-entry-criteria"></a>

**Entry criteria** are the short list of what must be true before a card moves into a column. They are part of the column's policy and are guidance: in the web app a column can ask the mover to confirm them, but the server never refuses a move because of them.

- **Belongs to:** the column.
- **Where do I find it?** The **Policy** button in the column header. To write them, the column's **⋮** menu, then **Add policy…**, or **Board settings → Rules & limits → Column policies**.
- **Full section:** [Column Policies](column-policies.md#column-policies).

!!! note "Entry requirements"
    Entry criteria are advisory text. A rule the server enforces on a move, such as a field that must be filled before a card enters a column, is a different thing, called an entry requirement. Entry requirements are not described here yet; they are tracked in #2602. Use WIP limits or [Field Enforcement](../architecture/field-enforcement.md) to see what the server enforces today.

### Column policy

<a id="concept-column-policy"></a>

A **column policy** is a column's entry criteria and its definition of done, plus a mode: **Advisory**, or **Ask the mover to confirm** (shown as a **Confirm on entry** badge).

- **Belongs to:** the column.
- **Where do I find it?** The **Policy** button in the column header. Admins edit it from the column's **⋮** menu or from **Board settings → Rules & limits → Column policies**.
- **Full section:** [Column Policies](column-policies.md#column-policies).

### WIP limit

<a id="concept-wip-limit"></a>

A **WIP limit** is the most active cards a column (or a swimlane) should hold at once. The column header shows `count / limit` with a meter. Whether a move past the limit is refused depends on the board's **Enforce WIP limits** setting and its **Hard mode (no admin override)** option.

- **Belongs to:** the column, or a swimlane.
- **Where do I find it?** The column header. To change it, the column's **⋮** menu, then **Edit settings…**. Enforcement is in **Board settings → Rules & limits**.
- **Full section:** [Columns](board.md#wip-limit) and [Hard WIP enforcement](board.md#hard-wip-enforcement).

## Work inside a card

### Checklist item

<a id="concept-checklist-item"></a>

A **checklist item** is a to-do inside one card, either done or not done. It can have an assignee and a due date, but no columns or history of its own.

- **Belongs to:** the card.
- **Where do I find it?** Open the card; the **Checklist** section is on the **Details** tab. The card face shows a `✓ 3/7` count.
- **Full section:** [Card detail panel](board.md#checklist).

### Child card

<a id="concept-child-card"></a>

A **child card** is a card on another board that carries a piece of a parent card's work in its own workflow, such as the security team's review of a contract. The parent's footer shows the child's progress. A card is never both a parent and a child.

- **Belongs to:** the card (the parent), with the child living on another board.
- **Where do I find it?** The card's **Children** tab, with **Add child**. A board admin turns the feature on in **Board settings → Rules & limits → Child cards** with **Cards on this board can have children**.
- **Full section:** [Child cards setting](board.md#child-cards).

### Planned child

<a id="concept-planned-child"></a>

A **planned child** is a child card for work the parent will need at a later stage. It waits in the child board's first column and its due date does not count until the parent reaches the stage it is **Needed** at (or someone pulls it out of To do).

- **Belongs to:** the parent card.
- **Where do I find it?** **Add child**, in the **Needed** field (**Now**, or a later column on the parent's board). On the parent's **Children** tab it reads "Planned for a later stage".
- **Full section:** [Planned children](board.md#planned-child).

## Fields

### Custom field

<a id="concept-custom-field"></a>

A **custom field** is a named, typed value that a board admin adds to every card (a **card field**) or every swimlane (a **swimlane field**), such as a budget, a region or a sprint. A track is a custom field with extra rules.

- **Belongs to:** the board.
- **Where do I find it?** **Board settings → Card fields** or **Swimlane fields**. Values show on the card, in its **Custom fields** section, or on the lane band.
- **Full section:** [Custom Fields](custom-fields.md#custom-fields).

### Field set

<a id="concept-field-set"></a>

A **field set** is a named block that groups some of a board's card fields in the card detail, with a progress count of how many are filled. It only changes how fields are displayed: it holds no values and never blocks a move.

- **Belongs to:** the board.
- **Where do I find it?** **Board settings → Field sets**. On a card, the **Custom fields** section becomes **Field sets** once the board has one.
- **Full section:** [Field sets](custom-fields.md#field-sets).

### Band, Details and Hidden

<a id="concept-field-visibility"></a>

**Band**, **Details** and **Hidden** are the three places a swimlane field can show. **Band** is always visible on the lane band (2 fields). **Details** is behind the band's **Show N more** toggle. **Hidden** keeps the field off the band, though it can still be read, searched and filtered.

- **Belongs to:** the swimlane field, set per board.
- **Where do I find it?** **Board settings → Swimlane fields**, the **Show** control on each row.
- **Full section:** [Choosing where each field shows](custom-fields.md#field-visibility).

## Status

### Health status

<a id="concept-health-status"></a>

**Health status** is a judgment, set by hand or calculated, that a board or group is **On track**, **At risk** or **Off track**. A group's status carries down to its subgroups and boards until one sets its own.

- **Belongs to:** a board or a group.
- **Where do I find it?** Next to the star after a board's name, or under a group's name. Admins click it to set one.
- **Full section:** [Health Status](health-status.md#health-status).

---

## Anchors

<a id="concept-anchors"></a>

Every entry above has an explicit `<a id>` anchor, so a heading rename cannot break a link from the app. These are the ids on this page, and the ids on the feature pages that the entries link to. Do not rename or remove one without updating every link that uses it.

| Term | Anchor on this page | Anchor on its full section |
|---|---|---|
| Concepts (page) | `concepts.md#concepts` | none |
| Stage | `concepts.md#concept-stage` | `board.md#board-columns` |
| Stage settings | `concepts.md#concept-stage-settings` | `board.md#stage-settings` |
| Sub-column | `concepts.md#concept-sub-column` | `board.md#sub-columns-and-tracks` |
| Track | `concepts.md#concept-track` | `board.md#sub-columns-and-tracks` |
| Entry criteria | `concepts.md#concept-entry-criteria` | `column-policies.md#column-policies` |
| Column policy | `concepts.md#concept-column-policy` | `column-policies.md#column-policies` |
| WIP limit | `concepts.md#concept-wip-limit` | `board.md#wip-limit` |
| Checklist item | `concepts.md#concept-checklist-item` | `board.md#checklist` |
| Child card | `concepts.md#concept-child-card` | `board.md#child-cards` |
| Planned child | `concepts.md#concept-planned-child` | `board.md#planned-child` |
| Custom field | `concepts.md#concept-custom-field` | `custom-fields.md#custom-fields` |
| Field set | `concepts.md#concept-field-set` | `custom-fields.md#field-sets` |
| Band, Details and Hidden | `concepts.md#concept-field-visibility` | `custom-fields.md#field-visibility` |
| Health status | `concepts.md#concept-health-status` | `health-status.md#health-status` |
