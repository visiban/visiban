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
  /** Non-negative. 0 means "nothing to show here"; the slot renders no tint. */
  value: number;
  /** e.g. `"3 cards"` — already pluralized and localized by the overlay. */
  label: string;
}

/**
 * Everything an overlay is allowed to read. Deliberately just the board data
 * already in memory: the 1.2 slot ships no new queries (#1147 non-goal), and a
 * later metric overlay (#459 dwell time) extends this context rather than
 * reaching for the network from inside `compute()`.
 *
 * `cards` is the *visible* card set — filters already applied — so an overlay never
 * disagrees with what is on screen; `isFiltered` tells the overlay it is describing a
 * filtered subset so it can say so in its labels.
 *
 * `columns` and `swimlanes` are keyed by **id** here. A later server-fed overlay may
 * have to bridge from names: the existing analytics aggregate
 * (`backend/boards/views/analytics.py` — `age_avg_days_per_column` and friends, which
 * #459 can consume instead of adding an endpoint) is keyed by column *name*, and
 * `Column`/`Swimlane` are `unique_together (board, name)`, so the mapping is safe but
 * has to be done by the adapter, not by widening this contract.
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
