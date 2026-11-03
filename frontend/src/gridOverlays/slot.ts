import type { GridOverlay, GridOverlayContext } from "./types";
import { cellKey } from "./types";
import { NONE_OVERLAY_ID } from "./registry";
import type { OverlayEncoding } from "./scale";
import {
  OVERLAY_BELOW_SCALE_ENCODING,
  OVERLAY_FLAT_LEVEL,
  OVERLAY_LEVELS,
  encodeOverlayLevel,
  formatOverlayValue,
  overlayLevel,
  overlayThresholdLevel,
} from "./scale";

export interface GridOverlayCellState {
  value: number;
  /** The overlay's own wording for this cell, e.g. `"3 cards"`. */
  label: string;
  /** The value as the badge shows it, e.g. `"4.0d"`. */
  display: string;
  encoding: OverlayEncoding;
}

/**
 * Per-level summary for the legend: how many cells landed in the level and the actual
 * range of values observed there.
 *
 * Observed ranges rather than formula ceilings: with `max = 7` the quartile bounds are
 * 1.8 / 3.5 / 5.3 / 7, and "up to 1.8 cards" is not a sentence worth shipping. The
 * observed range is exact, stays integral for counts, and explains itself.
 */
export interface GridOverlayLevelSummary {
  level: number;
  encoding: OverlayEncoding;
  /** Cells at this level. 0 means the level is unused on this board. */
  count: number;
  /** Smallest / largest value observed at this level. 0 when `count` is 0. */
  min: number;
  max: number;
  /** The step's fixed wording on an absolute scale, e.g. `"3–5d"`; else null. */
  stepLabel: string | null;
}

export interface GridOverlayState {
  overlayId: string;
  label: string;
  description: string;
  /** Only cells with a reading; a miss means "render this cell untouched". */
  cells: Map<string, GridOverlayCellState>;
  /** Level 1..OVERLAY_LEVELS, in ascending order — the legend's rows. */
  levels: GridOverlayLevelSummary[];
  /** The extra row below level 1 on an absolute scale; null on a relative one. */
  belowScale: GridOverlayLevelSummary | null;
  /** The overlay's caveat about cards it left out, or null. */
  note: string | null;
  /** Reads a value the way the badge does, for the legend's ranges. */
  formatValue: (value: number) => string;
  /** Largest value on the visible grid — the top of the scale. */
  max: number;
  /** Smallest reading on the visible grid. 0 when there are none. */
  min: number;
  /** True when the active overlay produced nothing to show on this board. */
  isEmpty: boolean;
  /**
   * Whether the values describe a filtered subset. The legend's empty state needs it:
   * "nothing on this board" is false when the board is full of cards and the filter
   * bar is what left the overlay with nothing to scale.
   */
  isFiltered: boolean;
  /**
   * True when every cell that has a value has the same one, so there is no spread to
   * rank. Every cell is then drawn at `OVERLAY_FLAT_LEVEL`, and the legend needs no
   * special case for it: its per-level rows show the one populated level's value and
   * an em dash against the three unused ones, which reads as "all equal" by itself.
   * Always false on an absolute scale: a step there means the same thing on any board,
   * so equal values have nothing to be demoted from.
   */
  isFlat: boolean;
}

/**
 * Turns an overlay's raw per-cell values into everything the slot renders.
 *
 * Returns `null` for the default "None" overlay (and for an unresolvable one), so
 * the un-overlaid board is not a styled special case but the complete absence of
 * overlay props on `BoardCell` — the cheapest possible proof that the default
 * path is byte-for-byte the pre-#1147 behavior.
 *
 * The scale is computed over the *visible* grid only: values are read through the
 * `columns x swimlanes` cross-product the caller passes in, so a card parked in a
 * hidden column cannot inflate `max` and wash out every tint on screen.
 */
export function buildGridOverlayState(
  overlay: GridOverlay | null | undefined,
  ctx: GridOverlayContext,
): GridOverlayState | null {
  if (!overlay || overlay.id === NONE_OVERLAY_ID) return null;

  const { scale } = overlay;
  const formatValue = overlay.formatValue ?? formatOverlayValue;
  const raw = overlay.compute(ctx);
  const visible: { key: string; value: number; label: string }[] = [];
  let max = 0;
  let min = Infinity;
  for (const column of ctx.columns) {
    for (const swimlane of ctx.swimlanes) {
      const key = cellKey(column.id, swimlane.id);
      const cell = raw.get(key);
      // On a relative scale 0 is "nothing to show". An absolute scale's overlay says
      // that by omitting the cell, so its 0 is a reading.
      if (!cell || !(scale ? cell.value >= 0 : cell.value > 0)) continue;
      visible.push({ key, value: cell.value, label: cell.label });
      if (cell.value > max) max = cell.value;
      if (cell.value < min) min = cell.value;
    }
  }
  if (visible.length === 0) min = 0;

  const isFlat = !scale && visible.length > 0 && min === max;
  const cells = new Map<string, GridOverlayCellState>();
  for (const cell of visible) {
    const level = scale
      ? overlayThresholdLevel(cell.value, scale.thresholds)
      : isFlat ? OVERLAY_FLAT_LEVEL : overlayLevel(cell.value, max);
    if (!scale && level <= 0) continue;
    const encoding = scale && level === 0 ? OVERLAY_BELOW_SCALE_ENCODING : encodeOverlayLevel(level);
    cells.set(cell.key, { value: cell.value, label: cell.label, display: formatValue(cell.value), encoding });
  }

  const summarize = (level: number, encoding: OverlayEncoding): GridOverlayLevelSummary => {
    const values = [...cells.values()].filter((c) => c.encoding.level === level).map((c) => c.value);
    return {
      level,
      encoding,
      count: values.length,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      stepLabel: scale ? scale.stepLabels[level] : null,
    };
  };
  const levels: GridOverlayLevelSummary[] = [];
  for (let level = 1; level <= OVERLAY_LEVELS; level++) {
    levels.push(summarize(level, encodeOverlayLevel(level)));
  }

  return {
    overlayId: overlay.id,
    label: overlay.label,
    description: overlay.description,
    cells,
    levels,
    belowScale: scale ? summarize(0, OVERLAY_BELOW_SCALE_ENCODING) : null,
    note: overlay.note?.(ctx) ?? null,
    formatValue,
    max,
    min,
    isEmpty: cells.size === 0,
    isFiltered: ctx.isFiltered,
    isFlat,
  };
}
