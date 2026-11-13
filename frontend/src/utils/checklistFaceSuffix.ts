import type { Card } from "../types";
import { todayInTimezone } from "./date";

/** The optional suffix after the card face's `✓ 3/7` checklist count (#445).
 *
 * At most one is shown, overdue first: an unchecked checklist item past due
 * (`· ⚑ 1`, danger tone), otherwise unchecked items assigned to the viewer
 * (`· mine 2`). Both are derived here, not on the server: "overdue" depends on
 * the viewer's timezone and "mine" on the viewer, while one card payload is
 * broadcast to every subscriber (architect R3a). A checklist item's due date
 * never feeds the card's own urgency badge or border (design A-Q9).
 */
export type ChecklistFaceSuffix = { kind: "overdue"; count: number } | { kind: "mine"; count: number } | null;

export function checklistFaceSuffix(
  card: Pick<Card, "checklist_open_due_dates" | "checklist_open_assignee_ids">,
  today: string,
  currentUserId?: number | null,
): ChecklistFaceSuffix {
  // ISO dates compare correctly as strings.
  const overdue = (card.checklist_open_due_dates ?? []).filter((d) => d < today).length;
  if (overdue > 0) return { kind: "overdue", count: overdue };
  if (currentUserId == null) return null;
  const mine = (card.checklist_open_assignee_ids ?? []).filter((id) => id === currentUserId).length;
  return mine > 0 ? { kind: "mine", count: mine } : null;
}

/** Today in the viewer's timezone, `YYYY-MM-DD`: the same "today" the card's
 *  own due label uses (formatDueDate). */
export function checklistToday(userTimezone: string): string {
  return todayInTimezone(userTimezone);
}
