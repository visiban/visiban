import type { Card } from "../types";
import { classifyCardUrgency } from "../utils/cardUrgency";

/**
 * A card's board status for the swimlane band and the collapsed-lane strip
 * (#2271). Overdue wins over stale; everything else is "ok" (on track).
 */
export type CardBoardStatus = "overdue" | "stale" | "ok";

/**
 * Square colors for the collapsed-lane strip, from tokens only: danger for
 * overdue, warning for stale, primary tint otherwise. Shared so the Show chip
 * swatches (#2272) draw the same colors; import this, do not redefine it.
 */
export const STATUS_SQUARE_CLASS: Record<CardBoardStatus, string> = {
  overdue: "bg-danger-emphasis",
  stale: "bg-warning-emphasis",
  ok: "bg-primary-emphasis/60",
};

/** Text for the status counts (band stats, screen-reader strip text). */
export const STATUS_LABEL: Record<CardBoardStatus, string> = {
  overdue: "overdue",
  stale: "stale",
  ok: "on track",
};

/**
 * Status of one card. Stale is the server's verdict (`is_stale`), ignored for a
 * card in a done column (finished, not idle), the same rule the card face uses.
 */
export function cardBoardStatus(card: Pick<Card, "due_date" | "is_stale" | "last_moved_at">, inDoneColumn: boolean): CardBoardStatus {
  // Overdue skips a done-column card too (#2313), as the server's auto health does.
  const kind = classifyCardUrgency({ due_date: card.due_date, closed: inDoneColumn, is_stale: false, last_moved_at: null })?.kind;
  if (kind === "overdue") return "overdue";
  if (card.is_stale && !inDoneColumn) return "stale";
  return "ok";
}
