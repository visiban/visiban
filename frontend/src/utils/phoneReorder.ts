import type { Card, Column } from "../types";
import { cardSubColumnIndex, isGatedStage } from "./stages";

/**
 * New order for `ids` with `id` moved one step past its neighbor among `visible`
 * (Move earlier / Move later, #2277). Hidden items keep their slots relative to
 * each other; the moved item lands just before (earlier) or after (later) the
 * visible neighbor, so the step is always one visible place.
 */
export function stepOrder(ids: number[], visible: number[], id: number, dir: -1 | 1): number[] | null {
  const vi = visible.indexOf(id);
  const neighbor = visible[vi + dir];
  if (vi === -1 || neighbor === undefined) return null;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(neighbor);
  if (at === -1) return null;
  rest.splice(dir === -1 ? at : at + 1, 0, id);
  return rest;
}

/**
 * A card's place among the cards of its cell that the board shows, and the
 * `position` each step sends (#2277): what the peek sheet's Move earlier /
 * Move later use. `visible` is the filter's card ids (`null`: no filter), so a
 * step never passes a hidden card and the first/last limits are the visible
 * ones; the card itself always counts, even if a filter hides it.
 *
 * The move endpoint reads `position` as a RAW slot on a same-cell reorder: it
 * does not compact the slot the card leaves, clamps to one past the top, and
 * shifts every other card at or above the slot up by one
 * (`_move_card_attempt`, `backend/boards/services/cards.py`). So the card's
 * own index + 1 is the slot just above it, a no-op. Instead Move earlier
 * sends the previous visible card's position (the card lands right before
 * it) and Move later the next visible card's position + 1 (right after it).
 * A hidden card between them keeps its side of the neighbor. `null` means
 * there is no visible card that way.
 */
export function cellOrderOf(
  cards: Card[], card: Card, visible: ReadonlySet<number> | null = null,
  /** The card's column. On a gated stage the steps stay inside the card's own sub-column (#2278). */
  column?: Pick<Column, "sub_columns"> | null,
): { index: number; count: number; earlier: number | null; later: number | null } {
  const gated = isGatedStage(column);
  const sub = gated && column ? cardSubColumnIndex(card, column) : 0;
  const cell = cards
    .filter((c) => c.column === card.column && c.swimlane === card.swimlane && !c.archived_at)
    .filter((c) => !gated || !column || cardSubColumnIndex(c, column) === sub)
    .filter((c) => c.id === card.id || visible === null || visible.has(c.id))
    .sort((a, b) => a.position - b.position || a.id - b.id);
  const index = cell.findIndex((c) => c.id === card.id);
  if (index === -1) return { index: 0, count: cell.length, earlier: null, later: null };
  const prev = cell[index - 1];
  const next = cell[index + 1];
  return {
    index,
    count: cell.length,
    earlier: prev ? prev.position : null,
    later: next ? next.position + 1 : null,
  };
}
