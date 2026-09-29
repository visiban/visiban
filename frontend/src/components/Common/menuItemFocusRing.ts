/**
 * Shared focus-ring classes for `role="menuitem"` buttons/links inside an open
 * dropdown or menu.
 *
 * Menu items are real tab stops, reached via roving-tabindex arrow-key
 * navigation (ArrowUp/ArrowDown/Home/End) — not just pointer targets.
 * `hover:` alone (or `focus:bg-*` alone) is invisible to a keyboard user who
 * arrowed onto an item without touching the mouse. See frontend/CLAUDE.md
 * "Focus ring consistency" and #1140/#1234 — this pattern has drifted twice
 * (SingleSelectDropdown fixed it for #1140; BulkActionToolbar, the BoardView/
 * LensToolbar collapse split-button menus, and OverflowMenu regressed it
 * again before #1234). Import this constant at every menuitem call site
 * instead of retyping the class string so it can't drift a third time.
 */
export const MENU_ITEM_FOCUS_RING = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/** Danger-variant menuitem focus ring — for destructive items (e.g. Sign out). */
export const MENU_ITEM_FOCUS_RING_DANGER = "focus:outline-none focus:ring-2 focus:ring-danger-emphasis";
