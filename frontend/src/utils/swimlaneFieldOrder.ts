/**
 * Whether the lane menu offers "Change field order…" (#1458; the "N fields" grid link it also drove is gone since #2658). Order
 * only means something with two or more field definitions, and the order is
 * board-wide and admin-edited, so members and viewers never get the shortcut.
 * Counts full board definitions, not the popover's visible entries.
 */
export function canEditSwimlaneFieldOrder(isAdmin: boolean, definitionCount: number): boolean {
  return isAdmin && definitionCount >= 2
}
