import { CHART_COLORS, warningTint } from "../../../utils/chartScale";

/**
 * The one definition of the bottleneck hatch (#2285). The flow row, the time bar, the empty-state example and the cumulative
 * flow band all derive from it, so the bottleneck looks the same wherever it is drawn. Aligned to the cumulative flow chart's
 * original SVG pattern (#2264); the old CSS hatch (dark overlay, 135deg, 3px/8px) was the one that drifted.
 */
export const HATCH_SPEC = {
  /** Stripe direction in degrees, as the SVG `patternTransform="rotate()"` takes it. */
  angle: 45,
  /** Stripe thickness in px. */
  stripe: 2,
  /** Ground between two stripes in px. */
  gap: 4,
  /** Opacity of the ground tint behind the stripes. */
  groundOpacity: 0.2,
} as const;

export const HATCH_PERIOD = HATCH_SPEC.stripe + HATCH_SPEC.gap;
export const HATCH_STRIPE_COLOR = CHART_COLORS.warning;
export const HATCH_GROUND_COLOR = warningTint(HATCH_SPEC.groundOpacity);

/** The stripe sits mid-tile, not at the edge, so an SVG tile boundary never clips half of it. */
const lead = HATCH_SPEC.gap / 2;

/** CSS rendering of the hatch. A CSS gradient angle runs along the gradient, 90deg off the stripe direction. */
export const HATCH_CSS = `repeating-linear-gradient(${HATCH_SPEC.angle + 90}deg, ${HATCH_GROUND_COLOR} 0 ${lead}px, ${HATCH_STRIPE_COLOR} ${lead}px ${lead + HATCH_SPEC.stripe}px, ${HATCH_GROUND_COLOR} ${lead + HATCH_SPEC.stripe}px ${HATCH_PERIOD}px)`;

/** SVG rendering of the hatch: attributes for `<pattern>`, `<rect>` (ground) and `<line>` (stripe). */
export const HATCH_SVG = {
  pattern: { patternUnits: "userSpaceOnUse", width: HATCH_PERIOD, height: HATCH_PERIOD, patternTransform: `rotate(${HATCH_SPEC.angle})` },
  ground: { width: HATCH_PERIOD, height: HATCH_PERIOD, fill: HATCH_GROUND_COLOR },
  stripe: { x1: HATCH_PERIOD / 2, y1: 0, x2: HATCH_PERIOD / 2, y2: HATCH_PERIOD, stroke: HATCH_STRIPE_COLOR, strokeWidth: HATCH_SPEC.stripe },
} as const;
