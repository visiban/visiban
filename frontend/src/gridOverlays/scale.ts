/**
 * The overlay slot's scale and its dual-encoding contract.
 *
 * #969 is the governing accessibility constraint for every grid overlay: a cell's
 * severity must be readable **twice** — once by color and once by a channel that
 * survives any form of color blindness (here: bottom-border weight and a rising
 * bar glyph). The rule lives in this one module, and every level comes out of a
 * single `OVERLAY_ENCODINGS` table, so an individual overlay physically cannot
 * ship a hue-only ramp: overlays supply numbers, never classes.
 */

/** Number of severity steps above "nothing to show". */
export const OVERLAY_LEVELS = 4;

/**
 * Level used when every cell that has a value has the *same* value.
 *
 * Relative-to-max bucketing puts the busiest cell at the top of the scale, which on a
 * board where every populated cell holds one card would paint the whole grid at level
 * 4 — technically true, and a false alarm. A flat distribution has no spread to show,
 * so the slot draws the quietest step instead, and the legend's own rows then report
 * one populated level and three empty ones.
 */
export const OVERLAY_FLAT_LEVEL = 1;

export interface OverlayEncoding {
  /** 0 = nothing to show (renders no tint at all), 1..OVERLAY_LEVELS = severity. */
  level: number;
  /** Color channel. Empty at level 0. */
  tintClass: string;
  /** Non-color channel 1 — height of the bar pinned to the cell's bottom edge. */
  barHeightClass: string;
  /** Tone of that bar. Part of the same geometric channel, not a separate one. */
  barToneClass: string;
  /** Non-color channel 2 — the wording used in the cell's and legend's a11y text. */
  levelLabel: string;
}

/**
 * One row per level, color and non-color channels declared together.
 *
 * Single-hue intensity ramp on `primary-emphasis`: a generic overlay's scalar means
 * "more/less", not "safe/dangerous", so it must not borrow the success -> warning ->
 * danger vocabulary the board already uses for WIP, weight and card aging — a red cell
 * would assert a judgment the overlay cannot justify, and a three-hue diverging ramp is
 * the thing #969 was filed about. `primary-emphasis` is also the one blue with no
 * existing meaning inside a grid cell (`bg-info/10` is the active-toggle state, `/15`
 * the filter-match pulse on collapsed stubs, `/20` the drop-target indicator) and it
 * resolves to the same value in both themes, so the ramp is verified once.
 *
 * The ramp starts at `/10`, the already-shipped selection fill: `/5` is below the
 * perceptibility floor over `bg-canvas` in both themes.
 *
 * The non-color channel is a bar `div`, never a font glyph: block-element glyphs like
 * `\u2581\u2583\u2585\u2587` do track `currentColor`, but their advance width and baseline are
 * font-dependent, so the ramp's step size would not be reproducible across platforms.
 */
export const OVERLAY_ENCODINGS: readonly OverlayEncoding[] = [
  { level: 0, tintClass: "", barHeightClass: "", barToneClass: "", levelLabel: "no value" },
  { level: 1, tintClass: "bg-primary-emphasis/10", barHeightClass: "h-px", barToneClass: "bg-primary-emphasis/50", levelLabel: "level 1 of 4" },
  { level: 2, tintClass: "bg-primary-emphasis/20", barHeightClass: "h-0.5", barToneClass: "bg-primary-emphasis/70", levelLabel: "level 2 of 4" },
  { level: 3, tintClass: "bg-primary-emphasis/30", barHeightClass: "h-[3px]", barToneClass: "bg-primary-emphasis/85", levelLabel: "level 3 of 4" },
  { level: 4, tintClass: "bg-primary-emphasis/40", barHeightClass: "h-1", barToneClass: "bg-primary-emphasis", levelLabel: "level 4 of 4" },
];

/**
 * Buckets a value against the board's busiest cell.
 *
 * Relative-to-max rather than absolute thresholds: the slot has no idea what unit
 * an overlay reports (cards, hours, percent), so the only scale it can define
 * honestly is "compared with the largest value currently on this board".
 */
export function overlayLevel(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  const level = Math.ceil((value / max) * OVERLAY_LEVELS);
  return Math.min(OVERLAY_LEVELS, Math.max(1, level));
}

/** The encoding row for a level. Out-of-range levels clamp to level 0. */
export function encodeOverlayLevel(level: number): OverlayEncoding {
  return OVERLAY_ENCODINGS[level] ?? OVERLAY_ENCODINGS[0];
}

/**
 * Formats a value for display. Integers stay integers (card counts are the common
 * case); anything else gets one decimal so a 0.3-hour bucket is not rounded into a
 * neighboring bucket's label.
 */
export function formatOverlayValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
