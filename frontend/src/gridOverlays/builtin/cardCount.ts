import type { GridOverlay, GridOverlayCell } from "../types";
import { cellKey } from "../types";

/**
 * Reference overlay proving the seam: how many visible cards sit in each cell.
 *
 * Deliberately the most trivial metric available — it is derived from the cards
 * already loaded by the board's `/full/` endpoint, so it adds no query, no
 * aggregation, and no per-cell request (#1147 non-goal; the real metric work is
 * #459's dwell time).
 */
export const cardCountOverlay: GridOverlay = {
  id: "card-count",
  label: "Card count",
  description: "Cards per cell, relative to the busiest cell on the board.",
  compute: (ctx) => {
    const cells = new Map<string, GridOverlayCell>();
    for (const card of ctx.cards) {
      const key = cellKey(card.column, card.swimlane);
      const current = cells.get(key);
      const value = (current?.value ?? 0) + 1;
      // "matching" when a filter is active. The cell's own corner badge stands down
      // while an overlay is on, so the two can no longer contradict each other there —
      // but the collapsed column and swimlane stubs still show their own counts, and
      // the legend and the screen-reader reading have to say which population this is.
      const noun = ctx.isFiltered ? (value === 1 ? "matching card" : "matching cards") : (value === 1 ? "card" : "cards");
      cells.set(key, { value, label: `${value} ${noun}` });
    }
    return cells;
  },
};
