# Frontend UI Conventions

## Color tokens

- **Always use `slate`, never `gray`** — they are not interchangeable. `gray` is warmer/less blue-tinted and creates visible mismatch on adjacent surfaces in the dark theme.

**Three-level background depth system** — use these levels consistently, never flatten them:

| Level | Usage | Class |
|---|---|---|
| Deepest | Grid cells, page canvas | `bg-slate-950` |
| Mid | Column headers, swimlane labels, card surfaces, panels | `bg-slate-800` |
| Elevated | Dropdowns, modals, popovers | `bg-slate-800` with `shadow-xl` |

- Borders: `border-slate-800` for grid lines (subtle), `border-slate-700` for panels, `border-slate-600` for interactive elements
- Text: `text-slate-200` for primary content, `text-slate-300` for secondary, `text-slate-500` for muted/stats

## Section header actions

When a section header (e.g. "My Boards", "Groups") carries action buttons:
- Place them right-aligned in a `flex items-center gap-2` group
- Primary action (e.g. "+ New board"): primary button variant
- Secondary action (e.g. "Import"): secondary button variant — **not** `text-blue-400`; that color is reserved for active filter/selection states
- Do **not** use a full-width dashed bottom button as the primary creation affordance when the section already has content — that pattern reads as an empty state

## Buttons

Three variants — use no others:

| Variant | Classes |
|---|---|
| Primary | `bg-blue-600 hover:bg-blue-700 text-white` |
| Secondary | bare text (`text-slate-300`) + `hover:text-white hover:bg-slate-700` |
| Icon-only | `hover:bg-slate-700` with icon content |

- Consistent sizing: `px-3 py-1.5 text-sm rounded` for most buttons
- Focus state: `focus:outline-none focus:ring-2 focus:ring-blue-500`
- Danger variant (destructive actions): `bg-red-600 hover:bg-red-700 text-white`

## Inputs and textareas

- `bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300`
- Focus ring: `focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`
- Placeholder: `placeholder-slate-500`

## Dropdown menus

All dropdowns — `SelectDropdown` or hand-rolled — must follow this style:

**Trigger button**
- `bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition`
- Default state: `border-slate-600 text-slate-300 hover:border-slate-400`
- Open / active-filter state: `border-blue-400 text-blue-400`

**Menu panel**
- `bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1`

**Menu items**
- `w-full text-left px-3 py-1.5 text-sm transition hover:bg-slate-700`
- Default text: `text-slate-300`; selected/active: `text-blue-400`

**Separators** (3D engraved effect — every adjacent item pair, all dropdowns):
```tsx
{i > 0 && (
  <div role="separator" className="mx-4">
    <div className="h-px bg-slate-900" />
    <div className="h-px bg-slate-600/50" />
  </div>
)}
```
- Place before each item where `i > 0`; no manual `separatorBefore` prop needed
- `SelectDropdown` handles this automatically; hand-rolled dropdowns (e.g. FilterBar) must add it manually

## Modals and dialogs

- Backdrop: `fixed inset-0 bg-black/60 z-50`
- Panel: `bg-slate-800 border border-slate-700 rounded-lg shadow-xl`
- Consistent padding: `p-6` for content, `pb-4` for header
- Close button: icon-only variant, top-right corner
- **Fixed-height tabbed modals** — when a modal contains tabs with variable content height, give the panel a fixed height (`h-[85vh] max-h-[640px] min-h-0`) rather than only a max-height. This prevents layout jumping between tabs. The scrollable content region uses `overflow-y-auto flex-1` and the panel uses `flex flex-col`. Never use `max-h` alone on a tabbed modal panel.
- **Inline confirmation for destructive toggles** — for settings toggles that have immediate, board-wide, non-reversible effects (e.g. enabling hard WIP enforcement), show an inline confirmation row before committing the change. On toggle click, replace the toggle row with a text prompt + Confirm + Cancel text buttons at `text-xs` scale (reuse the member-removal confirm pattern in `BoardSettingsModal`). On Cancel, revert the toggle. Do not use a modal-within-modal or a danger-zone text input for toggle-level confirmations.

## Badges and labels

- **Priority pills use filled background everywhere** — green/orange/red/dark-red fill, white text. Do not use outline/ring style; filled is more immediately scannable.
- Filter active-count badge: `bg-blue-500/20 text-blue-400` — never `bg-blue-100 text-blue-700` (light-mode colors)
- Consistent badge sizing: `px-2 py-0.5 text-xs rounded-full`

## Board navigation bar

The sub-nav bar directly below the main navbar contains view tabs, actions, and status:

- **Active tab** (e.g. "Board"): `bg-blue-600 text-white rounded px-3 py-1 text-sm font-medium`
- **Inactive tabs** (e.g. "Summary", "Analytics"): `text-slate-400 hover:text-slate-200 px-3 py-1 text-sm` — no background
- **Vertical separators** between logical groups: `text-slate-600 select-none` rendered as `|`
- **Live indicator**: green dot + "Live" label — `flex items-center gap-1 text-sm text-green-400` with `●` prefix; always top-right of the sub-nav
- **Settings link**: `text-slate-400 hover:text-slate-200 text-sm`

## Column headers

- Background: `bg-slate-800` — one level above the cell canvas
- Layout: left nav arrow · colored dot · name (truncated) · right nav arrow, then WIP + Weight stats row below
- Column name: `text-sm font-medium text-slate-200 truncate`
- WIP / Weight stats: `text-xs text-slate-500` — format `WIP {count}/∞` and `Weight {count}/∞`
- **Over-limit states use text color + `font-semibold` only — no filled background:**
  - WIP over-limit: `text-red-400 font-semibold`
  - Weight over-limit: `text-orange-400 font-semibold`
  - Never use `bg-red-900/50` or any filled background for over-limit stats — it competes with the column header surface color
- Column color dot: `w-2.5 h-2.5 rounded-full flex-shrink-0` in the column's assigned color
- Nav arrows (`◄` / `►`): `text-slate-600 hover:text-slate-300 text-xs transition`
- Column name truncates with ellipsis — never wraps

## Board grid cells

- Background: `bg-slate-950` — darkest level, creates depth contrast with cards and headers
- Grid lines: `border border-slate-800` — subtle, not prominent
- `+ Add card` affordance: `text-xs text-slate-600 hover:text-slate-400 cursor-pointer mt-1` — always visible at the bottom of each cell, not hidden until hover
- Board stats corner cell (top-left, where header row meets swimlane column): stacked `text-xs text-slate-500` lines for col/lane/card counts

## Cards

- Container: `bg-slate-800 rounded-lg border p-2.5 cursor-grab`
- **Border color = priority/status indicator** — full border on all sides (not just left accent):
  - Default / low: `border-blue-500`
  - Medium: `border-orange-500`
  - High / blocked: `border-red-500`
  - No priority: `border-slate-700`
- Card title: `text-sm text-slate-200`
- No drop shadow — the colored border provides visual weight
- Cards sit directly on the dark cell background; the contrast between `bg-slate-800` card and `bg-slate-950` cell creates depth without shadow
- **Metadata row** (when present — assignee, tasks, due date): `flex items-center gap-2 mt-1.5 text-xs text-slate-500`
  - Task count: `✓ {done}/{total}`
  - Due date: `Due MM/DD/YY`
  - Assignee badge: see Avatar chips section

## Avatar chips

- Shape: `rounded-full flex items-center justify-center flex-shrink-0`
- Size: `w-6 h-6 text-xs font-medium text-white`
- Background: deterministic color based on user — use a consistent palette (teal `bg-teal-600`, amber `bg-amber-600`, violet `bg-violet-600`, rose `bg-rose-600`, etc.)
- Content: 2-letter uppercase initials only
- Position on cards: bottom-right, `absolute` or flex end
- Never show more than the initials — no full name, no tooltip required (but allowed)

## Swimlane label panel

- Background: `bg-slate-800` — visually distinct from the `bg-slate-950` grid cells
- Color stripe: **`border-l-4`** in the swimlane's assigned color — thick enough to read at a glance; no thin stripes
- When a swimlane has a color, that same color bleeds as the left border of the entire swimlane row across all columns (applied to the label panel, not individual cells)
- Drag handle (`⋮⋮`): `text-slate-600 hover:text-slate-400 cursor-grab` — show on row hover via `group-hover:opacity-100`, default `opacity-0`
- Swimlane name: `text-sm text-slate-300`
- Collapse/expand chevron: prominent, `text-slate-400 hover:text-white transition` — must clearly communicate interactivity
- Edit (✎) button: `group-hover:opacity-100 opacity-0 transition` — visible at full opacity on hover, not discoverable by accident

## Radio groups

Never render browser-default radio circles. Use `sr-only` native `<input type="radio">` inside a `label` container — this preserves native keyboard navigation (arrow keys, Tab, Space) while hiding the visual control.

Represent selection state on the container:
- Selected: `border-blue-500 bg-blue-500/10`
- Unselected: `border-slate-600 hover:bg-slate-700/40`
- Keyboard focus: `focus-within:ring-2 focus-within:ring-blue-500 rounded-lg` on the `label`
- Transition: `transition-colors duration-150`

Option text: `text-sm text-slate-200 font-medium` for the label, `text-xs text-slate-500 mt-0.5` for the description line below it.

The action button following a radio group uses the primary variant (`bg-blue-600 hover:bg-blue-700 text-white`) and its label should reflect the current selection (e.g. "Export JSON" / "Export CSV") to eliminate ambiguity.

## Ancestor breadcrumbs

Use this pattern whenever showing a full ancestor chain (e.g. group hierarchies):

```tsx
<nav aria-label="Group breadcrumb" className="flex flex-wrap items-center mb-1">
  {ancestors.map((ancestor, i) => (
    <span key={ancestor.id} className="flex items-center">
      {i > 0 && <span className="text-slate-600 mx-1.5 select-none">/</span>}
      <a
        href={`/groups/${ancestor.id}`}
        onClick={(e) => { e.preventDefault(); navigate(`/groups/${ancestor.id}`); }}
        className="text-sm text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded transition max-w-[12rem] truncate"
        title={ancestor.name}
      >
        {ancestor.name}
      </a>
    </span>
  ))}
  <span className="text-slate-600 mx-1.5 select-none">/</span>
  <span className="text-sm text-slate-300 max-w-[12rem] truncate" title={current.name}>{current.name}</span>
</nav>
```

- Ancestor links: `text-sm text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded transition`
- Separator `/`: `text-slate-600 mx-1.5 select-none`
- Current item (non-linked): `text-sm text-slate-300`
- Per-item max-width: `max-w-[12rem] truncate` with `title` attribute for full name
- Container: `flex flex-wrap items-center` — wraps on narrow viewports
- Root-level items with no ancestors render nothing (omit the `<nav>` entirely)

## Inline description fields (non-RTE)

For plain-text description fields that are inline-editable by admins:

- **Idle / view state**: wrap content in a `border border-transparent hover:border-slate-600 cursor-text rounded px-2 py-1.5 -mx-2 transition-colors` container; hover-reveal pencil icon must include `focus:opacity-100 focus:ring-2 focus:ring-blue-500`
- **Edit state**: `bg-slate-900 border border-blue-400 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent` on the `<textarea>`; `resize-none`; Escape cancels, blur saves
- **Error slot**: always render `<p className="text-xs h-4">` below the field unconditionally; place error text in a `<span className="text-red-400">` inside it — never conditionally render the container itself
- **Non-admin, non-empty**: render plain `<p className="text-sm text-slate-400 whitespace-pre-wrap">`
- **Non-admin, empty**: render nothing (`null`) — do not show a placeholder the user cannot act on

## Tooltips

- Consistent delay: 300 ms show, immediate hide
- Placement: prefer `top` for icon buttons, `bottom` for nav items
- Style: `bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 shadow-lg`

## Inline status messages

- **Reserve vertical space unconditionally** — render the container element always (`<p className="text-xs h-4">`) and conditionally render the text content inside it. Never conditionally render the container itself; doing so causes buttons and surrounding elements to shift when messages appear or disappear.
- Error text: `text-red-400`; success text: `text-green-400` — always on a `<span>` inside the reserved container, not directly on the `<p>`
- **Relabel destructive-escape actions after success** — if a modal stays open after a successful action, relabel "Cancel" to "Close" once success state is set, so the button's semantics match the user's situation

## Paired numeric settings fields

When two related numeric inputs belong to the same conceptual setting (e.g. threshold + warning percentage):

- Group them in a single `<section>` with a shared `<h3>` heading
- Render each as its own `flex flex-col gap-1.5` block (input row + helper text), stacked in a `flex flex-col gap-3` container
- Each input row: `flex items-center gap-2` with a `w-20` number input and a `text-sm text-slate-400` unit label
- Helper text: `text-xs text-slate-500` — explain the relationship between the two values with a concrete example
- Non-admin read-only view: single `text-sm text-slate-300` line combining both values (e.g. "14 days · 50% warning")
- `onBlur` saves each field independently via `patchBoard`; clamp values client-side before patching

## Loading and spinner states

- Consistent spinner: single size per context (e.g. `w-5 h-5` inline, `w-8 h-8` full-page)
- Center spinners with `flex items-center justify-center`

## Empty states

- Consistent pattern: centered icon (muted, `text-slate-600`) + heading (`text-slate-400`) + optional CTA button
- No one-off inline empty messages with different styling

## Typography

- Page headings: `text-xl font-semibold text-white`
- Section headings: `text-sm font-medium text-slate-400 uppercase tracking-wide`
- Body: `text-sm text-slate-300`
- Muted/secondary: `text-sm text-slate-500`
- Monospace (version strings, IDs): `font-mono text-xs text-slate-500`

## Version display

- **Do not show a version badge or pill in the Navbar** — remove it entirely from the main nav
- Surface the version string in **Settings → About** only, where users can find it when filing support requests
- Style: inline `font-mono text-xs text-slate-500`, no badge/pill wrapper

## Rich text editor

- **`RichTextEditor` is the only editor component** — never add a second Tiptap instance or markdown editor
- View mode uses `react-markdown` with `prose prose-sm` + `rehypeRaw` plugin — **never `dangerouslySetInnerHTML`**
- **Color token overrides: use `[&_el]:text-*` not `prose-el:text-*`** — the `prose-p:text-slate-300` modifier syntax is unreliable when class names appear in dynamically-joined arrays; always use explicit arbitrary variant selectors:
  ```
  text-slate-300                              ← base color on the prose wrapper itself
  [&_h1]:text-slate-200 [&_h2]:text-slate-200 [&_h3]:text-slate-200
  [&_p]:text-slate-300 [&_li]:text-slate-300
  [&_strong]:text-slate-200 [&_em]:text-slate-300
  [&_code]:text-slate-200 [&_code]:bg-slate-700
  [&_pre]:bg-slate-900 [&_blockquote]:text-slate-400
  [&_a]:text-blue-400
  ```
- **`html: true` (default) on the Markdown extension is required** — `html: false` strips `<span style="color:...">` from the serialized output, silently discarding text colors on save. Never set `html: false`.
- **`rehypeRaw` is required on `<ReactMarkdown>`** to render `<span style="color:...">` HTML spans from the Color extension in view mode
- **`onKeyDown stopPropagation` is required on `EditorContent`** — prevents board-level single-key shortcuts (e.g. `f` for filter) from firing while the user types in the description
- **View/edit toggle pattern:** hover shows `border-slate-600 cursor-text` + ✎ icon (`group-hover:opacity-100 opacity-0`); click enters edit mode with `border-blue-400 bg-slate-900`. Apply this pattern to all future rich editable fields.
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
- **Always amber** — `border-amber-600 / text-amber-400`. Do not introduce a second color for a different limit type; severity is communicated via icon, not color.
- **Always show three things**: what was blocked (column name), why (with numbers), and an admin override link when `isAdmin` is true.
- **Admin override link**: `text-xs text-amber-400 hover:text-amber-200 underline transition` — never a button with background fill.
- **Hard-block variant** (`error.code === "wip_hard_blocked"`): use `⛔` as the toast icon instead of `⚠`. This is the only permitted way to signal severity difference between soft and hard constraint blocks — do not change the amber color. Omit the admin override link for all roles. Add a `text-xs text-slate-400` resolution line: "To unblock, move a card out of [column], or ask an admin to raise the WIP limit."

## Collapsed sidebar rail

The collapsed rail (48px, `w-12`) is for **fixed destinations only** — Dashboard, admin utility links, and a small number of curated shortcuts. Never render an unbounded list of items directly in the rail.

**Rule:** When a section has a variable number of items (boards, groups, favorites), represent it as a **single trigger icon** that opens a positioned flyout panel. Trigger icons sit in the rail like any other icon; the flyout panel appears to the right of the sidebar.

**Flyout panel spec:**
- Rendered via `createPortal(panel, document.body)` to escape the sidebar's `overflow-hidden`
- Positioned with coordinates captured at click time via `getBoundingClientRect()` on the trigger — store as `{ top, left }` state, never a ref
- `position: fixed; top: anchor.top; left: anchor.left + 4` (4px gap from sidebar edge)
- Panel: `w-56 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 max-h-80 overflow-y-auto z-50`
- Header row: `px-3 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-700 mb-1`
- Items: `px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-700 transition truncate`
- Active item: `bg-blue-600/20 text-blue-400 font-medium`

**Toggle behaviour:**
- Click to open, click again to close
- Add `onMouseDown={(e) => { if (open) e.stopPropagation(); }}` to the trigger so the flyout's outside-click (`document mousedown`) handler doesn't close it before the `onClick` toggle fires
- Opening one flyout closes any other open flyout (mutual exclusion via setting the other anchor to `null` in the click handler — do **not** use `useEffect`)
- Closed by: second click on trigger, click outside (document `mousedown` guard), Escape key

**Separators in the collapsed rail** use the same double-`<div>` engraved pattern as everywhere else — never a plain `<hr>`:
```tsx
<div className="mx-2 my-1.5">
  <div className="h-px bg-slate-900" />
  <div className="h-px bg-slate-600/50" />
</div>
```

**Trigger active state:** when the currently active route belongs to an item inside the flyout, apply `text-blue-400 bg-blue-600/20` to the trigger icon (same as direct nav links). This communicates "you are here" without opening the flyout.

**Groups flyout hierarchy** — the Groups flyout must be populated by flattening `sidebarTree` in depth-first pre-order, not from the flat `groups` array. Never source the Groups flyout from `groups.map(...)`:
- Flatten using a local recursive function carrying a `depth` counter; pass the result as `FlyoutItem[]`
- Apply `paddingLeft: 12 + depth * 12` via inline style (matching the expanded tree formula — never Tailwind padding classes)
- Cap visual depth at 3: `Math.min(depth, 3)` — nodes deeper than 3 are clamped, not omitted
- Group items: set `icon: "group"` (folder icon); board items: `icon: "board"` (clipboard icon, the default)
- Inactive items at `depth > 0` use `text-slate-400`; root items (`depth === 0`) use `text-slate-300`

## Sidebar explorer tree (expanded mode)

The expanded sidebar renders groups and their boards as a recursive tree. Rules:

- **Use `buildSidebarTree(groups, boards)` from `src/utils/groupTree.ts`** — never reconstruct the tree inline in the component. It returns `SidebarTreeNode[]` with `{ group, boards, children }` at every level.
- **Depth-based indentation uses inline style, never Tailwind padding classes** — `style={{ paddingLeft: depth * 12 + 8 }}`. This handles arbitrary depth cleanly. `depth` starts at `0` for root groups.
- **Only top-level groups appear as icons in the collapsed rail** — subgroups are reachable via the expanded tree only. Never add a collapsed icon for a group whose `parent !== null`.
- **`SidebarGroupNode` is the recursive component** — it renders a group row, its boards (as `BoardItem`), then its subgroup children. Boards appear before subgroups within the same level.
- **`BoardItem` uses `depth: number`** — never the old `indent: 1 | 2` prop. Depth cascades down from the containing group.

## First-encounter indicators

When surfacing a feature that users may not discover on their own, use a static dot indicator:

- **Token:** `bg-blue-500 rounded-full` — distinct from `bg-blue-400`, which is reserved for active filter/selection states
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
- The active visual treatment (e.g. `text-blue-400 !opacity-100`) is sufficient for sighted users; `aria-pressed` covers the rest

## User preference persistence

**User-scoped UI preferences** (toggles reflecting a reading habit or display style not tied to a specific board) use a single flat localStorage key in the format `user:prefs:{preference-name}`. Do not embed a board ID. Do not extend `useViewPrefs`. Create a dedicated hook following the try/catch + fallback pattern in `useViewPrefs.ts`. Never store UI-only preferences in the backend `UserSerializer` unless cross-device sync is an explicit requirement.

- **Board-scoped keys:** `board:{boardId}:{pref-name}` — for preferences that are per-board (hidden columns, filters, column widths)
- **User-scoped keys:** `user:prefs:{pref-name}` — for preferences that apply across all boards (reading habits, display toggles)

Each key in either namespace requires a `load()` function with try/catch + fallback-to-default, and a `save()` function that fails silently.

## Mode indicator banners

When a persistent board-wide mode is active (e.g. focus mode, a future "view-only" lock), render a full-width strip between the filter row and the scroll container. The strip must sit **outside** the scroll container so it does not scroll away.

- Style: `bg-blue-600/15 border-b border-blue-500/40 px-4 py-2 flex items-center gap-3 text-sm text-blue-300 transition-opacity duration-150`
- Use `bg-blue-600/15` to signal "active mode" — distinct from transient toast notices (`bg-slate-700/80`) and warnings (amber)
- Exit controls within the strip use the **secondary button variant** (`text-slate-300 hover:text-white hover:bg-slate-700 px-2 py-1 rounded text-xs shrink-0 focus:ring-2 focus:ring-blue-500`) — never the primary variant
- Mode name or target label: `font-medium text-blue-200 truncate max-w-[24rem]` with `flex-shrink-0` on the exit button

## Common dropdown primitives

`SingleSelectDropdown` and `CheckboxDropdown` live in `src/components/Common/`. Do not re-implement these inline in feature components. Both follow the dropdown menu spec (trigger: `bg-slate-800 border rounded px-2 py-1`, active/filtered state: `border-blue-400 text-blue-400`). Any new component that needs a select or checkbox dropdown must import from `Common`, never duplicate inline.

## Summary and analytics table layout

- Any table in a Summary or Analytics view that may exceed the viewport width must **pin its first column** sticky-left: `sticky left-0 bg-slate-900` (matching the column's own background token)
- New metric columns grouped under a common section must use a two-row `<thead>`: first row `colspan` spanning the group with a `text-xs text-slate-500 uppercase tracking-wide` group label, second row with individual headers
- Numeric metric cells: `font-mono text-slate-300`; zero or null values render `—` in `text-slate-500`, never `0`

## System event visual treatment in timeline views

Apply this consistently in `CardMovementTimeline` and `MovementHistoryView`:

| Event type | Timeline dot | Card left border |
|---|---|---|
| Column move | `bg-blue-500` | none |
| Activity (comment, assign) | `bg-slate-500` | none |
| Archived | `bg-slate-600` | `border-l-2 border-slate-600` |
| Reactivated (restored) | `bg-violet-500` | `border-l-2 border-violet-500` |

- System event label text (`text-slate-400 italic` for "Archived", `text-violet-400` for "Reactivated") is visually distinct from column-move text (`text-slate-300 font-medium`)
- Do not collapse system events by default — Jordan's audit trail use case requires them visible

## Read-only mode for interactive components

Any component that calls `useDraggable`, `useSortable`, or registers interactive event handlers must accept a `readOnly?: boolean` prop. When `readOnly={true}`:

- Skip the DnD hook call entirely (avoids errors when the component is rendered outside a `DndContext`)
- Replace `cursor-grab` with `cursor-default`
- Remove `hover:-translate-y-0.5` and any other drag-affordance hover effects
- Turn `onClick` into a no-op (or omit the handler entirely)

This applies to `CardItem` and any future draggable component used in unauthenticated or view-only contexts (e.g. share board page, print view).

## Card metadata row coexistence

When two pieces of metadata in `CardItem`'s metadata row represent the same underlying datum (e.g. `last_moved_at` expressed as both a dot and a text label), define a mutual exclusion rule in the component. General principle: the hover-reveal dot covers the "very recent" case (within 24h); a persistent text label covers the "older but still relevant" case. Never render both simultaneously for the same card.
