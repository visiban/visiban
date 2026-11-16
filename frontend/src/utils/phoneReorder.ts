import type { Card } from "../types";

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
 * A card's index among the live cards of its cell, sorted by position, and the
 * cell's size (#2277): what the peek sheet's Move earlier / Move later step from.
 * The index is the move endpoint's `position` (the cell without the card).
 */
export function cellOrderOf(cards: Card[], card: Card): { index: number; count: number } {
  const cell = cards
    .filter((c) => c.column === card.column && c.swimlane === card.swimlane && !c.archived_at)
    .sort((a, b) => a.position - b.position);
  return { index: Math.max(0, cell.findIndex((c) => c.id === card.id)), count: cell.length };
}
