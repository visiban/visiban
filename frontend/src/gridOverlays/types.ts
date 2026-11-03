import type { Card, Column, Swimlane } from "../types";

/**
 * One cell's contribution from an overlay: a numeric value the slot scales, and
 * a human-readable label the slot puts in the legend, the tooltip, and the
 * screen-reader text.
 *
 * An overlay only ever produces value + label. Everything visual — the scale,
 * the tint, the non-color channel, the legend, the empty state — belongs to the
 * slot (`scale.ts` / `slot.ts`), so the accessibility contract in #969 is
 * enforced exactly once instead of once per overlay.
 */
export interface GridOverlayCell {
  /**
   * Non-negative. On the default relative scale, 0 means "nothing to show here" and
   * the slot renders nothing. An overlay with its own `scale` omits a cell to say
   * that instead, because there 0 is a real reading (a card that just arrived).
   */
  value: number;
  /** e.g. `"3 cards"` — already pluralized and localized by the overlay. */
  label: string;
}

/**
 * Everything an overlay is allowed to read. Deliberately just the board data
 * already in memory: an overlay never reaches for the network from inside
 * `compute()`. That is what keeps a metric overlay live and filter-aware (#459), and
 * what its value has to come from a field on the loaded cards for.
 *
 * `cards` is the *visible* card set — filters already applied — so an overlay never
 * disagrees with what is on screen; `isFiltered` tells the overlay it is describing a
 * filtered subset so it can say so in its labels.
 *
 * `columns` and `swimlanes` are keyed by **id** here.
 */
export interface GridOverlayContext {
  columns: Column[];
  swimlanes: Swimlane[];
  cards: Card[];
  /**
   * True when `cards` is a filtered subset of the board rather than all of it. The
   * board shows several other per-cell counts (the cell corner badge, the collapsed
   * column and swimlane stubs), which do not all agree about filtering; an overlay
   * reports what is on screen and must label it unambiguously.
   */
  isFiltered: boolean;
  /**
   * Wall clock in epoch ms, handed in so `compute()` stays pure. Coarse by design: it
   * advances on the overlay's `refreshMs`, and is 0 for an overlay that declares none,
   * so an overlay that does not read the time is never rebuilt because time passed.
   */
  now: number;
}

/**
 * Absolute steps, for a value whose unit has fixed meaning (#459: days).
 *
 * Without one, the slot buckets against the board's largest value, which is the only
 * honest scale for a unit it cannot interpret. With one, the same value always lands on
 * the same step on every board, and a value below the first threshold is a real reading
 * that gets the numeral but no tint and no bar. It holds numbers and words, never
 * classes: the ramp itself stays in `scale.ts`.
 */
export interface GridOverlayScale {
  /** Ascending lower bounds of levels 1..4, inclusive, in the overlay's unit. */
  thresholds: readonly [number, number, number, number];
  /** Legend wording per step, lowest first: below level 1, then levels 1..4. */
  stepLabels: readonly [string, string, string, string, string];
}

/**
 * A pluggable board-grid overlay.
 *
 * `id` is the serialization handle: it is what a board preset (#1146) stores
 * and what `board:{id}:grid-overlay` persists, so it must stay stable across
 * releases even if `label` is reworded.
 */
export interface GridOverlay {
  /** Stable, serializable, unique. Never rename a shipped id. */
  id: string;
  /** Menu + legend label, e.g. `"Card count"`. */
  label: string;
  /** One sentence for the picker tooltip and the legend caption. */
  description: string;
  /** Absolute steps. Omitted: relative to the largest visible value. */
  scale?: GridOverlayScale;
  /** How the value reads on the badge and the legend, e.g. `4.0d`. */
  formatValue?: (value: number) => string;
  /**
   * Set when a value depends on the time as well as the board, so a mounted board does
   * not show it stale indefinitely. The slot recomputes at this interval, and only then.
   */
  refreshMs?: number;
  /**
   * One sentence for the legend when visible cards count for nothing in `compute()`, or
   * null when none do. A cell has no room to say so, and a number that quietly leaves
   * cards out reads as covering them. Same rules as `compute()`: pure and synchronous.
   */
  note?: (ctx: GridOverlayContext) => string | null;
  /**
   * Per-cell values, keyed by `cellKey(columnId, swimlaneId)`. Cells the
   * overlay omits are treated as value 0. Must be pure and synchronous — the
   * slot calls it inside a `useMemo` on every board mutation.
   */
  compute(ctx: GridOverlayContext): Map<string, GridOverlayCell>;
}

/** Canonical cell key. `column` first so the string sorts column-major. */
export function cellKey(columnId: number, swimlaneId: number): string {
  return `${columnId}:${swimlaneId}`;
}
