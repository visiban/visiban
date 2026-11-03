import type { Card } from "../../types";
import type { GridOverlay, GridOverlayCell } from "../types";
import { cellKey } from "../types";

const MS_PER_DAY = 86_400_000;

/**
 * The badge reads to a tenth of a day, which is 2.4 hours, so five minutes is far finer
 * than anything it can show, and a step boundary is crossed at most a few minutes late.
 * A socket event or a move recomputes sooner than this anyway.
 */
const DWELL_REFRESH_MS = 5 * 60_000;

/**
 * The nearest-rank median of the *Flow metric definitions* ADR: rank `(50n + 99) // 100`,
 * the lower middle value for an even n, so the number is always a real card's time.
 * Expects `sorted` ascending and non-empty.
 */
export function nearestRankMedian(sorted: readonly number[]): number {
  return sorted[Math.floor((50 * sorted.length + 99) / 100) - 1];
}

/** `column_entered_at` in epoch ms, or null when the card has no measured visit. */
function enteredAtMs(card: Card): number | null {
  const parsed = card.column_entered_at ? Date.parse(card.column_entered_at) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Current dwell (#459): the median time the visible cards in each cell have been in
 * their column.
 *
 * Computed in the browser, from cards the board already loaded, because it has to be
 * live and filter-aware; a cached board-wide endpoint could be neither. What counts as a
 * visit stays on the server: `column_entered_at` is `null` for every card with no
 * measured open visit (archived, done column, broken history), and this only does
 * `now − column_entered_at` and the median. The ADR's n ≥ 5 floor deliberately does not
 * apply: the overlay describes the cards on screen, it does not estimate a distribution.
 *
 * A done column is also checked here rather than trusting the field alone, because a
 * column can be marked done over the socket while its cards still hold a time.
 *
 * Absolute steps, not relative to the board's maximum: on a board where everything is
 * two hours old, the worst cell is not a bottleneck, and the scale must not say it is.
 */
export const dwellOverlay: GridOverlay = {
  id: "dwell",
  label: "Dwell time",
  description: "Median days the cards in each cell have been in their column.",
  scale: {
    thresholds: [1, 3, 5, 8],
    stepLabels: ["Under 1d", "1–3d", "3–5d", "5–8d", "8d+"],
  },
  formatValue: (value) => `${value.toFixed(1)}d`,
  refreshMs: DWELL_REFRESH_MS,
  compute: (ctx) => {
    const doneColumnIds = new Set(ctx.columns.filter((c) => c.is_done).map((c) => c.id));
    const byCell = new Map<string, { days: number[]; total: number }>();
    for (const card of ctx.cards) {
      if (doneColumnIds.has(card.column)) continue;
      const key = cellKey(card.column, card.swimlane);
      const cell = byCell.get(key) ?? { days: [], total: 0 };
      byCell.set(key, cell);
      cell.total += 1;
      const enteredAt = enteredAtMs(card);
      if (enteredAt === null) continue;
      // The server already dropped misdated rows, so a time ahead of this clock is
      // either browser clock skew or a move made since the last tick. Either way the
      // card has only just arrived, which is what 0 says.
      cell.days.push(Math.max(0, ctx.now - enteredAt) / MS_PER_DAY);
    }

    const cells = new Map<string, GridOverlayCell>();
    for (const [key, { days, total }] of byCell) {
      if (days.length === 0) continue;
      days.sort((a, b) => a - b);
      // Rounded before the slot steps it, so the tint can never contradict the badge: a
      // median of 2.96 days reads `3.0d` and is in the 3-to-5 step. The median itself is
      // taken first, as the ADR says, and a tenth of a day is all this display carries.
      const value = Math.round(nearestRankMedian(days) * 10) / 10;
      const noun = ctx.isFiltered ? "matching cards" : "cards";
      const scope = days.length < total
        ? `, ${days.length} of ${total} ${noun} measured`
        : ctx.isFiltered ? ` across ${noun}` : "";
      cells.set(key, { value, label: `median dwell ${value.toFixed(1)} days${scope}` });
    }
    return cells;
  },
  // "No exclusion is silent" (ADR). The reading says it per cell for a screen reader; this
  // says it to everyone, including about a cell where no card could be measured at all.
  note: (ctx) => {
    const columnIds = new Set(ctx.columns.filter((c) => !c.is_done).map((c) => c.id));
    const swimlaneIds = new Set(ctx.swimlanes.map((s) => s.id));
    let count = 0;
    for (const card of ctx.cards) {
      if (columnIds.has(card.column) && swimlaneIds.has(card.swimlane) && enteredAtMs(card) === null) count += 1;
    }
    if (count === 0) return null;
    const noun = ctx.isFiltered ? (count === 1 ? "matching card" : "matching cards") : (count === 1 ? "card" : "cards");
    return `${count} ${noun} with no recorded time in this column left out.`;
  },
};
