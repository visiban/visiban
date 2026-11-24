import { formatShortMonthDay } from "../../utils/cardStatusLine";

/**
 * The Move popover's planned-date warning (#2371 §2/§7, #2550). A planned child's due date is inactive while it
 * waits in the child board's first column; a move out of that column pulls it, the date becomes live, and a date
 * that has already passed makes it overdue at once. So the popover says so before the move, as a status line and
 * not a confirm: the move is still the person's call. A move within the first column pulls nothing, and a move to
 * a done column is never overdue, so neither warns.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the pure rule is co-located with the line it drives
export function plannedMoveWarningText(
  card: { planned?: boolean; due_date: string | null },
  target: { id: number; is_done?: boolean } | null | undefined,
  firstColumnId: number | undefined,
  today: string,
): string | null {
  if (card.planned !== true || !card.due_date || !target) return null;
  if (target.id === firstColumnId || target.is_done) return null;
  const due = card.due_date.slice(0, 10);
  if (due >= today) return null;
  return `Its date, ${formatShortMonthDay(due)}, has passed. It will be overdue once moved.`;
}

/** The board's first column (lowest position), where a planned child waits. */
// eslint-disable-next-line react-refresh/only-export-components -- a helper of the rule above
export function firstColumnId(columns: { id: number; position: number }[]): number | undefined {
  let first: { id: number; position: number } | undefined;
  for (const c of columns) if (!first || c.position < first.position || (c.position === first.position && c.id < first.id)) first = c;
  return first?.id;
}

/**
 * The warning line itself: `role="status"`, warning text, no glyph (#2371: the clock means Stale or idle only).
 * Always mounted (`sr-only` and empty when there is nothing to say), so the live region exists before its text
 * arrives and screen readers announce it when the target changes, like the popovers' error line (ux-review).
 */
export default function PlannedMoveWarning({ text }: { text: string | null }) {
  return <p role="status" className={text ? "text-xs text-warning" : "sr-only"} data-testid="planned-move-warning">{text ?? ""}</p>;
}
