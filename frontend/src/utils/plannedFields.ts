import type { Card } from "../types";

/**
 * The five per-reader planned-child fields (#2371). Like `parent`, the server sends them only on reads that name a
 * viewer (never on writes or socket frames), so a client re-reads them over REST after an ids-only ping.
 */
export const PLANNED_FIELD_KEYS = [
  "planned", "needed_now", "needed_at_column", "needed_at_column_name", "planned_released_at",
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
