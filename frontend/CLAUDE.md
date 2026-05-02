# Frontend UI Conventions

## Color tokens

- **Always use `slate`, never `gray`** — they are not interchangeable. `gray` is warmer/less blue-tinted and creates visible mismatch on adjacent surfaces in the dark theme.

**Three-level background depth system** — use these levels consistently, never flatten them:

| Level | Usage | Class |
|---|---|---|
| Deepest | Grid cells, page canvas | `bg-canvas` |
| Mid | Column headers, swimlane labels, card surfaces, panels | `bg-surface` |
| Elevated | Dropdowns, modals, popovers | `bg-surface` with `shadow-xl` |

- Borders: `border-line-subtle` for grid lines (subtle), `border-line` for panels, `border-line-strong` for interactive elements
- Text: `text-fg` for primary content, `text-fg-secondary` for secondary, `text-fg-muted` for muted/stats

## Section header actions

When a section header (e.g. "My Boards", "Groups") carries action buttons:
- Place them right-aligned in a `flex items-center gap-2` group
- Primary action (e.g. "+ New board"): primary button variant
- Secondary action (e.g. "Import"): secondary button variant — **not** `text-info`; that color is reserved for active filter/selection states
- Do **not** use a full-width dashed bottom button as the primary creation affordance when the section already has content — that pattern reads as an empty state

## Buttons

Three variants — use no others:

| Variant | Classes |
|---|---|
| Primary | `bg-button-primary hover:bg-button-primary-hover text-on-primary` |
| Secondary | bare text (`text-fg-secondary`) + `hover:text-fg hover:bg-surface-hover` |
| Icon-only | `hover:bg-surface-hover` with icon content |

- Consistent sizing: `px-3 py-1.5 text-sm rounded` for most buttons
- Focus state: `focus:outline-none focus:ring-2 focus:ring-primary-emphasis` (use `focus:ring-danger-emphasis` for danger buttons) — always use `focus:` not `focus-visible:` for consistency
- Danger variant (destructive actions): `bg-danger-bg hover:bg-danger-bg-hover text-on-danger`
- Disabled state: `disabled:opacity-40 disabled:cursor-not-allowed` — never `disabled:opacity-50`
- Primary and danger buttons always include `font-medium`
- Border radius: always `rounded` — never `rounded-lg` on buttons

**Why `--button-primary` is a separate token from `--primary`:** CTAs use `blue-900` (`#1e3a8a`, 10.36:1 on white) in light mode for comfortable AAA contrast, while `--primary` stays `blue-600` for brand-tint surfaces (avatars, active tabs, toggle tracks, saved-filter tabs). Do not consolidate these back into a single token — issue #855 intentionally split them so primary CTAs read as strong actions without desaturating the app's blue accents. Dark mode assigns both tokens the same blue-600 value; the split only matters on light backgrounds. Never use `bg-primary` on a button-shaped element, and never use `text-fg` on a `bg-button-primary` fill — `text-on-primary` is the only permitted text color on primary CTAs.

## Inputs and textareas

- `bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary`
- Focus ring: `focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent`
- Placeholder: `placeholder-fg-muted`

## Dropdown menus

All dropdowns — `SelectDropdown` or hand-rolled — must follow this style:

**Trigger button**
- `bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition`
- Default state: `border-line-strong text-fg-secondary hover:border-line-emphasis`
- Open / active-filter state: `border-primary-soft text-info`

**Menu panel**
- `bg-surface border border-line-strong rounded-lg shadow-lg py-1`

**Menu items**
- `w-full text-left px-3 py-1.5 text-sm transition hover:bg-surface-hover`
- Default text: `text-fg-secondary`; selected/active: `text-info`

**Separators** (3D engraved effect — every adjacent item pair, all dropdowns):
```tsx
{i > 0 && (
  <div role="separator" className="mx-4">
    <div className="h-px bg-sunken" />
    <div className="h-px bg-surface-active/50" />
  </div>
)}
```
- Place before each item where `i > 0`; no manual `separatorBefore` prop needed
- `SelectDropdown` handles this automatically; hand-rolled dropdowns (e.g. FilterBar) must add it manually

**Disabled dropdowns must include an explanation** — when rendering `<SelectDropdown disabled={true}>`, always pass `disabledReason="..."`. The component renders it as a `title` attribute and `aria-label` on the trigger. A silently greyed-out control with no explanation is inaccessible and a dead end for all users.

## Modals and dialogs

- Backdrop: `fixed inset-0 bg-backdrop/60 z-50`
- Panel: `bg-surface border border-line rounded-lg shadow-xl`
- Consistent padding: `p-6` for content, `pb-4` for header
- Close button: icon-only variant, top-right corner
- Footer layout: `flex items-center justify-end gap-3` — always `gap-3`, never `gap-2`
- **Fixed-height tabbed modals** — when a modal contains tabs with variable content height, give the panel a fixed height (`h-[85vh] max-h-[640px] min-h-0`) rather than only a max-height. This prevents layout jumping between tabs. The scrollable content region uses `overflow-y-auto flex-1` and the panel uses `flex flex-col`. Never use `max-h` alone on a tabbed modal panel.
- **Inline confirmation for destructive toggles** — for settings toggles that have immediate, board-wide, non-reversible effects (e.g. enabling hard WIP enforcement), show an inline confirmation row before committing the change. On toggle click, replace the toggle row with a text prompt + Confirm + Cancel text buttons at `text-xs` scale (reuse the member-removal confirm pattern in `BoardSettingsModal`). On Cancel, revert the toggle. Do not use a modal-within-modal or a danger-zone text input for toggle-level confirmations.

## Badges and labels

- **Priority pills use filled background everywhere** — green/orange/red/dark-red fill, white text. Do not use outline/ring style; filled is more immediately scannable.
- **Label pills are an exception to the filled-pill rule** — labels carry arbitrary user-assigned colors (any hue, any lightness), so white-on-fill would fail contrast on light labels. Use a tint (`color + "22"` alpha suffix for the background, `color + "44"` for the border) with the label color as the text color. This is the only permitted outline-style pill in the system.
- Filter active-count badge: `bg-primary-emphasis/20 text-info` — always use the `primary-emphasis` token for the fill so the badge tracks the active theme
- Consistent badge sizing: `px-2 py-0.5 text-xs rounded-full`

## Top chrome — two-row composition

The authenticated UI is framed by two horizontally-divided chrome rows and a main region. Maintain this skeleton across all routes; feature work lands inside the rows, not on top of them.

| Row | Purpose | Surface | Height | Typography | Landmark |
|---|---|---|---|---|---|
| Row 1 | App header (logo, breadcrumb, star, utilities, account) | `bg-sunken border-b border-line` | `h-14` | `text-sm text-fg` | `<header role="banner">` |
| Row 2 | Board chrome (view tabs, actions, utilities, connection status) | `bg-surface border-b border-line` | `h-10` | `text-xs text-fg-tertiary` (default; active view tab keeps its own active styling) | `<nav aria-label="Board toolbar">` |
| Filter row | Conditional card filter chips | `bg-surface border-b border-line` | auto (single row, wraps) | inherits | `role="search" aria-label="Card filters"` on the wrapper |
| Main | Route content | inherits from route | `flex-1` | — | `<main role="main">` wraps `<AuthenticatedRoutes>` in `App.tsx` |

- **The accessible name for Row 2 is `"Board toolbar"`, not `"Board chrome"`** — "chrome" is developer jargon that announces as meaningless noise in screen readers. If internal design docs reference "chrome", the landmark label still stays `"Board toolbar"`.
- **Vertical dividers** between logical zones inside Row 2: `w-px h-4 bg-surface-hover mx-1` with `aria-hidden="true"`. Use between zone 1/2 and zone 2/3; never as a heading/section break.
- **Row 2 single source of vertical rhythm** — the outer `<nav>` owns the `h-10 flex items-center`. The inner toolbar container uses `h-full flex items-center` and must not re-introduce `py-*` padding, which would double-pad against zone button `p-1.5`/`px-3 py-1` heights.
- **Horizontal overflow behavior on narrow viewports:** when Row 2 has a pinned trailing cluster (overflow kebab + connection status), the scrollable region is an inner wrapper with `flex-1 min-w-0 overflow-x-auto`, not the outer `<nav>`. The inner toolbar inside that region uses `min-w-max` so the control set scrolls horizontally. The pinned cluster sits as a sibling flex-child of the scrollable region with `shrink-0` and `border-l border-line` so it is always visible even when the scroll region overflows. When a Row 2 layout has no pinned trailing cluster (e.g. non-board routes), `overflow-x-auto` may stay on the outer `<nav>`.
- **Never add a fifth landmark in chrome** — if a future feature needs a new region, fold it into one of the existing landmarks. Four landmarks (`banner`, `navigation: Breadcrumb`, `navigation: Board toolbar`, `search: Card filters`) plus `main` is the cap.
- **Always query landmarks by accessible name in tests** — with multiple `<nav>` elements in the tree, bare `getByRole('navigation')` is ambiguous. Use `getByRole('navigation', { name: 'Board toolbar' })`.

## Board navigation bar

This section refines the Row 2 landmark described in § Top chrome — two-row composition above. Anything here is scoped to individual controls inside that `<nav aria-label="Board toolbar">`; the outer surface, height, typography, and dividers are set by the top-chrome section. Do not re-specify them here.

The sub-nav bar directly below the main navbar contains view tabs, actions, and status:

- **Active tab** (e.g. "Board"): `bg-primary text-on-primary rounded px-3 py-1 text-sm font-medium`
- **Inactive tabs** (e.g. "Summary", "Analytics"): `text-fg-tertiary hover:text-fg px-3 py-1 text-sm` — no background
- **Vertical separators** between logical groups: `text-fg-faint select-none` rendered as `|`
- **Connection status**: use the `ConnectionStatus` component (see § Connection status indicator below) — single canonical component for the sub-nav live indicator and for the group detail header
- **Settings link**: `text-fg-tertiary hover:text-fg text-sm`

## Column kebab menu (#965)

Each column header carries a `⋮` overflow kebab as the discoverable surface for column-scoped actions. The kebab is the *only* keyboard-reachable path to column rename, settings, and delete — no separate `✎` icon button.

- **Trigger:** `OverflowMenu` instance with `ariaLabel={\`Actions for column "${column.name}"\`}` so screen readers announce *which* column is being acted on. The trigger uses the standard kebab styling and is wrapped in `opacity-0 group-hover/col:opacity-100 focus-within:opacity-100 transition` so it is hidden at rest, revealed on column hover, and stays visible when keyboard focus enters the menu (per the hover-reveal-controls rule).
- **Items, in order:**
  1. `Rename` — sets the column name into an inline editor (the same editor reachable by double-clicking the name)
  2. `Edit settings…` — opens `EditColumnModal` (color, WIP/weight limits, allow card creation, is_done)
  3. `Delete column` — danger-styled (`OverflowItem.danger: true`), preceded by an engraved separator. Routes to the confirmation dialog.
- **Non-admins see no kebab affordance** — the control is hidden entirely from the DOM, per the *Conditional admin-only elements* rule. Do not render a greyed-out `⋮` glyph, a disabled trigger, or a tooltip explaining missing permission; affordances Sam (occasional, non-admin) cannot use should not look like affordances at all.
- **Double-click on the column name** continues to open `EditColumnModal` as a power-user shortcut; the kebab is the discoverable path.

## Column delete confirmation (#965)

Deleting a column is permanent and removes every card in it (active and archived). The confirmation dialog applies a tiered safety pattern:

- **Empty column** — a plain `Cancel` / `Delete` modal is sufficient. There is nothing destructive to mistype against; adding name-typed friction here is noise.
- **Column with cards** — the dialog renders the same name-typed danger-zone pattern used for board deletion in `BoardSettingsModal`: an input with the column name in `font-mono`, a `text-xs text-fg-muted` instruction line above it, and a `Delete` button that stays disabled until the typed value matches the column name exactly. Pressing Enter inside the input commits when the value matches. Closing the dialog (Cancel, Esc, or backdrop click) resets the input.
- The confirmation copy explicitly says how many active cards and that archived cards in the column will also be deleted. *This cannot be undone.* is the closing line.

## Column drag-to-trash gating (#965)

The destructive column trash drop zone is **opt-in via ⌥ (Alt)**, never visible by default during a column drag. Reorder is the common case; deletion is a deliberate, modifier-gated gesture.

- The trash zone renders only when `activeColumn !== null && altHeldDuringColumnDrag === true`. The Alt-tracking `keydown` / `keyup` / `blur` listeners register only while a column drag is active so the global-keyboard footprint is empty at rest.
- The drag overlay shows a small hint below the dragged column name: `Hold ⌥ to delete` (`text-xs text-fg-muted`) flips to `Drop on trash to delete` (`text-xs text-danger`, `aria-live="polite"`) the moment Alt is held. The hint is the discoverability cue for the gated gesture.
- Dropping on the trash zone routes to the same name-typed confirmation dialog as the kebab `Delete column` path — there is one canonical column-delete dialog, never two.

## Column headers

- Background: `bg-surface` — one level above the cell canvas
- Layout: left nav arrow · colored dot · name (truncated) · right nav arrow, then a single stat row below
- Column name: `text-sm font-medium text-fg truncate`
- **Stat row — single line, worst-offender wins.** A column header renders exactly one stat line, never two stacked lines. The decision tree (priority order: WIP > Weight > calm):
  - **Over WIP** → `⚠ Over WIP · {count}/{limit}` (or `⛔` glyph when `hardWipEnforced`), `text-danger font-medium`, `title="Over WIP limit"`
  - **Over Weight** (and not over WIP) → `Weight {weight}/{limit}`, `text-warning font-medium`, `title="Over weight budget"`
  - **Calm** → `{count} cards` (`1 card` for a single card), `text-fg-muted`, `title="Cards in column"`
- **Drop the `WIP` / `Weight` label words in calm states.** The limit phrasing only earns its place when a column is actually over — otherwise the count alone reads faster on a scan.
- **Top accent strip — peripherally scannable cue for over-limit state.** When over WIP, render `border-t-2 border-t-danger-emphasis` on the header surface; when over weight (and not over WIP), `border-t-2 border-t-warning-emphasis`. The strip is the *only* over-limit chrome; the existing rule "text color + `font-semibold` only, no filled background" still holds for the stat text. Never use a filled `bg-danger/…` background for over-limit stats — it competes with the column header surface color.
- The collapsed (40px-wide) header mirrors the same top accent strip and shows a `⚠` glyph in red (over WIP) or amber (over weight, not over WIP). Title includes the over-limit reason for screen readers.
- Column color dot: `w-2.5 h-2.5 rounded-full flex-shrink-0` in the column's assigned color
- Nav arrows (`◄` / `►`): `text-fg-faint hover:text-fg-secondary text-xs transition`
- Column name truncates with ellipsis — never wraps

## Board grid cells

- Background: `bg-canvas` — darkest level, creates depth contrast with cards and headers
- Grid lines: `border border-line-subtle` — subtle, not prominent
- **Empty addable cells (#962)** — when a cell has no cards, the user can create cards in it (`column.allow_card_creation && canEdit`), and is not currently editing, the cell wrapper itself is the keyboard-reachable creation surface. Spec:
  - `role="button"`, `tabIndex={0}`, `aria-label="Add card to {column.name} in {swimlane.name}"` so screen readers announce *which* slot the action targets
  - `cursor-pointer hover:bg-surface-hover/30` on the cell so hover gives a soft wash; `focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis` for keyboard focus
  - Dashed inset border (`border border-dashed border-line/50`) is the visual frame
  - The visible **`+ Add card`** label is a centered, `pointer-events-none`, `aria-hidden="true"` overlay (`absolute inset-0 flex items-center justify-center text-xs text-fg-muted`) that brightens on cell hover/focus via `group-hover/cell:text-fg group-focus/cell:text-fg`
  - Click anywhere in the cell — or Enter / Space when focused — opens the new-card input. Double-click and right-click continue to work as before
  - During an active card drag, hide the centered overlay so the existing drop-target indicator owns the visual frame
- **Populated cells** keep the dense info-rich layout. The `+ Add card` affordance is the bottom-aligned button (`w-full text-left text-xs text-fg-faint hover:text-fg-secondary hover:bg-surface-hover/50 mt-1`) and the cell wrapper is *not* `role="button"` — power users can Tab from the last card directly into the bottom button without the cell intercepting Enter.
- **Never render two creation affordances on the same cell.** Empty cells have the cell-as-button only; populated cells have the bottom button only. The two states are mutually exclusive.
- Board stats corner cell (top-left, where header row meets swimlane column): stacked `text-xs text-fg-muted` lines for col/lane/card counts

## Card density (#961)

Each board has an admin-controlled `card_density` setting that drives how much metadata renders on the card face. The three tiers are:

| Tier | Default for | Card face shows |
|---|---|---|
| `comfortable` | New boards (1.1+) | One urgency badge, one primary label + `+N`, checklist progress, assignee. *Weight, attachments, last-moved, extra labels, priority badge, description indicator → moved to the hover peek.* |
| `standard` | (admin opt-in) | Adds a second label (2 + `+N`), due date when not folded into the urgency badge, weight pill (`>1`), attachment count. Still suppresses the priority badge (the colored card border carries priority) and last-moved text. **Named `standard` not `compact`** to avoid colliding with the per-user *Card layout: Compact / Expanded* toolbar pref. |
| `dense` | Existing boards migrated from 1.0 | Today's pre-1.1 layout — every metadata field on the card face. **Does not render the new urgency badge** (the per-field cues already cover the same signals). |

- The new urgency badge is a worst-offender classification: **overdue > due-soon (≤72h) > stale (server `is_stale`) > recent (<24h since last move)**. Implemented in `frontend/src/utils/cardUrgency.ts` (`classifyCardUrgency()`); pure function, server-anchored staleness, deterministic for tests via the optional `now` argument.
- The badge tone follows the design tokens (`text-danger` / `text-warning` / `text-info`) — no filled background, no second-tier border. *Stale* uses the full `text-warning` amber, not a softer `text-fg-secondary` — VoC feedback was that the soft tone read as too quiet next to a calm card.
- **Date-based urgency badges carry the formatted date inline** rather than the generic word: an overdue card reads `⚑ 2d late`, a due-soon card reads `⏱ Tomorrow`. The standalone due-date pill is suppressed at lower densities so the date is never duplicated, and never lost.
- At Comfortable density the standalone due-date pill is suppressed entirely (urgency badge is the single date signal; non-urgent dates move to the peek). At Standard the standalone pill is restored for cards outside the urgency window. At Dense the urgency badge is not rendered at all — the existing per-field cues stay.
- `density` is a *required* prop on `CardItem`'s public TypeScript shape but defaults to `"comfortable"` so any caller that forgets to pass it (e.g. drag overlay constructed without a board context) degrades gracefully.
- The hover peek (`CardPeekPopover`) renders the hidden metrics as a single muted line — `Weight 5 · 3 attachments · Moved 2d ago`. **Never stack them into multiple rows** — that recreates the wall-of-icons we just removed from the card face.
- Per-user per-field hide toggles (the prior `hideLabels` / `hideDueDate` / `hideAssignee` / `hidePriority` / `hideLastMoved` checkboxes in Board Settings → Display) are removed in 1.1. Density is the single knob; legacy localStorage values for those keys are silently ignored.
- The Board Settings *Display* tab gives admins a radio group (Comfortable / Compact / Dense) with a one-line description of each tier. Non-admins see a read-only line stating the current density.

## Cards

- Container: `bg-surface rounded-lg border p-2.5 cursor-grab`
- **Border color = priority/status indicator** — full border on all sides (not just left accent):
  - Default / low: `border-primary-emphasis`
  - Medium: `border-warning-emphasis`
  - High / blocked: `border-danger-emphasis`
  - No priority: `border-line`
- Card title: `text-sm text-fg`
- No drop shadow — the colored border provides visual weight
- Cards sit directly on the dark cell background; the contrast between `bg-surface` card and `bg-canvas` cell creates depth without shadow
- **Metadata row** (when present — assignee, tasks, due date): `flex items-center gap-2 mt-1.5 text-xs text-fg-muted`
  - Task count: `✓ {done}/{total}`
  - Due date: `Due MM/DD/YY`
  - Assignee badge: see Avatar chips section

## Avatar chips

- Shape: `rounded-full flex items-center justify-center flex-shrink-0`
- Size: `w-6 h-6 text-xs font-medium text-on-primary`
- Background: deterministic color based on user — use a consistent palette (teal `bg-palette-teal`, amber `bg-warning-bg`, violet `bg-palette-violet`, rose `bg-palette-rose`, etc.)
- Content: 2-letter uppercase initials only
- Position on cards: bottom-right, `absolute` or flex end
- Never show more than the initials — no full name, no tooltip required (but allowed)
- **Always use the `Avatar` component** (`src/components/Common/Avatar.tsx`) — never hand-roll avatar circles with inline palette arrays or hardcoded background colors. The `Avatar` component owns the canonical `-600` tone palette and handles initials, image avatars, and deterministic color assignment.
- **Sizes:** `xs` (20px), `sm` (24px, default chip on cards), `trigger` (28px, reserved for nav/chrome menu triggers — sits between chip and user-header sizes), `md` (32px), `lg` (40px)

## User menu (top-chrome)

The avatar-triggered user menu in `Navbar.tsx` is the single entry point for all account-scoped actions (`Profile & preferences`, `Keyboard shortcuts`, `Help & docs`, `Sign out`). Rules:

- **Trigger:** `Avatar` at `size="trigger"` (28px) + a small inline `▾` chevron. `aria-haspopup="menu"`, `aria-expanded={open}`, `aria-label={`Account menu for ${displayName}`}`. Never render a bare text `Sign out` button in the navbar — Sign out lives only inside the menu, is always the last item, and uses the danger treatment (`text-danger hover:bg-danger-bg/20`).
- **Panel:** `w-56 bg-surface border border-line-strong rounded-lg shadow-xl py-1 z-50`, `role="menu"`, positioned `absolute right-0 top-full mt-1` relative to the trigger.
- **Header row:** non-interactive `role="none"` block — display name in `text-sm font-medium text-fg`, email in `text-xs text-fg-muted`, both `truncate` with `title`. Omit the email line entirely when missing; never render a placeholder.
- **Items:** each a `<button role="menuitem">` (or `<a role="menuitem">` for external links) with the shared dropdown item classes plus a fixed `w-4 text-center flex-shrink-0` icon slot so labels align across rows. `tabIndex={-1}` on all items; roving focus via arrow keys, Home/End.
- **Separators:** standard engraved double-`<div>` pattern, `mx-4 my-1`. Two total: after header, before Sign out.
- **Dismissal:** Esc (via `useEscapeStack` at priority 25), outside-click, Tab out. On Esc close, refocus the trigger.
- **Theme entry is prohibited until a theme system ships** — do not add a dead link for theme switching.

## Connection status indicator

`ConnectionStatus` (`src/components/Common/ConnectionStatus.tsx`) is the single canonical component for surfacing WebSocket state. Do not re-introduce a second `LiveIndicator`, and do not render a bare `●ᅠLive` in feature components.

- **Prominence rule — quiet when healthy, loud when degraded.** Connected state is a bare success dot with the word "Live" shown only at `lg+` viewports (`labelClass: "hidden lg:inline"`). Every other state — `connecting`, `reconnecting`, `stale`, `failed` — always shows its label with an amber or red pill background so Maya/Jordan can see degraded state at a glance.
- **Five states:**
  - `connected` → `text-success` dot, no background
  - `connecting` / `reconnecting` / `stale` → `text-warning bg-warning/10 border border-warning/30 rounded px-2 py-0.5`
  - `failed` → `text-danger bg-danger-bg/30 border border-danger-emphasis/40 rounded px-2 py-0.5`
- **Stale detection:** `useIsStale(status, lastEventAt, thresholdMs = 60_000)` flips `connected` into the `stale` variant when no event has arrived within 60 seconds. Do not poll; the hook schedules a single `setTimeout`.
- **Popover:** click trigger opens a `role="dialog" aria-label="Connection status"` popover (`w-64 bg-surface border border-line-strong rounded-lg shadow-xl p-3`). Dismissal via Esc (`useEscapeStack` priority 25), outside-click, or re-clicking the trigger. On Esc close, refocus the trigger.
- **Popover actions:**
  - connected / stale → "Refresh board" secondary button (only when `onRefresh` is passed — board pages yes, group page no)
  - failed → "Reload page" danger button
  - connecting / reconnecting → informational only; no button
- **Accessibility:** trigger carries `aria-haspopup="dialog"`, `aria-expanded`, and a state-specific `aria-label` ("Real-time updates active" / "Reconnecting to real-time updates" / …). Include an inner `<span role="status" aria-live="polite" aria-atomic="true" className="sr-only">` that announces degraded states to screen readers; stay silent when connected.

## Swimlane label panel

- Background: `bg-surface` — visually distinct from the `bg-canvas` grid cells
- Color stripe: **`border-l-4`** in the swimlane's assigned color — thick enough to read at a glance; no thin stripes
- When a swimlane has a color, that same color bleeds as the left border of the entire swimlane row across all columns (applied to the label panel, not individual cells)
- Drag handle (`⋮⋮`): `text-fg-faint hover:text-fg-tertiary cursor-grab` — show on row hover via `group-hover:opacity-100`, default `opacity-0`
- Swimlane name: `text-sm text-fg-secondary`
- Collapse/expand chevron: prominent, `text-fg-tertiary hover:text-fg transition` — must clearly communicate interactivity
- Edit (✎) button: `group-hover:opacity-100 opacity-0 transition` — visible at full opacity on hover, not discoverable by accident

## Radio groups

Never render browser-default radio circles. Use `sr-only` native `<input type="radio">` inside a `label` container — this preserves native keyboard navigation (arrow keys, Tab, Space) while hiding the visual control.

Represent selection state on the container:
- Selected: `border-primary-emphasis bg-primary-emphasis/10`
- Unselected: `border-line-strong hover:bg-surface-hover/40`
- Keyboard focus: `focus-within:ring-2 focus-within:ring-primary-emphasis rounded-lg` on the `label`
- Transition: `transition-colors duration-150`

Option text: `text-sm text-fg font-medium` for the label, `text-xs text-fg-muted mt-0.5` for the description line below it.

The action button following a radio group uses the primary variant (`bg-button-primary hover:bg-button-primary-hover text-on-primary`) and its label should reflect the current selection (e.g. "Export JSON" / "Export CSV") to eliminate ambiguity.

## Ancestor breadcrumbs

Use this pattern whenever showing a full ancestor chain (e.g. group hierarchies):

```tsx
<nav aria-label="Group breadcrumb" className="flex flex-wrap items-center mb-1">
  {ancestors.map((ancestor, i) => (
    <span key={ancestor.id} className="flex items-center">
      {i > 0 && <span className="text-fg-faint mx-1.5 select-none">/</span>}
      <a
        href={`/groups/${ancestor.id}`}
        onClick={(e) => { e.preventDefault(); navigate(`/groups/${ancestor.id}`); }}
        className="text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition max-w-[12rem] truncate"
        title={ancestor.name}
      >
        {ancestor.name}
      </a>
    </span>
  ))}
  <span className="text-fg-faint mx-1.5 select-none">/</span>
  <span className="text-sm text-fg-secondary max-w-[12rem] truncate" title={current.name}>{current.name}</span>
</nav>
```

- Ancestor links: `text-sm text-fg-tertiary hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded transition`
- Separator `/`: `text-fg-faint mx-1.5 select-none`
- Current item (non-linked): `text-sm text-fg-secondary`
- Per-item max-width: `max-w-[12rem] truncate` with `title` attribute for full name
- Container: `flex flex-wrap items-center` — wraps on narrow viewports
- Root-level items with no ancestors render nothing (omit the `<nav>` entirely)

**Navbar breadcrumb override:** the top-chrome breadcrumb in `Navbar.tsx` uses the same pattern but renders the terminal (current) segment as `text-sm text-fg font-medium max-w-[18rem]` instead of `text-fg-secondary max-w-[12rem]`. The board/page name is the primary context indicator in the chrome, so it reads brighter and has more room to breathe. Standalone ancestor breadcrumbs elsewhere keep `text-fg-secondary max-w-[12rem]`.

## Inline description fields (non-RTE)

For plain-text description fields that are inline-editable by admins:

- **Idle / view state**: wrap content in a `border border-transparent hover:border-line-emphasis cursor-text rounded px-2 py-1.5 -mx-2 transition-colors` container; hover-reveal pencil icon must include `focus:opacity-100 focus:ring-2 focus:ring-primary-emphasis`
- **Edit state**: `bg-sunken border border-primary-soft rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent` on the `<textarea>`; `resize-none`; Escape cancels, blur saves
- **Error slot**: always render `<p className="text-xs h-4">` below the field unconditionally; place error text in a `<span className="text-danger">` inside it — never conditionally render the container itself
- **Non-admin, non-empty**: render plain `<p className="text-sm text-fg-tertiary whitespace-pre-wrap">`
- **Non-admin, empty**: render nothing (`null`) — do not show a placeholder the user cannot act on

## Tooltips

- Consistent delay: 300 ms show, immediate hide
- Placement: prefer `top` for icon buttons, `bottom` for nav items
- Style: `bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg`

## Inline status messages

- **Reserve vertical space unconditionally** — render the container element always (`<p className="text-xs h-4">`) and conditionally render the text content inside it. Never conditionally render the container itself; doing so causes buttons and surrounding elements to shift when messages appear or disappear.
- Error text: `text-danger`; success text: `text-success` — always on a `<span>` inside the reserved container, not directly on the `<p>`
- **Relabel destructive-escape actions after success** — if a modal stays open after a successful action, relabel "Cancel" to "Close" once success state is set, so the button's semantics match the user's situation

## Paired numeric settings fields

When two related numeric inputs belong to the same conceptual setting (e.g. threshold + warning percentage):

- Group them in a single `<section>` with a shared `<h3>` heading
- Render each as its own `flex flex-col gap-1.5` block (input row + helper text), stacked in a `flex flex-col gap-3` container
- Each input row: `flex items-center gap-2` with a `w-20` number input and a `text-sm text-fg-tertiary` unit label
- Helper text: `text-xs text-fg-muted` — explain the relationship between the two values with a concrete example
- Non-admin read-only view: single `text-sm text-fg-secondary` line combining both values (e.g. "14 days · 50% warning")
- `onBlur` saves each field independently via `patchBoard`; clamp values client-side before patching

## Loading and spinner states

- **Canonical animated spinner:** `w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin` (inline context). Use `w-8 h-8` for full-page center spinners. Always wrap in `flex items-center justify-center gap-2` with a `text-sm text-fg-tertiary` label when the wait context is not obvious.
- Center spinners with `flex items-center justify-center`

## Empty states

- Consistent pattern: centered icon (muted, `text-fg-faint`) + heading (`text-fg-tertiary`) + optional CTA button
- No one-off inline empty messages with different styling

## Typography

- **Minimum text size for informational content is `text-xs` (12px).** Never use `text-[10px]` or smaller arbitrary pixel sizes for stats, labels, status text, or any text the user is meant to read. Sub-12px arbitrary sizes are reserved for decorative single-glyph indicators where the meaning is carried by an adjacent label or `title` attribute (e.g. the rotated column abbreviation in a collapsed column header).
- Page headings: `text-xl font-semibold text-fg`
- Page-level section headings (Dashboard-style landmark regions like "My Boards", "Groups", "Favorite Boards"): `text-lg font-semibold text-fg`. These are top-level navigation regions on a full page, not sub-sections inside a card or panel. Pair each heading with an `id` and `aria-labelledby` on the enclosing `<section>` so the landmark has an accessible name.
- Section headings (sub-sections inside a card, panel, or modal): `text-sm font-medium text-fg-tertiary uppercase tracking-wide`
- Body: `text-sm text-fg-secondary`
- Muted/secondary: `text-sm text-fg-muted`
- Monospace (version strings, IDs): `font-mono text-xs text-fg-muted`

## Version display

- **Do not show a version badge or pill in the Navbar** — remove it entirely from the main nav
- Surface the version string in **Settings → About** only, where users can find it when filing support requests
- Style: inline `font-mono text-xs text-fg-muted`, no badge/pill wrapper

## Rich text editor

- **`RichTextEditor` is the only editor component** — never add a second Tiptap instance or markdown editor
- View mode uses `react-markdown` with `prose prose-sm` + `rehypeRaw` plugin — **never `dangerouslySetInnerHTML`**
- **Color token overrides: use `[&_el]:text-*` not `prose-el:text-*`** — the `prose-p:text-fg-secondary` modifier syntax is unreliable when class names appear in dynamically-joined arrays; always use explicit arbitrary variant selectors:
  ```
  text-fg-secondary                              ← base color on the prose wrapper itself
  [&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg
  [&_p]:text-fg-secondary [&_li]:text-fg-secondary
  [&_strong]:text-fg [&_em]:text-fg-secondary
  [&_code]:text-fg [&_code]:bg-surface-hover
  [&_pre]:bg-sunken [&_blockquote]:text-fg-tertiary
  [&_a]:text-info
  ```
- **`html: true` (default) on the Markdown extension is required** — `html: false` strips `<span style="color:...">` from the serialized output, silently discarding text colors on save. Never set `html: false`.
- **`rehypeRaw` is required on `<ReactMarkdown>`** to render `<span style="color:...">` HTML spans from the Color extension in view mode
- **`onKeyDown stopPropagation` is required on `EditorContent`** — prevents board-level single-key shortcuts (e.g. `f` for filter) from firing while the user types in the description
- **View/edit toggle pattern:** hover shows `border-line-strong cursor-text` + ✎ icon (`group-hover:opacity-100 opacity-0`); click enters edit mode with `border-primary-soft bg-sunken`. Apply this pattern to all future rich editable fields.
- `readOnly` prop must be wired to `!canEdit` at every call site — viewers see rendered markdown only, no hover affordance

## Conditional admin-only elements

- Admin-only nav items and UI elements must be **hidden entirely** for non-admin users — never greyed out or rendered with reduced opacity. Use `{user.is_site_admin && ...}` (or the equivalent condition) to omit the element from the DOM entirely.
- Never use `disabled` or `opacity-50` to signal lack of permission for a navigation link — if the user cannot access it, it should not be visible at all.

## Long URL display fields

- Truncate long URLs in read-only display inputs: `truncate overflow-hidden text-ellipsis whitespace-nowrap`
- The full value must remain in the clipboard on copy — only the display is truncated
- Add a `title` attribute (or tooltip on hover) showing the full URL

## Hover-reveal controls

When an action button is hidden until hover (`opacity-0 group-hover:opacity-100`), it **must** also include `focus:opacity-100` and a focus ring so keyboard users can reach and activate it. Without `focus:opacity-100`, the button is unreachable by keyboard. This applies to all hover-reveal controls (comment delete, swimlane edit, RTE pencil icon, etc.).

## Move-blocked toast (MoveBlockedToast)

- **Use `MoveBlockedToast` for all card move constraint violations** — WIP limit, weight limit, or any future column constraint. Never add a second inline toast block in `App.tsx`.
- **Always amber** — `border-warning / text-warning`. Do not introduce a second color for a different limit type; severity is communicated via icon, not color.
- **Always show three things**: what was blocked (column name), why (with numbers), and an admin override link when `isAdmin` is true.
- **Admin override link**: `text-xs text-warning hover:text-warning underline transition` — never a button with background fill.
- **Hard-block variant** (`error.code === "wip_hard_blocked"`): use `⛔` as the toast icon instead of `⚠`. This is the only permitted way to signal severity difference between soft and hard constraint blocks — do not change the amber color. Omit the admin override link for all roles. Add a `text-xs text-fg-tertiary` resolution line: "To unblock, move a card out of [column], or ask an admin to raise the WIP limit."

## Collapsed sidebar rail

The collapsed rail (48px, `w-12`) is for **fixed destinations only** — Dashboard, admin utility links, and a small number of curated shortcuts. Never render an unbounded list of items directly in the rail.

**Rule:** When a section has a variable number of items (boards, groups, favorites), represent it as a **single trigger icon** that opens a positioned flyout panel. Trigger icons sit in the rail like any other icon; the flyout panel appears to the right of the sidebar.

**Flyout panel spec:**
- Rendered via `createPortal(panel, document.body)` to escape the sidebar's `overflow-hidden`
- Positioned with coordinates captured at click time via `getBoundingClientRect()` on the trigger — store as `{ top, left }` state, never a ref
- `position: fixed; top: anchor.top; left: anchor.left + 4` (4px gap from sidebar edge)
- Panel: `w-56 bg-surface border border-line rounded-lg shadow-xl py-1 max-h-80 overflow-y-auto z-50`
- Header row: `px-3 py-1.5 text-xs font-semibold text-fg-muted uppercase tracking-wider border-b border-line mb-1`
- Items: `px-3 py-1.5 text-sm text-fg-secondary hover:text-fg hover:bg-surface-hover transition truncate`
- Active item: `bg-primary/20 text-info font-medium`

**Toggle behaviour:**
- Click to open, click again to close
- Add `onMouseDown={(e) => { if (open) e.stopPropagation(); }}` to the trigger so the flyout's outside-click (`document mousedown`) handler doesn't close it before the `onClick` toggle fires
- Opening one flyout closes any other open flyout (mutual exclusion via setting the other anchor to `null` in the click handler — do **not** use `useEffect`)
- Closed by: second click on trigger, click outside (document `mousedown` guard), Escape key

**Separators in the collapsed rail** use the same double-`<div>` engraved pattern as everywhere else — never a plain `<hr>`:
```tsx
<div className="mx-2 my-1.5">
  <div className="h-px bg-sunken" />
  <div className="h-px bg-surface-active/50" />
</div>
```

**Trigger active state:** when the currently active route belongs to an item inside the flyout, apply `text-info bg-primary/20` to the trigger icon (same as direct nav links). This communicates "you are here" without opening the flyout.

**Groups flyout hierarchy** — the Groups flyout must be populated by flattening `sidebarTree` in depth-first pre-order, not from the flat `groups` array. Never source the Groups flyout from `groups.map(...)`:
- Flatten using a local recursive function carrying a `depth` counter; pass the result as `FlyoutItem[]`
- Apply `paddingLeft: 12 + depth * 12` via inline style (matching the expanded tree formula — never Tailwind padding classes)
- Cap visual depth at 3: `Math.min(depth, 3)` — nodes deeper than 3 are clamped, not omitted
- Group items: set `icon: "group"` (folder icon); board items: `icon: "board"` (clipboard icon, the default)
- Inactive items at `depth > 0` use `text-fg-tertiary`; root items (`depth === 0`) use `text-fg-secondary`

## Sidebar explorer tree (expanded mode)

The expanded sidebar renders groups and their boards as a recursive tree. Rules:

- **Use `buildSidebarTree(groups, boards)` from `src/utils/groupTree.ts`** — never reconstruct the tree inline in the component. It returns `SidebarTreeNode[]` with `{ group, boards, children }` at every level.
- **Depth-based indentation uses inline style, never Tailwind padding classes** — `style={{ paddingLeft: depth * 12 + 8 }}`. This handles arbitrary depth cleanly. `depth` starts at `0` for root groups.
- **Only top-level groups appear as icons in the collapsed rail** — subgroups are reachable via the expanded tree only. Never add a collapsed icon for a group whose `parent !== null`.
- **`SidebarGroupNode` is the recursive component** — it renders a group row, its boards (as `BoardItem`), then its subgroup children. Boards appear before subgroups within the same level.
- **`BoardItem` uses `depth: number`** — never the old `indent: 1 | 2` prop. Depth cascades down from the containing group.

## First-encounter indicators

When surfacing a feature that users may not discover on their own, use a static dot indicator:

- **Token:** `bg-primary-emphasis rounded-full` — distinct from `bg-primary-soft`, which is reserved for active filter/selection states
- **Size:** `w-2 h-2` minimum — `w-1.5` (6px) is too small to draw attention at desktop scale
- **Position:** `absolute top-0 right-0` inside the button's `relative` wrapper
- **Pointer events:** always `pointer-events-none` — the dot must never intercept clicks intended for the button beneath it
- **Dismissal trigger:** first intentional click/activation of the associated button — not hover (hover is passive and transient)
- **Persistence:** use `user:prefs:{pref-name}` localStorage key with `false` as the "unseen" default (show dot); `true` means seen (hide dot). Follow the try/catch + fallback pattern in `useShowFullHistoryPref.ts`
- **No animation** — no pulsing, no fade-in. A static dot is sufficient and avoids motion-sensitivity concerns
- **Gate it on the same condition as the button** — if the button is hidden for viewers (`canEdit && onMoveCard`), the dot must be hidden too

## Toggle buttons (icon-only)

Icon-only buttons that toggle a persistent mode (e.g. focus mode, collapse) must include:

- `aria-pressed={boolean}` — exposes toggle state to screen readers; color-only treatment is invisible to assistive technology
- Updated `title` attribute when active (e.g. `isFocused ? "Exit focus" : \`Focus on ${name}\``) — tooltip text must reflect the current action, not the initial one
- The active visual treatment (e.g. `text-info !opacity-100`) is sufficient for sighted users; `aria-pressed` covers the rest

## User preference persistence

**User-scoped UI preferences** (toggles reflecting a reading habit or display style not tied to a specific board) use a single flat localStorage key in the format `user:prefs:{preference-name}`. Do not embed a board ID. Do not extend `useViewPrefs`. Create a dedicated hook following the try/catch + fallback pattern in `useViewPrefs.ts`. Never store UI-only preferences in the backend `UserSerializer` unless cross-device sync is an explicit requirement.

- **Board-scoped keys:** `board:{boardId}:{pref-name}` — for preferences that are per-board (hidden columns, filters, column widths)
- **User-scoped keys:** `user:prefs:{pref-name}` — for preferences that apply across all boards (reading habits, display toggles)

Each key in either namespace requires a `load()` function with try/catch + fallback-to-default, and a `save()` function that fails silently.

## Mode indicator banners

When a persistent board-wide mode is active (e.g. focus mode, a future "view-only" lock), render a full-width strip between the filter row and the scroll container. The strip must sit **outside** the scroll container so it does not scroll away.

- Style: `bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info transition-opacity duration-150`
- Use `bg-primary/15` to signal "active mode" — distinct from transient toast notices (`bg-surface-hover/80`) and warnings (amber)
- Exit controls within the strip use the **secondary button variant** (`text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:ring-2 focus:ring-primary-emphasis`) — never the primary variant
- Mode name or target label: `font-medium text-info truncate max-w-[24rem]` with `flex-shrink-0` on the exit button

## Common dropdown primitives

`SingleSelectDropdown`, `CheckboxDropdown`, and `SplitButton` live in `src/components/Common/`. Do not re-implement these inline in feature components. Both dropdowns follow the dropdown menu spec (trigger: `bg-surface border rounded px-2 py-1`, active/filtered state: `border-primary-soft text-info`). Any new component that needs a select or checkbox dropdown must import from `Common`, never duplicate inline.

### SplitButton

Use `SplitButton` whenever a toolbar action has a dominant single-click behavior plus a menu of granular variants (e.g. Collapse / Collapse lanes / Collapse columns). Rules:

- **Two sibling `<button>` elements** inside a visual container — each with its own tab stop and focus ring. Never implement a split button as a single focus target with two click zones; it fails the WAI-ARIA Menu Button pattern and breaks keyboard access for power users.
- **Segmentation token:** `border-line-strong` on the chevron's left edge — not `border-line`. The stronger token is required so the visual bisection is obvious at rest on `bg-surface`.
- **Primary segment size:** `text-xs px-2 py-1 rounded-l` — matches Row 2 text buttons (Filters, Archived).
- **Chevron segment size:** `px-1.5 py-1 rounded-r` with a `w-3 h-3` chevron SVG (stroke 1.5). Use the same chevron shape as `SingleSelectDropdown` (`M4 6l4 4 4-4`).
- **Menu open state** on the chevron: `text-info bg-info/10`, identical to the active-toggle treatment used by other Row 2 controls. The primary segment never changes state.
- **Menu panel** uses the shared dropdown chrome: `bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[200px]`, right-aligned to the chevron.
- **Items author their own content** via `renderMenu({ close })` — SplitButton owns positioning, outside-click, Escape handling, and open state; the caller decides the item shape, vocabulary, and disabled logic.
- **Menu vocabulary** must match app-wide terminology. In Visiban, the axis terms are "swimlanes" and "columns" (not "lanes", "rows"). Use action-first copy (`Hide all swimlanes`, not `Collapse lanes`) so occasional users aren't forced to learn domain jargon to operate the menu.
- **Disabled items stay rendered.** If an action would be a no-op (e.g. `Hide all swimlanes` when everything is already collapsed), apply `disabled` to the item rather than removing it — the menu shape is stable across states so users can build a mental model.
- **Two engraved separator groups** inside a collapse-style menu: Hide-variants first, Show-variants second, separated by the canonical double-`<div>` engraved separator. Both groups are always rendered.

### OverflowMenu

`OverflowMenu` in `src/components/Layout/` is the Row 2 kebab (`⋮`) menu. It is driven by an `items: OverflowItem[]` prop so enterprise surfaces (audit log, automation rules) can inject entries without modifying the OSS component.

- **Trigger icon:** `p-1.5 rounded` kebab (`w-4 h-4` SVG with three `r=1.75` circles), `text-fg-tertiary hover:text-fg hover:bg-surface-hover`. Open-state uses `text-info bg-info/10`.
- **First-encounter dot:** uses the shared `user:prefs:overflow-seen` key via `useOverflowSeenPref`. The dot clears on **intentional click of the kebab**, never on the `.` keyboard shortcut — the shortcut proves the user already knows the menu exists.
- **Row anatomy:** `flex items-center gap-3 px-3 py-1.5 text-sm text-fg-secondary`, three slots — a `w-4 text-center` icon, a `flex-1 truncate` label, and an optional right-aligned `<kbd>` shortcut hint styled identically to `KeyboardShortcutsOverlay`.
- **Separators** use `separatorBefore: true` on the item that should be preceded by the engraved double-`<div>`. The separator is implicitly omitted on the first rendered item.
- **Disabled items require `disabledReason`** — the string is rendered as a `title` attribute and contributes to the `aria-label`. A silently-greyed item is a dead end; always explain why.
- **Items are responsive-aware** — at sub-`lg` viewports, fold the direct Row 2 secondary controls into the items array so functionality is preserved without cluttering the toolbar. Do not spray `matchMedia` checks across consumers; use `useIsLargeViewport` / `useIsMediumViewport` hooks and build the items list in `BoardView` once.

- **`SingleSelectDropdown` — `triggerPrefix` slot for decorative icons.** When a trigger needs a leading icon (e.g. `🔍 This board ▾`), pass it via the `triggerPrefix` prop. The component wraps the node in `aria-hidden="true"` — keep the accessible name on the dropdown label, not the icon. Do not bake icons into each option label; that duplicates the glyph across the menu panel and couples the icon to the option rather than the trigger.

## Global search entry (Row 1)

The `🔍` button in `Navbar.tsx` is the single visible entry point for the command palette. Do not render a second palette trigger button anywhere in the chrome — the Row 2 icon was removed in #852. Clicking the button dispatches a `visiban:open-palette` window event; `GlobalCommandPalette` (#869) listens for it and opens the palette with the right mode for the current surface.

- **Visible copy adapts per surface** — driven by `useNavbarSearchLabel`. On board routes the label reads `Search cards`; on Dashboard/Group routes it reads `Jump to board`; on Settings/Admin it reads `Jump to…`. Do not hard-code the copy; always route through the hook so the trigger and the palette placeholder stay in sync.
- Responsive width: icon-only square at sub-`lg` (`w-8 h-8 justify-center`), `w-56` at `lg+` to fit the widest adaptive label plus the `⌘K` hint
- Accessible name: `{placeholder} (Cmd+K)` — the magnifying-glass emoji is decorative (`aria-hidden`)
- Never re-add a Row 2 palette trigger, and never wire a new component to open the palette directly — always dispatch `visiban:open-palette` so the single listener in `GlobalCommandPalette` stays authoritative

## Command palette ownership (#869)

The command palette is owned by `GlobalCommandPalette` at two shell-level mount points:

1. **Inside `BoardPage`** (inside `BoardProvider`) — mounts on every `/boards/*` route so the palette is available on every sub-tab (Board/Summary/History/Analytics) and has access to board cards via `useOptionalBoardContext()`.
2. **Inside `AuthenticatedRoutes`** (above the route tree, only when pathname does NOT start with `/boards/`) — mounts on Dashboard, Group, Settings, and Admin so `⌘K` works everywhere.

Mutual exclusion by pathname guarantees only one `⌘K` keydown listener is ever registered. Do not mount a third palette. Do not register a `keydown` listener for `⌘K` in any feature component — the `GlobalCommandPalette` owner is the single source.

- **Action dispatch goes through `window` CustomEvents** — the palette fires `visiban:open-card`, `visiban:filter-my-cards`, `visiban:show-history`, `visiban:open-settings`, and the existing `visiban:open-shortcuts`. `BoardView` subscribes to the board-scoped subset. Do not reach into `BoardView` state from the palette directly — event-based delegation keeps the shell / board boundary clean.
- **Off-board actions are filtered automatically** — actions marked `boardOnly` in `CommandPalette.STATIC_ACTIONS` are suppressed on Dashboard/Group/Settings/Admin so the palette doesn't offer operations that would target no board. `Show keyboard shortcuts` is route-agnostic and surfaces everywhere.
- **Placeholder adapts per surface** — `GlobalCommandPalette` passes a `placeholder` prop per pathname. Board: `Search cards, boards, actions…`. Dashboard/Group: `Jump to board…`. Settings/Admin: `Jump to…`. Copy must match what the palette can actually do on that surface.

## Keyboard shortcuts — noise budget and registry (#868)

Shortcut wiring lives in two places: the board-scoped keydown listener in `BoardView` (for on-board bindings like `b`/`s`/`h`/`a`, `e`, `y`, `f`, `c`, `/`, `.`, `?`, `⌘,`, `⌘\\`, `⌘⇧E`, `⌘⇧L`) and the shell-level listener in `GlobalCommandPalette` (`⌘K`). Every bare-letter shortcut must respect `shouldIgnoreShortcut()` from `src/utils/keyboard.ts` so typing letters into inputs, textareas, and rich-text editors never triggers the board behavior.

- **`aria-keyshortcuts` noise budget — single-key or single-modifier only.** Every toolbar affordance that responds to a bare-letter shortcut (B/S/H/A/E/F/Y) or a one-modifier chord (⌘K, ⌘\\, ⌘,) must carry the corresponding `aria-keyshortcuts` attribute so screen readers announce the binding. Do **not** expose two-modifier chords (⌘⇧L, ⌘⇧E) via `aria-keyshortcuts` — exposing every chord drowns assistive technology in noise and offers no navigation benefit. Surface richer chords in the shortcuts overlay and tooltip only.
- **Platform-aware formatting — always route through `src/utils/platform.ts`.** `formatShortcut({ mod, shift, alt, key })` renders visible hints (⌘⇧L on Mac; Ctrl+Shift+L elsewhere). `formatAriaKeyshortcuts()` renders the ARIA 1.2 canonical form (`Meta+Shift+L` / `Control+Shift+L`). Never hard-code the Mac glyphs or the `Meta+` prefix at a call site.
- **Tooltip hints — parenthesize the shortcut after the label.** Format `"${label} (${formatShortcut(...)})"`. The overflow menu's own `shortcut` slot already renders the hint inline; set it there instead of baking the hint into the item label.
- **The shortcuts overlay is the canonical registry.** Every non-trivial binding must appear in `KeyboardShortcutsOverlay.tsx` grouped under one of the four sections (Navigation / Board view / Board actions / Help) and in `docs/features/keyboard-shortcuts.md`. Descriptions are imperative (`Switch to Board view`, not `Board view`) so each row reads as a command.
- **Command palette surface-awareness — suppress actions that have no target.** When adding a new action to `CommandPalette.STATIC_ACTIONS` that requires a board (opens a card, toggles filters, switches view), set `boardOnly: true` so `GlobalCommandPalette` filters it out on Dashboard/Group/Settings/Admin. Route-agnostic actions (open shortcuts overlay, log out) must *not* carry the flag.

## Board search scope toggle

The filter bar's search input carries a `SingleSelectDropdown` scope toggle to its left when `onScopeChange` is provided by the parent. Scope is URL-persisted via `?scope=all` (absent ⇒ `board`) so the selection is link-shareable. Rules:

- Trigger copy follows the selected option (`This board` / `Everywhere`) with a leading `🔍` via `triggerPrefix`
- Selecting `Everywhere` sets `?scope=all` **and** dispatches `visiban:open-palette` — until #191 ships, the palette is the cross-board search surface
- While `scope=all`, the board search input is disabled (`disabled:opacity-40 disabled:cursor-not-allowed`) but its value is preserved, and a helper line `Searching across all your boards` appears below (`text-xs text-fg-muted`, `aria-describedby` wired to the input)
- Placeholder is the exact string `Search cards on this board…` — keep US English and the ellipsis character
- Do not conflate scope with `FilterState` — scope is a search-surface selector, not a card-filter dimension; keep it in its own state/URL merge in `BoardView`

## Summary and analytics table layout

- Any table in a Summary or Analytics view that may exceed the viewport width must **pin its first column** sticky-left: `sticky left-0 bg-sunken` (matching the column's own background token)
- New metric columns grouped under a common section must use a two-row `<thead>`: first row `colspan` spanning the group with a `text-xs text-fg-muted uppercase tracking-wide` group label, second row with individual headers
- Numeric metric cells: `font-mono text-fg-secondary`; zero or null values render `—` in `text-fg-muted`, never `0`

## Analytics / split-panel scroll layout

When a panel contains a fixed reference section (toolbar + table) and a scrollable list below it:

- Use `flex-1 overflow-hidden flex flex-col` on the outer container — **no `overflow-auto` on the outer container**
- Pinned section: `shrink-0 flex flex-col` — grows to natural height; add `overflow-x-auto overflow-y-auto max-h-[40vh]` on the table wrapper if it can overflow vertically (many rows)
- Scrollable section: `flex-1 overflow-y-auto min-h-0` with an explicit `minHeight: "8rem"` floor so the section is never a zero-height peephole
- Separate the two regions with the standard engraved double-`<div>` separator (`h-px bg-sunken` / `h-px bg-surface-active/50`) — never a plain `border-t` alone; the engraved pattern is used everywhere else in the design system
- Add a count label inline with the section heading (`flex items-center gap-2`) using `text-xs text-fg-muted` — e.g. "N cards stalled" or "N items". Use a ternary for singular/plural (`"1 card"` / `"N cards"`), never the `(s)` parenthetical form
- Sticky first-column cells inside a horizontally-scrolling table must carry `bg-sunken` to match the scroll container's background; verify this is not broken when the outer `p-4` moves to inner sections

## System event visual treatment in timeline views

Apply this consistently in `CardMovementTimeline` and `MovementHistoryView`:

| Event type | Timeline dot | Card left border |
|---|---|---|
| Column move | `bg-primary-emphasis` | none |
| Activity (comment, assign) | `bg-fg-muted` | none |
| Archived | `bg-surface-active` | `border-l-2 border-line-strong` |
| Reactivated (restored) | `bg-activity-reactivated` | `border-l-2 border-activity-reactivated` |

- System event label text (`text-fg-tertiary italic` for "Archived", `text-accent-violet` for "Reactivated") is visually distinct from column-move text (`text-fg-secondary font-medium`)
- Do not collapse system events by default — Jordan's audit trail use case requires them visible

## Read-only mode for interactive components

Any component that calls `useDraggable`, `useSortable`, or registers interactive event handlers must accept a `readOnly?: boolean` prop. When `readOnly={true}`:

- Skip the DnD hook call entirely (avoids errors when the component is rendered outside a `DndContext`)
- Replace `cursor-grab` with `cursor-default`
- Remove `hover:-translate-y-0.5` and any other drag-affordance hover effects
- Turn `onClick` into a no-op (or omit the handler entirely)

This applies to `CardItem` and any future draggable component used in unauthenticated or view-only contexts (e.g. share board page, print view).

## One-time token reveal

When a token or secret is shown exactly once after creation (e.g. invite links, PATs), use an inline expanded state on the newly created row — never a modal or toast:

1. After creation, replace the creation form area with:
   - `text-xs text-warning` notice: "Copy this link now — it won't be shown again."
   - Monospace display field: `font-mono text-xs bg-sunken border border-warning/50 rounded px-2 py-1.5 text-fg truncate` with `title` attribute for full value
   - Copy button (primary variant)
   - "Done" button (secondary variant) that collapses the row to prefix-only display
2. Row collapses to prefix-only display after the user copies or clicks Done
3. Never store the full token client-side after the reveal state is dismissed
4. Use `transition-all duration-150` on the expanded row so it does not pop in

## Admin offboarding modal

When a destructive admin action has preconditions requiring data collection (e.g. board ownership transfer before user deactivation), use a dedicated modal — not `ConfirmDialog`:

- Modal follows the standard spec: `bg-surface border border-line rounded-lg shadow-xl`, `p-6` content, `fixed inset-0 bg-backdrop/60 z-50` backdrop
- Must use `useEscapeStack` for Escape key handling; focus must be trapped inside the modal
- Board list: `flex flex-col divide-y divide-line`; each row: board name (`text-sm text-fg truncate` with `title`) + card count (`text-xs text-fg-muted`)
- User picker: typeahead input following `BoardSettingsModal` invite search pattern; include `text-xs text-fg-muted` helper text below the input describing any scoping constraint (e.g. "Only users who are members of all boards listed above")
- Irreversibility warning: `text-sm text-warning` sentence above the confirm button — not a text-input confirmation, not a red banner. Use amber (not red) because the action is reversible by re-transferring manually
- Confirm button: danger variant (`bg-danger-bg hover:bg-danger-bg-hover text-on-danger`) with a label describing both actions (e.g. "Transfer ownership and deactivate")
- If no eligible transfer target exists: block deactivation and show a `text-sm text-warning` message naming the specific board(s) with a direct action prompt (e.g. "Add another member to [board name] before deactivating this user")

## Card metadata row coexistence

When two pieces of metadata in `CardItem`'s metadata row represent the same underlying datum (e.g. `last_moved_at` expressed as both a dot and a text label), define a mutual exclusion rule in the component. General principle: the hover-reveal dot covers the "very recent" case (within 24h); a persistent text label covers the "older but still relevant" case. Never render both simultaneously for the same card.
