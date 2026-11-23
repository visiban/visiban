import type { Card } from "../types";

/**
 * The per-reader planned-child fields (#2371). Like `parent`, the server sends them only on reads that name a
 * viewer (never on writes or socket frames), so a client re-reads them over REST after an ids-only ping.
 */
export const PLANNED_FIELD_KEYS = [
  "planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at", "needed_now_reason",
] as const;

export type CardPlannedFields = Partial<Pick<Card, (typeof PLANNED_FIELD_KEYS)[number]>>;

/** The planned fields `card` carries, leaving out any the read did not send. */
export function pickPlannedFields(card: CardPlannedFields): CardPlannedFields {
  const out: Record<string, unknown> = {};
  for (const key of PLANNED_FIELD_KEYS) if (card[key] !== undefined) out[key] = card[key];
  return out as CardPlannedFields;
}

/** True when a card shows a planned or needed-now state that its own move changes (a pull ends both). */
export function plannedStateMovesWithCard(card: CardPlannedFields | undefined): boolean {
  return card?.planned === true || card?.needed_now === true;
}

/**
 * The due date that counts for Overdue, Due soon and urgency (#2371): none while the card is a planned child, whose
 * stored date is inactive until the parent reaches the column or someone pulls it. Every place that judges a card
 * overdue or due soon reads this, not `due_date`, so the card face, filters, chips, lane squares and detail agree.
 */
export function activeDueDate(card: Pick<Card, "due_date"> & CardPlannedFields): string | null {
  return card.planned === true ? null : card.due_date;
}
