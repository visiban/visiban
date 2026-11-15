import { useId } from "react";
import { CHART_COLORS } from "../../../utils/chartScale";
import type { ChartColor } from "../../../utils/chartScale";
import { HATCH_SVG } from "./hatch";

const LIST = "flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary";

/**
 * Key for the cumulative flow chart's hatched band (#2284). The swatch is drawn from `HATCH_SVG`, the one hatch definition
 * (#2285), so it cannot drift from the band it names. Rendered only when a bottleneck band is on screen.
 */
export function CumulativeFlowLegend() {
  const id = `cfd-legend-hatch-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <ul className={LIST} aria-label="Cumulative flow legend" data-testid="cfd-legend">
      <li className="flex items-center gap-1.5">
        <svg width={16} height={12} aria-hidden="true" data-testid="cfd-legend-hatch">
          <defs>
            <pattern id={id} {...HATCH_SVG.pattern}>
              <rect {...HATCH_SVG.ground} />
              <line {...HATCH_SVG.stripe} />
            </pattern>
          </defs>
          <rect width={16} height={12} fill={`url(#${id})`} />
        </svg>
        Bottleneck column
      </li>
    </ul>
  );
}

export type AgeTier = Exclude<ChartColor, "hue">;

const TIER_LABELS: Record<AgeTier, string> = {
  neutral: "Under the 50th percentile",
  warning: "Past the 50th percentile",
  danger: "Past the 85th percentile",
};

/**
 * Key for the WIP aging tiers (#2284), in the shapes the chart draws: a dot, and for past P85 a dot inside a ring (the ring
 * is the non-hue cue). Only tiers with a mark on screen are listed; under a breakdown the marks take group colors, so the
 * chart passes no tiers. The blocked square keeps its meaning under a breakdown, so it is keyed whenever a blocked card is drawn,
 * in the neutral color (the shape, not the hue, is the cue).
 */
export function WipAgeLegend({ tiers, blocked = false }: { tiers: AgeTier[]; blocked?: boolean }) {
  if (tiers.length === 0 && !blocked) return null;
  return (
    <ul className={LIST} aria-label="WIP aging legend" data-testid="wip-age-legend">
      {tiers.map((tier) => (
        <li key={tier} className="flex items-center gap-1.5" data-legend-tier={tier}>
          <svg width={18} height={18} aria-hidden="true">
            {tier === "danger" && <circle cx={9} cy={9} r={8} fill="none" stroke={CHART_COLORS.danger} strokeWidth={1.5} />}
            <circle cx={9} cy={9} r={4} fill={CHART_COLORS[tier]} />
          </svg>
          {TIER_LABELS[tier]}
        </li>
      ))}
      {blocked && (
        <li className="flex items-center gap-1.5" data-legend-blocked>
          <svg width={18} height={18} aria-hidden="true">
            <rect x={5} y={5} width={8} height={8} fill={CHART_COLORS.neutral} />
          </svg>
          Blocked card
        </li>
      )}
    </ul>
  );
}
