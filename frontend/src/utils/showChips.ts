import type { Card, Column } from "../types";
import { classifyCardUrgency } from "./cardUrgency";

/**
 * Show chips (#2272): a one-click quick view above the grid. `all` is the
 * default and is not written to the URL; the others travel as `?show=<key>`.
 * A chip is a quick view, not a saved filter: it is not persisted to storage or
 * to saved filters, and it combines with the Filter panel (both apply).
 */
export type ShowChipKey = "all" | "overdue" | "stale" | "due_soon";

export const SHOW_CHIP_ORDER: readonly ShowChipKey[] = ["all", "overdue", "stale", "due_soon"];

export const SHOW_CHIP_LABEL: Record<ShowChipKey, string> = {
  all: "All cards",
  overdue: "Overdue",
  stale: "Stale",
  due_soon: "Due soon",
};

/** Parse the `show` URL param; anything unknown falls back to `all`. */
export function parseShowChip(value: string | null): ShowChipKey {
  return value === "overdue" || value === "stale" || value === "due_soon" ? value : "all";
}

/**
 * Which chip a card belongs to, by the same precedence the card face uses for
 * its one status line: overdue, then due soon, then stale. Stale is ignored in
 * a done column (finished, not idle). A card on track belongs to no chip.
 */
export function cardShowChip(
  card: Pick<Card, "due_date" | "is_stale">,
  inDoneColumn: boolean,
  now: number = Date.now(),
): Exclude<ShowChipKey, "all"> | null {
  const kind = classifyCardUrgency(
    { due_date: card.due_date, is_stale: card.is_stale && !inDoneColumn, last_moved_at: null },
    now,
  )?.kind;
  if (kind === "overdue") return "overdue";
  if (kind === "due-soon") return "due_soon";
  if (kind === "stale") return "stale";
  return null;
}

function doneColumnIds(columns: Pick<Column, "id" | "is_done">[]): Set<number> {
  return new Set(columns.filter((c) => c.is_done).map((c) => c.id));
}

/** Counts for the whole board (archived cards excluded), independent of any filter. */
export function showChipCounts(
  cards: Pick<Card, "column" | "due_date" | "is_stale" | "archived_at">[],
  columns: Pick<Column, "id" | "is_done">[],
  now: number = Date.now(),
): Record<ShowChipKey, number> {
  const done = doneColumnIds(columns);
  const counts: Record<ShowChipKey, number> = { all: 0, overdue: 0, stale: 0, due_soon: 0 };
  for (const card of cards) {
    if (card.archived_at) continue;
    counts.all += 1;
    const chip = cardShowChip(card, done.has(card.column), now);
    if (chip) counts[chip] += 1;
  }
  return counts;
}

/** Ids of the cards a non-`all` chip keeps. */
export function showChipCardIds(
  cards: Pick<Card, "id" | "column" | "due_date" | "is_stale">[],
  columns: Pick<Column, "id" | "is_done">[],
  chip: Exclude<ShowChipKey, "all">,
  now: number = Date.now(),
): Set<number> {
  const done = doneColumnIds(columns);
  return new Set(cards.filter((c) => cardShowChip(c, done.has(c.column), now) === chip).map((c) => c.id));
}
