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
- Border radius: always `rounded` — never `rounded-lg` on buttons (sole exception: the file dropzone, see § Multi-step import wizards and file uploads)

**Why `--button-primary` is a separate token from `--primary`:** CTAs use `blue-900` (`#1e3a8a`, 10.36:1 on white) in light mode for comfortable AAA contrast, while `--primary` stays `blue-600` for brand-tint surfaces (avatars, active tabs, toggle tracks, saved-filter tabs). Do not consolidate these back into a single token — issue #855 intentionally split them so primary CTAs read as strong actions without desaturating the app's blue accents. Dark mode assigns both tokens the same blue-600 value; the split only matters on light backgrounds. Never use `bg-primary` on a button-shaped element, and never use `text-fg` on a `bg-button-primary` fill — `text-on-primary` is the only permitted text color on primary CTAs.

- **Every per-row text-button action in an admin table must carry the full button compliance set — `rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis` (or `focus:ring-danger-emphasis` for a destructive action) — even though it renders as bare text, not a filled button.** The Admin → Users per-row actions cell (`AdminPage.tsx`) is the reference: as of #1291 only the two highest-frequency actions — Deactivate/Reactivate and Make/Demote admin — stay as inline bare-text buttons, with `focus:ring-danger-emphasis` reserved for Deactivate and Demote admin (the two that remove access). Every remaining low-frequency action (Grant/Revoke all-content, Force reset, Clear lockout, Restart onboarding tour) moved into that row's `OverflowMenu` — see § Admin table row overflow menu below. A bare-text action is still a real button and needs a visible focus indicator and consistent corner radius like any other (#1280).

## Admin table row overflow menu (#1291)

When an admin table row (e.g. Admin → Users) accumulates enough conditional per-row actions that a no-wrap `flex` cell starts depending on the table's `overflow-x-auto` wrapper to absorb the width, fold the low-frequency actions into an `OverflowMenu` rather than letting the row keep growing — the same fold used for the column kebab (§ Column kebab menu below), applied to a table row instead of a column header.

- **Keep inline only the actions used most often** — for Admin → Users that's Deactivate/Reactivate and Make/Demote admin. Everything else (Grant/Revoke all-content, Force reset, Clear lockout, Restart onboarding tour) is a support action reached far less often and belongs in the menu.
- **Trigger:** `OverflowMenu` with `ariaLabel={`More actions for ${displayName}`}` — unlike the column kebab, the admin-table trigger is **not** hover-revealed (`opacity-0 group-hover:opacity-100`); admin tables are keyboard/mouse-scannable lists, not a hover-dense canvas, so the trigger stays visible at rest like the other row buttons.
- **Build the items array inline in the row render** (not `useMemo`, since a table row isn't its own component the way `ColumnHeader` is) — the array is small (at most 4 items) and the row already re-renders on every users-list update.
- `OverflowMenu` itself renders nothing when a row's items array is empty — don't add a separate conditional to hide the trigger.

## Feature parity between self-service and admin-initiated equivalents

**Invite by email (#731, #1444).** `EmailInviteForm` is shared by the site, group and board surfaces; a new surface passes `surface`, `roleOptions` and `showLinkDivider` and must not fork the copy. Its pickers pass `SingleSelectDropdown`'s `ariaLabel` (`"Role"`, `"Expires"`) because the trigger's visible text is only the selected value.

When a feature has both a self-service control (Settings) and an admin-initiated equivalent (Admin panel) — e.g. "Restart onboarding tour" in `SettingsPage.tsx` and the matching per-user action in `AdminPage.tsx` — both use **identical action copy** and **the same success/error feedback pattern** (inline `text-success`/`text-danger` message, same auto-clear timing). Do not let the two surfaces drift into different wording or different feedback mechanisms for what is, from the affected user's perspective, the exact same state change (#1280).

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

**Active-count badge on a "reveals sub-controls" trigger (#964).** A `CheckboxDropdown`/`SingleSelectDropdown` trigger may carry an active-count badge (`bg-primary-emphasis/20 text-info px-2 py-0.5 text-xs rounded-full`, `aria-hidden="true"`, count folded into the trigger's `aria-label` as `"{label}, {N} active"`) when the trigger's job is to reveal a variable set of sub-controls into the toolbar row rather than being itself a single filter. Precedent: `"+ Filter"` in `FilterBar` (`frontend/src/components/Board/FilterBar.tsx`), which replaced four always-visible facet dropdowns with one collapsed trigger; the badge counts facets that have an active *value*, independent of which facets are currently expanded — that "expanded" signal already has its own presentation (the trigger's own `border-info text-info` active state), so the badge stays a distinct, decoupled signal rather than duplicating it. Do not add this badge to a trigger that is itself a single filter (e.g. the Assignee/Label/Priority dropdowns it replaces) — those communicate their own active state via the existing border-color treatment and don't need a second indicator.

**A badge-carrying "reveals sub-controls" trigger must pin its own visible label, not let `selected` drive it.** `CheckboxDropdown`'s default `displayLabel` logic renders a generic `"{label}: {selected labels}"` summary once anything is selected — correct for a trigger that *is* a filter (Assignee, Label, Priority), wrong for one whose `selected` instead tracks which *other* controls are expanded (`"+ Filter"`), where it would produce `"+ Filter: Assignee, Label"` — a third, text-based signal on top of the border-color "expanded" state and the badge's "has a value" count, and one that can diverge from the trigger's `aria-label` (always built from the static `label`), a WCAG 2.5.3 Label-in-Name mismatch. Pass `hideSelectionSummary` on any such trigger to keep its visible text pinned to `label`. `badge={0}` and `badge={undefined}` both suppress the badge and its `aria-label` fold-in identically — the component gates both on the same truthy check, so a caller never needs to remember to pass `count || undefined`.

## Modals and dialogs

- Backdrop: `fixed inset-0 bg-backdrop/60 z-50`
- Panel: `bg-surface border border-line rounded-lg shadow-xl`
- Consistent padding: `p-6` for content, `pb-4` for header
- Close button: icon-only variant, top-right corner
- Footer layout: `flex items-center justify-end gap-3` — always `gap-3`, never `gap-2`
- **Fixed-height tabbed modals** — when a modal contains tabs with variable content height, give the panel a fixed height (`h-[85vh] max-h-[640px] min-h-0`) rather than only a max-height. This prevents layout jumping between tabs. The scrollable content region uses `overflow-y-auto flex-1` and the panel uses `flex flex-col`. Never use `max-h` alone on a tabbed modal panel.
- **A scroll region inside a popover or dialog must be reachable and visible (#1455).** (a) Make it keyboard-focusable: `tabIndex={0}`, `role="region"`, an `aria-label`, and `focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis`. When it overflows on open, focus it rather than the panel, since a focused ancestor scrolls the page instead. (b) Show an overflow cue: a `h-8 bg-gradient-to-t from-surface to-transparent pointer-events-none` fade pinned to its bottom, rendered only while `scrollTop + clientHeight < scrollHeight`. Never rely on the native scrollbar, which macOS hides. (c) A popover that closes on outside scroll with a capture-phase listener must ignore scrolls whose target is inside the panel, or scrolling its own list dismisses it. **Named exception to (a):** `MultiSelectDropdown`'s list is not a Tab stop, because it follows the ARIA combobox pattern: focus stays in the search combobox, whose arrow keys move `aria-activedescendant` and scroll the active option into view, and Tab there closes the menu. A second Tab stop on the list would break that keyboard model, not complete it. A popover whose list is reachable only by scrolling has no such alternative and is not covered by this exception.
- **Anchored `fixed` popovers are sized to content and placed from a measurement (#1455).** Cap the scroll region at the viewport (`calc(100vh - <margins + chrome>)`), not at a fixed rem height. Measure `offsetHeight` in `useLayoutEffect` and place the panel below the trigger, else above it, else pinned to the viewport's bottom edge. **Keep the side chosen at open for as long as the panel still fits there (#1457)**: a filter that shrinks the list must not flip an upward menu below the trigger, and an upward menu keeps its bottom edge at the trigger. Choose the side again only when the list grows past that edge — never slide a panel over its own trigger. Never estimate the height from an item count. Keep it `visibility: hidden` until placed, and dismiss on window `resize` and on any scroll outside the panel (capture phase, ignoring scrolls inside it per rule (c) above). **Move focus only after placement**, in an effect keyed on `top !== null`, never `useEffect(..., [])`: the hidden first commit's passive effects flush before the placement re-render, and browsers ignore `focus()` on a hidden element. jsdom does not, so assert on the panel's visibility at the moment `focus()` runs (see `swimlaneCustomFields.test.tsx`), not with `toHaveFocus()`. Reuse `useAnchoredPlacement` (placement with the side lock, hidden-until-placed `top`, and the `onResize`/`onOutsideScroll` dismissals) and `useOverflowFade` (the bottom-fade flag) from `src/hooks/` rather than re-deriving them; a popup that is not a React child (the Tiptap mention list in `RichTextEditor`) uses `placeFixedElement` from the same module, re-placed from a `ResizeObserver` because its list renders asynchronously. **Named exception to rule (a) (Tab stop):** a roving-focus `role="menu"` list (`SingleSelectDropdown`'s portal menu) is reached with Arrow/Home/End, so its scroll region is not a Tab stop; rule (b), the overflow cue, still applies. Named exceptions to (a): MultiSelectDropdown and SelectDropdown. Both are focus-staying comboboxes driven by aria-activedescendant. Any such component MUST scroll the active option into view on every activeIndex change, or a keyboard user can move the highlight out of the capped list. **Named exception to the scroll dismissal:** the mention list re-anchors to the live caret on an outside scroll instead of closing, because ProseMirror and the browser scroll the caret into view as the query is typed, which happens exactly when the caret is near an edge, so a scroll dismissal would close the list mid-word. It still ends on `resize`, through Tiptap's own exit path (a `{ exit: true }` meta transaction on its suggestion `PluginKey`, as Escape does), never by only hiding the element, which would leave the suggestion capturing Enter and the arrow keys. Adopters: `SwimlaneFieldsPopover`, `MultiSelectDropdown`, `SelectDropdown` (#1480: always portaled and anchored, so a role/option select in a scrolling modal, the Members tab last row included, no longer clips), `SingleSelectDropdown`'s `portalMenu` (#1478: it holds user-data choice lists, so the Edit Swimlane dropdown field no longer clips; the Row 2 toolbar pickers share the path), `CustomFieldQuickEditPopover`, `CollapsedFlyout`, `OverflowMenu` (also a per-row menu in the admin user table, so a bottom-row kebab opens upward), the `BoardSettingsModal` member-search suggestions, `CardPeekPopover` (`mode: "side"`, no dismissals since mouse-leave closes it) and the `RichTextEditor` mention list. **Exempt, audited in #1457 because their content is bounded:** `SplitButton` (a fixed handful of menu items, used only in the Row 2 board and Lens toolbars near the top of the viewport); `Tooltip`, `RoleInfoTooltip` and `ConnectionStatus` (a line of text or a fixed `w-64` status panel, anchored in the header or toolbar); the `CardDetail` move popover (a fixed form of two selects and two buttons under the Move button in the panel header); and `ChoiceColorPicker` (`absolute`, not `fixed`: eight swatches plus a reset button inside the scrolling settings panel, which it scrolls into view). A new menu whose items come from user data is not exempt.
- **Inline confirmation for destructive toggles** — for settings toggles with immediate, broad-blast-radius effects (board-wide or instance-wide — e.g. enabling hard WIP enforcement, enabling maintenance mode), show an inline confirmation row before committing. The trigger is **blast radius and immediacy, not permanence**: a reversible change that instantly affects everyone still qualifies. **Confirm only the transition that removes access or functionality, never the one that restores it** — confirm turning maintenance mode on, never turning it off. On toggle click, keep the toggle **mounted and rendered** and add a text prompt + Confirm + Cancel **bare-text** buttons at `text-xs` scale directly below it (`text-danger hover:text-danger font-medium` for Confirm, `text-fg-tertiary hover:text-fg` for Cancel, both with `focus:ring-2` — reuse the member-removal and hard-WIP patterns in `BoardSettingsModal`). Do **not** swap the toggle row out for the confirm row, and do **not** use a filled button variant for Confirm — either one creates a third visual treatment of what should be a single pattern. Do **not** flip the toggle optimistically first: none of the reference instances do, and with the control never having changed there is nothing for Cancel to revert. Do not use a modal-within-modal or a danger-zone text input for toggle-level confirmations. This styling (including `font-medium` on Confirm) applies to **any** dedicated two-button inline Confirm/Cancel destructive row, not only toggles — e.g. the connected-account Disconnect confirm (#1314). The only sanctioned bare-text exemption from `font-medium` is the admin table's persistent row actions (§ Admin table row overflow menu); a transient confirm prompt is never that exemption.
- **Confirm/Cancel is the only sanctioned word pair for the inline destructive-confirm pattern.** Never use Yes/No, Revoke/Cancel, or a terse "Remove?" prompt. The prompt is a full sentence naming the target and consequence (`Remove <username> from this board?`, `Revoke this invite link? Anyone holding it will no longer be able to join.`), at `text-xs`, with `font-medium` on Confirm. `BoardSettingsModal` is the canonical reference; `BoardMembersModal`, `InviteLinkPanel`, the `GroupDetail` member/label removes, `AdminPage` invite revoke and `SettingsPage` token revoke (#1238), connected-account Disconnect (#1366) and `CardDetail`'s comment delete (#1365) conform. A page that registers a priority-0 Escape-to-navigate handler (e.g. `GroupDetail`, `AdminPage`, `SettingsPage`) must also register a higher-priority `useEscapeStack` handler (40) that cancels any open inline confirm, or Escape on the prompt leaves the page. When a row can show two confirms at once, disambiguate with `aria-label` per § Disambiguating repeated button labels.
- **Dismissing an inline confirm returns focus to its trigger (#1367).** When an inline Confirm/Cancel prompt closes (Cancel, Escape, or a Confirm that completes and closes the prompt; a `CardDetail` comment delete that fails stays open instead, see the #1421 rule), keyboard focus must land on the control that opened it. The focused Cancel button unmounts, and most triggers are swapped out while the prompt is open, so without this focus falls to `body` and the user loses their place. Never hand-roll it with a captured element (the trigger is re-mounted, so the captured node is stale). Use `useConfirmFocusReturn(activeKey)` from `src/hooks/useConfirmFocusReturn.ts`: pass the key of the open confirm (`null` when none), attach `triggerRef(key)` to the trigger (a row id, or a constant string for a single prompt; a `Toggle` takes it as `buttonRef`; in a Save-attached confirm the trigger is Save). It restores focus only when focus would otherwise be lost, and is a no-op when the confirmed action removed the row. Every inline-confirm site uses it: the `BoardSettingsModal` member remove and hard-WIP confirms, `BoardMembersModal`, `LensConnectionModal`, `InviteLinkPanel` (group and board lists), `GroupDetail` member/label removes, `AdminPage` invite revoke and maintenance mode, `SettingsPage` token revoke and Disconnect, `EmailSettingsSection` source switch, `BoardSettingsFieldsTab` "Change type" prompt (trigger is the type button), and `CardDetail` comment delete. A new inline confirm must add itself to this list and test Cancel (and Escape, where a handler exists) returning focus.
- **An inline Confirm/Cancel prompt is a best-effort polite live region and guards its own request (#1421).** Put `role="status" aria-live="polite" aria-atomic="true"` on the prompt's wrapper element (same trio as the existing status regions) so screen reader users are told it appeared, and render any failure text *inside* that same wrapper, on its own line (`<p className="text-xs text-danger mt-1">`) so it never overflows a single-line `whitespace-nowrap` row. Text inserted into an already-mounted region is announced reliably; the initial mount of the region together with its content may not be announced by every screen reader, so treat the announcement as a best-effort cue. A persistent, always-mounted `sr-only` region is the more robust option and is deferred design debt. Disable **both** Confirm and Cancel (`disabled:opacity-40`) while the request is in flight and early-return from the handler when one is already pending, so a double click sends one request. Wrap the request in `try/catch`: on failure keep the prompt open with a short `text-danger` message (`Could not delete comment.`) and re-enable the buttons, never leaving the UI stuck or letting a rejection go unhandled. Clear the error when the prompt is cancelled or reopened. Reference: `CardDetail` comment delete; `InviteLinkPanel` revoke (group and board lists, #1444) also follows it, and reports a `400` "already used" outcome — which closes the prompt — through an always-mounted `sr-only` `role="status"` region so it is still announced. `BoardSettingsModal` member remove carries only the live-region wrapper; it keeps its own #1373 design (shared error slot below the list, Cancel not disabled, prompt closed in `finally`).
- **In an explicit Save/Cancel composite editor, inline confirmation attaches to Save, not to the control.** The toggle rule above assumes the control commits on click. In a composite editor (§ Composite inline editors) nothing commits until Save, so confirming when a value is *selected* would force a second confirmation at Save time and leaves an incoherent state where the user "confirmed" something they can still Cancel. Instead, diff the last-saved value against the pending draft inside the submit handler and show the confirm row only when the blast-radius transition is actually present — still only the direction that removes or re-routes functionality, never the one that restores it. Reference: `EmailSettingsSection.tsx`'s `env → database` switch, which reuses the maintenance-mode confirm's exact bare-text styling with a different trigger point.
- **Escape priority inside the card detail panel** — any dropdown, picker, or popover rendered inside `CardDetail` must register `useEscapeStack` at a priority **above 30**. **Never use `useDropdownEscape`** there: it registers at 25, below the panel's own close handler at 30, so Escape would dismiss the entire panel instead of the control. Allocated so far: `30` panel close · `35` archive/delete confirm and the inline comment-delete prompt (#1365) · `36` move popover · `37` relation picker · `38` MR/PR link editor (`CardExternalRefSection`, #352) · `39` multi-select custom-field value menu (`MultiSelectValueInput`'s default, #1391) · `41` dropdown custom-field value menu in `CustomFieldEditRow` (#1478; above 40 because a modal can open over the panel, and it is passed explicitly, so it also applies to the multi-select value menu there). · `50` SelectDropdown's default (#1480); see the modal list. Claim the next free integer and record it in this list.
- **Deep-link into a tabbed modal (#1458).** When a modal opens onto a non-default tab from a shortcut (e.g. the swimlane `+N` popover's "Edit field order…" opening Board Settings on Swimlane fields), pass the tab as `initialTab` and focus that tab's button with a mount-only `requestAnimationFrame` effect, so it runs after `ModalWrapper` focuses the panel. Run it only when `initialTab` was explicitly passed, and only if focus has not already moved deeper into the modal (`document.activeElement` is the panel, `document.body` or null); a control that already took focus keeps it. Cancel the frame on cleanup. The active tab button carries `aria-current="true"` (nothing on inactive tabs); do not add `role="tab"`/`aria-selected` without implementing the full tablist arrow-key pattern. Every other opener leaves `initialTab` unset and opens on the default tab. Reference: `BoardSettingsModal`.
- **Menu items need a focus ring too — every `role="menuitem"`, not just the one primitive that first got it fixed.** Any `role="menuitem"` button/link inside an open menu (`SingleSelectDropdown`, `OverflowMenu`, `UserMenu`, `BulkActionToolbar`'s Move/Assign/Priority menus, and every `SplitButton` `renderMenu`, e.g. the BoardView/LensToolbar Collapse-Expand menus) is a real tab stop, reached by roving `ArrowUp`/`ArrowDown`/`Home`/`End` focus, not just a pointer target. `hover:bg-surface-hover` or `focus:bg-surface-hover` alone is invisible to a keyboard user who arrowed onto an item without touching the mouse — the ring is mandatory in addition to any focus background. Import `MENU_ITEM_FOCUS_RING` (or `MENU_ITEM_FOCUS_RING_DANGER` for destructive items) from `src/components/Common/menuItemFocusRing.ts` at every menuitem call site instead of retyping `focus:outline-none focus:ring-2 focus:ring-primary-emphasis` — this exact gap regressed independently in four components before #1234 fixed it a second time (first fixed for `SingleSelectDropdown` alone in #1140).
- **Escape priority inside a `ModalWrapper` is the same trap as inside `CardDetail` (#1140).** `ModalWrapper` registers `useEscapeStack` at priority 40; `SingleSelectDropdown` registers at 25 through `useDropdownEscape`. An open dropdown inside a modal therefore does not consume Escape — the modal closes and the user's in-progress form goes with it. Any `SingleSelectDropdown`, picker, or popover rendered inside a modal must be passed an `escapePriority` **above 40**. Allocated so far: `40` modal close · `45` custom-field value dropdown in `EditSwimlaneModal` · `46` multi-select custom-field value menu in `EditSwimlaneModal` (#1391) · `47` choice color swatch popover in the Board Settings field editors (`ChoiceColorPicker`, #1391). · `48` canceling an in-flight sample load in the Import Board modal (`ImportBoardModal`, #1452) — a loading-only handler that returns `false` otherwise so Escape still closes the modal; the board-name input's own Escape handler must skip while a sample loads, or it closes the modal first. · `49` revoke-confirm prompt of the board invite list in Board Settings → Members (`InviteLinkPanel` with `escapePriority={49}`, #1444) — the group page keeps the panel's default 40, which sits above GroupDetail's priority-0 navigate; inside the modal it must clear ModalWrapper's 40. · `50` SelectDropdown default (#1480): above 48 and above every card-panel tier, below the command palette (60); it registers only while open, so a closed menu never consumes Escape. · `51` Role and Expires pickers of the board "Invite by email" form in Board Settings → Members (`EmailInviteForm` `surface="board"`, portaled, #1444). SingleSelectDropdown defaults to 25 and SelectDropdown to 50 deliberately: SelectDropdown is a form control used almost only inside modals and the card panel, SingleSelectDropdown is toolbar-first and opts in. Do not align the two defaults. Claim the next free integer and record it in this list.

## Badges and labels

- **Priority pills use filled background everywhere** — green/orange/red/dark-red fill, white text. Do not use outline/ring style; filled is more immediately scannable.
- **Label pills are an exception to the filled-pill rule** — labels carry arbitrary user-assigned colors (any hue, any lightness), so white-on-fill would fail contrast on light labels. Use a tint (`color + "22"` alpha suffix for the background, `color + "44"` for the border) with the label color as the text color. This is one of two permitted outline-style pills in the system — see the custom-field chip exception below for the other.
- **Pinned custom-field chips are a second, distinct exception to the filled-pill rule** — the card-face custom-field chip (`CustomFieldValueDisplay`, `CardItem`) uses `border border-line rounded` with plain `text-fg-secondary` value text; the chip itself is never filled or tinted — the one tint permitted is a colored choice's badge *inside* it (see the colored-choices rule below). Custom fields need their own visual language distinct from both the priority pill (filled, semantic urgency color) and the label pill (tinted, user-assigned color) — collapsing all three into one visual bucket would make it impossible to scan a card face and tell "this is a priority" from "this is a label" from "this is a custom field" at a glance. The neutral bordered chip signals "structured metadata, no inherent color" the way a table cell border does, leaving the field's own semantics (a dropdown choice's color dot or color badge, a date, a number) to carry any further meaning inside it.
- **Colored dropdown and multi-select choices may render as a tinted badge (#1391).** When a field choice has an explicit color, its value renders as a tinted badge inside the neutral bordered chip on the card face and in the row header: `rounded px-1.5 py-0.5 text-xs`, with fg and bg from the 8-key `{light, dark}` palette in `src/constants/choiceColors.ts`. Rules: (1) The text label is always rendered. Color never carries meaning alone, and the badge is never an icon or dot only. (2) Every key must reach at least 4.5:1 against its badge background in both themes (currently at least 6.0), and any new key requires a recorded ratio. (3) A choice with no explicit color keeps the existing neutral chip and hash `choiceColor` dot, so existing boards look unchanged. (4) An orphaned value (choice removed or renamed) renders neutral with no color. (5) Never use the tinted badge for the field name or a non-choice type. It is the second permitted tinted pill, after label pills (priority pills are filled, not tinted), and it remains distinct from a label because it sits inside the field chip. **Mechanics:** render it only through `ChoiceBadge` (`components/Card/ChoiceValue.tsx`, which also owns the one `ChoiceDot`), resolve the key only through `explicitChoiceColor()` (`utils/customFieldValue.ts` — it returns `null` for unset, orphaned and unknown keys), and never inline the palette hex: `choiceBadgeStyle()` passes the pair as `--cf-{bg,fg}-{light,dark}` custom properties and the `cf-choice-badge` class in `index.css` picks the pair for the active `data-theme`, so no `dark:` duplicate is needed. An explicit color *replaces* the dropdown dot; it never sits beside one. On the card face a quick-editable badge carries the edit hint as an inner text span with `underline decoration-dotted underline-offset-2` — the decoration is `currentColor`, so it always matches the badge fg's contrast — never as a `border-b` on the badge, which would change its height. In card detail (`variant="detail"`) the value renders as a bare `ChoiceBadge` with no bordered chip around it, the same way detail renders every other value as plain text rather than a chip.
- **Swimlane-row custom-field chips are the same neutral bordered chip, with two deviations the surface forces (#1140)** — the row chip is `CustomFieldValueDisplay` at `variant="row-chip"` and keeps `border border-line rounded` with a `text-fg-muted` name and `text-fg-secondary` value, so a custom field reads as a custom field whether it hangs off a card or a row. It is **not** a fourth exception to the filled-pill rule. What differs: (a) `max-w-full min-w-0` replaces `max-w-[10rem]` and the value truncates at 20 characters instead of 16, because the swimlane label panel is a `sidebarWidth ?? 220`px *vertical* column, not a horizontal metadata row — row chips stack, so each owns a full line and a 160px cap would truncate for nothing; (b) an `is_admin_only` definition renders a leading `w-3 h-3 text-fg-faint` padlock **inline SVG on `currentColor`** (`role="img"`, `aria-label="Admin-only field"`) before the dropdown color dot, and appends ` · Only board admins can see this` to the chip's `title`. Never a `🔒` emoji — an emoji paints in its own fixed color and stops tracking the theme. Only an admin ever receives an admin-only value, so the padlock never renders for a member; it exists so an admin can tell, without opening Board Settings, which values on their screen their team cannot see. The same padlock marks the same fact in the Board Settings → Swimlane fields list — one glyph, one meaning, both surfaces.
- **A multi-select value is neutral sub-chips inside the same neutral bordered chip (#1391).** The value cell holds `MultiSelectChips`: `text-xs px-1.5 py-0.5 rounded truncate bg-surface-hover text-fg-secondary`, each with its full text in `title` — never color-dotted. An entry whose choice has an explicit color is a tinted `ChoiceBadge` with the same width cap instead (see the colored-choices rule above); pass the field's `definition` to `MultiSelectChips` so it can resolve them. Card face: at most **2** sub-chips (each `max-w-[6rem]`) then a `+N` (`text-fg-muted text-xs`) whose `title` lists every entry; the outer chip is `max-w-[14rem] min-w-0` (not `shrink-0`, because the card metadata row is single-line `overflow-hidden`) and the field name (`min-w-0 shrink-[3]`) truncates before the value chips do. Swimlane row header: at most **3**, wrapping (`flex-wrap gap-1`, sub-chips `max-w-full`). Detail and the editor trigger show all, wrapping. The card-face chip is read-only for this type — no quick-edit role and no dotted underline; edit in card detail.
- **One shared admin-only padlock component — never a second hand-rolled copy (#1140).** The `is_admin_only` padlock (`w-3 h-3 text-fg-faint` inline SVG, `role="img"`, `aria-label="Admin-only field"`) is rendered from `components/Common/AdminOnlyFieldGlyph.tsx` and imported everywhere it appears — the row chip, `SwimlaneFieldEditRow`, `SwimlaneFieldsPopover`, and the Board Settings → Swimlane fields list. Do not re-inline the `<rect>`/`<path>` markup at a new call site. This is the same drift the codebase already guards against for `toolbarIcons.tsx` and `relativeTime()`, and it had already happened here: the glyph shipped as four inline copies and one of them announced `aria-label="Admin only"` while the other three said `"Admin-only field"`, silently splitting the accessible name across surfaces the rule above requires to say one thing.
- Filter active-count badge: `bg-primary-emphasis/20 text-info` — always use the `primary-emphasis` token for the fill so the badge tracks the active theme
- Consistent badge sizing: `px-2 py-0.5 text-xs rounded-full`
- Active filter chip (`FilterChip.tsx`, the dismissible tag shown per applied filter in the filter row): `bg-primary-emphasis/20 text-info` fill with a `border border-primary-emphasis/40` border — same fill/text token pair as the badges above, plus the border so it reads as removable rather than a plain count/state indicator (#1239)
- **`bg-info/*` vs `bg-primary-emphasis/*` — know which one your state is.** These are not interchangeable, and `--info`/`--primary` are different values in dark mode (they only coincide in light mode, which is why this drifts invisibly). Two patterns, never cross them:
  - **Transient disclosure / toggle-open state** (a button whose job is "is this popover/menu/panel currently open" — Filters button, kebab trigger, SplitButton chevron, dropdown trigger's open state): `text-info bg-info/10`.
  - **Persistent selection / "where you are" / "what's active" state** (nav-active item, tree-active item, flyout-active item, filter active-count badge, active filter chip, radio selected, grid-overlay cell tint, lens "Current" pill, mode-indicator banners): `bg-primary-emphasis/*` (paired text token varies by context — `text-info`, `text-warning`, etc. — keep whatever paired text token the surface already uses; only the background fill is the `primary-emphasis`-vs-`info` decision).

  When introducing or touching any new "this item is the active/selected/current one" treatment, grep for `bg-info` in the file first and ask which bucket above it falls into before picking a token. Prior incidents: #1002, #1239 (`SavedFiltersDropdown`/`AdminPage`), #1336 (`AppSidebar`/`CollapsedFlyout`).

## Motion and reduced motion (#199)

- **Every decorative animation carries `motion-reduce:animate-none`** — `animate-pulse` (highlighted card, search-match cells, "Working..." text, connection-status dots, indeterminate progress) and `animate-fade-in` (e.g. a newly created board row) must stop under `prefers-reduced-motion`.
- **An indeterminate progress bar also falls back to a static one-third width** (`w-full motion-reduce:w-1/3`), never a full bar that reads as "done" — see § Import Board sample gallery (#1452).
- Functional `animate-spin` loading spinners are exempt.

## Truncation inside nested flex chips

Any chip built as an `inline-flex` container around one or more `truncate` text spans (custom-field chips, multi-select sub-chips, and any future nested-flex chip) must give **every** truncating span an explicit `min-w-0` (or a numeric `min-w-[Nrem]` floor), and give the **chip itself** `overflow-hidden`. A flex child's default `min-width: auto` is content-based — without an explicit override, `truncate`'s ellipsis never engages inside a flex container, and long content silently overflows the chip's own box onto whatever renders next in the row (#1411: this is why pinned custom-field chips rendered on top of their neighbors instead of clipping). A chip that needs to shrink in its own parent flex context (e.g. the card metadata row) must not be `shrink-0` with only a `max-w` — pair an explicit `min-w-[Nrem]` floor with the `max-w` instead, or it will overflow its parent rather than shrink into it.

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
- **Inactive tabs** (e.g. "Summary", "Analytics"): `text-fg-tertiary hover:text-fg hover:bg-surface-active px-3 py-1 text-sm rounded` — same height and padding as the active tab so the bar never shifts (the active tab adds only `font-medium`); the tabs sit in a `bg-surface-hover rounded p-0.5` group, so the hover uses the stronger `bg-surface-active` to stay visible
- **Vertical separators** between logical groups: `<div className="w-px h-4 bg-surface-hover mx-1" aria-hidden="true" />` (see § Top chrome), never a `|` character
- **Connection status**: use the `ConnectionStatus` component (see § Connection status indicator below) — single canonical component for the sub-nav live indicator and for the group detail header
- **Settings and utilities** (shortcuts, export, board settings): icon-only buttons sharing one treatment, `p-1.5 rounded text-fg-tertiary hover:text-fg hover:bg-surface-hover` plus the standard focus ring

## Column kebab menu (#965)

Each column header carries a `⋮` overflow kebab as the discoverable surface for column-scoped actions. The kebab is the only keyboard-reachable path to column settings and delete — no separate `✎` icon button. Inline rename is additionally reachable by Tab + Enter/Space on the column name itself, which is a real `<button>` for admins (#1376).

- **Trigger:** `OverflowMenu` instance with `ariaLabel={\`Actions for column "${column.name}"\`}` so screen readers announce *which* column is being acted on. The trigger uses the standard kebab styling and is wrapped in `opacity-0 group-hover/col:opacity-100 focus-within:opacity-100 transition` so it is hidden at rest, revealed on column hover, and stays visible when keyboard focus enters the menu (per the hover-reveal-controls rule).
- **Items, in order:**
  1. `Rename` — sets the column name into the inline editor (the same editor the admin column-name button opens on click, Enter, or Space)
  2. `Edit settings…` — opens `EditColumnModal` (color, WIP/weight limits, allow card creation, is_done)
  3. `Delete column` — danger-styled (`OverflowItem.danger: true`), preceded by an engraved separator. Routes to the confirmation dialog.
- **Non-admins see no kebab affordance** — the control is hidden entirely from the DOM, per the *Conditional admin-only elements* rule. Do not render a greyed-out `⋮` glyph, a disabled trigger, or a tooltip explaining missing permission; affordances Sam (occasional, non-admin) cannot use should not look like affordances at all.
- **Double-click on the column header** continues to open `EditColumnModal` as a power-user shortcut (the name button itself does inline rename on a single click / Enter / Space); the kebab is the discoverable path.

## Column delete confirmation (#965)

Deleting a column is permanent and removes every card in it (active and archived). The confirmation dialog applies a tiered safety pattern:

- **Empty column** — a plain `Cancel` / `Delete` modal is sufficient. There is nothing destructive to mistype against; adding name-typed friction here is noise.
- **Column with cards** — the dialog renders the same name-typed danger-zone pattern used for board deletion in `BoardSettingsModal`: an input with the column name in `font-mono`, a `text-xs text-fg-muted` instruction line above it, and a `Delete` button that stays disabled until the typed value matches the column name exactly. Pressing Enter inside the input commits when the value matches. Closing the dialog (Cancel, Esc, or backdrop click) resets the input.
- The confirmation copy explicitly says how many active cards and that archived cards in the column will also be deleted. *This cannot be undone.* is the closing line.

The swimlane delete confirmation (`EditSwimlaneModal.tsx`) reuses the same copy pattern for the deletable (empty) case: a declarative `{name} will be permanently deleted.` line, a `text-danger` line warning that any archived cards in the swimlane will also be permanently deleted, and the `text-fg-muted` *This cannot be undone.* closer. It does not reuse the tiered pattern above — a swimlane that still has cards blocks deletion outright (a single `OK` acknowledgment, no typed-confirmation tier) rather than offering the column's name-typed override; that `OK` button has no column counterpart, but still takes the standard `px-3 py-1.5` sizing rather than a one-off size. Keep the two dialogs' shared copy and button sizing (`px-3 py-1.5`) in sync; a wording or sizing change to one without the other is a drift, not a deliberate divergence.

## Column drag-to-trash gating (#965)

The destructive column trash drop zone is **opt-in via ⌥ (Alt)**, never visible by default during a column drag. Reorder is the common case; deletion is a deliberate, modifier-gated gesture.

- The trash zone renders only when `activeColumn !== null && altHeldDuringColumnDrag === true`. The Alt-tracking `keydown` / `keyup` / `blur` listeners register only while a column drag is active so the global-keyboard footprint is empty at rest.
- The drag overlay shows a small hint below the dragged column name: `Hold ⌥ to delete` (`text-xs text-fg-muted`) flips to `Drop on trash to delete` (`text-xs text-danger`, `aria-live="polite"`) the moment Alt is held. The hint is the discoverability cue for the gated gesture.
- Dropping on the trash zone routes to the same name-typed confirmation dialog as the kebab `Delete column` path — there is one canonical column-delete dialog, never two.

## Column headers

- Background: `bg-surface` — one level above the cell canvas
- Layout: left nav arrow · colored dot · name (truncated) · right nav arrow, then a single stat row below
- Column name: `text-sm font-medium text-fg truncate`
- **Stat row — single line, worst-offender wins.** A column header renders exactly one stat line, never two stacked lines. The decision tree (priority order: Over WIP > Over Weight > At WIP > calm):
  - **Over WIP** → `⚠ Over WIP · {count}/{limit}` (or `⛔` glyph when `hardWipEnforced`), `text-danger font-medium`, `title="Over WIP limit"`
  - **Over Weight** (and not over WIP) → `Weight {weight}/{limit}`, `text-warning font-medium`, `title="Over weight budget"`
  - **At WIP** (`cardCount === wip_limit`, not over WIP/Weight, board opt-in `show_wip_at_limit` on) → `WIP {count}/{limit}`, `text-fg-muted` (no accent strip, no glyph — it's calm, not a warning), `title="Column is at its WIP limit ({count}/{limit})"` (#973)
  - **Calm** → `{count} cards` (`1 card` for a single card), `text-fg-muted`, `title="Cards in column"`
- **Drop the `WIP` / `Weight` label words in calm states.** The limit phrasing only earns its place when a column is actually over, or the board has opted into the at-limit indicator — otherwise the count alone reads faster on a scan.
- **At-limit indicator is off by default and board-scoped (`Board.show_wip_at_limit`, admin-only toggle in Board Settings → Rules → Limit enforcement).** It never adds chrome beyond the calm-state text color — no top accent strip, no glyph — so it stays visually subordinate to the two over-limit states above it in the priority chain.
- **Top accent strip — peripherally scannable cue for over-limit state.** When over WIP, render `border-t-2 border-t-danger-emphasis` on the header surface; when over weight (and not over WIP), `border-t-2 border-t-warning-emphasis`. The strip is the *only* over-limit chrome; the existing rule "text color + `font-semibold` only, no filled background" still holds for the stat text. Never use a filled `bg-danger/…` background for over-limit stats — it competes with the column header surface color.
- The collapsed (40px-wide) header mirrors the same top accent strip and shows a `⚠` glyph in red (over WIP) or amber (over weight, not over WIP). Title includes the over-limit reason for screen readers.
- Column color dot: `w-2.5 h-2.5 rounded-full flex-shrink-0` in the column's assigned color
- Nav arrows (`◄` / `►`): `text-fg-faint hover:text-fg-secondary text-xs transition`
- Column name truncates with ellipsis — never wraps

## Board grid cells

- Background: `bg-canvas` — darkest level, creates depth contrast with cards and headers
- Grid lines: `border-r border-line/50` on populated cells; an empty cell swaps it for the dashed `border border-dashed border-line/50` frame — subtle, not prominent
- **Empty addable cells (#962)** — when a cell has no cards, the user can create cards in it (`column.allow_card_creation && canEdit`), and is not currently editing, the cell wrapper itself is the keyboard-reachable creation surface. Spec:
  - `role="button"`, `tabIndex={0}`, `aria-label="Add card to {column.name} in {swimlane.name}"` so screen readers announce *which* slot the action targets. When a grid overlay gives the cell a value, that reading is appended to this same label — see § Board grid overlay slot; an `aria-label` overrides every descendant's text, so an `sr-only` reading inside the cell would be silently discarded
  - `cursor-pointer hover:bg-surface-hover/30` on the cell so hover gives a soft wash; `focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis` for keyboard focus
  - Dashed inset border (`border border-dashed border-line/50`) is the visual frame
  - The visible **`+ Add card`** label is a centered, `pointer-events-none`, `aria-hidden="true"` overlay (`absolute inset-0 flex items-center justify-center text-xs text-fg-muted`) that brightens on cell hover/focus via `group-hover/cell:text-fg group-focus/cell:text-fg`; the label text sits in an inner `rounded px-2 py-1` span that also gains `group-hover/cell:bg-surface-hover/50 group-focus/cell:bg-surface-hover/50` so it reads as a button (#200). Cells keep `min-h-[80px]` so empty rows hold a consistent height
  - Click anywhere in the cell — or Enter / Space when focused — opens the new-card input. Double-click and right-click continue to work as before
  - During an active card drag, hide the centered overlay so the existing drop-target indicator owns the visual frame
- **Populated cells** keep the dense info-rich layout. The `+ Add card` affordance is the bottom-aligned button (`w-full text-left text-xs text-fg-faint hover:text-fg-secondary hover:bg-surface-hover/50 mt-1`) and the cell wrapper is *not* `role="button"` — power users can Tab from the last card directly into the bottom button without the cell intercepting Enter.
- **Never render two creation affordances on the same cell.** Empty cells have the cell-as-button only; populated cells have the bottom button only. The two states are mutually exclusive.
- Board stats corner cell (top-left, where header row meets swimlane column): stacked `text-xs text-fg-muted` lines for col/lane/card counts

## Board grid overlay slot (#1147)

The board grid has one pluggable shading layer. An overlay (`src/gridOverlays/`) supplies
a per-cell `{value, label}`; the slot owns the scale, every class, the legend, and the
empty state. Rules:

- **An overlay supplies numbers, never classes.** `GridOverlay.compute()` returns values
  and labels only. The ramp, the non-color channels, the legend and the empty state live
  in `src/gridOverlays/scale.ts` and `slot.ts`, so #969's dual-encoding rule is enforced
  once for every overlay instead of once per overlay. An overlay that *could* ship a
  hue-only ramp is a bug in the slot, not in the overlay.
- **Severity is encoded three ways, and none of them is a font glyph (#969).** Tint
  (`bg-primary-emphasis/10 /20 /30 /40`) + a bar pinned to the cell's bottom edge
  (`h-px / h-0.5 / h-[3px] / h-1`, `bg-primary-emphasis` at `/50 /70 /85 /100`) + the
  value itself. Never `▁▃▅▇` or any block-element glyph: they do track `currentColor`,
  but their advance width and baseline are font-dependent, so the ramp's step size is not
  reproducible across platforms. Never `⚠` / `⛔` on a magnitude overlay — those belong to
  actionable severity (§ Column headers, § Move-blocked toast), and a high card count is
  not a problem.
- **A generic overlay ramps one hue; it never borrows success→warning→danger.** A scalar
  the slot cannot interpret means "more/less", not "safe/dangerous" — `bg-warning/*` is
  the card aging tint and `bg-danger/*` is over-WIP, so a red cell would assert a judgment
  the overlay cannot justify. The ramp is `primary-emphasis`, identical in both themes, so
  it is verified once. **Never `bg-info/*` inside a cell:** `/10` is the active-toggle
  state, `/15` the filter-match pulse on collapsed stubs, `/20` the drop-target indicator.
  The ramp starts at `/10`; `/5` is below the perceptibility floor over `bg-canvas`.
- **The tint is the first child of the cell root, `z-0`, `pointer-events-none`,
  `aria-hidden`; the value badge is a sibling at `z-[5]`.** A positioned descendant paints
  above non-positioned in-flow content regardless of DOM order, so the card stack and the
  affordances after it carry `relative` and beat the tint on DOM order. The badge needs the
  opposite outcome and cannot get it from DOM order at all: `CardItem`'s root is
  `relative z-0`, so a z-auto badge earlier in the subtree paints *underneath* the first
  card. The three numbers in play are exact — `z-[5]` clears the cards, stays **below** the
  sticky swimlane label panel (`z-10`) and the sticky header row (`z-20`) which a badge
  must never cover when the grid is scrolled, and still yields to a hovered card
  (`hover:z-20`) so the card's own selection checkbox stays usable in the same corner.
  Never put the tint on the cell root's `bg-*`: the root already carries `bg-canvas` and
  the drag-over `bg-surface-hover/40`, and a third `bg-*` on one node is a Tailwind
  ordering coin-flip.
- **A cell tint or z-order change needs a browser check in both themes before merge.**
  jsdom renders no paint order, so a vitest suite will pass over a layer that is invisible
  in the product. Class-level assertions (the z value, the tint token) are a guard against
  regression, not evidence that the layer is visible.
- **The layer is suppressed on the cell being dragged over.** Drop feedback owns the
  background channel — same precedent as hiding the centered `+ Add card` overlay during a
  drag.
- **One scalar per cell corner.** The top-right slot renders *either* the built-in
  `cards.length` badge (at ≥ 2) *or* the overlay's value badge, never both.
- **A cell whose `aria-label` is set must carry the overlay reading inside that label.**
  An empty addable cell is `role="button"` with an `aria-label`, and an `aria-label`
  overrides every descendant's text — an `sr-only` reading there is silently discarded.
  Append it to the cell's label and mark the visible badge `aria-hidden` instead.
- **The legend floats; it is never a strip.** Every above-grid strip is in-flow and
  `shrink-0`, so it shrinks the `flex-1 min-h-0` scroll container — that is displacement,
  which this slot forbids. The legend is `absolute bottom-4 right-4 z-30
  pointer-events-none` inside a `relative` wrapper around the **scroll container only**,
  so it can never cover `BoardActivityDrawer`. `bottom-4` clears `.board-scroll`'s
  always-visible 10px custom scrollbar (`src/index.css`) and `pointer-events-none`
  means a graze can never eat a scrollbar drag. `z-30`
  is deliberately below `BulkActionToolbar` (`z-40`) and `MoveBlockedToast` (`z-50`) — a
  transient message always wins over a passive key. It fades (never unmounts) during a
  drag, and drops to a single compact row below `lg` via `useIsLargeViewport`.
- **The legend's empty state is filter-aware, and it is the second one-line empty state
  in the system.** § Empty states' centered-icon pattern is for a surface with nothing in
  it, and the board is full of cards, so the legend uses the one-line form at `text-xs
  italic` — but `text-fg-muted`, not the `text-fg-faint` the card-detail sub-sections use:
  faint is a decorative tone and this is the only sentence the panel shows. The copy must
  name the actual cause — `No values match the active filters.` when `isFiltered`, and
  `No values on this board yet.` otherwise. "Nothing on this board" is a lie when the
  filter bar is what emptied the overlay.
- **`role="group"`, never `role="region"`** — the board is capped at four landmarks
  (§ Top chrome). Swatches are `aria-hidden`; each legend row carries an `sr-only` level
  prefix, and an unused level renders `—`, never `0`.
- **The picker never folds into `OverflowMenu`.** It is the one Zone 2 control exempt from
  the fold set: an `OverflowItem` carries an action, not a selection, and the never-folded
  set still fits Row 2 at every supported width. It lives right after **Filters** (Filters
  changes *which cards*; the overlay changes *what is drawn over them*), passes
  `portalMenu`, and maps "None" to `selected={null}` so the trigger reads `Overlay` at
  rest and takes the primitive's active treatment — showing the overlay's own name —
  exactly when one is on. `triggerPrefix={OverlayIcon}` is not decorative: it is what keeps
  the control identifiable once its text becomes the option name.
- **Overlay ids are a persisted contract.** `board:{boardId}:grid-overlay` stores the raw
  id and unknown ids decay to `none` through `resolveGridOverlayId` — a board preset
  (#1146) or a stale value may name an overlay this build has never heard of, and an
  un-overlaid board is a strictly better failure than a board that does not render. Never
  rename a shipped id; `label` is free to be reworded.
- **Never gate the overlay on `canEdit` or `isAdmin`** — it is a local reading preference
  with no server write, so every role gets it. It renders only in `view === "board"`.
- **Two live regions on the board is deliberate.** The overlay announcer sits beside the
  DnD announcer because they are driven by disjoint actions (a pointer drag vs. a toolbar
  click); the one-region-per-action rule targets two regions racing on a *single* action.
  Cell values themselves carry no `aria-live`: they change from other users' WebSocket
  events, and announcing those would make the board unusable with a screen reader.

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
- **Non-pinned custom fields get exactly one line of their own in the peek, above the metrics line — never one row per field (#1308).** This is the one deliberate exception to the single-line rule above: a label that scopes custom fields cannot also scope weight/attachments sharing its line. When the board has any `show_on_card` definition, the line opens with `Other fields — ` (`font-medium text-fg-tertiary`) so a peek entry (`AE: Bob`) can never be read as the card-face chip (`SA: Glenda`) disagreeing with itself; with nothing pinned, no label. Key the label off `show_on_card`, never a pin count (#1146 presets). Pinned fields are **not** repeated in the peek. Each entry is its own `<span className="inline-block max-w-full truncate align-bottom" title="{name}: {value} — {help_text}">` (clipped like the card-face chip, so a long unbroken value never overflows the 288px panel) (help text omitted when empty) — there is no separate full-name field, so the field's help text is the only place an abbreviated name can be spelled out, and a per-entry element keeps room for #1122 threshold coloring. Cap at 6 visible slots: 5 entries + `+N more`, whose `title` lists the hidden field names.
- Per-user per-field hide toggles (the prior `hideLabels` / `hideDueDate` / `hideAssignee` / `hidePriority` / `hideLastMoved` checkboxes in Board Settings → Display) are removed in 1.1. Density is the single knob; legacy localStorage values for those keys are silently ignored.
- The Board Settings *Display* tab gives admins a radio group (Comfortable / Standard / Dense) with a one-line description of each tier. Non-admins see a read-only line stating the current density.
- **Per-user density override, layered on the board default (#974).** Every user (admin or not) can additionally set a personal density that overrides the board admin's `card_density` for their own view only, via a "Use my own density" toggle beneath the admin radio in Board Settings → Display. Rules:
  - **Storage is board-scoped, not global**: `useCardDensityOverride` (`frontend/src/hooks/useCardDensityOverride.ts`) persists to `board:{boardId}:card-density-override`, holding one of `comfortable` / `standard` / `dense`. Absence of the key — not a stored `null` — means "follow board default"; toggling the override off calls `localStorage.removeItem`. A global `user:prefs:*` key would be wrong here because "follow board default" only has meaning relative to *this* board's admin setting.
  - **Resolution happens once, in `BoardView`**: `effectiveCardDensity = cardDensityOverride ?? board.card_density` is computed a single time and passed through the *same* `density` prop that already flows `BoardView` → `SwimlaneRow` → `BoardCell` → `CardItem` (and the drag-overlay `CardItem`). Never read `board.card_density` directly at a card-rendering call site again — always the resolved value — or a density change ends up half-applied (e.g. dense card face but a comfortable-computed row height).
  - **The admin's board-level radio and the personal toggle+radio are separate, non-stomping storage locations by construction** — writing one never touches the other. An admin changing the board default does not clear any user's personal override, including the admin's own.
  - **The personal radio group is a distinct `name` (`personal-card-density`) from the admin group's (`card-density`)** so the two native radio sets never collide, and is conditionally rendered (not just visually hidden) when the toggle is off, matching the personal Columns/Swimlanes section's own conditional-render pattern in the same tab.
  - **Gate the personal-override UI on `onSetCardDensityOverride` alone** — never couple it to `isAdmin` or to the `viewPrefs`/hidden-column gate. Density override and column/swimlane visibility are unrelated personal settings that happen to share this tab; admins get both the board radio and their own personal toggle, since an admin may want a personal view that differs from the team default they set.

**Card-face blocked indicator (#449) — the one card-face signal with no density gate.** When `blocker_count > 0`, `CardItem` renders a danger-toned glyph as the **first** element of the metadata row, outside the `!compact` branch and outside every density conditional.

- **No density gate, and outside `!compact`.** The checklist badge has no gate either, and blocked-ness is more actionable than checklist progress. `comfortable` is the default for every board created since 1.1, so gating it out there would remove the whole-board scan signal — the entire point of the feature — from most boards.
- **First in the row.** The metadata row is `overflow-hidden` with no wrap at rest, so it clips right-to-left: anything placed after a variable-width neighbor (a long label pill, `⚑ 12d late`, a `max-w-[10rem]` custom-field chip) can be cut off on a narrow column. Leading position also keeps every blocked card's marker in one x-gutter, which is what makes a top-to-bottom column scan work.
- **Inline SVG with `currentColor`, never an emoji.** `⛔`/`🚫` paint in their own fixed color and would ignore `text-danger`, so the badge would stop tracking the theme. The neutral `📎`/`✓` badges get away with it; a danger signal does not.
- **Icon always, numeral only above 1.** At one blocker the numeral repeats what the icon says. The exact count always appears in `aria-label` and `title`.
- **`role="img"` + `aria-label` are required, not optional.** At a count of 1 the element contains no text node, so without them it has no accessible name at all. `title` is retained for the sighted hover tooltip only — it is not a reliable accessible name.
- **Tone only — no fill, no border.** It is therefore not a pill and creates no third exception to the filled-pill rule in § Badges and labels. The precedent is the urgency badge, not the label or custom-field chip.
- **`blocker_count` must be in `arePropsEqual` and in `hasMetadata`.** Without the first, the memo swallows the WebSocket update and the badge never appears; without the second, a card whose only metadata is "blocked" drops the whole metadata row.
- Never duplicate it into `CardPeekPopover` — the peek carries metrics *hidden* at low density, and nothing is hidden here.

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
- **Position on cards: `absolute bottom-1.5 right-1.5 z-10`, not a flex child of the metadata row (#1411).** `CardItem`'s metadata row is `overflow-hidden` with no wrap at rest; an avatar rendered as the row's last flex child (`ml-auto`) is the first thing silently clipped when the row overflows — backwards, since the avatar is the one metadata element with no density gate. The content wrapper carries `relative`, and the metadata row carries `min-h-5 pr-7` whenever `card.assignee` is set: `pr-7` keeps clipped chip content from running under the avatar's corner, and `min-h-5` (20px, the `xs` Avatar's height) gives the row the vertical footprint the avatar needs. Both are required — the reservation is the row's height plus its right padding together. **This reservation must hold even when the assignee is the only metadata on the card** — `card.assignee` stays in `hasMetadataRow`'s OR-chain for exactly this reason: an otherwise-empty row still has to render, and because an empty flex row has zero height, `pr-7` alone reserves nothing vertically (the avatar would overlap the last title line by ~12px); the `min-h-5` is what pushes the card's bottom edge below the avatar, or the absolutely-positioned avatar sits on top of the title with nothing stopping it. Dropping that clause because "the avatar isn't a row child anymore" was a real regression caught by ux-review (#1411) — don't reintroduce it by a different path.
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
- **Pulse and reduced motion.** The healthy dot stays static per the prominence rule (a pulse was proposed in #199 and declined in favor of #851). Degraded-state dot pulses follow the general reduced-motion rule in § Motion and reduced motion.
- **Five states:**
  - `connected` → `text-success` dot, no background
  - `connecting` / `reconnecting` / `stale` → `text-warning bg-warning/10 border border-warning/30 rounded px-2 py-0.5` (the connecting and reconnecting dots pulse with `animate-pulse motion-reduce:animate-none`; stale is static)
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
- **Pinned custom-field chips stack below the name, and do not survive collapse (#1140).** Up to eight pinned values (the interim cap, #1417) render inside the label panel in a `flex flex-col items-start gap-1 mt-1 min-w-0` container directly beneath the name/`contact_email` block — never as a full-width band across the cells, which the row's `flex` label-panel-then-cells structure has nowhere to put. A trailing `+N` chip in the same container opens `SwimlaneFieldsPopover` with the row's full visible field list; render it only when `N > 0`, and label it `+N more` when no pinned chip precedes it, so the affordance is readable standing alone. A value of `""` renders nothing at all — never a dashed ghost chip; dashed already means "unset ghost" on the card face and must not acquire a second meaning here. The whole cluster is gated on `!collapsed`, matching `contact_email` on the line above: a collapsed row is `py-1` and exists to give vertical space back, so stacked chips would undo the gesture. The tradeoff — row metadata is least visible exactly when a user is scanning many rows — is accepted because the `+N` trigger disappears with the chips, so nothing is silently truncated, only folded behind the chevron the user just pressed.
- **`SwimlaneFieldsPopover` leads with what `+N` counted (#1455).** The `+N` chip counts the fields that are *not* on the row, so the popover lists those first and the pinned ones after an `On row` sub-heading, styled exactly like the `Fields` heading plus `border-t border-line`. Omit the sub-heading when either group is empty. Viewer-facing surfaces say "On row"; only admin settings say "Pin" or "Pinned" (`BoardSettingsSwimlaneFieldsTab`), because members never see the pin control.

## Board Settings tab bar (#1140)

- **Field-list type labels never wrap (#1391).** The type label cell in Board Settings → Card fields and Swimlane fields is `w-20 whitespace-nowrap shrink-0`. `w-16` truncated "Multi-select" onto two lines and pushed the row taller than its siblings; size the cell for the longest type label, and widen it again (in both tabs) rather than abbreviating a new one.

- **Label tabs by scope as soon as two of them configure the same kind of thing.** `Fields` became `Card fields` when `Swimlane fields` landed. Two tabs named for *what* they configure and not for *what it attaches to* is a coin flip on first encounter, and the cost of the wrong guess is an admin defining a field on the wrong object and only finding out when it fails to appear. Whenever a new tab configures a sibling of an existing tab's subject, rename **both** to carry the scope noun. Never disambiguate with an icon, a tooltip, or a help line under an otherwise identical label. Keep the pair adjacent in the tab array — a renamed pair split across the strip does none of the work the rename was for.
- **Use the product's own noun.** "Swimlane fields", not "Row fields": `EditSwimlaneModal`, `AddSwimlaneModal`, the collapse `aria-label`, and the Display tab all say *swimlane*, and a label is the wrong place to introduce a synonym.
- **The tab strip scrolls; it never wraps — and the panel is sized so it rarely has to.** The strip is `flex border-b border-line px-6 gap-1 overflow-x-auto` with `shrink-0 whitespace-nowrap` on every tab button, which is what actually prevents a second row of tabs appearing under the border; that guarantee holds at any panel width. The panel's `max-w-2xl` is a separate, weaker call: at `max-w-lg` the seven current labels overflow and the strip scrolls on first open, which reads as a broken tab bar rather than an affordance, and `Members (N)` grows with the member count. So the width buys breathing room, not correctness — do not justify it as a wrapping fix, and if a future change makes the label set short again, narrowing it back is safe.

## Radio groups

Never render browser-default radio circles. Use `sr-only` native `<input type="radio">` inside a `label` container — this preserves native keyboard navigation (arrow keys, Tab, Space) while hiding the visual control.

Represent selection state on the container:
- Selected: `border-primary-emphasis bg-primary-emphasis/10` — **never `bg-info/10`**; the `primary-emphasis` token tracks the active theme, `info` does not, so an `info`-tinted fill reads off-brand in dark mode
- Unselected: `border-line-strong hover:bg-surface-hover/40`
- Keyboard focus: `focus-within:ring-2 focus-within:ring-primary-emphasis rounded-lg` on the `label`
- Transition: `transition-colors duration-150`

Option text: `text-sm text-fg font-medium` for the label, `text-xs text-fg-muted mt-0.5` for the description line below it.

**Compact / chip-style radio groups** — a 2-4 option inline segmented choice (e.g. the relation-type picker in `RelationCardPicker`) may use `rounded` instead of `rounded-lg` on the option container, matching its smaller `px-2 py-1 text-xs` chip sizing. The `rounded-lg` guidance above assumes the larger card-with-description-line layout (e.g. the export format choice). Both variants keep the same selected/unselected token pair and the same `focus-within:ring-2 focus-within:ring-primary-emphasis` treatment — only the corner radius and text sizing shrink. A chip row also takes `flex-wrap`: three short chips fit at 320px today, but a longer translation or a fourth option would clip silently without it, and there is no action button to push the overflow onto.

Group the options in a `<fieldset>` with a `<legend>` (`sr-only` when there is no visible heading for it) — never put `role="radiogroup"` on a `<fieldset>`, which already carries group semantics.

The action button following a radio group uses the primary variant (`bg-button-primary hover:bg-button-primary-hover text-on-primary`) and its label should reflect the current selection (e.g. "Export JSON" / "Export CSV") to eliminate ambiguity.

## Subordinate settings blocks (toggle/checkbox-gated)

When a block of settings is only relevant while a toggle or checkbox directly above it is on (e.g. the Rules tab's Hard-WIP-mode options gated by "Enforce WIP limits", or the Display tab's personal density radio group gated by "Use my own density"), indent and rule off that block with exactly:

```
ml-6 border-l-2 border-line pl-4
```

**Do not invent a per-instance variant** — no custom border color (`border-line-strong`), no opacity modifier (`border-line-strong/40`), no different indent/padding pairing. This is the one sanctioned treatment for "a settings block that visually belongs to the control above it," established by the Rules tab's Hard-WIP-mode block (`BoardSettingsModal.tsx`) and reused as-is by the Display tab's personal density override block. `RoleTooltip`'s `pl-3 border-l-2 border-line` is a pre-existing, unrelated exception (tooltip content formatting, not a gated settings block) — do not treat it as a third variant to reconcile against.

**Not every control-plus-dependent-fields layout is toggle-gated.** The rule above applies when the dependent block is *inert* while the controlling toggle is off — there is nothing useful to do with it. It does **not** apply when the dependent fields stay independently meaningful whichever option is selected, because the safe path to switching requires filling them in *before* the switch. Admin Settings → Email is the reference case (`EmailSettingsSection.tsx`): the SMTP host/port/credential fields stay unindented and fully editable whether "Environment variables" or "Database" is selected, because indenting or disabling them under an unselected radio would force an admin to switch mail configuration blind. When leaving a block unindented for this reason, add an inline status line saying whether it is currently in effect (e.g. "Saved, but not in use — {other option} is selected above"), sourced from the **last-saved server state, never the in-progress draft** — do not assert a saved fact about a selection the user has not committed.

**Render-and-disable instead of conditional render is permitted only for a single dependent toggle whose existence is itself the thing being advertised (#356).** The default stays "conditionally render an inert block" (Hard-WIP options, personal density radio). But when the dependent control is *one* switch, the controlling toggle defaults to off for most users, and hiding the switch would make the capability undiscoverable — Sam checks in twice a week and would never learn per-event email notification exists — render it always inside the standard `ml-6 border-l-2 border-line pl-4` block and set `disabled`. Four requirements, all of them load-bearing:

1. The block carries a **visible, always-rendered reason line** whose `id` is passed to the switch via `aria-describedby` (`Toggle` supports that prop), and whose text changes with state — including a distinct state for a stored-ON value under an off parent. A helper that reads as a claim ("Sends a copy…") must not appear under an off switch.
2. The stored value is **never auto-cleared**. Clearing it needs a second write that can half-fail, and it discards a choice the user will want back the moment they re-enable the parent. The disabled switch stays visibly ON and the reason line says it is paused and kept.
3. Dim the label to `text-fg-muted` only. No new opacity modifier — the switch's own `disabled:opacity-40` is the sole dimming.
4. Never use this for a **multi-control** block. Those stay conditionally rendered.
5. **Use `ariaDisabled`, not `disabled`, on the switch whenever the reason line is the "why is this off" case rather than a transient in-flight save (#1159).** Native `disabled` removes the control from the tab order, so a sighted keyboard user never reaches the reason text a screen-reader browse-mode user sees. `Toggle` supports `ariaDisabled` as an opt-in: the switch stays focusable, click and keyboard (Space/Enter) activation are both ignored, and the same disabled visual styling is kept. Keep plain `disabled` for genuinely transient states (e.g. a save in flight) that have no reason line to reach.

Reference implementation: `NotificationRow` in `SettingsPage.tsx`.

**The same `aria-disabled` + `aria-describedby` principle extends to a plain `<button>` whose action is blocked for a reason (#1314).** The rule above is written for `Toggle`, but any standalone action button that can be legitimately blocked (e.g. "Disconnect" on a connected-accounts row when it is the user's last remaining sign-in method) follows the same shape, by hand: `aria-disabled={condition}` (never native `disabled`, for the same tab-order reason), `aria-describedby` pointing at a reason `<p>` rendered **only while the condition holds** (the hint and the block share one gate), and `onClick` set to `undefined` while blocked rather than guarded inside the handler. Keep the control's own semantic focus-ring color (e.g. `focus:ring-danger-emphasis` for a destructive action) in both states. Reference implementation: `ConnectedAccountRow` in `SettingsPage.tsx`.

**A row containing two controls is never wrapped in a single `<label>` (#356).** A click on label text forwards to the first labelable descendant, so text belonging to the second control would toggle the first. Give each control its own `<label htmlFor>` around only its own text block, wrap the pair in `role="group" aria-label="{event}"` so each control has context, and give the repeated visible label a unique accessible name that *begins with* that visible text (`aria-label="Also send by email: {event}"`) so label-in-name holds and `getByRole('switch', { name })` stays unambiguous.

## Native checkbox and radio accent

When a native `<input type="checkbox">` or `<input type="radio">` is rendered with its default browser control visible (i.e. *not* the `sr-only` custom-styled radio pattern above), it **must** set `accent-primary` — never a raw palette value like `accent-blue-500` / `accent-blue-600`. The `accent-primary` token tracks the active theme (including dark mode); a hardcoded `accent-blue-*` stays the same hue regardless of theme and reads as an off-brand control. This applies to filter checkboxes (`ActivityFilterDropdown`), column-option checkboxes (`EditColumnModal`), and any admin toggle that keeps the native control.

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

- **Idle / view state**: a `relative` wrapper holds a `<button type="button">` (`block w-[calc(100%+1rem)] text-left border border-transparent hover:border-line-emphasis cursor-text rounded px-2 py-1.5 -mx-2 transition-colors`, standard focus ring) whose children are `<span className="block ...">` text (no `<p>` inside a button). This button is the single keyboard tab stop. The hover-reveal pencil is an overlay sibling (`absolute top-1 right-1`, `tabIndex={-1}`, `focus:opacity-100 focus:ring-2 focus:ring-primary-emphasis`) so it adds no height (reference: `GroupDetail`)
- **Edit state**: `bg-sunken border border-primary-soft rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent` on the `<textarea>`; `resize-none`; Escape cancels, blur saves
- **Error slot**: always render `<p className="text-xs h-4">` below the field unconditionally; place error text in a `<span className="text-danger">` inside it — never conditionally render the container itself
- **Non-admin, non-empty**: render plain `<p className="text-sm text-fg-tertiary whitespace-pre-wrap">`
- **Non-admin, empty**: render nothing (`null`) — do not show a placeholder the user cannot act on

## Composite inline editors — explicit Save/Cancel (#371)

The pattern above (and the single-value autosave pattern used everywhere else — Weight, Due date, priority, labels) commits on blur or on selection with no separate save step. That pattern only holds for a **single interdependent value**. It breaks down once an editor has **two or more sub-fields that depend on each other** — e.g. Board Settings → Fields' add/edit panel, where the `field_type` selector changes which other sub-fields are relevant (dropdown needs a `choices` list; other types don't) and requires cross-field validation ("a dropdown field needs at least one choice") before any of it is safe to persist.

**Rule:** an inline editor with ≥2 interdependent sub-fields, or any cross-field validation that must pass before a partial state is safe to write, uses explicit `Cancel` / `Save {noun}` text buttons (secondary + primary variant, standard focus rings, `gap-3`) instead of blur/immediate-commit. A single-value inline editor (one text field, one toggle, one dropdown with no dependent fields) stays on blur/immediate-commit — do not add a Save button to a field that doesn't need one; that adds friction without a matching risk.

Reference implementation: `BoardSettingsFieldsTab`'s `FieldEditPanel` (name + type + choices + help text + pin toggle, all validated together in `handleSave`).

## Tooltips

- Consistent delay: 300 ms show, immediate hide
- Placement: prefer `top` for icon buttons, `bottom` for nav items
- Style: `bg-sunken text-fg text-xs rounded px-2 py-1 shadow-lg`

## Inline status messages

- **Reserve vertical space unconditionally** — render the container element always (`<p className="text-xs h-4">`) and conditionally render the text content inside it. Never conditionally render the container itself; doing so causes buttons and surrounding elements to shift when messages appear or disappear.
- Error text: `text-danger`; success text: `text-success` — always on a `<span>` inside the reserved container, not directly on the `<p>`
- **Relabel destructive-escape actions after success** — if a modal stays open after a successful action, relabel "Cancel" to "Close" once success state is set, so the button's semantics match the user's situation
- **`h-4` reserves exactly one line — size the reservation to the copy.** A slot whose longest state wraps to two lines uses `h-8`; a slot holding a full sentence whose wrapping depends on viewport width uses `min-h-4`, which still reserves space unconditionally but cannot clip. A fixed `h-4` under a wrapping sentence overflows into the block below, and the states most likely to carry long copy are first-run states, so the bug ships visible on day one (#306).
- **On form fields, the reserved slot doubles as the helper slot.** Render helper text there by default and swap it for the error when the field is invalid. This satisfies the reservation rule while spending the space productively instead of leaving a dead gap under every input, and it keeps `aria-describedby` pointing at one stable id.
- **Pending server-side effects follow the same rules.** A note describing a deferred/pending server-side effect (e.g. "confirmation email sent") is the affected field's reserved helper slot: render its container unconditionally, with a stable id that the field's `aria-describedby` always points at, and vary only the text. The note itself is not a live region. If the page doesn't navigate away after the triggering save, the save-result line is the terminal state, so make it `role="status" aria-live="polite" aria-atomic="true"`. When part of the change hasn't taken effect, put state-specific copy in that live region instead of a generic "Changes saved." (e.g. "Profile updated. Check your inbox to confirm your new email address."). The two must never coexist (#1273, ProfileTab's pending email change).
- **Actions on a pending effect sit under its note, outside the `<label>`.** Follow-up actions on a pending server-side effect (e.g. **Resend link** / **Cancel change** under ProfileTab's pending email note) are bare-text secondary buttons (`text-xs`, `px-1.5 py-0.5`, `gap-3`, standard focus ring, `type="button"`) rendered only while the effect is pending, placed after the note and outside the field's `<label>` so they never join the input's accessible name; each carries `aria-describedby` pointing at the note so it is announced with what it acts on. Their results go to the same save-result live region as the form's own save (success / `text-warning` for a 429 cooldown whose copy comes from the server / `text-danger`), and a new action or save replaces the previous result — never two at once. When an action ends the pending state and the buttons unmount, move focus to the field they belonged to rather than letting it drop to `<body>`. A personal, reversible withdrawal like Cancel change commits immediately without an inline confirm (#1293).

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
- **In-button variant: `w-3 h-3`.** A spinner rendered *inside* a `px-3 py-1.5 text-sm` button uses `w-3 h-3` with the same border treatment, plus `shrink-0` and `aria-hidden="true"` (the button's own label text carries the state, e.g. "Sending…"). The canonical `w-5 h-5` overflows a `py-1.5` button. Established by `AutosaveIndicator`, reused by `EmailSettingsSection`.
- Center spinners with `flex items-center justify-center`

## Empty states

- Consistent pattern: centered icon (muted, `text-fg-faint`) + heading (`text-fg-tertiary`) + optional CTA button
- No one-off inline empty messages with different styling
- **Card-detail sub-sections are the exception — use the one-line form, not the centered icon.** The centered-icon pattern is page/panel-level; inside the 540px card detail panel it visually out-weighs its own section header. Every sub-section there uses:
  - empty — `No {noun} yet.` · `text-xs text-fg-faint italic`
  - loading — `Loading {noun}…` · `text-sm text-fg-tertiary`, **no spinner** (the panel already fires several fetches without one, and a spinner inside a 20px sub-section is more motion than signal)
  - error — `Failed to load {noun}.` · `text-sm text-danger`, with a `Retry` text button **only when that section is the sole path to an action the user needs** (e.g. Relations is the only way to remove a stale relation, so a dead-end failure would block the user's only remedy)

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
- **Card-detail sub-section gating.** The collapsible sub-sections in `CardDetail` (Custom fields, Relations, Checklist, Attachments) follow one three-way rule, all outcomes being *omit from the DOM*: **board-config-gated** — the board has nothing to show (no custom field definitions): omit the section and its divider; **permission + empty** — a reader with no rows: omit the section and its divider; **permission + non-empty** — a reader with rows: render the rows read-only with every control omitted, never disabled. **Never render a header that a resolving fetch will then remove** — render nothing until the data is in; a section that appears late is better than one that appears and vanishes.
- **Permission + load-error is treated the same as permission + empty: omit.** A reader has no remedy for a failed fetch — no retry worth offering, nothing to act on — so a dead error message is worse than silence, and the section stays absent. This is deliberate, not an oversight in the rule above. A future sub-section that genuinely needs a reader-visible retry is a new exception to argue for, not an extension of this one.
- **Collapsing hides rows, never controls.** A sub-section that collapses itself when empty must keep its add affordance outside the collapse gate, or creating the first item would require expanding a section that looks empty. It must also expand itself when an item is added, or the new row lands in a hidden list and reads as a silent failure.
- **Permission-gated and context-gated are distinct reasons to hide, with the same outcome: omit from the DOM.** *Permission-gated* — the user's role forbids the action (admin-only delete, site-admin nav). *Context-gated* — the action is valid for this user but meaningless in the current surface (e.g. the "Refresh board" affordance on `ConnectionStatus` is omitted on the group page, which has no single board to refresh). In both cases render nothing rather than a disabled/greyed affordance; do not show users a control they cannot act on, regardless of *why* they cannot.
- **A server-omitted value is omitted, not explained (#1140).** `is_admin_only` on a swimlane custom field strips the value from the payload a member or viewer receives; the frontend has nothing to hide, because it was never sent. Do **not** render a placeholder chip, a count of hidden fields, or a "some fields are only visible to admins" note on the board for that user. It is a dead end with no remedy, and it advertises that structured entity data exists on a row whose contact details the same visibility split already hides. This is the permission+load-error rule above, applied to data the client never received. The admin-side signal for the same fact belongs in Board Settings → Swimlane fields — a surface only admins can open, where it has context and an action attached.

## Swapping the open card (#449)

- The only sanctioned way to open a different card from inside `CardDetail` is `window.dispatchEvent(new CustomEvent("visiban:open-card", { detail: { cardId } }))`. `BoardView` owns the listener; no new props, no reaching into board state.
- **Panels replace, never stack.** Stacking card detail panels would create an unbounded Escape / z-index / focus-trap chain with no precedent anywhere in the app. Replacement is what the breadcrumb, the `?card=` deep link, and the command palette already do.
- **Every `<CardDetail>` mount site must carry `key={selectedCard.id}`.** The component seeds `localCard` and its collapsible-section state from `useState(card)` initializers with no prop-sync effect, and its fetch effects key on the card id. Without the key, swapping cards renders the previous card's title, weight, labels, and relations while the new card's data loads — a silent stale-state bug.
- **Never render a navigation affordance to an archived card.** `visiban:open-card` resolves against the board's active cards and silently no-ops, so an archived row renders its title as a `<span>`, not a `<button>`.

## Long URL display fields

- Truncate long URLs in read-only display inputs: `truncate overflow-hidden text-ellipsis whitespace-nowrap`
- The full value must remain in the clipboard on copy — only the display is truncated
- Add a `title` attribute (or tooltip on hover) showing the full URL

## Click handlers need keyboard parity (#1376, Sonar S1082)

A click handler never goes on a non-interactive element (`div`, `span`, `p`, `h1`) without keyboard parity. Pick the first option that fits:

1. **Make it a `<button type="button">`** — inline-rename text (column/swimlane/board/group names), file dropzones, and "click the text to edit" regions. Tailwind preflight already resets button chrome; add `text-left`, `block`, or `max-w-full truncate` as the original element needed. A truncating button inside a `<p>` needs `block`. Add the standard `focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded`. For a heading, put the button *inside* the `<h1>` so heading semantics survive. Do not nest block elements (`div`/`p`) or inputs inside the button — use `<span className="block">` and render hidden file inputs as siblings.
2. **Put the handler on the focusable control** — an overlay `<input type="date">` owns its own `onClick` (picker fallback) instead of a wrapper `div`; a `<label htmlFor>` forwards clicks on label text to its switch (see `ToggleField`).
3. **Decorative pointer-only backdrops** — `aria-hidden="true"` when the backdrop is a sibling of the panel (drawers, tour spotlight, bulk-add overlay), `role="presentation"` when it is the panel's parent (`ModalWrapper`). Both require that Escape (via `useEscapeStack`) and a visible Close button already exist.
4. **A `stopPropagation`-only wrapper is a smell** — delete the wrapper handler and move the guard into the parent handler (e.g. `closest("[data-column-drag-handle]")` in the collapsed `ColumnHeader`).

**Pencil policy:** when a text button is paired with a hover-reveal `✎` pencil that starts the same edit, the text button is the single keyboard tab stop and the pencil is `tabIndex={-1}` (keep its `aria-label`, `focus:opacity-100`, and ring). Never two tab stops for one field.

**Allowed shapes that are not a real button:**
- `CardItem` forwards the dnd-kit `listeners.onKeyDown` explicitly. This is the one sanctioned bare `onKeyDown` on a `div`: the div already has `role="button"` and `tabIndex` from dnd-kit `attributes`, and the restatement only makes the handler visible to static analysis.
- `SelectDropdown` options use the `aria-activedescendant` shape: the combobox trigger owns keyboard selection, and each `role="option"` gets `tabIndex={-1}` plus an Enter/Space handler for parity.

Otherwise never add a bare `onKeyDown` to a `div` just to silence the rule; if the element is operable it should be a real control.

## Focus ring consistency

The permitted focus-ring form is `focus:ring-2 focus:ring-primary-emphasis` (or `focus:ring-danger-emphasis` for destructive actions, `focus:ring-warning-emphasis` for amber confirms). `focus-visible:` is **not permitted** on standalone buttons, dropdown triggers, or tab controls — Firefox and desktop Safari treat `:focus-visible` as more restrictive than `:focus` and skip the ring on pointer-driven focus, leaving keyboard users with no indicator after a click+keyboard-handoff sequence.

`focus-visible:` is permitted only on elements that receive programmatic focus from drag-and-drop libraries (e.g. `CardItem` while a drag is mid-flight) where suppressing the ring during pointer drag is intentional.

**Gate for any PR that touches interactive elements:** run `grep -r "focus-visible:ring" frontend/src/`. If any new instances appear outside the documented DnD exception, switch them to `focus:`. Issues #933, #949, and #983 all closed the same regression — keep this rule visible so it does not recur.

**Confirmation-dialog Cancel buttons need a ring too.** The secondary / "Cancel" button in a confirm or destructive-action dialog is a real tab stop and the keyboard user's safe escape path — it must carry `focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded`, not only the primary or danger action button. A bare-text Cancel with no ring leaves keyboard users with no focus indicator on the very control they are most likely to reach for.

## Hover-reveal controls

When an action button is hidden until hover (`opacity-0 group-hover:opacity-100`), it **must** also include `focus:opacity-100` and a focus ring so keyboard users can reach and activate it. Without `focus:opacity-100`, the button is unreachable by keyboard. This applies to all hover-reveal controls (comment delete, swimlane edit, RTE pencil icon, etc.).

## Card-face quick-edit chip affordance (custom fields, #371)

Pinned custom-field chips on the card face (`CardItem`, checkbox/dropdown types only) are a deliberate exception to the hover-reveal-by-default convention above and to § Inline description fields' hover-only pencil-icon pattern: the dotted-underline edit affordance (`border-b border-dotted border-fg-tertiary` on the value text) is **always visible at rest**, not gated behind `group-hover:opacity-100`.

**Why:** VoC input flagged that Sam (occasional, non-daily user) gets no opportunity to learn a hover-only affordance exists on a card face he visits only a few times a week — by the time he'd hover to discover it, he's already concluded there's no way to edit the value inline. A persistent, low-contrast dotted underline is discoverable without training and adds no visual weight to the chip beyond the browser's own `<abbr title>` convention for "this text is a control."

This exception is scoped narrowly to the pinned-chip quick-edit affordance itself. It does **not** relax the hover-reveal convention for anything else on the card — the card's other hover-only controls (the selection checkbox, etc.) keep their existing `opacity-0 group-hover:opacity-100 focus:opacity-100` treatment. Do not generalize "always visible" to other inline-edit affordances without a matching VoC finding; hover-reveal stays the default.

## Number custom-field formatting (#1391)

1. **One formatter.** Every read-only rendering of a number value (card-face chip, row chip, card detail, peek, filter chip) goes through `formatCustomFieldValue` → `formatNumberValue` in `utils/customFieldValue.ts`. Never format a number value inline at a call site. With all three options at their defaults it returns the raw string untouched — no grouping is added to an unformatted field. A non-numeric stored value renders raw. The minus sign goes before the prefix (`-$5.00`). **Chips do not character-slice a formatted number:** the card-face (16) and row (20) character caps cut the suffix — the unit — first, so `chipValueText` leaves a number with any format option whole and lets the chip's CSS `truncate` clip it only when it truly does not fit (the `title` carries the full text). Unformatted numbers and every other type keep the character cap.
2. **The settings Format block** (`components/Board/NumberFormatFields.tsx`, shared by the Card fields and Swimlane fields tabs) renders **only** while the selected type is `number`: a `Format` section label, then `grid grid-cols-2 sm:grid-cols-3 gap-3` (Decimals wraps to a second row on phones) of three `<label>`-wrapped inputs — Prefix and Suffix (`maxLength={10}`, placeholders `e.g. $` / `e.g. h`, never trimmed), Decimals (`type="number" min=0 max=10`, empty = as typed). Below it, one reserved `text-xs min-h-4` slot holds `Preview: …` (`text-fg-muted`, the formatter applied to `1234.5`; `min-h-4` because a long prefix/suffix can wrap it) or, for invalid decimals, `Enter 0 to 10.` (`text-danger`, `role="alert"` on that error span only — never on the preview or the slot, which would announce every keystroke — with `aria-invalid` + `border-danger focus:ring-danger-emphasis` on the input) — never both. Invalid decimals block Save. A non-number type sends none of the three keys; the server clears them on a retype.
3. **The adorned number input.** In `CustomFieldValueInput`, a prefix and/or suffix wraps the raw `type="number"` input in `inline-flex w-auto min-w-28 max-w-full items-center bg-surface border border-line rounded focus-within:ring-2 focus-within:ring-primary-emphasis focus-within:border-transparent` — never a fixed width, so two 10-character adornments cannot squeeze the number — the input itself is borderless `bg-transparent` and keeps the plain input's width (`w-20` sm / `w-32` md) with a `min-w-[4rem]` floor, and each adornment is a `shrink-0 select-none whitespace-pre text-fg-muted` span with `aria-hidden="true"`. Because the adornments are hidden from assistive tech, the input's `aria-label` carries the unit: `{field name} ({prefix suffix})`, e.g. `Budget ($ USD)`. With neither set, render the original plain input — no wrapper.

## Custom-field choice color picker (#1391)

- **One control per choice row, in both field-editor tabs.** `components/Board/ChoiceColorPicker.tsx` renders in front of each choice input, only while the type is `dropdown` or `multi_select`: a `p-0.5` (24px hit area) button around a `w-5 h-5 rounded-full` swatch: filled with the explicit color's `base` (`border border-line-strong`), or — for *Automatic* — a **hollow `border-dashed border-line-strong` circle with no fill**. Never fill Automatic with the hash `choiceColor`: a filled circle reads as a picked color, and a multi-select entry with no color shows no dot at all. `aria-label="Color for {choice}: {Name|Automatic}"` (also the `title`), `aria-haspopup="dialog"`, `aria-expanded`; disabled while the choice is blank. Clicking it opens a `role="dialog"` popover (`bg-surface border border-line-strong rounded-lg shadow-xl p-2`, labelled `Color for {choice}`) holding the current name, a `role="radiogroup" aria-label="Palette"` `grid grid-cols-4 gap-2` of the 8 swatches (`role="radio"`, `aria-label` = the capitalized key, `aria-checked`), and a `Reset to automatic` text button. The selected swatch shows a check icon **and** `ring-2 ring-fg ring-offset-1 ring-offset-surface` — the `text-on-primary` check alone is under 3:1 on amber, green and teal, so selection never rests on it.
- **Keyboard:** one roving tab stop; arrow keys move focus (Up/Down by a row of 4) without selecting, Space/Enter select and close, focus returns to the swatch button. Escape closes **only** the popover — `useEscapeStack` at 47 (see the modal allocation list); a click outside, or focus leaving the picker (Tab out — a `focusout` whose `relatedTarget` is outside the wrapper), closes it without a change and without pulling focus back. No focus trap.
- **Edge handling inside the scrolling settings panel.** On open, the picker measures the viewport space below its trigger and opens upward (`bottom-full mb-1` instead of `top-full mt-1`) when under 200px is left, and the popover calls `scrollIntoView({ block: "nearest" })` on mount, so one opened on the last choice row is never half out of view.
- **Draft-only, saved with the field.** A pick changes the editor draft; the existing **Save field** sends `choice_colors` (only for choice types — a non-choice type sends no key and the server clears the map on retype). Never a save per pick.
- **Renaming resets the color, and the editor says so.** Colors are keyed by the choice text: editing or removing a choice drops its entry from the draft (`withoutChoiceColor`), and `choiceColorsPayload` sends only trimmed, current choices with known keys. The note `Renaming a choice resets its color.` (`text-xs text-fg-muted`) sits directly under the choice list, shown only while at least one choice in the draft has an explicit color — with nothing to lose it is noise. Choice names are user text used as object keys, so draft and payload maps are built with `Object.fromEntries` / read with `Object.hasOwn` (`withChoiceColor`, `draftChoiceColor`, `choiceColorsPayload`): a plain `obj[choice] = …` silently drops a choice named `__proto__`.

## Move-blocked toast (MoveBlockedToast)

- **Use `MoveBlockedToast` for all card move constraint violations** — WIP limit, weight limit, or any future column constraint. Never add a second inline toast block in `App.tsx`.
- **Always amber** — `border-warning / text-warning`. Do not introduce a second color for a different limit type; severity is communicated via icon, not color.
- **Always show three things**: what was blocked (column name), why (with numbers), and an admin override link when `isAdmin` is true.
- **Admin override link**: `text-xs text-warning hover:text-warning underline transition` — never a button with background fill.
- **Hard-block variant** (`error.code === "wip_hard_blocked"`): use `⛔` as the toast icon instead of `⚠`. This is the only permitted way to signal severity difference between soft and hard constraint blocks — do not change the amber color. Omit the admin override link for all roles. Add a `text-xs text-fg-tertiary` resolution line: "To unblock, move a card out of [column], or ask an admin to raise the WIP limit."
- **Systemic vs. personal block reasons need a fixed, non-admin-authored title** (#1127). When a block is operator-imposed and instance-wide rather than caused by the current user's own state (e.g. `maintenance_mode`), the toast title must be a fixed sentence — not the generic hard-block title, and never left to the operator's free-text `detail` field alone to convey. A terse or generic operator message must not read as "you personally did something wrong." This mirrors the fixed-lead + operator-message pattern in `MaintenanceBanner` (see § Degraded-state site banners): `maintenance_mode`'s title is "The instance is temporarily read-only", with `error.detail` following after the em dash exactly as any other variant's body. This is a deliberate exception to the terse noun-phrase title vocabulary used elsewhere in this table ("WIP limit reached", "Cannot move this card") — do not shorten it to fit that pattern.

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
- `aria-label` reflecting the current state (e.g. `isFocused ? "Exit focus" : \`Focus on ${name}\``) — an icon-only toggle's SVG is `aria-hidden`, so `title` alone is **not** a reliable accessible name (Firefox/VoiceOver skip it). Always pair the state-reflecting `title` with a matching `aria-label`
- Updated `title` attribute when active (e.g. `isFocused ? "Exit focus" : \`Focus on ${name}\``) — tooltip text must reflect the current action, not the initial one
- The active visual treatment (e.g. `text-info !opacity-100`) is sufficient for sighted users; `aria-pressed` covers the rest
- A glyph, letter, or symbol child (e.g. `◀`, `B`, `✕`, `A`) is **not** a substitute for `aria-label`, even though it produces some accessible name — screen readers announce the bare character ("bee", "ex"), not the action. `aria-label` must describe the action (e.g. `aria-label="Bold"`, not relying on the visible "B"). This applies to every icon/glyph-only button, not only toggles (#1240)

## User preference persistence

**User-scoped UI preferences** (toggles reflecting a reading habit or display style not tied to a specific board) use a single flat localStorage key in the format `user:prefs:{preference-name}`. Do not embed a board ID. Do not extend `useViewPrefs`. Create a dedicated hook following the try/catch + fallback pattern in `useViewPrefs.ts`. Never store UI-only preferences in the backend `UserSerializer` unless cross-device sync is an explicit requirement.

- **Board-scoped keys:** `board:{boardId}:{pref-name}` — for preferences that are per-board (hidden columns, filters, column widths)
- **User-scoped keys:** `user:prefs:{pref-name}` — for preferences that apply across all boards (reading habits, display toggles)

Each key in either namespace requires a `load()` function with try/catch + fallback-to-default, and a `save()` function that fails silently.

**Not every "show once" surface is a client-side preference (#1314).** The `user:prefs:*` / `board:{boardId}:*` namespaces above are for reading habits and display choices, where "has this device seen it" is the right question. A one-time prompt gated on **server state** — e.g. `pending_connect_provider` on the current user, driving `ConnectProviderModal` — stays server-owned: render it from the field's presence, and dismiss it with a real API call ("Not now" calls `dismissPendingConnect()`), never a localStorage/sessionStorage "seen" flag. A client-side marker would re-show the prompt on every other device and tab. Close optimistically; if the dismiss call fails, let the prompt reappear on a later load rather than blocking the user.

## Mode indicator banners

**Post-join success strip (#1444).** `Common/JoinedNotice.tsx` is the single post-join success strip, used by `GroupDetail` (#998) and `BoardView` (#1444). It persists until dismissed and never auto-dismisses (`role="status"`, dismiss button `aria-label="Dismiss notification"`). Any new invite surface that lands the user on a destination page reuses it rather than hand-rolling a banner. Board placement is between the filter row and the scroll container — the same slot as the mode banners below.

When a persistent board-wide mode is active (e.g. focus mode, a future "view-only" lock), render a full-width strip between the filter row and the scroll container. The strip must sit **outside** the scroll container so it does not scroll away.

- Style: `bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info transition-opacity duration-150`
- Use `bg-primary/15` to signal "active mode" — distinct from transient toast notices (`bg-surface-hover/80`) and warnings (amber)
- Exit controls within the strip use the **secondary button variant** (`text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:ring-2 focus:ring-primary-emphasis`) — never the primary variant
- Mode name or target label: `font-medium text-info truncate max-w-[24rem]` with `flex-shrink-0` on the exit button

## Degraded-state site banners (system-imposed, not user-chosen)

Not every persistent banner is a "mode" the current user opted into. When a banner reflects a site-wide degraded state set by an operator — the user did not choose it and cannot exit it — use the amber degraded-state language from § Connection status indicator, **not** the `bg-primary/15` mode-indicator treatment above. `bg-primary/15` reads as "you turned this on"; for a state imposed on the user it reads as decorative and gets ignored.

- Style: `bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-3 text-sm text-warning shrink-0`
- Sits **outside** the scroll container, same placement rule as § Mode indicator banners, so it never scrolls away
- **Non-dismissible** for the duration of the state — no exit or dismiss control. The banner disappears on its own once the operator clears the condition. A banner the user can dismiss is one they will dismiss and then forget, which defeats the point of telling them
- `role="status" aria-live="polite" aria-atomic="true"` — informational, **not** `role="alert"`. The user did not cause this and has nothing to act on, so it must not interrupt them
- The message text is operator-supplied: render it as a text node, never via `dangerouslySetInnerHTML`. Use `truncate min-w-0 flex-1` plus a `title` so a long notice never wraps the strip or forces horizontal scroll, while staying complete in the DOM for screen readers
- **Icon: use the app's canonical `⚠` / `⛔` glyph, never a bespoke SVG** — `<span aria-hidden="true" className="text-base leading-none shrink-0">⚠</span>`. These are the same Unicode characters `ColumnHeader`, `MoveBlockedToast` and `LensProvenanceBanner` already use for identical amber/red severity semantics; drawing a new SVG triangle per banner gives the app two different renderings of one meaning
- Reference implementation: `MaintenanceBanner` (`src/components/Common/MaintenanceBanner.tsx`, issue #783)

## Inline summary panels (embedded, not chrome)

Not every amber-toned status block is a § Degraded-state site banner. That section is specifically for persistent, full-width chrome outside the scroll container (`MaintenanceBanner`). When a panel instead sits *inside* a form or card to summarize the live effect of settings the user is actively editing — e.g. Admin Settings → Email's "Currently sending mail" panel (`EmailSettingsSection.tsx`) — it may borrow the same tokens (`border-warning/30 bg-warning/10`, the canonical `⚠`/`⛔` glyph, `aria-hidden` on the glyph) but must **not** copy the `role="status" aria-live="polite"` treatment.

- Use `role="group" aria-labelledby="{heading-id}"` instead.
- **Why:** these panels sit next to an action that already owns a live region for *its* result (Save, Send test). A second concurrent polite region queues against the first and produces duplicated or out-of-order announcements. Carry exactly one live region per user-initiated action, not one per visually-amber element.
- State the panel's facts from **saved server state only**, never the in-progress draft — the panel answers "what is happening right now", which an uncommitted edit has not changed.
- Warning copy in such a panel is usually a full sentence, so its reserved slot uses `min-h-4`, not `h-4`. See § Inline status messages.

## Write-only secret fields ("leave blank to keep")

For an admin-editable secret the server never returns in cleartext (SMTP password, webhook signing secret, API key), use this pattern rather than inventing one per field. Reference: `EmailSettingsSection.tsx`'s password field.

- The input is `type="password"`, `autoComplete="new-password"`, starts empty, and its `placeholder` communicates **current state** rather than an example value: `"Leave blank to keep the current password"` when one is stored and usable, no placeholder when none is stored, and an explicit re-entry prompt (`"Enter the password again"`) when a stored value exists but cannot be decrypted.
- The unrecoverable-secret state is surfaced, never silent: `border-warning/50` on the input plus `text-warning` helper text naming the likely cause and the remedy.
- Two helper lines beneath the input say what is stored and what typing or leaving blank will do. Reserve them unconditionally (`h-8` for two `text-xs` lines, or `min-h-` if the copy can wrap).
- A `Clear` bare-text button appears in the label row **only** when a secret is stored and Clear has not already been pressed. It stages the removal — input disabled and empty, `text-warning` "will be cleared when you save", and an `Undo` bare-text button. The clear commits with Save, never on click.
- **On the wire, omit the key entirely unless the user typed a value (send it) or pressed Clear (send `""`).** "Leave blank" must never resolve to an empty string on the wire, or an unrelated edit silently wipes the secret.
- A validation error touching the secret **replaces both helper lines**, never just the first. Rendering "Leave blank if your server doesn't require a password." directly beneath "A password is required when a username is set." shows two contradictory instructions at once.
- Give each field's helper copy its own wording. Reusing one sentence across two fields (username and password, say) makes the UI read as boilerplate and makes text-based test queries ambiguous.

## Verification actions against a saved configuration

When a surface lets an admin verify a stored configuration against a live external system (send a test email, ping a webhook):

- **It tests saved state, never the draft.** Disable the action while the form is dirty and say why in both a `title` and the result region's first line ("Save your changes before testing."). Testing a draft would require sending an unsaved credential for a side-effecting action, and would not tell the admin what is actually live.
- Place it below the form's Save/Cancel footer behind a `pt-3 border-t border-line-subtle` divider. The physical separation is what makes "this tests what is live, not what you typed" legible without a paragraph of explanation. Use the **secondary** button variant — the form's Save is the primary action.
- The backend returns an **opaque error code from a closed set**, never a raw upstream error string. The frontend owns the copy: map each code in one lookup table to a `{ headline, remedy }` pair — headline in the tone color (`text-danger` / `text-warning` / `text-success`), remedy in `text-fg-muted` beneath it — and treat an unrecognized code as the generic failure rather than rendering it.
- Both lines live in reserved `text-xs h-4` containers inside a single `role="status" aria-live="polite" aria-atomic="true"` wrapper.
- A throttled response (429) is `text-warning`, not `text-danger` — nothing is broken, the admin is just early.
- Rate limits and retry windows are backend-owned numbers; interpolate them from the response where the API provides them rather than hardcoding them in the copy table, or the string goes stale silently when the limit changes.

## Disambiguating repeated button labels

When one page or tab can simultaneously render more than one bare-text button with the same visible label — most often `Cancel` or `Save` across two independent inline-confirm or composite-editor blocks — give each a distinguishing `aria-label` and keep the visible text generic (e.g. `aria-label="Discard email settings changes"`). Two controls accessibly named only "Cancel" are ambiguous for screen-reader rotor navigation and for `getByRole`/`getByText` queries alike. This is not hypothetical: it broke `adminPage.test.tsx` in #306, where the Email section's footer Cancel collided with the maintenance-mode confirm's Cancel.

## Common dropdown primitives

`SingleSelectDropdown`, `CheckboxDropdown`, `MultiSelectDropdown` (#1391), and `SplitButton` live in `src/components/Common/`. Do not re-implement these inline in feature components. **Pick the multi-select primitive by when it applies:** `CheckboxDropdown` applies every click immediately (filters); `MultiSelectDropdown` is a searchable checklist that commits **once, on close** (value editors, where one change is several clicks and a save per click would be noise). The dropdowns follow the dropdown menu spec (trigger: `bg-surface border rounded px-2 py-1`, active/filtered state: `border-primary-soft text-info`). Any new component that needs a select or checkbox dropdown must import from `Common`, never duplicate inline.

- **A soft-capped multi-select refuses the click; it never lets a serializer truncate.** When a multi-select has a maximum selection count (typically a server-side cap), enforce it in the feature component's `onChange` handler — drop the additional selection on the floor — and never leave the cap to a downstream serializer that sorts and slices the array. A slice evicts whichever item sorts last, which is routinely an item the user never touched, so the click appears to succeed while silently changing a *different* selection. `CheckboxDropdown` has no `maxSelected` prop today (`toggle()` always appends), so the handler in the calling component is the enforcement point; the reference implementation is `handleLabelsChange` in `LensFilterBar`. Deselection must stay allowed at the cap, or the control becomes a dead end.
- **Limit and helper text beside a control must be announced, not merely visible.** A cap that silently makes further clicks do nothing is invisible to a screen-reader user, so render the message in a `role="status"` live region that goes from empty to text when the limit is reached (the content change is what triggers the announcement). A bare sibling `<span>` with no role conveys nothing. Where the control accepts `aria-describedby` and the text is static rather than state-dependent, the `id`-bearing helper-span pattern in `FilterBar` (`aria-describedby="filterbar-search-helper"`) is the alternative.
- **A dropdown inside an `overflow-x-auto` toolbar strip must portal its menu.** Per the
  CSS spec, `overflow-x: auto` with the default `overflow-y: visible` promotes the y-axis
  to `auto` too, so Row 2's `h-10` strip clips any `absolute top-full` menu to 40px.
  `SingleSelectDropdown` takes `portalMenu` for this (rendered `position: fixed` through
  `createPortal`). It is opt-in, not the default, because the in-flow menu is what modal
  focus traps and existing call sites assume. Pass it for any dropdown rendered in Row 2
  or inside a scrolling/clipping ancestor (the Edit Swimlane field list, #1478). Its
  portal path follows the "Anchored `fixed` popovers" rule (#1455): measured placement via
  `useAnchoredPlacement`, dismissed on resize and outside scroll, bottom fade via
  `useOverflowFade`, menu at least trigger-width and clamped to the viewport's right edge.
  Known limitation, `SplitButton` only: its anchor is measured once when the menu opens,
  so scrolling Row 2 or resizing the window while it is open leaves the menu behind.
  Closing on scroll/resize (or re-measuring) is the fix whenever that becomes visible.
- **Portaled menus close on Tab and return focus to the trigger on selection (#1478).**
  A portal lands at the end of `<body>`, so Tab from a menu item would leave the dialog
  with the menu still open, and selecting an item unmounts the focused element, dropping
  focus to `<body>`. Close on Tab (focus to the trigger, then let the browser's Tab move
  on) and `focus()` the trigger after a selection.

- **The multi-select custom-field value editor (`MultiSelectValueInput` → `MultiSelectDropdown`, #1391).** (1) **Commit on close, never per click** — Done, Escape, Tab (focus moves on past the trigger), a click outside, or a page scroll/resize closes the menu and commits the whole set once, only if it changed as a set; a rejected save reverts the trigger and shows `Couldn't save {field}. Try again.` (`role="alert"`) under it. (2) **Two-step Escape** — with a search typed, the first Escape clears the search and the second closes. (3) **Chips follow the choice's explicit color** — selected entries render through `MultiSelectChips` everywhere (trigger, card face, row header): a choice with a `choice_colors` key is a tinted `ChoiceBadge`, every other entry a neutral `bg-surface-hover` sub-chip. Never `choiceColor` hash dots on multi-select entries; the menu's option rows stay neutral, and multi-select filter options carry no dot. (Dropdown filter options do carry a dot: the choice's explicit palette `base` when `explicitChoiceColor` resolves a key, else the hash dot — so the filter matches the card face.) (4) **Orphans** — selected entries no longer in `choices` are listed under a `No longer a choice` divider, `text-fg-muted`, checked; they can be unchecked but never added elsewhere. (5) **ARIA** — the sticky search input is `role="combobox"` (`aria-expanded`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`, `aria-controls`, `aria-activedescendant`) over a `role="listbox" aria-multiselectable="true"` of `role="option" aria-selected` rows; the "No matching choices" message sits outside the listbox; the count is a `role="status"` in the sticky footer. (6) **Active row = `ring-2 ring-inset ring-primary-emphasis`**, never a second background: a selected row keeps `bg-primary-emphasis/20` and gets no hover tint. (7) **Arrowing scrolls the active row into view** (`scrollIntoView({ block: "nearest" })`, with `scroll-mt-*`/`scroll-mb-*` clearing the sticky search and footer). Rows `py-2`, Done `px-3 py-1.5` for touch. The menu is portaled, opens upward when there is no room below, and is clamped horizontally to the viewport.

- **Free-text filter inputs in the same row clear on Escape, all of them.** Escape resets the input and blurs. Applying it to only some inputs in a row is worse than applying it to none — a keyboard user who learns the affordance on one input expects it on its neighbors.

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

Shortcut wiring lives in three places: the board-scoped keydown listener in `BoardView` (for on-board bindings like `b`/`s`/`h`/`a`, `l` (lens-gated — only when the Issue Board Lens is available), `e`, `y`, `f`, `c`, `/`, `.`, `?`, `⌘,`, `⌘\\`, `⌘⇧E`, `⌘⇧L`), the shell-level listener in `GlobalCommandPalette` (`⌘K`), and the `g`→`u` chord listener in `Navbar` (opens the user menu). New listeners should use `shouldIgnoreShortcut()` from `src/utils/keyboard.ts` so typing letters into inputs, textareas, and rich-text editors never triggers the shortcut; the existing `BoardView` and `Navbar` listeners currently use equivalent inline typing-context checks instead.

- **`aria-keyshortcuts` noise budget — single-key or single-modifier only.** Every toolbar affordance that responds to a bare-letter shortcut (B/S/H/A/E/F/Y) or a one-modifier chord (⌘K, ⌘\\, ⌘,) must carry the corresponding `aria-keyshortcuts` attribute so screen readers announce the binding. Do **not** expose two-modifier chords (⌘⇧L, ⌘⇧E) via `aria-keyshortcuts` — exposing every chord drowns assistive technology in noise and offers no navigation benefit. Surface richer chords in the shortcuts overlay and tooltip only.
- **Platform-aware formatting — always route through `src/utils/platform.ts`.** `formatShortcut({ mod, shift, alt, key })` renders visible hints (⌘⇧L on Mac; Ctrl+Shift+L elsewhere). `formatAriaKeyshortcuts()` renders the ARIA 1.2 canonical form (`Meta+Shift+L` / `Control+Shift+L`). Never hard-code the Mac glyphs or the `Meta+` prefix at a call site.
- **Tooltip hints — parenthesize the shortcut after the label.** Format `"${label} (${formatShortcut(...)})"`. The overflow menu's own `shortcut` slot already renders the hint inline; set it there instead of baking the hint into the item label.
- **The shortcuts overlay is the canonical registry.** Every non-trivial binding must appear in `KeyboardShortcutsOverlay.tsx` grouped under one of the four sections (Navigation / Board view / Board actions / Help) and in `docs/features/keyboard-shortcuts.md`. Descriptions are imperative (`Switch to Board view`, not `Board view`) so each row reads as a command.
- **Sequential chords render as separate chips, never one.** Sequential chords (press, release, press — e.g. `G` then `U`) render as separate <kbd> chips joined by "then", never as one chip, so they can't be mistaken for a simultaneous combo like ⌘K.
- **A control is allowed to have no shortcut, on purpose.** The grid overlay picker
  (#1147) deliberately has none and carries no `aria-keyshortcuts`: it is a cosmetic
  reading layer, it is Tab-reachable in Row 2 at every supported width, and the bare-letter
  set is already crowded. Do not "complete" it with a binding — the budget above is the
  reason it was left out.
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

## Issue board lens (read-only external data)

The "Lens" view renders one public GitHub/GitLab repo's issues as a read-only kanban board. These rules cover the lens-specific surfaces and any future read-only external-data view.

- **Read-only external cells and headers are forked, not parameterized.** Do not add a `readOnly` flag to the DnD-coupled `SwimlaneRow` / `BoardCell` / `ColumnHeader`. The lens uses dedicated read-only siblings (`LensSwimlaneRow`, `LensColumnHeader`, the cell markup inside `LensSwimlaneRow`, and `LensIssueCard`) that copy the visual treatment without any drag hooks, add-card affordances, kebabs, rename, or edit pencils. The interactive board components stay focused on the editable board; the lens components stay focused on rendering. This is distinct from the `CardItem` `readOnly` prop (§ Read-only mode for interactive components), which applies to a *single* component used in both contexts — when an entire family of components would need DnD-removal branches, fork instead.
- **Lens issue cards encode state with a pill + opacity, never the priority border.** Issues have no Visiban priority, so `LensIssueCard` uses `border-line` (neutral) on all sides — never the priority/status border colors. Open vs. closed is carried by a state pill (open → `bg-success/15 text-success`; closed → `bg-surface-hover text-fg-muted`) plus `opacity-70` on the whole card when closed. The card is a `<button>` with `cursor-pointer hover:bg-surface-hover` (never `cursor-grab` / `hover:-translate-y-0.5`) and opens `issue.url` in a new tab via `window.open(url, "_blank", "noopener,noreferrer")`.
- **External-data provenance banner sits outside the grid scroll container.** Any view rendering data sourced from outside Visiban must show a non-dismissible `role="status"` banner with the source identity (`LensProvenanceBanner`: provider glyph + "Read-only lens · {repo}", repo linking to the source). Place it between the toolbar and the scroll container — never inside it (same placement rule as § Mode indicator banners) — so it never scrolls away. When the source truncated the result, append a `text-warning` "Showing first N issues" notice inside the banner. The banner fill token is `bg-primary/15` (matching the Mode Indicator Banner spec — `bg-primary` tracks the active theme; do not use `bg-info`), and it carries `aria-atomic="true"` so it is announced as a single unit.
- **Multi-lane duplicate cards carry an explicit indicator.** When an issue maps to more than one swimlane value (e.g. multiple matching labels) it renders once in *each* lane — never hidden, never collapsed to one lane. Each duplicate shows a `🔗 ×N` indicator (`text-xs text-fg-muted`, `title` explaining the count) so the reader knows the same issue appears elsewhere. `laneCount` is `issue.swimlane_keys.length`. The `🔗 ×N` span must carry an `aria-label` describing the lane count (e.g. `Appears in 3 lanes`) and the `🔗` emoji itself must be `aria-hidden="true"` — the `title` alone is not a reliable accessible name.
- **Synthetic "(none)" lanes render last.** Backend axes use synthetic keys (`__none__`, `__nostatus__`) for issues with no value on the pivot dimension, and arrive with friendly labels already set (e.g. "(no milestone)", "No status"). Sort these lanes to the end of the grid so real milestones/assignees lead — never interleave or drop them. Match on the *key*, not the label.
- **One shared `relativeTime()` helper — never fork a second formatter.** "Synced X ago" freshness (`LensFreshness`) and the connection-status popover ("Last update: X ago") both import `relativeTime(ts, now)` from `src/utils/relativeTime.ts`. The `now` argument is explicit so callers stay deterministic in tests. Do not re-implement relative-time formatting inline in any new component.
- **The lens reuses the board's shared Row-2 toolbar — no separate lens toolbar row.** The lens's interactive controls (pivot dropdowns, Filters toggle, layout toggle) render in the shared `<nav aria-label="Board toolbar">` (in `BoardView`, via `LensToolbar`), so switching Board↔Lens doesn't reflow the chrome. `BoardView` drives them from the URL params it reads directly (`?column_dim=`/`?swimlane_dim=`/`?state=`/`?milestone=`/`?q=`) + the shared `useCardLayoutPref` — **do not lift `useLensData` up or portal controls.** The one data-dependent control, freshness ("Synced X · Refresh"), lives in `LensProvenanceBanner` (next to `useLensData` inside `LensView`), not on Row 2. The Filters button (board-styled, with the active-count badge) toggles the `LensFilterBar` row, whose visibility is local `lensShowFilters` in `BoardView` (initialized `true` when a filter param is active on mount); filter *values* stay URL-persisted. **Parity includes the responsive fold**: below `lg` (`useIsLargeViewport`) the layout toggle folds into an `OverflowMenu` kebab labelled `Lens actions`, exactly as the native Row 2 folds its own low-frequency controls — the pivots and Filters stay inline. The lens pins **no** `ConnectionStatus` beside the kebab: it is a pull-only mirror with no WebSocket, so there is no live status to show. Row-2 icons come from `components/Board/toolbarIcons.tsx` — import them, never re-inline an SVG copy, or the two toolbars drift. `f` toggles the lens filter row (routed by `viewRef` in `BoardView`) and `⌘⇧L` the layout, matching the native chords.
- **Lens "compact" is the board's `useCardLayoutPref` — multi-card-per-row, not just smaller cards.** Compact reuses `user:prefs:card-layout` (shared with the board). The old `user:prefs:lens-density` is deliberately **not** migrated: the hook has one instance (`BoardView`) feeding both surfaces, so honoring it would silently flip the *native* board into compact for someone who only set it on the lens. The lens cell is `compact ? "grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1.5" : "flex flex-col gap-2"` — **auto-fill/minmax, not a fixed 2-column grid** (#1065): lens columns are resizable (see the resizing rule below), so a fixed track count would either waste space at a wide column or crowd cards at a narrow one. The `120px` floor matches `MIN_LENS_COL_WIDTH`'s single-track case; below that, `auto-fill` naturally collapses to one card per row.
- **Lens columns and the swimlane-label sidebar are resizable, forked read-only from the native board (#1065).** `useLensViewPrefs` (`frontend/src/hooks/useLensViewPrefs.ts`) persists `{ sidebarWidth, columnWidths }` to board-scoped localStorage (`board:{boardId}:lens-view-prefs`) — a separate store from the native board's `useViewPrefs`, not an extension of it, because lens `columnWidths` is keyed by the pivot-derived column **string** key (e.g. `"in_review"`), not a numeric board Column ID. Clamp ranges are lens-specific and *not* the native board's: sidebar 120–480px, columns 160–640px (`MIN_LENS_SIDEBAR_WIDTH`/`MAX_LENS_SIDEBAR_WIDTH`/`MIN_LENS_COL_WIDTH`/`MAX_LENS_COL_WIDTH` in `lensDims.ts`). Defaults (200/280) intentionally match the pre-#1065 fixed widths so upgrading users see no shift until they resize.
  - **The drag affordance is `LensResizeHandle`** (`frontend/src/components/Board/Lens/LensResizeHandle.tsx`), a forked, simplified sibling of the native board's `ColumnSeparator`/`RowSeparator` — `role="separator" aria-orientation="vertical"`, absolutely positioned (`absolute inset-y-0 right-0 w-2 translate-x-1/2`) so it adds **zero layout width**: the `translate-x-1/2` centers its hit target on the column's own right border instead of widening the column. Unlike the native separator, a plain click is a no-op — there is no insert-column affordance to disambiguate from a drag, so the handle has no `DRAG_THRESHOLD` and no click handler at all.
  - **One handle per column, in the header only — never re-rendered per swimlane row.** The native board renders `ColumnSeparator` as a real 16px layout gutter in every row (for its continuous cross-row hover-highlight strip); the lens deliberately does not, because that strip is exactly the "per-row separator" affordance the issue asked to avoid. Every row already reads the same shared width state (`LensGrid`'s `colWidths: Map<string, number>`, passed to `LensSwimlaneRow`), so one handle in the header keeps every row in sync. The accepted tradeoff: the resize hover-highlight is visible only across the header, not down through the body rows — deliberate simplification for this lower-chrome, read-only view, not an oversight.
  - **Keyboard resize**: `ArrowLeft`/`ArrowRight` nudge by 8px, Shift+Arrow by 32px, while the handle has focus (it's a real tab stop, `tabIndex={0}`) — the only way to resize without a mouse.
  - **Row-height resize is out of scope for #1065** — explicitly deferred pending confirmation with the requester (the issue marks it "optional / confirm"). Because the cards get narrow, compact *also* strips the label/milestone/branch-MR/avatar metadata (keeping `#number` + state pill + multi-lane indicator + single-line title); on the lens one pref drives both layout + metadata (no per-board `card_density`). The empty-cell `—` marker carries `col-span-full` so it stays centered in the compact grid.
- **The current milestone lane is promoted, not recolored — sort-to-front + a "Current" pill.** When `swimlane_dim == milestone`, the lane the backend marks `is_current` sorts to the top of the grid (`LensGrid.tsx`) and carries a `Current` pill on its label panel (`LensSwimlaneRow.tsx`, `bg-primary-emphasis/20 text-info` — the same token pair as the filter active-count badge; do **not** introduce a new hue for it). Position is the primary signal and the pill is the secondary one, so the meaning survives without color (#969): the pill carries the literal word "Current" plus a `title`, never color alone. Only one lane is ever marked. The synthetic "(no milestone)" lane still sorts **last** and is never current. `is_current` is additive on the axis payload — absent means false, so an older client simply renders the old order.
- **Lens collapse/focus stay URL-persisted.** Swimlane collapse (`?lens_collapsed=`, comma-joined `encodeURIComponent`'d keys) and single-lane focus (`?lens_focus=<key>`) live in the URL because a lens link is a shareable snapshot. Both are validated against the live `data.swimlanes` key set on read and silently dropped when stale. The collapse chevron + focus crosshair are **forked read-only affordances** on `LensSwimlaneRow` (copy the native `SwimlaneRow` SVGs; chevron always visible, crosshair hover-reveal with `focus:opacity-100`); focus renders a `LensFocusBanner` (`bg-primary/15`, **not** `bg-info/15`) stacked *below* the provenance banner and outside the scroll container, with Escape-to-exit at `useEscapeStack` priority 12.
- **Lens cards may carry a nested link; switch the card root to `<div role="button">`.** When a lens card surfaces a secondary external link (e.g. the pipeline MR chip), the card root must be a `<div role="button" tabIndex={0}>` with an Enter/Space `keydown` handler — not a `<button>` — because interactive nesting inside a `<button>` is invalid HTML. The nested `<a>` carries `onClick={(e) => e.stopPropagation()}` so the chip opens its own URL while the card body opens the issue; never `preventDefault` the anchor (preserves middle/cmd-click). **Pipeline evidence renders on the existing metadata row** — branch as a `font-mono text-fg-tertiary` `<span>` (`⎇` glyph, `max-w-[10rem] truncate`, full name in `title`), MR as a `text-info` `<a>` (`!{number}`) — never a new stacked row; the left cluster may `flex-wrap` as the sole permitted exception to the single-row metadata rule, justified by the VoC "placement must be explainable" requirement. **closes-vs-references is distinguished by glyph + `aria-label` only, never color** — both stay `text-info` (`⮰` closes, `↗` references). **Empty lens cells render a centered `text-fg-faint` em-dash** (`aria-hidden`, `select-none`); the count lives in the column header stat. The lens cards stay neutral (`border-line`, no priority colors) and the pipeline column headers stay neutral too — do not invent a frontend `pipeline → color` map (the payload axis carries no color; coloring would reintroduce the native-board coupling the lens was forked to avoid).

## De-emphasized controls and context-dependent defaults (#1063)

- **De-emphasis must not drop below AA.** To visually demote an enabled control (e.g. the Board tab on a lens-only board), use `text-fg-tertiary italic` and keep the hover state. Never use `text-fg-muted` on a `bg-surface-hover` track (the `ViewToggle` background) — in dark mode it is ~2:1. `text-fg-muted` is for `bg-surface` / `bg-canvas`. A de-emphasized control stays enabled, focusable, one click away, keeps the standard focus ring, and explains itself via `Tooltip`; never `disabled`, `pointer-events-none`, or hidden. The de-emphasis condition is derived automatically (lens configured AND zero native swimlanes), never a per-board setting.
- **A default view that depends on data resolved elsewhere yields to explicit intent.** The lens is the default landing tab only when `?view=` is absent and there is no `?card=` / `?focus=` deep link; an explicit `?view=` always wins, and opening a native card (deep link or command palette) switches to the Board view because the lens branch renders no `CardDetail`.

## Inline informational callouts (login demo banner, #1034)

An informational callout inside a card or form (not a full-width chrome strip) uses `role="note"` — static, not announced — with `rounded border border-primary-emphasis/30 bg-primary-emphasis/10 px-3 py-2.5 text-sm text-fg-secondary`. It is a deliberate deviation from § Mode indicator banners / § Degraded-state site banners, which are chrome strips. Copyable values (credentials, IDs) go in `<code className="font-mono text-fg select-all">` so one click selects them. **Superseded (#1179):** the reset time is no longer hardcoded — it is interpolated from site-config's `demo_next_reset_at` via `formatClockTime()`; see § Hosted demo surfaces.

## Hosted demo surfaces (#1179)

The public demo (`demo_mode` on the user / site-config) runs behind a server-side, deny-by-default write fence: everything except card create/edit/move, archive and checklist writes answers `403 {"code": "demo_read_only"}`. The SPA's job is to make refused things look refused **before** the visitor tries them.

- **Fixed-lead refusal copy.** Every refusal reads `This is a shared demo — {surface clause}.` The lead clause is identical everywhere and never reworded per surface, so the visitor learns to read it as "the demo, not you" (same convention as maintenance mode's fixed title). All strings live in `src/constants/demoCopy.ts` — add new surfaces there via `demoReason()`, never inline.
- **`aria-disabled`, never native `disabled`, on a control the fence blocks.** Native `disabled` drops the control from the tab order, hiding the reason from keyboard and screen-reader users. Guard the handler as well (`onClick={() => { if (!demoMode) ... }}`) and style with `opacity-40 cursor-not-allowed`. Playwright treats `aria-disabled` as non-actionable, so e2e specs that prove "a click does nothing" use `click({ force: true })`.
- **Reason surfacing — two sub-patterns, same disabling mechanism.** (A) where there is room, an always-visible reason line tied to the control with `aria-describedby` (comment composer, attachment upload, Board Settings); (B) for compact toolbar/nav buttons, `title` + the reason folded into `aria-label` (`"New board. This is a shared demo — …"`) — sidebar and Dashboard New board / Import / New group.
- **Whole regions: `DemoInert`** (`src/components/Common/DemoInert.tsx`). When many controls must go inert together (Board Settings' admin sections), wrap them in `DemoInert` with ONE shared notice id instead of threading a prop through every control: a per-control prop fails open for the next control someone adds; a region fails closed. It renders `role="group" aria-disabled="true" aria-describedby=<notice>` and blocks activation in the capture phase while leaving everything focusable. Only wrap controls that write to the server — personal, browser-local prefs (card-density override, hidden columns) stay live. The region dims with `opacity-60`, lighter than the `opacity-40` used on a single refused control: a whole section at `opacity-40` becomes hard to read, and the visitor still needs to read the current settings — only changing them is refused. `opacity-60` is reserved for this whole-region case.
- **Ownership-gated buttons mirror the server's demo carve-out.** The server lets the published visitor (a plain MEMBER) archive, unarchive and reassign cards others created while `DEMO_MODE` is on. Components that derive those buttons from `is_moderator` widen the check with `demoMode && role === "member"` — a display heuristic, never a copy of the server's username check — and widen **only** the writes on `DEMO_ALLOWED_WRITES`. Card delete is not on it, so Delete stays unwidened and is hidden in demo mode.
- **Typed text is kept.** A refused composer never sends, so nothing clears it — make the submit handler a no-op in demo mode rather than letting it fail.
- **`DemoModeBar` color divergence.** The in-app bar uses the **mode-indicator** tone (`bg-primary/15`, § Mode indicator banners) in its normal state — the visitor opted into the demo — and flips to the **degraded-state amber** (§ Degraded-state site banners, `⚠`, one fixed sentence) from 5 minutes before the reset, because at that point the sign-out IS being imposed on them. No exit control in either state. Announce transitions only, through an `sr-only` live region; the visible bar is not live, or the minute label would be re-announced every tick.
- **Reset times are browser-local** (`formatClockTime()` in `src/utils/date.ts`), computed from the server's `demo_next_reset_at` — never hardcode a cadence or a timezone.
- **An absent reset is a real state, not a missing value (#1180).** When `demo_next_reset_at` is null (e.g. the Helm chart's `demo.reset.enabled=false` leaves `DEMO_RESET_SCHEDULE` empty), the login banner must not fall back to assuming an hourly — or any — cadence. Gate the reset-countdown sentence on the concrete `demoNextResetAt` value, never on the raw schedule string, and render a shared-state disclosure instead: "Other visitors can see and change everything here, and it is never reset." Never let an empty/absent schedule silently read as "every hour, on the hour."
- **Fallback toast is a safety net.** `DemoWriteBlockedToast` (shell-level, fed by `auth:demoWriteBlocked` from `api/client.ts`) catches refusals from surfaces that were not disabled up front. If it fires during normal use of a surface, that surface is missing its up-front affordance — fix the surface, do not reword the toast.
- **A background save nobody clicked is silently skipped, not `aria-disabled` (#1193).** Some refused writes have no control to disable at all — `ThemeServerSync`'s cross-device theme PATCH fires from a `useEffect`, not a click. Showing a toast for a save the visitor never asked for is noise, not an affordance; the fix is to not send the request in demo mode (`if (user.demo_mode !== true) { ...PATCH... }`) and let the local/optimistic state keep applying. Same treatment as the onboarding tour's completion save, which needs no code guard at all — `seed_demo_data` seeds the published visitor's `has_completed_tour` flag `true`, so that save never fires in the first place.
- **A control whose primary purpose is navigation is never `aria-disabled`, even when it also fires a refused side-effect write (#1193).** Clicking a notification row both navigates to the related card and marks it read; `aria-disabling` the row to block the refused mark-read write would also block the navigation the visitor actually asked for. Skip the side-effect write silently instead (same as the background-save case above), and give the *explicit*, standalone version of the same action — here, the "Mark all read" button, which does nothing else — the up-front `aria-disabled` affordance.
- **A hover-reveal control that becomes demo-gated goes always-visible at `opacity-40`, not `group-hover:opacity-100` (#1193).** Per-row delete controls (comment ✕, attachment ✕) are normally hidden until hover/focus. In demo mode that would recreate exactly the "refused only after you try it" problem this section exists to close — a visitor who never hovers never learns the control is dead. Drop the `group-hover`/`opacity-0` classes for the demo-gated branch and render the disabled control at a flat `opacity-40` instead, same reasoning as the pinned custom-field chip's always-visible exception to the general hover-reveal default.

## Card-face external links (#352)

- **A native card may carry one nested link — the MR/PR badge — and it follows the lens nested-link rules with drag-safety added.** The badge in `CardItem` is a real `<a href target="_blank" rel="noopener noreferrer">` inside the clickable, draggable card root. It stops propagation on `onClick`, `onPointerDown` (so dnd-kit never starts a drag from it) and `onKeyDown` (so Enter never reaches the card's key handling), and never calls `preventDefault` (cmd/middle-click must still work). Style: `text-info`, `text-xs`, the shared `ExternalRefGlyph`, `max-w-[10rem]` + `truncate font-mono` ref text, full ref in the accessible name (`"{ref}, {Provider}, opens in new tab"`) and in `title` together with the **real host** (`"{Provider} {ref} — {host} (opens in new tab)"`) — provider and ref are free text an editor chooses, so the tooltip is where a reader verifies where the link actually goes. It is the **first** item inside the `!compact` branch of the metadata row (the row clips right-to-left); at `comfortable` density it renders the glyph only, and the peek popover lists `{Provider} {ref}` as plain text — never a link, the peek is a hover tooltip. A glyph-only badge must never be the sole way to read the reference.
- **Every user-controlled `href` passes `isHttpUrl()` (`utils/externalRef.ts`) at the render site, even when the server already validated it.** When the guard fails, render the same content as a non-interactive `<span>` (`role="img"` + `aria-label` on the card face) — never an anchor with the raw value. An `href` is an XSS sink, and data can arrive from older rows or imports.
- **Icon-only informational glyphs on the card face are at least `w-3.5 h-3.5`.** `w-3 h-3` is for decorative glyphs that sit beside text; when the glyph is the only visible indicator (and the click target), step it up.
- **Immediate destructive text buttons get a real hit area.** A bare-text action that commits with no confirm (e.g. the link section's Remove) carries at least `px-1.5 py-0.5` and sits `gap-3` from adjacent actions, so reaching for its neighbor does not mis-hit it.
- **No brand logos for external providers.** One generic PR glyph for GitHub, GitLab and Other; the provider is named in text (detail panel) and in the accessible name. Logos would not track the theme color and add trademark/asset burden.

## Multi-step import wizards and file uploads (#456)

Established by the Trello import wizard (`components/Board/TrelloImportModal.tsx`, `components/Board/trello/`). Reuse these for any future import/creation wizard.

- **Wizard shell.** A multi-step flow inside `ModalWrapper` uses `maxWidth="max-w-2xl" noPadding headerBorder`, with `subtitle="Step X of N · {step name}"` as the only step indicator — no stepper graphic. Each step renders an `h3` (`text-sm font-medium text-fg-tertiary uppercase tracking-wide`, `tabIndex={-1}`) that receives focus on every step change, because the button that triggered the change unmounts; skip it on first open (`ModalWrapper` focuses the panel). Any step with variable-height content, **and the in-flight state that follows it**, uses the fixed panel height `h-[85vh] max-h-[640px] min-h-0` so the panel never collapses and re-expands mid-flow. Footer: bare-text Back on the left (`justify-between`), Cancel + primary grouped right with `gap-3`, `flex-wrap` for narrow widths. While a non-cancelable write is in flight the footer is not rendered and the modal is `dismissable={false}`.
- **One live region per wizard.** Exactly one `role="status" aria-live="polite" aria-atomic="true"` element, placed between the scrolling body and the footer (so errors stay next to the buttons when the body is scrolled). It holds an `sr-only` announcement span plus the visible error callout. Show an error **only** in the callout — set the sr-only text to `""` — or screen readers read it twice and RTL `getByText` finds duplicates. Callout tones: danger `bg-danger/10 border-danger/30 text-danger`; rate limits (429) use warning `bg-warning/10 border-warning/30 text-warning`.
- **A blocked primary action explains itself.** When the primary button is blocked by a field that may be scrolled out of view, use `aria-disabled` (with `aria-disabled:opacity-40 aria-disabled:cursor-not-allowed`) instead of `disabled`, point `aria-describedby` at an `sr-only` reason, and on click focus the offending field instead of submitting.
- **Upload progress bar.** Track `h-2 rounded-full bg-sunken overflow-hidden`; fill `h-full bg-button-primary transition-[width] motion-reduce:transition-none`; the track carries `role="progressbar"`, `aria-label`, `aria-valuemin/max`, `aria-valuenow`. At 100% the bytes are sent but the server is still working, so switch to indeterminate — omit `aria-valuenow`, full-width fill with `animate-pulse` (under `motion-reduce`, a static one-third fill — never full; see § Motion and reduced motion above and the Reduced motion bullet in § Import Board sample gallery) — and change the paired text (and the busy button label) from "Uploading… N%" to the server-phase copy. Announce progress through the live region in 25% buckets only. An in-button spinner on a primary fill uses `border-on-primary border-t-transparent` (the `border-primary` spinner in § Loading assumes a neutral background).
- **Dropzone-as-button.** A file dropzone is one full-width `<button type="button">` (native Enter/Space) wrapping nothing but text, with a sibling `<input type="file" className="hidden">`. The field title is a `<p id>` referenced by the button's `aria-labelledby` — never a `<label htmlFor>` pointing at the hidden input. Style: `w-full border border-dashed rounded-lg p-6 text-center`; idle `border-line-strong hover:border-line-emphasis`, drag-over `border-primary-emphasis bg-primary-emphasis/10`; inner text spans are `pointer-events-none` so `dragleave` does not flicker. This is the **one sanctioned exception** to the `rounded`-only button rule. While busy use `aria-disabled` (not `disabled` — a disabled button stops receiving drop events) and guard the handlers. The dropzone **and the enclosing wizard body** both `preventDefault` on `dragover`/`drop`, so a stray drop never navigates the browser to the file. Reset `e.target.value = ""` after a pick so re-picking the same file fires `onChange`. Validate the file **type** on pick, show the message in the live region, and disable Continue rather than rejecting the pick. Never hard-code a server-configurable size limit as a blocking client check: at most show it as advisory copy ("25 MB by default"), and on a `413` show the server's JSON `detail` when present, falling back to generic "too large for this server" copy for a non-JSON proxy `413`.
- **Review-summary tiles.** `grid grid-cols-2 sm:grid-cols-4 gap-2`; tile `bg-sunken border border-line rounded-lg px-3 py-2`; value `font-mono text-lg` (`text-fg-secondary`, or `text-fg-muted` when zero — render `0`, never an em-dash, which reads as "unknown"); caption `text-xs text-fg-muted`, singular when the value is 1 (no "(s)").
- **Matched-user privacy in import previews.** An import preview shows matched existing Visiban users **only as a count** — never names, usernames, emails, or avatars — and lists only the unmatched external identities by the name in the uploaded file. The copy states that matching is limited to people the importer can already see. This is a security requirement (user-enumeration), not a style preference.
- **Focusable scroll regions.** Any inner `overflow-y-auto` region given `tabIndex={0}` so keyboard users can scroll it needs an accessible name (`<ul>`/`<table>` with `aria-label`, or a `div` with `role="group"` + `aria-label` — not `role="region"`, see the landmark cap) and a focus ring: `focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-emphasis`.
- **Import options (#119).** Choosing what an import includes is a `<fieldset className="min-w-0">` with a `<legend>` styled as a field label (`block text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-1.5`), a `text-xs text-fg-muted` line naming what is always imported (the fieldset's `aria-describedby`), and native checkboxes (the `EditColumnModal` idiom) in one `space-y-2 bg-sunken border border-line rounded-lg px-3 py-2.5` box. Mount it only once a supported file is chosen, and reset every choice on each new pick. An option that depends on another is indented `ml-6 border-l-2 border-line pl-4` and uses native `disabled` (so it leaves the tab order) while its parent is off; turning the parent off unchecks it, turning it back on restores the value from just before (memoize it — never reset a deliberate choice to the default). Each row has an always-rendered `text-xs text-fg-muted mt-0.5 ml-6 min-h-4` consequence slot wired with `aria-describedby` (rest copy, the short "… are skipped" consequence, or "Requires {parent}"), so a row keeps its height as long as its copy fits one line; the slots are not live regions — one polite `sr-only` status region announces only the parent cascade. Consequence-slot copy must fit one line at `max-w-md` (about 45 characters for a dependent row); if it cannot, reserve `min-h-8`. Under the fieldset an "Importing: …" summary line (`text-xs text-fg-muted min-h-8`) reads "Importing: everything" or lists what is selected, and is the primary button's `aria-describedby` (dropped while submitting). Never send contradictory options (a dependent `true` with its parent `false`), and send nothing at all when every option is at its default. Report what was skipped afterwards in an informational-tone notice (`bg-primary/15`, never amber — skipping was a choice, not a failure): only non-zero counts (cards, comments, checklist items, card labels, and movements plus activity entries as "history entries"), singular for one, at most three then "and N more". Its `role="status"` wrapper is mounted empty and the text is set one tick later, so screen readers announce it. The notice mounts bottom-center like `MoveBlockedToast` and must not render while a move error is showing (the warning wins). Give it an explicit width (`w-max max-w-[min(24rem,calc(100%-2rem))]`) because an absolutely positioned `left-1/2` element otherwise collapses to half its container at narrow widths. It auto-dismisses after 8s and pauses while hovered or focused. This is a sanctioned exception to § Subordinate settings blocks' single-toggle limit and its `ariaDisabled` guidance: the dependents are a fixed, tiny set whose existence is the thing being advertised, the "Requires {parent}" reason is also in the always-rendered slot, and the parent's cascade announcement tells screen-reader users why they are gone from the tab order. Dim an unavailable dependent's label text with `text-fg-muted` on the label `<span>` only; do not put `opacity-*` on the `<label>` (it double-dims the native disabled control).
- **Neutral state pill.** A neutral status pill (e.g. "Archived", "Skipped") is `px-2 py-0.5 text-xs rounded-full border border-line text-fg-tertiary`. Never `text-fg-muted` on `bg-surface-hover` (see § De-emphasized controls). The state is always spelled as a word, never carried by tone alone.

## URL custom-field links (#1390)

Established by the `url` custom field type. `components/Card/CustomFieldLink.tsx` is the **one** renderer for a URL value — card detail (`full`), the card-face and swimlane-row chips (`host`), and the editor's `Open link ↗` helper (`action`). Do not hand-roll a second anchor for a custom field value.

1. **A link inside a clickable or draggable surface stops propagation and never calls `preventDefault`.** A link nested in a card (dnd-kit drag + click-to-open) or a swimlane label panel (double-click-to-edit) stops `onClick`, `onDoubleClick`, `onPointerDown`, `onMouseDown`, `onTouchStart` and `onKeyDown` from bubbling, so it neither opens the card, starts a drag, nor edits the row. It must not `preventDefault`: the link has to open, including cmd/middle-click. `CustomFieldLink`'s `stopPropagation` prop does exactly this; the MR/PR badge (§ Card-face external links) is the same rule applied by hand.
2. **External links use `target="_blank" rel="noopener noreferrer"`, an `aria-label="Open {host} in new tab"` (chip), `"Open {url} in new tab"` (full URL) or `"Open link in new tab"` (the `action` helper, whose visible text is "Open link ↗" — the accessible name must contain the visible text, WCAG 2.5.3), and only an `http:`/`https:` `href`.** Anything else — a legacy `javascript:` value, an import, a value from a newer server — renders as plain `text-fg-secondary` text with no `href`, never an anchor holding the raw value. The guard runs at render time (`normalizeUrl` + `isHttpUrl`) even though the server already validated the value. A pinned chip shows the hostname only (leading `www.` stripped) with the full URL in the chip's `title`. The link focus ring is `focus:ring-2`, not `focus-visible:` (§ Focus ring consistency).
3. **URL inputs normalize bare domains to `https://`, validate on blur and Enter only, and keep invalid text in the input without saving it.** `normalizeUrl` (`utils/customFieldValue.ts`) trims, prepends `https://` when there is no scheme (`localhost:8080` is a host and port, not a scheme), and **rejects** — never rewrites — any non-http(s) scheme. An invalid value shows its error in the always-rendered `min-h-4` slot under the input (`aria-invalid`, `aria-describedby`, `border-danger`), `onCommit` is not called, and Escape restores the last saved value. A server `400` is mapped to the same copy (`urlErrorFromServer`) in the same slot. The error is `role="alert"` and is the input's `aria-describedby` only while shown — the `Open link ↗` helper is never the input's description, and it is hidden while the input holds unsaved text (it links the saved value). A legacy value that fails the type check is edited through the same blur/Enter editor, never the per-keystroke fallback. No per-keystroke or debounced commit for this type, whatever `debounceMs` says. **A Save-button surface must listen to `onInvalidChange`**: clicking Save blurs the input first and the invalid text is refused, so a form that does not track it saves without the edit and closes as if it had succeeded. `EditSwimlaneModal` is the reference — invalid text blocks Save, keeps the modal open and refocuses the field; a server `400` naming the field (`'{name}': …`) is routed back into that field's slot.
4. **An invalid input keeps a danger indicator while focused.** The standard input focus classes (`focus:ring-primary-emphasis focus:border-transparent`) erase a `border-danger` exactly while the user is fixing the value. When an input is invalid, swap them for `focus:ring-danger-emphasis` and keep the border — build the class list conditionally, never by string-replacing a token out of a shared class string.

## Import Board sample gallery (#1452)

`SampleGallery` ("Start from a sample") sits above the dropzone in `ImportBoardModal`. It is named *sample*, not *template* (`BoardTemplate` is a different concept) and owns no import logic: it takes `onSelect`, so user-defined templates (#442) can add an entry point beside it.

- **Modal shell.** `max-w-[640px]` (was `max-w-md`) so two cards fit side by side; the panel is `max-h-[calc(100dvh-2rem)]` and the *body* scrolls (`flex-1 min-h-0 overflow-y-auto`, `px-4 sm:px-6`) so the header and footer stay fixed. Below 560px the grid is one column and the collapsed view shows 3 samples, not 4. Below ~672px of viewport the panel is the viewport minus the backdrop's `p-4`, so no separate "sheet" shell exists.
- **Fold budget.** At 1280x768 the collapsed gallery must leave the dropzone and footer in view (`e2e/import-samples.spec.ts` pins it). Cards are ~133px; any chrome added to a card or above the gallery spends that budget.
- **Cards.** A `<ul>` of `<li>`; the only focusable element is the card's button, whose `::after` stretches over the card (`relative` card, `after:absolute after:inset-0`), so a click anywhere selects it without a handler on a `div` (§ Click handlers need keyboard parity). The card shows the focus ring (`focus-within`), never the button. Text comes from the manifest; secondary text is `text-fg-tertiary` (`text-fg-muted` fails AA on the dark surface). Accessible names contain the visible label (WCAG 2.5.3): `Use this sample: {Title}`, and `Try again, {Title} sample` after a failure.
- **Includes badges render once when every sample is identical** ("Every sample includes" under the helper text) and per card as soon as any sample differs — derived from the data, never hand-toggled.
- **One Tab stop.** Roving `tabindex` (the focused card is `0`, the rest `-1`); the last-focused card is remembered. Arrow keys move in two dimensions without selecting, Home/End jump, Enter/Space select. "Show all" moves focus to the first revealed card (card 5, or card 4 in one column); "Show fewer" leaves focus on the toggle, and the tab stop falls back to the last visible card while the remembered one is hidden.
- **Focus is never stolen.** On open, focus goes to the first card (or **Retry** when the list is unavailable) only if it is still on the dialog or lost. A failed card moves focus to its **Try again**. An Esc-canceled load and **Change** return focus to that sample's card, expanding the list first if it sits behind "Show all".
- **Announce each message once.** The modal's one persistent polite live region (mounted empty) announces "Loading the {Title} sample." and "Loading canceled."; the card's "Loading sample…" is `aria-hidden` visual text. A per-card failure is its own `role="alert"` only and never reaches the submit error banner. Do not add a second `role="status"` for the gallery.
- **Other samples while one loads** are `aria-disabled` (not `disabled`, so the roving focus survives), and the dropzone stays usable: choosing a file aborts the request.
- **Abort for real.** A new pick, Escape, a file choice and unmount `abort()` the in-flight `AbortController`; a late response from an aborted request is ignored. Escape runs at `useEscapeStack` **48** (see the modal allocation list) and returns `false` when nothing is loading; the board-name input's own Escape handler skips while a sample loads, or it closes the modal first.
- **Reduced motion.** The indeterminate bar pulses; at `motion-reduce` it is a static one-third bar, never a full one that reads as "done".
- **Unavailable list.** The grid is replaced by the neutral notice banner with **Retry**, the divider reads "Upload your own file" (no "or"), and an empty list counts as unavailable — the section never disappears silently.
- **Upload notes follow the dropzone.** The size-limit notice and the Trello link moved below the dropzone to pay for the fold budget; both are hidden while a sample is the source.
- **Next step.** A fetched sample replaces the dropzone with a "From sample: {Title} · ~{n} cards" row and **Change** (no footer Back); the import sends `shift_dates_from` so the board is not mostly overdue, and never a `name`, so "Imported: <title>" numbering still applies.
